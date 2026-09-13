import type { UserAlias } from './types';

export type AiMode = 'aus' | 'unsicher' | 'immer';
/** Modell-Auswahl: zwei OpenRouter-Voreinstellungen, die lokalen CLIs mit eigener Subscription, oder frei. */
export type AiPreset = 'schnell' | 'gruendlich' | 'claude' | 'codex' | 'benutzerdefiniert';
/** Wie der Aufruf technisch läuft: HTTP (OpenAI-kompatibel) oder ein lokaler CLI-Prozess. */
export type AiProviderKind = 'http' | 'claude' | 'codex';
export type CliProvider = 'claude' | 'codex';

export interface AiPresetDef {
  id: AiPreset;
  label: string;
  model: string;
  /** Preis in USD pro Million Tokens (Eingabe, Ausgabe) – Fallback, wenn OpenRouter nicht erreichbar */
  pricePerMTokens: [number, number];
  description: string;
}

export const AI_PRESETS: AiPresetDef[] = [
  {
    id: 'schnell',
    label: 'Schnell',
    model: 'google/gemini-2.5-flash-lite',
    pricePerMTokens: [0.1, 0.4],
    description: 'Günstiges Vision-Modell über OpenRouter. Reicht für gedruckte Überschriften.',
  },
  {
    id: 'gruendlich',
    label: 'Gründlich',
    model: 'openai/gpt-5',
    pricePerMTokens: [1.25, 10],
    description: 'OpenAI-Modell über OpenRouter. Besser bei Handschrift und schlechten Kopien, etwa 15-mal teurer.',
  },
];

export interface CliProviderDef {
  id: CliProvider;
  label: string;
  description: string;
  /** Standard-Binary-Name (wird in PATH und bekannten Ordnern gesucht) */
  binary: string;
  /** Kuratierte Modelle, falls die CLI keine Liste liefert; leer = Liste kommt aus dem Probe */
  models: { id: string; label: string; isDefault: boolean }[];
  loginHint: string;
}

export const CLI_PROVIDERS: CliProviderDef[] = [
  {
    id: 'claude',
    label: 'Claude Code (Subscription)',
    description: 'Nutzt die lokal installierte Claude-Code-CLI mit deinem Claude-Login. Kein Schlüssel in der App, zählt gegen die Limits deines Plans.',
    binary: 'claude',
    models: [
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', isDefault: true },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', isDefault: false },
      { id: 'claude-opus-5', label: 'Claude Opus 5', isDefault: false },
    ],
    loginHint: 'Claude Code installieren und im Terminal `claude auth login` ausführen.',
  },
  {
    id: 'codex',
    label: 'Codex (ChatGPT)',
    description: 'Nutzt die lokal installierte Codex-CLI mit deinem ChatGPT-Login. Kein Schlüssel in der App, zählt gegen die Limits deines Plans.',
    binary: 'codex',
    models: [],
    loginHint: 'Codex installieren (oder die ChatGPT-App, die die CLI mitbringt) und im Terminal `codex login` ausführen.',
  },
];

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Grobe Token-Annahme pro Seite (Kopfbereich als Bild + Prompt, JSON-Antwort). */
export const TOKENS_PER_PAGE = { input: 700, output: 60 };

export function estimateCostPer1000Pages(pricePerMTokens: [number, number]): number {
  const [pin, pout] = pricePerMTokens;
  return 1000 * ((TOKENS_PER_PAGE.input * pin + TOKENS_PER_PAGE.output * pout) / 1_000_000);
}

export interface CliSettings {
  /** Name (PATH und bekannte Ordner) oder absoluter Pfad; `~` wird expandiert */
  binary: string;
  /** Modell-ID; bei Codex leer = Standard der CLI */
  model: string;
}

export interface Settings {
  aliases: UserAlias[];
  includeUnnumbered: boolean;
  workers: number;
  lastInputFolder?: string;
  lastOutputFolder?: string;
  /** Zuletzt geöffnete Ordner/Dateien, neueste zuerst */
  recentInputs: string[];
  /** Zuletzt gesuchte Stimmen */
  lastQueries: string[];
  ai: {
    mode: AiMode;
    preset: AiPreset;
    openrouterKey: string;
    /** Überschreibbare Modell-IDs der Voreinstellungen */
    presetModels: Record<'schnell' | 'gruendlich', string>;
    custom: { baseUrl: string; model: string; apiKey: string };
    claude: CliSettings;
    codex: CliSettings;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  aliases: [],
  includeUnnumbered: true,
  workers: 0, // 0 = automatisch
  recentInputs: [],
  lastQueries: [],
  ai: {
    mode: 'aus',
    preset: 'schnell',
    openrouterKey: '',
    presetModels: { schnell: AI_PRESETS[0].model, gruendlich: AI_PRESETS[1].model },
    custom: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5vl', apiKey: '' },
    claude: { binary: 'claude', model: 'claude-haiku-4-5' },
    codex: { binary: 'codex', model: '' },
  },
};

export function aiProviderKind(s: Settings): AiProviderKind {
  if (s.ai.preset === 'claude' || s.ai.preset === 'codex') return s.ai.preset;
  return 'http';
}

export function resolveAiEndpoint(s: Settings): { baseUrl: string; model: string; apiKey: string } {
  if (s.ai.preset === 'benutzerdefiniert') return { ...s.ai.custom };
  if (s.ai.preset === 'claude' || s.ai.preset === 'codex') return { baseUrl: '', model: s.ai[s.ai.preset].model, apiKey: '' };
  return { baseUrl: OPENROUTER_BASE_URL, model: s.ai.presetModels[s.ai.preset], apiKey: s.ai.openrouterKey };
}
