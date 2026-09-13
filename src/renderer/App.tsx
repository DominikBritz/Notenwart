import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import type { FileInfo } from '@shared/ipc-types';
import Start from './steps/Start';
import Auswahl from './steps/Auswahl';
import Analyse from './steps/Analyse';
import Kontrolle from './steps/Kontrolle';
import KontrolleAufteilen from './steps/KontrolleAufteilen';
import Export from './steps/Export';
import ExportAufteilen from './steps/ExportAufteilen';
import Einstellungen from './Einstellungen';
import { selectForQuery } from './analysis/select';
import type { AnalyzedEntry, Mode, Query, Selection, Step } from './state';
import type { AutorunUiState } from './autorun';
import { parseQuery } from '@shared/matcher';

const STEPS: { id: Step; label: string }[] = [
  { id: 'auswahl', label: '1 Auswahl' },
  { id: 'analyse', label: '2 Analyse' },
  { id: 'kontrolle', label: '3 Kontrolle' },
  { id: 'export', label: '4 Export' },
];

const MODE_LABEL: Record<Mode, string> = { suchen: 'Stimmen heraussuchen', aufteilen: 'Stimmen aufteilen' };

export default function App({ initial, openSettings = false }: { initial?: AutorunUiState; openSettings?: boolean }) {
  const [mode, setMode] = useState<Mode | null>(initial?.mode ?? null);
  const [step, setStep] = useState<Step>(initial ? 'kontrolle' : 'start');
  const [files, setFiles] = useState<FileInfo[]>(initial?.files ?? []);
  const [queries, setQueries] = useState<Query[]>(initial ? initial.queries.map((raw) => ({ raw, part: parseQuery(raw) })) : []);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [cpus, setCpus] = useState(4);
  const [showSettings, setShowSettings] = useState(false);
  const [entries, setEntries] = useState<Map<string, AnalyzedEntry>>(() => new Map((initial?.entries ?? []).map((e) => [e.info.path, e])));
  const [selections, setSelections] = useState<Selection[]>(() => {
    if (!initial || initial.mode !== 'suchen') return [];
    const list = initial.entries;
    return initial.queries.map((raw) => {
      const q = parseQuery(raw);
      const m: Selection = new Map();
      if (q) for (const hit of selectForQuery(list, q, { includeUnnumbered: true })) m.set(hit.file.info.path, new Set(hit.pages));
      return m;
    });
  });
  /** Aufteilen-Modus: einbezogene Seiten je Datei; ohne Eintrag gelten alle Seiten */
  const [splitSelection, setSplitSelection] = useState<Selection>(() => new Map());
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ file: FileInfo; error: string }[]>([]);
  const [reanalyze, setReanalyze] = useState<FileInfo | null>(null);

  useEffect(() => {
    window.api.invoke('settings:get').then((s) => {
      const st = s as Settings;
      setSettings(st);
      setOutputDir(st.lastOutputFolder ?? null);
      if (openSettings) setShowSettings(true); // Screenshot-Modus: erst mit geladenen Einstellungen öffnen
      if (!initial && st.lastQueries?.length) setQueries((q) => (q.length ? q : st.lastQueries.map((raw) => ({ raw, part: parseQuery(raw) }))));
    });
    window.api.invoke('system:cpus').then((n) => setCpus(Number(n)));
  }, []);

  // Screenshot-Modus (Tests): Auswahl aus den mitgelieferten Ergebnissen ableiten, Bild aufnehmen, beenden
  useEffect(() => {
    if (!initial) return;
    const t = setTimeout(async () => {
      await window.api.invoke('autorun:screenshot', initial.screenshot);
      await window.api.invoke('autorun:done', null, null);
    }, 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const workers = settings.workers > 0 ? settings.workers : Math.max(1, Math.min(8, cpus - 1));
  const validQueries = useMemo(() => queries.filter((q) => q.part), [queries]);

  function buildSelections(map: Map<string, AnalyzedEntry>): Selection[] {
    const list = [...map.values()];
    return validQueries.map((q) => {
      const m: Selection = new Map();
      for (const hit of selectForQuery(list, q.part!, { includeUnnumbered: settings.includeUnnumbered })) {
        m.set(hit.file.info.path, new Set(hit.pages));
      }
      return m;
    });
  }

  function onAnalysisDone(map: Map<string, AnalyzedEntry>, errs: { file: FileInfo; error: string }[]) {
    setEntries(map);
    setErrors(errs);
    setSelections(buildSelections(map));
    setSplitSelection(new Map());
    setStep('kontrolle');
  }

  function updateEntry(e: AnalyzedEntry) {
    const m = new Map(entries);
    m.set(e.info.path, e);
    setEntries(m);
  }

  async function patchSettings(patch: Partial<Settings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    await window.api.invoke('settings:set', next);
  }

  async function saveSettings(s: Settings) {
    const saved = (await window.api.invoke('settings:set', s)) as Settings;
    setSettings(saved);
    setShowSettings(false);
  }

  function startReanalyze(info: FileInfo) {
    const m = new Map(entries);
    m.delete(info.path);
    setEntries(m);
    setReanalyze(info);
    setStep('analyse');
  }

  function chooseMode(m: Mode) {
    setMode(m);
    setStep('auswahl');
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const hasResults = entries.size > 0;
  const busy = step === 'analyse';
  const canGo: Record<Step, boolean> = {
    start: !busy,
    auswahl: !busy && !!mode,
    analyse: !busy && files.length > 0 && (mode === 'aufteilen' || validQueries.length > 0),
    kontrolle: !busy && hasResults,
    export: !busy && hasResults && (mode === 'aufteilen' || selections.length > 0),
  };
  function goTo(target: Step) {
    if (!canGo[target] || target === step) return;
    if (target === 'analyse') {
      // erneut analysieren: bereits analysierte Dateien kommen aus dem Cache
      setReanalyze(null);
      setEntries(new Map());
    }
    if (target === 'kontrolle' && mode === 'suchen' && selections.length !== validQueries.length) {
      // Stimmen wurden nach der Analyse geändert: Auswahl neu ableiten
      setSelections(buildSelections(entries));
    }
    setStep(target);
  }

  const order = files.map((f) => f.path);

  return (
    <div className={"app" + (initial ? " blur-notes" : "")}>
      <div className="topbar">
        <span
          className={'brand' + (canGo.start && step !== 'start' ? ' clickable' : '')}
          role="button"
          tabIndex={0}
          title="Zur Startseite"
          onClick={() => goTo('start')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') goTo('start'); }}
        >
          Notenwart
        </span>
        {mode && step !== 'start' && (
          <>
            <span className="muted" style={{ fontSize: 13 }}>{MODE_LABEL[mode]}</span>
            <div className="steps">
              {STEPS.map((s, i) => (
                <span
                  key={s.id}
                  role="button"
                  tabIndex={canGo[s.id] ? 0 : -1}
                  className={(s.id === step ? 'active' : i < stepIndex ? 'done' : '') + (canGo[s.id] && s.id !== step ? ' clickable' : '')}
                  title={s.id === 'analyse' && hasResults ? 'Analyse erneut starten' : undefined}
                  onClick={() => goTo(s.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') goTo(s.id); }}
                >
                  {s.label}
                </span>
              ))}
            </div>
          </>
        )}
        <span className="spacer" />
        <button className="btn small" onClick={() => setShowSettings(true)}>Einstellungen</button>
      </div>
      <div className="content">
        {step === 'start' && <Start onChoose={chooseMode} />}
        {step === 'auswahl' && mode && (
          <Auswahl
            mode={mode}
            files={files}
            setFiles={setFiles}
            queries={queries}
            setQueries={setQueries}
            recentInputs={settings.recentInputs ?? []}
            onRecentChange={(recent) => patchSettings({ recentInputs: recent })}
            onStart={() => {
              if (mode === 'suchen') patchSettings({ lastQueries: queries.map((q) => q.raw) });
              setEntries(new Map());
              setReanalyze(null);
              setStep('analyse');
            }}
          />
        )}
        {step === 'analyse' && (
          <Analyse
            key={reanalyze ? 'force-' + reanalyze.path : 'all'}
            files={reanalyze ? [reanalyze] : files}
            settings={settings}
            workers={workers}
            existing={reanalyze ? entries : new Map()}
            onDone={(map, errs) => {
              if (reanalyze) {
                // Ergebnis der Einzeldatei mit dem Bestand zusammenführen, Reihenfolge der Dateiliste beibehalten
                const merged = new Map<string, AnalyzedEntry>();
                for (const f of files) {
                  const e = map.get(f.path) ?? entries.get(f.path);
                  if (e) merged.set(f.path, e);
                }
                setReanalyze(null);
                onAnalysisDone(merged, errs);
              } else {
                onAnalysisDone(map, errs);
              }
            }}
            onCancel={() => { setReanalyze(null); setStep(entries.size ? 'kontrolle' : 'auswahl'); }}
          />
        )}
        {step === 'kontrolle' && (
          <>
            {errors.length > 0 && (
              <div className="panel" style={{ borderColor: 'var(--bad)' }}>
                <b>{errors.length} Datei{errors.length === 1 ? '' : 'en'} konnte{errors.length === 1 ? '' : 'n'} nicht gelesen werden:</b>
                <div className="log">{errors.map((e) => `${e.file.name}: ${e.error}`).join('\n')}</div>
              </div>
            )}
            {mode === 'aufteilen' ? (
              <KontrolleAufteilen
                entries={entries}
                order={order}
                splitSelection={splitSelection}
                setSplitSelection={setSplitSelection}
                updateEntry={updateEntry}
                onBack={() => setStep('auswahl')}
                onNext={() => setStep('export')}
                onReanalyze={startReanalyze}
                onReanalyzeAll={() => goTo('analyse')}
              />
            ) : (
              <Kontrolle
                entries={entries}
                queries={queries}
                selections={selections}
                setSelections={setSelections}
                includeUnnumbered={settings.includeUnnumbered}
                updateEntry={updateEntry}
                onBack={() => setStep('auswahl')}
                onNext={() => setStep('export')}
                onReanalyze={startReanalyze}
                onReanalyzeAll={() => goTo('analyse')}
                autoPreview={!!initial}
              />
            )}
          </>
        )}
        {step === 'export' && mode === 'aufteilen' && (
          <ExportAufteilen
            entries={entries}
            order={order}
            splitSelection={splitSelection}
            outputDir={outputDir}
            setOutputDir={setOutputDir}
            onBack={() => setStep('kontrolle')}
            onRestart={() => { setStep('auswahl'); setEntries(new Map()); setSplitSelection(new Map()); }}
          />
        )}
        {step === 'export' && mode === 'suchen' && (
          <Export
            entries={entries}
            queries={queries}
            selections={selections}
            order={order}
            outputDir={outputDir}
            setOutputDir={setOutputDir}
            onBack={() => setStep('kontrolle')}
            onRestart={() => { setStep('auswahl'); setEntries(new Map()); setSelections([]); }}
          />
        )}
      </div>
      {showSettings && <Einstellungen settings={settings} cpus={cpus} onSave={saveSettings} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
