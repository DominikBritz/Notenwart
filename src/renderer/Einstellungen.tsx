import { useEffect, useState } from 'react';
import { AI_PRESETS, CLI_PROVIDERS, estimateCostPer1000Pages, type AiPreset, type CliProvider, type Settings } from '@shared/settings';
import type { AiClassifyResponse, AiProbe } from '@shared/ipc-types';

interface Props {
  settings: Settings;
  onSave: (s: Settings) => void;
  onClose: () => void;
  cpus: number;
}

type OpenRouterPreset = 'schnell' | 'gruendlich';
const isOpenRouter = (p: AiPreset): p is OpenRouterPreset => p === 'schnell' || p === 'gruendlich';
const isCli = (p: AiPreset): p is CliProvider => p === 'claude' || p === 'codex';

function makeTestImage(): string {
  const c = document.createElement('canvas');
  c.width = 900; c.height = 220;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#111';
  ctx.font = '28px Georgia'; ctx.fillText('Trompete 2 in B', 30, 50);
  ctx.font = 'italic 36px Georgia'; ctx.fillText('Böhmischer Traum', 330, 70);
  ctx.font = '18px Georgia'; ctx.fillText('Musik: Norbert Gälle', 620, 110);
  return c.toDataURL('image/jpeg', 0.8);
}

