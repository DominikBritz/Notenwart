/**
 * KI-Aufruf über die lokal installierte Codex-CLI
 * (`codex exec --ephemeral -i <bild> --output-schema … --output-last-message …`).
 * Der ChatGPT-Login liegt in ~/.codex/auth.json und gehört der CLI.
 *
 * Status und Modell-Liste kommen aus `codex app-server` (JSON-RPC über stdio:
 * `account/read`, `model/list`); stdin muss dabei offen bleiben, sonst beendet
 * sich der Server vor der Antwort.
 */
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiProbe, AiProbeModel } from '@shared/ipc-types';
import { CLI_PROVIDERS } from '@shared/settings';
import { childEnv, makeScratchDir, probeVersion, resolveBinary, runWithTimeout, snippet } from './cli-common';
import type { ClassifyPrompt, CliClassifyResult } from './claude-cli';

const TOOL = 'codex-CLI';
/** Codex lädt seine eigenen Instruktionen (~17k Token), deshalb großzügig. */
export const CODEX_DEFAULT_TIMEOUT_MS = 180_000;
const APP_SERVER_TIMEOUT_MS = 20_000;

/** Suchkandidaten (die ChatGPT-App bündelt die CLI ohne PATH-Eintrag). */
export const CODEX_BINARY_CANDIDATES = [
  '~/.local/bin/codex',
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '~/.npm-global/bin/codex',
  '~/.local/lib/node_modules/@openai/codex/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  '~/AppData/Roaming/npm/codex.cmd',
];

function notFound(configured: string): string {
  return `codex-CLI nicht gefunden: „${configured}“ (gesucht in PATH, ~/.local/bin, /opt/homebrew/bin, ChatGPT.app). ${CLI_PROVIDERS[1].loginHint}`;
}

/** `codex exec` hat keinen System-Prompt-Schalter: System-Text als führender Instruktionsblock. */
export function buildCodexPrompt(system: string, userText: string): string {
  return `# Instructions\n\n${system}\n\n# Input\n\n${userText}\n\nDas Bild des Kopfbereichs ist angehängt.`;
}

/** Argumente für `codex exec` (ohne Binary); `model` leer ⇒ Codex-Standard. Prompt kommt über stdin (`-`). */
export function buildCodexArgs(model: string, files: { image: string; schema: string; out: string }): string[] {
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--color', 'never'];
  if (model.trim()) args.push('-m', model.trim());
  args.push('-i', files.image, '--output-schema', files.schema, '--output-last-message', files.out, '--json', '-');
  return args;
}

/** Fallback ohne Last-Message-Datei: letzte `agent_message` aus dem JSONL-Eventstrom. */
export function lastAgentMessage(jsonl: string): string | undefined {
  let last: string | undefined;
  for (const line of jsonl.split('\n')) {
    try {
      const ev = JSON.parse(line);
      if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') last = ev.item.text;
    } catch {
      /* keine JSON-Zeile */
    }
  }
  return last;
}

/** Token-Verbrauch aus `turn.completed`. */
export function usageFromJsonl(jsonl: string): CliClassifyResult['usage'] {
  for (const line of jsonl.split('\n')) {
    try {
      const ev = JSON.parse(line);
      if (ev?.type === 'turn.completed' && ev.usage) {
        return { promptTokens: ev.usage.input_tokens ?? 0, completionTokens: ev.usage.output_tokens ?? 0 };
      }
    } catch {
      /* keine JSON-Zeile */
    }
  }
  return undefined;
}

