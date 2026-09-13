import type { AiClassifyRequest, AiClassifyResponse, AiProbe } from '@shared/ipc-types';
import { aiProviderKind, resolveAiEndpoint, type CliProvider, type Settings } from '@shared/settings';
import { claudeClassify, probeClaude, type ClassifyPrompt, type CliClassifyResult } from './claude-cli';
import { parseDataUrl } from './cli-common';
import { codexClassify, probeCodex } from './codex-cli';

const SYSTEM_PROMPT = `Du liest den Kopfbereich einer gescannten Notenseite aus der Blasmusik.
Bestimme, für welche Stimme (Instrument) diese Seite ist. Antworte NUR mit einem JSON-Objekt:
{"headerText": "<die Stimmenbezeichnung wörtlich, wie sie auf dem Blatt steht, oder leer>",
 "instrument": "<Instrument auf Deutsch, z.B. Trompete, Flügelhorn, Tenorhorn, Bariton, Posaune, Tuba, Horn, Klarinette, Schlagzeug, Flöte, Saxophon, Gitarre, Gesang; oder 'Stimme' bei generischen Angaben wie '1. Stimme'; oder leer>",
 "number": "<Stimmnummer als Ziffer, z.B. 1, 2, 1/2, oder leer>",
 "key": "<Stimmung wie B, Es, F, C oder leer>",
 "isScore": <true wenn es eine Partitur/Direktion ist (mehrere Instrumente untereinander in einem System), sonst false>}
Titel des Stücks, Komponist, Arrangeur und Verlag sind KEINE Stimmenbezeichnung. Wenn keine Stimmenbezeichnung erkennbar ist, lass die Felder leer.`;

/** Antwortschema für die strukturierte Ausgabe der CLIs (Codex verlangt strict: alle Felder required, keine Zusatzfelder). */
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    headerText: { type: 'string' },
    instrument: { type: 'string' },
    number: { type: 'string' },
    key: { type: 'string' },
    isScore: { type: 'boolean' },
  },
  required: ['headerText', 'instrument', 'number', 'key', 'isScore'],
  additionalProperties: false,
} as const;

/** Höchstens so viele CLI-Prozesse gleichzeitig: jeder Aufruf startet eine eigene Laufzeit, die Seiten-Pipeline würde sonst pro Worker einen starten. */
const CLI_MAX_PARALLEL = 3;
let cliRunning = 0;
const cliWaiting: (() => void)[] = [];

async function withCliSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (cliRunning >= CLI_MAX_PARALLEL) await new Promise<void>((resolve) => cliWaiting.push(resolve));
  cliRunning++;
  try {
    return await fn();
  } finally {
    cliRunning--;
    cliWaiting.shift()?.();
  }
}

function userText(req: AiClassifyRequest): string {
  return req.ocrText
    ? `Lokale OCR hat gelesen (kann fehlerhaft sein): "${req.ocrText.slice(0, 300)}"`
    : 'Bitte den Kopfbereich lesen.';
}

function parseJson(text: string): Partial<AiClassifyResponse> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function toResponse(content: string, meta: Pick<CliClassifyResult, 'usage' | 'model'>, fallbackModel: string): AiClassifyResponse {
  const parsed = parseJson(content);
  if (!parsed) return { ok: false, error: 'Antwort enthielt kein JSON: ' + content.slice(0, 200) };
  return {
    ok: true,
    headerText: parsed.headerText ?? '',
    instrument: parsed.instrument ?? '',
    number: parsed.number !== undefined && parsed.number !== null ? String(parsed.number) : '',
    key: parsed.key ?? '',
    isScore: !!parsed.isScore,
    usage: meta.usage,
    model: meta.model ?? fallbackModel,
  };
}

async function httpClassify(req: AiClassifyRequest, settings: Settings): Promise<AiClassifyResponse> {
  const { baseUrl, model, apiKey } = resolveAiEndpoint(settings);
  if (!baseUrl || !model) return { ok: false, error: 'KI-Anbindung ist nicht konfiguriert.' };
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://github.com/DominikBritz/Notenwart';
    headers['X-Title'] = 'Notenwart';
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: 300,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText(req) },
          { type: 'image_url', image_url: { url: req.imageDataUrl } },
        ],
      },
    ],
  };
  if (/gpt-5|o[1-4]|reasoning|thinking/i.test(model)) {
    body.reasoning = { effort: 'low' };
    delete body.temperature;
    delete body.max_tokens;
    body.max_completion_tokens = 1500;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    const json = JSON.parse(text);
    const content: unknown = json.choices?.[0]?.message?.content ?? '';
    const usage = json.usage
      ? { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 }
      : undefined;
    return toResponse(typeof content === 'string' ? content : JSON.stringify(content), { usage, model: json.model }, model);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function cliClassify(kind: CliProvider, req: AiClassifyRequest, settings: Settings): Promise<AiClassifyResponse> {
  const cfg = settings.ai[kind];
  try {
    const prompt: ClassifyPrompt = { system: SYSTEM_PROMPT, userText: userText(req), image: parseDataUrl(req.imageDataUrl), schema: OUTPUT_SCHEMA };
    const r = await withCliSlot(() => (kind === 'claude' ? claudeClassify(cfg, prompt) : codexClassify(cfg, prompt)));
    return toResponse(r.content, r, cfg.model);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function aiClassify(req: AiClassifyRequest, settings: Settings): Promise<AiClassifyResponse> {
  const kind = aiProviderKind(settings);
  return kind === 'http' ? httpClassify(req, settings) : cliClassify(kind, req, settings);
}

/** Verbindungsstatus einer lokalen CLI (Binary, Login, Modelle) für die Einstellungen. */
export function aiProbe(provider: CliProvider, binary: string): Promise<AiProbe> {
  return provider === 'claude' ? probeClaude(binary) : probeCodex(binary);
}

/** Holt aktuelle Preise (USD pro Token) von OpenRouter für die Voreinstellungen. */
export async function fetchOpenRouterPricing(models: string[]): Promise<Record<string, [number, number]>> {
  const out: Record<string, [number, number]> = {};
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return out;
    const json = await res.json();
    for (const m of json.data ?? []) {
      if (models.includes(m.id) && m.pricing) {
        out[m.id] = [Number(m.pricing.prompt) * 1e6, Number(m.pricing.completion) * 1e6];
      }
    }
  } catch {
    /* offline: Fallback-Preise */
  }
  return out;
}