export default function Einstellungen({ settings, onSave, onClose, cpus }: Props) {
  const [s, setS] = useState<Settings>(structuredClone(settings));
  const [pricing, setPricing] = useState<Record<string, [number, number]>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [cache, setCache] = useState<{ count: number; path: string } | null>(null);
  const [aliasPattern, setAliasPattern] = useState('');
  const [aliasTarget, setAliasTarget] = useState('');
  const [probes, setProbes] = useState<Partial<Record<CliProvider, AiProbe>>>({});
  const [probing, setProbing] = useState<CliProvider | null>(null);

  useEffect(() => {
    window.api.invoke('ai:pricing', Object.values(s.ai.presetModels)).then((p) => setPricing(p as Record<string, [number, number]>));
    window.api.invoke('cache:stats').then((c) => setCache(c as { count: number; path: string }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Status der gewählten CLI beim ersten Anzeigen prüfen (Binary-Pfad aus dem ungespeicherten Entwurf).
  useEffect(() => {
    if (isCli(s.ai.preset) && !probes[s.ai.preset] && probing !== s.ai.preset) void probe(s.ai.preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.ai.preset]);

  async function probe(provider: CliProvider) {
    setProbing(provider);
    try {
      const r = (await window.api.invoke('ai:probe', provider, s.ai[provider].binary)) as AiProbe;
      setProbes((p) => ({ ...p, [provider]: r }));
    } catch (e) {
      setProbes((p) => ({ ...p, [provider]: { provider, target: '', loggedIn: false, models: [], message: e instanceof Error ? e.message : String(e) } }));
    } finally {
      setProbing(null);
    }
  }

  function costText(preset: OpenRouterPreset): string {
    const def = AI_PRESETS.find((p) => p.id === preset);
    if (!def) return 'abhängig vom Anbieter';
    const model = s.ai.presetModels[preset];
    const price = pricing[model] ?? def.pricePerMTokens;
    const usd = estimateCostPer1000Pages(price);
    return `ca. ${usd.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD pro 1000 Seiten${pricing[model] ? '' : ' (Listenpreis, offline)'}`;
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    await onSaveSilently();
    const r = (await window.api.invoke('ai:classify', { imageDataUrl: makeTestImage(), ocrText: '' })) as AiClassifyResponse;
    setTesting(false);
    if (!r.ok) setTestResult('Fehler: ' + r.error);
    else setTestResult(`OK (${r.model}): "${r.headerText}" → ${r.instrument} ${r.number} ${r.key ? 'in ' + r.key : ''}${r.usage ? ` · ${r.usage.promptTokens}+${r.usage.completionTokens} Tokens` : ''}`);
  }

  async function onSaveSilently() {
    await window.api.invoke('settings:set', s);
  }

  const setAi = (patch: Partial<Settings['ai']>) => setS({ ...s, ai: { ...s.ai, ...patch } });
  const setCli = (provider: CliProvider, patch: Partial<Settings['ai'][CliProvider]>) => setAi({ [provider]: { ...s.ai[provider], ...patch } });

  function cliStatus(provider: CliProvider) {
    const p = probes[provider];
    if (probing === provider && !p) return <span className="badge neutral">prüfe…</span>;
    if (!p) return <span className="badge neutral">unbekannt</span>;
    if (p.loggedIn) {
      const parts = ['verbunden', p.authLabel, p.email, p.version].filter(Boolean);
      return <><span className="badge ok">verbunden</span> <span className="hint">{parts.slice(1).join(' · ')}</span></>;
    }
    return <><span className="badge bad">{p.target ? 'nicht angemeldet' : 'nicht gefunden'}</span> {p.version && <span className="hint">{p.version}</span>}</>;
  }

  function cliFields(provider: CliProvider) {
    const def = CLI_PROVIDERS.find((p) => p.id === provider)!;
    const p = probes[provider];
    const models = p?.models.length ? p.models : def.models;
    const cfg = s.ai[provider];
    return (
      <>
        <div className="field">
          <span>Status</span>
          <div>
            <div className="row">
              {cliStatus(provider)}
              <button className="btn small" onClick={() => probe(provider)} disabled={probing !== null}>Status prüfen</button>
            </div>
            {p?.message && <div className="hint" style={{ marginTop: 4 }}>{p.message}</div>}
            {p?.target && <div className="hint" style={{ marginTop: 4 }} title={p.target}>Gefunden: {p.target}</div>}
          </div>
        </div>
        <div className="field">
          <span>Modell-ID</span>
          <div>
            <input
              type="text"
              list={`models-${provider}`}
              value={cfg.model}
              onChange={(e) => setCli(provider, { model: e.target.value })}
              placeholder={provider === 'codex' ? 'leer = Standard der Codex-CLI' : 'claude-haiku-4-5, claude-sonnet-5 … oder haiku / sonnet / opus'}
              style={{ width: '100%' }}
            />
            <datalist id={`models-${provider}`}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.isDefault ? ' (Standard)' : ''}</option>)}
            </datalist>
            <div className="hint">
              {provider === 'claude'
                ? 'Haiku reicht für gedruckte Überschriften, Sonnet ist bei Handschrift besser und verbraucht mehr vom Plan-Limit.'
                : 'Liste aus der ChatGPT-Anmeldung, nur Modelle mit Bildeingabe. Leer lassen für den Standard.'}
            </div>
          </div>
        </div>
        <div className="field">
          <span>Programm</span>
          <div>
            <input type="text" value={cfg.binary} onChange={(e) => setCli(provider, { binary: e.target.value })} placeholder={def.binary} style={{ width: '100%' }} />
            <div className="hint">
              {provider === 'claude'
                ? 'Name oder Pfad, z.B. ~/.local/bin/claude. Anmeldung im Terminal mit `claude auth login`.'
                : 'Name oder Pfad. Die ChatGPT-App bringt die CLI unter /Applications/ChatGPT.app/Contents/Resources/codex mit. Anmeldung mit `codex login`.'}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Einstellungen</h2>

        <h3>Erkennung</h3>
        <div className="field">
          <span>Stimmen ohne Nummer</span>
          <label><input type="checkbox" checked={s.includeUnnumbered} onChange={(e) => setS({ ...s, includeUnnumbered: e.target.checked })} /> bei Suche nach „Trompete 1“ auch „Trompete“ ohne Nummer einbeziehen</label>
        </div>
        <div className="field">
          <span>Parallele OCR-Prozesse</span>
          <div className="row">
            <input type="number" min={0} max={16} value={s.workers} onChange={(e) => setS({ ...s, workers: Number(e.target.value) })} style={{ width: 80 }} />
            <span className="hint">0 = automatisch ({Math.max(1, cpus - 1)} auf diesem Rechner)</span>
          </div>
        </div>

        <h3>Eigene Bezeichnungen (Aliase)</h3>
        <p className="hint">Wenn auf den Noten z.B. „1. Stimme (B)“ steht und das deine Trompete 1 ist, trage das hier ein. Der Alias hat Vorrang vor der eingebauten Erkennung.</p>
        <table className="files">
          <tbody>
            {s.aliases.map((a, i) => (
              <tr key={i}>
                <td>{a.pattern}</td><td>→ {a.target}</td>
                <td><button className="btn small" onClick={() => setS({ ...s, aliases: s.aliases.filter((_, j) => j !== i) })}>✕</button></td>
              </tr>
            ))}
            <tr>
              <td><input type="text" placeholder="steht auf dem Blatt, z.B. 1. Stimme (B)" value={aliasPattern} onChange={(e) => setAliasPattern(e.target.value)} style={{ width: '100%' }} /></td>
              <td><input type="text" placeholder="bedeutet, z.B. Trompete 1" value={aliasTarget} onChange={(e) => setAliasTarget(e.target.value)} style={{ width: '100%' }} /></td>
              <td><button className="btn small" disabled={!aliasPattern.trim() || !aliasTarget.trim()} onClick={() => { setS({ ...s, aliases: [...s.aliases, { pattern: aliasPattern.trim(), target: aliasTarget.trim() }] }); setAliasPattern(''); setAliasTarget(''); }}>+</button></td>
            </tr>
          </tbody>
        </table>

        <h3>KI-Erkennung (optional)</h3>
        <p className="hint">Schon analysierte Dateien müssen nicht neu erkannt werden: Beim nächsten Lauf werden nur die Seiten, die der gewählte Modus betrifft, an die KI nachgereicht.</p>
        <p className="hint">Die lokale Texterkennung liest gedruckte Überschriften gut. Bei Handschrift oder schlechten Kopien kann zusätzlich ein Vision-Modell den Kopfbereich lesen. Dafür wird das Bild des Seitenkopfs an den gewählten Anbieter geschickt.</p>
        <div className="field">
          <span>Modus</span>
          <select value={s.ai.mode} onChange={(e) => setAi({ mode: e.target.value as Settings['ai']['mode'] })}>
            <option value="aus">Aus – nur lokale Erkennung</option>
            <option value="unsicher">Nur bei unsicheren oder nicht erkannten Seiten</option>
            <option value="immer">Immer – jede Seite zusätzlich per KI prüfen</option>
          </select>
        </div>
        <div className="field">
          <span>Modell</span>
          <div>
            <select value={s.ai.preset} onChange={(e) => setAi({ preset: e.target.value as AiPreset })}>
              {AI_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label} – {s.ai.presetModels[p.id as OpenRouterPreset]}</option>)}
              {CLI_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              <option value="benutzerdefiniert">Benutzerdefiniert (OpenAI, Ollama, andere)</option>
            </select>
            <div style={{ marginTop: 6 }}>
              {isOpenRouter(s.ai.preset) ? (
                <>
                  <span className="cost">{costText(s.ai.preset)}</span>
                  <div className="hint" style={{ marginTop: 4 }}>{AI_PRESETS.find((p) => p.id === s.ai.preset)?.description}</div>
                </>
              ) : isCli(s.ai.preset) ? (
                <>
                  <span className="cost">Keine Kosten pro Seite, verbraucht das Nutzungslimit deines Abos.</span>
                  <div className="hint" style={{ marginTop: 4 }}>{CLI_PROVIDERS.find((p) => p.id === s.ai.preset)?.description}</div>
                </>
              ) : (
                <span className="cost">Kosten abhängig vom Anbieter. Ollama läuft lokal und kostenlos.</span>
              )}
            </div>
          </div>
        </div>
        {isOpenRouter(s.ai.preset) ? (
          <>
            <div className="field">
              <span>OpenRouter-Schlüssel</span>
              <div>
                <input type="password" value={s.ai.openrouterKey} onChange={(e) => setAi({ openrouterKey: e.target.value })} style={{ width: '100%' }} placeholder="sk-or-…" />
                <div className="hint">Schlüssel unter openrouter.ai/keys anlegen. Ein Schlüssel reicht für beide Voreinstellungen.</div>
              </div>
            </div>
            <div className="field">
              <span>Modell-ID {AI_PRESETS.find((p) => p.id === s.ai.preset)?.label}</span>
              <input type="text" value={s.ai.presetModels[s.ai.preset]} onChange={(e) => setAi({ presetModels: { ...s.ai.presetModels, [s.ai.preset]: e.target.value } })} />
            </div>
          </>
        ) : isCli(s.ai.preset) ? (
          cliFields(s.ai.preset)
        ) : (
          <>
            <div className="field"><span>Basis-URL</span><input type="text" value={s.ai.custom.baseUrl} onChange={(e) => setAi({ custom: { ...s.ai.custom, baseUrl: e.target.value } })} placeholder="https://api.openai.com/v1 oder http://localhost:11434/v1" /></div>
            <div className="field"><span>Modell</span><input type="text" value={s.ai.custom.model} onChange={(e) => setAi({ custom: { ...s.ai.custom, model: e.target.value } })} placeholder="gpt-5-mini, qwen2.5vl, llava…" /></div>
            <div className="field"><span>API-Schlüssel</span><input type="password" value={s.ai.custom.apiKey} onChange={(e) => setAi({ custom: { ...s.ai.custom, apiKey: e.target.value } })} placeholder="bei Ollama leer lassen" /></div>
          </>
        )}
        <div className="row">
          <button className="btn" onClick={test} disabled={testing}>{testing ? 'Teste…' : 'Verbindung testen'}</button>
          {testResult && <span className="hint">{testResult}</span>}
        </div>

        <h3>Cache</h3>
        <div className="row">
          <span className="muted">{cache ? `${cache.count} analysierte Dateien` : '…'}</span>
          <button className="btn small" onClick={async () => { await window.api.invoke('cache:clear'); setCache({ count: 0, path: cache?.path ?? '' }); }}>Cache leeren</button>
          {cache && <span className="hint" title={cache.path}>Speicherort: {cache.path}</span>}
        </div>

        <div className="footer-actions" style={{ marginTop: 16 }}>
          <button className="btn" onClick={onClose}>Abbrechen</button>
          <button className="btn primary" onClick={() => onSave(s)}>Speichern</button>
        </div>
      </div>
    </div>
  );
}