export async function codexClassify(
  cfg: { binary: string; model: string; timeoutMs?: number },
  prompt: ClassifyPrompt,
): Promise<CliClassifyResult> {
  const binary = resolveBinary(cfg.binary, CODEX_BINARY_CANDIDATES);
  if (!binary) throw new Error(notFound(cfg.binary));
  const dir = await makeScratchDir('codex');
  try {
    const files = { image: join(dir, `kopf.${prompt.image.ext}`), schema: join(dir, 'schema.json'), out: join(dir, 'last.txt') };
    const cwd = join(dir, 'cwd');
    await Promise.all([
      writeFile(files.image, Buffer.from(prompt.image.base64, 'base64')),
      writeFile(files.schema, JSON.stringify(prompt.schema), 'utf8'),
      import('node:fs/promises').then((fs) => fs.mkdir(cwd)),
    ]);
    const out = await runWithTimeout(TOOL, binary, buildCodexArgs(cfg.model, files), {
      cwd,
      stdin: buildCodexPrompt(prompt.system, prompt.userText),
      timeoutMs: cfg.timeoutMs ?? CODEX_DEFAULT_TIMEOUT_MS,
    });
    if (out.code !== 0) throw new Error(`${TOOL} (Exit ${out.code}): ${snippet(out.stderr, out.stdout)}`);
    const fromFile = await readFile(files.out, 'utf8').then((s) => s.trim()).catch(() => '');
    const content = fromFile || lastAgentMessage(out.stdout);
    if (!content) throw new Error(`${TOOL}: leere Antwort`);
    return { content, usage: usageFromJsonl(out.stdout), model: cfg.model.trim() || 'Codex-Standard' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── app-server-Probe ────────────────────────────────────────────────────────

const PLAN_LABELS: Record<string, string> = {
  prolite: 'Pro Lite', pro: 'Pro', plus: 'Plus', team: 'Team', business: 'Business', enterprise: 'Enterprise', free: 'Free',
};

/** JSON-RPC-Antworten (`account/read`, `model/list`) → Probe-Felder. */
export function parseAppServer(
  account: unknown,
  models: unknown,
): { loggedIn: boolean; label?: string; email?: string; models: AiProbeModel[] } {
  let loggedIn = false;
  let label: string | undefined;
  let email: string | undefined;
  const acc = (account as { account?: Record<string, unknown> } | undefined)?.account;
  if (acc && typeof acc === 'object') {
    loggedIn = true;
    const kind = String(acc.type ?? '');
    if (kind === 'chatgpt') {
      const plan = String(acc.planType ?? '');
      label = plan ? `ChatGPT ${PLAN_LABELS[plan] ?? plan}` : 'ChatGPT';
    } else if (kind === 'apiKey') label = 'OpenAI API-Schlüssel';
    else label = kind || undefined;
    if (typeof acc.email === 'string') email = acc.email;
  }
  const m = models as { data?: unknown[]; models?: unknown[] } | undefined;
  const list = (m?.data ?? m?.models ?? []) as Record<string, unknown>[];
  const out: AiProbeModel[] = [];
  for (const item of list) {
    if (typeof item?.id !== 'string' || item.hidden === true) continue;
    const modalities = Array.isArray(item.inputModalities) ? (item.inputModalities as string[]) : null;
    if (modalities && !modalities.includes('image')) continue; // ohne Bild-Eingabe unbrauchbar
    out.push({ id: item.id, label: typeof item.displayName === 'string' ? item.displayName : item.id, isDefault: item.isDefault === true });
  }
  return { loggedIn, label, email, models: out };
}

/** Startet `codex app-server`, holt Account + Modell-Liste, beendet ihn. */
function queryAppServer(binary: string): Promise<{ account?: unknown; models?: unknown }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server'], { env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const got: { account?: unknown; models?: unknown } = {};
    let buf = '';
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(got);
    };
    const timer = setTimeout(() => {
      if (got.account !== undefined || got.models !== undefined) finish();
      else finish(new Error(`${TOOL} app-server: keine Antwort`));
    }, APP_SERVER_TIMEOUT_MS);
    child.on('error', (e) => finish(new Error(`${TOOL} nicht startbar (${binary}): ${e.message}`)));
    child.on('close', () => finish(got.account === undefined && got.models === undefined ? new Error(`${TOOL} app-server beendet ohne Antwort`) : undefined));
    child.stdout.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) got.account = msg.result ?? msg.error;
          if (msg.id === 3) got.models = msg.result;
        } catch {
          /* keine JSON-Zeile */
        }
        if (got.account !== undefined && got.models !== undefined) finish();
      }
    });
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'notenwart', title: 'Notenwart', version: '0.2.0' } } },
      { jsonrpc: '2.0', method: 'initialized' },
      { jsonrpc: '2.0', id: 2, method: 'account/read', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'model/list', params: {} },
    ];
    child.stdin.on('error', () => { /* Server weg; close liefert den Fehler */ });
    // stdin bewusst offen halten, bis beide Antworten da sind.
    child.stdin.write(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
  });
}

/** Verbindungsstatus für die Einstellungen: Binary, Version, Login, Modelle. */
export async function probeCodex(configuredBinary: string): Promise<AiProbe> {
  const def = CLI_PROVIDERS.find((p) => p.id === 'codex')!;
  const binary = resolveBinary(configuredBinary, CODEX_BINARY_CANDIDATES);
  if (!binary) return { provider: 'codex', target: '', loggedIn: false, models: [], message: notFound(configuredBinary) };
  const probe: AiProbe = { provider: 'codex', target: binary, loggedIn: false, models: [] };
  probe.version = await probeVersion(TOOL, binary);
  try {
    const { account, models } = await queryAppServer(binary);
    const st = parseAppServer(account, models);
    probe.loggedIn = st.loggedIn;
    probe.authLabel = st.label;
    probe.email = st.email;
    probe.models = st.models;
    if (!st.loggedIn) probe.message = 'Nicht angemeldet. ' + def.loginHint;
    return probe;
  } catch {
    // Fallback: Textstatus der CLI, ohne Modell-Liste.
  }
  try {
    const out = await runWithTimeout(TOOL, binary, ['login', 'status'], { timeoutMs: 15_000 });
    const text = out.stdout.trim();
    if (out.code === 0 && text.includes('Logged in')) {
      probe.loggedIn = true;
      probe.authLabel = text.startsWith('Logged in using ') ? text.slice('Logged in using '.length) : 'Codex';
      probe.message = 'Modell-Liste nicht abrufbar (app-server); Modell-ID frei eintragen oder leer lassen.';
    } else {
      probe.message = `Nicht angemeldet. ${def.loginHint} (${snippet(out.stderr, out.stdout)})`;
    }
  } catch (e) {
    probe.message = e instanceof Error ? e.message : String(e);
  }
  return probe;
}
