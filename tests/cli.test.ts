import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childPath, expandTilde, parseDataUrl, quoteForCmd, resolveBinaryIn } from '../src/main/cli-common';
import { buildClaudeRequest, parseAuthStatus, parseClaudeStream } from '../src/main/claude-cli';
import { buildCodexArgs, buildCodexPrompt, lastAgentMessage, parseAppServer, usageFromJsonl } from '../src/main/codex-cli';
import { OUTPUT_SCHEMA } from '../src/main/ai';
import { aiProviderKind, DEFAULT_SETTINGS, resolveAiEndpoint } from '../src/shared/settings';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'notenwart-cli-'));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe('resolveBinaryIn', () => {
  it('PATH vor Kandidaten, Kandidaten nur mit Standardnamen, expliziter Pfad mit ~', async () => {
    const pathDir = join(root, 'path');
    const home = join(root, 'home');
    await mkdir(pathDir, { recursive: true });
    await mkdir(join(home, '.local/bin'), { recursive: true });
    await writeFile(join(home, '.local/bin/claude'), '');
    const cands = ['~/.local/bin/claude'];
    // nicht im PATH ⇒ HOME-Kandidat
    expect(resolveBinaryIn('claude', pathDir, home, cands, 'darwin')).toBe(join(home, '.local/bin/claude'));
    // im PATH ⇒ PATH gewinnt
    await writeFile(join(pathDir, 'claude'), '');
    expect(resolveBinaryIn('claude', pathDir, home, cands, 'darwin')).toBe(join(pathDir, 'claude'));
    // anderer Name: Kandidat gilt nicht
    expect(resolveBinaryIn('claude-x', undefined, home, cands, 'darwin')).toBeNull();
    // expliziter Pfad
    expect(resolveBinaryIn('~/.local/bin/claude', undefined, home, [], 'darwin')).toBe(join(home, '.local/bin/claude'));
    expect(resolveBinaryIn('/nonexistent/claude', undefined, home, [], 'darwin')).toBeNull();
    expect(resolveBinaryIn('  ', pathDir, home, cands, 'darwin')).toBeNull();
  });

  it('Windows: .exe/.cmd werden ergänzt, PATH mit Semikolon', async () => {
    const home = join(root, 'winhome');
    const npm = join(home, 'AppData/Roaming/npm');
    await mkdir(npm, { recursive: true });
    await writeFile(join(npm, 'codex.cmd'), '');
    expect(resolveBinaryIn('codex', undefined, home, ['~/AppData/Roaming/npm/codex.cmd'], 'win32')).toBe(join(npm, 'codex.cmd'));
    expect(resolveBinaryIn('codex', `${join(root, 'nix')};${npm}`, home, [], 'win32')).toBe(join(npm, 'codex.cmd'));
  });
});

describe('cli-common Helfer', () => {
  it('childPath hängt Standardordner ohne Duplikate an', () => {
    const p = childPath('/opt/homebrew/bin:/usr/bin', '/Users/x', 'darwin').split(':');
    expect(p[0]).toBe('/opt/homebrew/bin');
    expect(p.filter((d) => d === '/opt/homebrew/bin')).toHaveLength(1);
    expect(p).toContain('/Users/x/.local/bin');
    expect(p).toContain('/usr/local/bin');
  });
  it('expandTilde', () => {
    expect(expandTilde('~/a', '/h')).toBe('/h/a');
    expect(expandTilde('~', '/h')).toBe('/h');
    expect(expandTilde('/x', '/h')).toBe('/x');
  });
  it('parseDataUrl', () => {
    expect(parseDataUrl('data:image/jpeg;base64,AAAA')).toEqual({ mediaType: 'image/jpeg', base64: 'AAAA', ext: 'jpg' });
    expect(parseDataUrl('data:image/png;base64,BBBB').ext).toBe('png');
    expect(() => parseDataUrl('http://x')).toThrow();
  });
  it('quoteForCmd', () => {
    expect(quoteForCmd('{"a":1}')).toBe('"{\\"a\\":1}"');
    expect(quoteForCmd('')).toBe('""');
  });
});

