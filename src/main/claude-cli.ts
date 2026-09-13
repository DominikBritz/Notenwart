/**
 * KI-Aufruf über die lokal installierte Claude-Code-CLI
 * (`claude -p --input-format stream-json --output-format stream-json --json-schema …`).
 *
 * Kein OAuth-Handling: der Login gehört der CLI (Keychain), HOME bleibt
 * unverändert. Nutzung zählt gegen die Plan-Limits der Subscription. Das
 * Kopfbild geht als Base64-Bildblock in der User-Message über stdin, es
 * werden keine Werkzeuge, Hooks, Skills oder MCP-Server geladen.
 */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiProbe } from '@shared/ipc-types';
import { CLI_PROVIDERS } from '@shared/settings';
import { makeScratchDir, parseDataUrl, probeVersion, resolveBinary, runWithTimeout, snippet, type ImageData } from './cli-common';

const TOOL = 'claude-CLI';
export const CLAUDE_DEFAULT_TIMEOUT_MS = 120_000;
const AUTH_TIMEOUT_MS = 15_000;

/** Suchkandidaten, wenn nur der Name konfiguriert ist (Finder-PATH). */
export const CLAUDE_BINARY_CANDIDATES = [
  '~/.local/bin/claude',
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '~/.npm-global/bin/claude',
  '~/.claude/local/claude',
  '~/.local/bin/claude.exe',
  '~/AppData/Roaming/npm/claude.cmd',
];

export interface ClassifyPrompt {
  system: string;
  userText: string;
  image: ImageData;
  /** JSON-Schema der Antwort (strukturierte Ausgabe) */
  schema: object;
}

export interface CliClassifyResult {
  /** Antworttext (JSON-String) */
  content: string;
  usage?: { promptTokens: number; completionTokens: number };
  model?: string;
}

export interface ClaudeRequest {
  args: string[];
  /** stream-json-Zeile mit der User-Message (Text + Bild), geht über stdin */
  stdin: string;
}

function notFound(configured: string): string {
  return `claude-CLI nicht gefunden: „${configured}“ (gesucht in PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin). ${CLI_PROVIDERS[0].loginHint}`;
}

/** Prompt → CLI-Argumente + stdin. Der System-Prompt liegt in `systemPromptFile` (Windows-Shims vertragen keine Zeilenumbrüche in Argumenten). */
export function buildClaudeRequest(model: string, systemPromptFile: string, prompt: Pick<ClassifyPrompt, 'userText' | 'image' | 'schema'>): ClaudeRequest {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model.trim(),
    '--system-prompt-file', systemPromptFile,
    '--json-schema', JSON.stringify(prompt.schema),
    // Reine Klassifikation: keine Werkzeuge, Hooks, Skills, MCP-Server, keine Session-Datei.
    '--settings', '{"disableAllHooks":true}',
    '--tools', '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
  ];
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: prompt.userText },
        { type: 'image', source: { type: 'base64', media_type: prompt.image.mediaType, data: prompt.image.base64 } },
      ],
    },
  };
  return { args, stdin: JSON.stringify(message) + '\n' };
}

/** stream-json-Ausgabe → Antwort. `structured_output` hat Vorrang, sonst `result`. Wirft bei Fehler-Envelope. */
export function parseClaudeStream(stdout: string): CliClassifyResult {
  let result: Record<string, unknown> | null = null;
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v = JSON.parse(t);
      if (v && v.type === 'result') result = v;
    } catch {
      /* Teilzeile */
    }
  }
  if (!result) throw new Error('kein result-Objekt in der Ausgabe: ' + snippet('', stdout));
  const subtype = String(result.subtype ?? '');
  if (result.is_error === true || subtype.startsWith('error')) {
    const detail = typeof result.result === 'string' && result.result.trim() ? result.result : subtype;
    throw new Error(`${TOOL}: ${snippet('', String(detail))}`);
  }
  const usage = result.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  const modelUsage = result.modelUsage as Record<string, unknown> | undefined;
  const model = modelUsage ? Object.keys(modelUsage)[0] : undefined;
  const meta = {
    usage: usage ? { promptTokens: usage.input_tokens ?? 0, completionTokens: usage.output_tokens ?? 0 } : undefined,
    model,
  };
  if (result.structured_output !== undefined && result.structured_output !== null) {
    return { content: JSON.stringify(result.structured_output), ...meta };
  }
  const text = typeof result.result === 'string' ? result.result.trim() : '';
  if (!text) throw new Error(`${TOOL}: leere Antwort`);
  return { content: text, ...meta };
}

