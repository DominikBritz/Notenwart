/**
 * Gemeinsame Helfer der CLI-Anbindungen (claude-cli, codex-cli):
 * Binary-Auflösung ohne Login-Shell, Kindprozess mit Timeout, Data-URL → Bild.
 *
 * Aus dem Finder/Dock gestartete Electron-Apps sehen nur einen minimalen PATH,
 * deshalb Kandidatenlisten statt blindem `which`. HOME bleibt unangetastet,
 * dort liegt der Login der CLIs (Keychain bzw. ~/.codex/auth.json).
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

export interface ProcessOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ImageData {
  mediaType: string;
  base64: string;
  /** Dateiendung ohne Punkt (jpg, png, …) */
  ext: string;
}

const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const EXTRA_HOME_PATH_DIRS = ['.local/bin', '.bun/bin', '.npm-global/bin', 'AppData/Roaming/npm'];
const WIN_EXTS = ['.exe', '.cmd', '.bat'];

export function expandTilde(value: string, home: string = homedir()): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return value;
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Name/Pfad → existierendes Binary. Enthält der Wert einen Pfadtrenner, zählt
 * nur dieser Pfad (mit `~`-Expansion). Sonst: PATH-Einträge, dann die
 * anbieterspezifischen Kandidaten (`~/…` relativ zu `home`). Auf Windows
 * werden .exe/.cmd/.bat ergänzt.
 */
export function resolveBinaryIn(
  configured: string,
  pathVar: string | undefined,
  home: string,
  candidates: string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  const name = configured.trim();
  if (!name) return null;
  const win = platform === 'win32';
  const exts = win && !WIN_EXTS.some((e) => name.toLowerCase().endsWith(e)) ? ['', ...WIN_EXTS] : [''];
  if (name.includes('/') || (win && name.includes('\\'))) {
    const p = expandTilde(name, home);
    for (const ext of exts) if (isFile(p + ext)) return p + ext;
    return null;
  }
  const sepChar = win ? ';' : delimiter;
  for (const dir of (pathVar ?? '').split(sepChar).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (isFile(p)) return p;
    }
  }
  for (const cand of candidates) {
    const p = expandTilde(cand, home);
    // Kandidaten sind auf den Standardnamen zugeschnitten; ein anderer Name wird nur im PATH gesucht.
    const base = basename(p).toLowerCase();
    if (!exts.some((e) => base === (name + e).toLowerCase())) continue;
    if (isFile(p)) return p;
  }
  return null;
}

export function resolveBinary(configured: string, candidates: string[]): string | null {
  return resolveBinaryIn(configured, process.env.PATH, homedir(), candidates);
}

/** PATH für den Kindprozess: bestehender PATH plus Standardordner, dedupliziert. */
export function childPath(current: string | undefined, home: string, platform: NodeJS.Platform = process.platform): string {
  const sepChar = platform === 'win32' ? ';' : delimiter;
  const out: string[] = [];
  const push = (d: string) => {
    if (d && !out.includes(d)) out.push(d);
  };
  for (const d of (current ?? '').split(sepChar)) push(d);
  if (platform !== 'win32') for (const d of EXTRA_PATH_DIRS) push(d);
  for (const rel of EXTRA_HOME_PATH_DIRS) push(join(home, rel));
  return out.join(sepChar);
}

/** Umgebung des Kindprozesses: erweiterter PATH, ohne CLAUDECODE (sonst verweigert die Claude-CLI den verschachtelten Start). */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: childPath(process.env.PATH, homedir()) };
  delete env.CLAUDECODE;
  return env;
}

/** Snippet für Fehlermeldungen: stderr, sonst stdout, 400 Zeichen. */
export function snippet(stderr: string, stdout: string): string {
  const src = stderr.trim() ? stderr : stdout;
  return src.trim().slice(0, 400);
}

function needsShell(binary: string): boolean {
  const b = binary.toLowerCase();
  return process.platform === 'win32' && (b.endsWith('.cmd') || b.endsWith('.bat'));
}

/** Argument für cmd.exe in Anführungszeichen setzen (nur für .cmd/.bat-Shims auf Windows). */
export function quoteForCmd(arg: string): string {
  return '"' + arg.replace(/"/g, '\\"') + '"';
}

/**
 * Startet `binary args…`, schreibt `stdin` (dann EOF), sammelt stdout/stderr
 * und wartet mit Timeout. Wirft bei Startfehler oder Timeout.
 */
export function runWithTimeout(
  tool: string,
  binary: string,
  args: string[],
  opts: { cwd?: string; stdin?: string; timeoutMs: number },
): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const shell = needsShell(binary);
    const child = spawn(shell ? quoteForCmd(binary) : binary, shell ? args.map(quoteForCmd) : args, {
      cwd: opts.cwd,
      env: childEnv(),
      shell,
      windowsHide: true,
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      reject(new Error(`${tool}: keine Antwort innerhalb von ${Math.round(opts.timeoutMs / 1000)} s`));
    }, opts.timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`${tool} nicht startbar (${binary}): ${e.message}`));
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* Prozess hat stdin geschlossen; Ergebnis kommt über close */ });
      child.stdin.end(opts.stdin);
    }
  });
}

/** `<binary> --version` → erste stdout-Zeile. */
export async function probeVersion(tool: string, binary: string): Promise<string | undefined> {
  try {
    const out = await runWithTimeout(tool, binary, ['--version'], { timeoutMs: 10_000 });
    const line = out.stdout.split('\n')[0]?.trim();
    return line || undefined;
  } catch {
    return undefined;
  }
}

/** `data:image/jpeg;base64,…` → Bilddaten. */
export function parseDataUrl(dataUrl: string): ImageData {
  const m = dataUrl.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!m) throw new Error('Bild ist keine Base64-Data-URL');
  const mediaType = m[1];
  const ext = mediaType === 'image/jpeg' ? 'jpg' : mediaType.replace(/^image\//, '') || 'bin';
  return { mediaType, base64: m[2], ext };
}

export function makeScratchDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `notenwart-${prefix}-`));
}