describe('claude-cli', () => {
  const image = { mediaType: 'image/jpeg', base64: 'QUJD', ext: 'jpg' };
  const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('buildClaudeRequest: stream-json in/out, Schema, keine Werkzeuge, Bild in stdin', () => {
    const req = buildClaudeRequest('claude-haiku-4-5', '/tmp/system.txt', { userText: 'USER', image, schema: OUTPUT_SCHEMA });
    expect(req.args[0]).toBe('-p');
    expect(argAfter(req.args, '--input-format')).toBe('stream-json');
    expect(argAfter(req.args, '--output-format')).toBe('stream-json');
    expect(argAfter(req.args, '--model')).toBe('claude-haiku-4-5');
    expect(argAfter(req.args, '--system-prompt-file')).toBe('/tmp/system.txt');
    expect(JSON.parse(argAfter(req.args, '--json-schema'))).toEqual(OUTPUT_SCHEMA);
    expect(argAfter(req.args, '--tools')).toBe('');
    expect(argAfter(req.args, '--permission-mode')).toBe('dontAsk');
    expect(req.args).toContain('--no-session-persistence');
    const msg = JSON.parse(req.stdin);
    expect(msg.type).toBe('user');
    expect(msg.message.content[0]).toEqual({ type: 'text', text: 'USER' });
    expect(msg.message.content[1].source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'QUJD' });
    expect(req.stdin.endsWith('\n')).toBe(true);
  });

  const RESULT = '{"type":"result","subtype":"success","is_error":false,"result":"{\\"headerText\\":\\"Trompete 2\\"}","structured_output":{"headerText":"Trompete 2","instrument":"Trompete","number":"2","key":"B","isScore":false},"usage":{"input_tokens":2247,"output_tokens":1205},"modelUsage":{"claude-haiku-4-5":{"inputTokens":2247}}}';

  it('parseClaudeStream: structured_output hat Vorrang, Usage und Modell werden gelesen', () => {
    const out = parseClaudeStream('{"type":"system","subtype":"init"}\n{"type":"assistant"}\n' + RESULT + '\n');
    expect(JSON.parse(out.content)).toEqual({ headerText: 'Trompete 2', instrument: 'Trompete', number: '2', key: 'B', isScore: false });
    expect(out.usage).toEqual({ promptTokens: 2247, completionTokens: 1205 });
    expect(out.model).toBe('claude-haiku-4-5');
  });
  it('parseClaudeStream: Fallback auf result, Fehler-Envelope, leer', () => {
    expect(parseClaudeStream('{"type":"result","subtype":"success","result":"  {\\"a\\":1} "}').content).toBe('{"a":1}');
    expect(() => parseClaudeStream('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Not logged in"}')).toThrow(/Not logged in/);
    expect(() => parseClaudeStream('{"type":"result","subtype":"success","result":""}')).toThrow(/leere Antwort/);
    expect(() => parseClaudeStream('kein json')).toThrow(/kein result/);
  });
  it('parseAuthStatus', () => {
    const st = parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"me@example.com","subscriptionType":"max"}')!;
    expect(st).toEqual({ loggedIn: true, label: 'Claude Max', email: 'me@example.com' });
    expect(parseAuthStatus('{"loggedIn":false}')).toEqual({ loggedIn: false, label: undefined, email: undefined });
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"console"}')!.label).toBe('Anthropic API-Schlüssel');
    expect(parseAuthStatus('garbage')).toBeNull();
  });
});

describe('codex-cli', () => {
  it('buildCodexArgs mit und ohne Modell', () => {
    const files = { image: '/t/kopf.jpg', schema: '/t/s.json', out: '/t/o.txt' };
    const a = buildCodexArgs('gpt-5.5', files);
    expect(a[0]).toBe('exec');
    expect(a).toContain('--ephemeral');
    expect(a).toContain('--skip-git-repo-check');
    expect(a[a.indexOf('-m') + 1]).toBe('gpt-5.5');
    expect(a[a.indexOf('-i') + 1]).toBe('/t/kopf.jpg');
    expect(a[a.indexOf('--output-schema') + 1]).toBe('/t/s.json');
    expect(a[a.indexOf('--output-last-message') + 1]).toBe('/t/o.txt');
    expect(a.at(-1)).toBe('-');
    expect(buildCodexArgs('  ', files)).not.toContain('-m');
  });
  it('buildCodexPrompt stellt Instruktionen voran', () => {
    const p = buildCodexPrompt('SYS', 'USER');
    expect(p.startsWith('# Instructions\n\nSYS')).toBe(true);
    expect(p).toContain('# Input\n\nUSER');
  });
  const JSONL = `{"type":"thread.started","thread_id":"x"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"…"}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"headerText\\":\\"hi\\"}"}}
{"type":"turn.completed","usage":{"input_tokens":18329,"output_tokens":43}}`;
  it('lastAgentMessage und usageFromJsonl', () => {
    expect(lastAgentMessage(JSONL)).toBe('{"headerText":"hi"}');
    expect(lastAgentMessage('{"type":"turn.started"}')).toBeUndefined();
    expect(usageFromJsonl(JSONL)).toEqual({ promptTokens: 18329, completionTokens: 43 });
  });
  it('parseAppServer: Account, Plan, Modelle nur mit Bildeingabe und nicht versteckt', () => {
    const account = { account: { type: 'chatgpt', planType: 'prolite', email: 'me@example.com' }, requiresOpenaiAuth: true };
    const models = { data: [
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true, inputModalities: ['text', 'image'] },
      { id: 'gpt-text', displayName: 'Text only', inputModalities: ['text'] },
      { id: 'gpt-hidden', displayName: 'Hidden', hidden: true, inputModalities: ['text', 'image'] },
      { id: 'gpt-5.5', displayName: 'GPT-5.5' },
    ] };
    const st = parseAppServer(account, models);
    expect(st.loggedIn).toBe(true);
    expect(st.label).toBe('ChatGPT Pro Lite');
    expect(st.email).toBe('me@example.com');
    expect(st.models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.5']);
    expect(st.models[0].isDefault).toBe(true);
    const out = parseAppServer({ account: null, requiresOpenaiAuth: true }, undefined);
    expect(out.loggedIn).toBe(false);
    expect(out.models).toEqual([]);
  });
});

describe('Einstellungen: Anbieter-Auswahl', () => {
  it('aiProviderKind und resolveAiEndpoint', () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    expect(aiProviderKind(s)).toBe('http');
    s.ai.preset = 'claude';
    expect(aiProviderKind(s)).toBe('claude');
    expect(resolveAiEndpoint(s)).toEqual({ baseUrl: '', model: 'claude-haiku-4-5', apiKey: '' });
    s.ai.preset = 'codex';
    expect(aiProviderKind(s)).toBe('codex');
    s.ai.preset = 'benutzerdefiniert';
    expect(aiProviderKind(s)).toBe('http');
  });
});