/** `claude auth status` (JSON) → Login-Felder. */
export function parseAuthStatus(stdout: string): { loggedIn: boolean; label?: string; email?: string } | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const loggedIn = v.loggedIn === true;
  const method = String(v.authMethod ?? '');
  const sub = String(v.subscriptionType ?? '');
  let label: string | undefined;
  if (!loggedIn) label = undefined;
  else if (method === 'claude.ai' || sub) label = ('Claude ' + (sub ? sub[0].toUpperCase() + sub.slice(1) : '')).trim();
  else if (method === 'console' || method === 'apiKey') label = 'Anthropic API-Schlüssel';
  else label = `Claude (${method})`;
  const email = typeof v.email === 'string' ? v.email : undefined;
  return { loggedIn, label, email };
}

export async function claudeClassify(
  cfg: { binary: string; model: string; timeoutMs?: number },
  prompt: ClassifyPrompt,
): Promise<CliClassifyResult> {
  const binary = resolveBinary(cfg.binary, CLAUDE_BINARY_CANDIDATES);
  if (!binary) throw new Error(notFound(cfg.binary));
  if (!cfg.model.trim()) throw new Error('Claude: kein Modell konfiguriert');
  const dir = await makeScratchDir('claude');
  try {
    const systemFile = join(dir, 'system.txt');
    await writeFile(systemFile, prompt.system, 'utf8');
    const req = buildClaudeRequest(cfg.model, systemFile, prompt);
    const out = await runWithTimeout(TOOL, binary, req.args, { cwd: dir, stdin: req.stdin, timeoutMs: cfg.timeoutMs ?? CLAUDE_DEFAULT_TIMEOUT_MS });
    if (out.code !== 0) {
      // Auch bei Exit ≠ 0 steht der Grund meist im result-Envelope.
      try {
        return parseClaudeStream(out.stdout);
      } catch (e) {
        throw new Error(`${TOOL} (Exit ${out.code}): ${snippet(out.stderr, e instanceof Error ? e.message : out.stdout)}`);
      }
    }
    return parseClaudeStream(out.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Verbindungsstatus für die Einstellungen: Binary, Version, Login, Modelle. */
export async function probeClaude(configuredBinary: string): Promise<AiProbe> {
  const def = CLI_PROVIDERS.find((p) => p.id === 'claude')!;
  const binary = resolveBinary(configuredBinary, CLAUDE_BINARY_CANDIDATES);
  if (!binary) return { provider: 'claude', target: '', loggedIn: false, models: def.models, message: notFound(configuredBinary) };
  const probe: AiProbe = { provider: 'claude', target: binary, loggedIn: false, models: def.models };
  probe.version = await probeVersion(TOOL, binary);
  try {
    const out = await runWithTimeout(TOOL, binary, ['auth', 'status'], { timeoutMs: AUTH_TIMEOUT_MS });
    const st = parseAuthStatus(out.stdout);
    if (!st) probe.message = 'Login-Status nicht lesbar: ' + snippet(out.stderr, out.stdout);
    else {
      probe.loggedIn = st.loggedIn;
      probe.authLabel = st.label;
      probe.email = st.email;
      if (!st.loggedIn) probe.message = 'Nicht angemeldet. ' + def.loginHint;
    }
  } catch (e) {
    probe.message = e instanceof Error ? e.message : String(e);
  }
  return probe;
}

export { parseDataUrl };
