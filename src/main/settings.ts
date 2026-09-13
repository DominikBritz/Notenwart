import { app } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

let cached: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (cached) return cached;
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<Settings>;
    cached = {
      ...DEFAULT_SETTINGS,
      ...raw,
      recentInputs: Array.isArray(raw.recentInputs) ? raw.recentInputs : [],
      lastQueries: Array.isArray(raw.lastQueries) ? raw.lastQueries : [],
      ai: {
        ...DEFAULT_SETTINGS.ai,
        ...(raw.ai ?? {}),
        presetModels: { ...DEFAULT_SETTINGS.ai.presetModels, ...(raw.ai?.presetModels ?? {}) },
        custom: { ...DEFAULT_SETTINGS.ai.custom, ...(raw.ai?.custom ?? {}) },
        claude: { ...DEFAULT_SETTINGS.ai.claude, ...(raw.ai?.claude ?? {}) },
        codex: { ...DEFAULT_SETTINGS.ai.codex, ...(raw.ai?.codex ?? {}) },
      },
    };
  } catch {
    cached = structuredClone(DEFAULT_SETTINGS);
  }
  return cached;
}

export async function setSettings(next: Settings): Promise<Settings> {
  cached = next;
  await writeFile(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}
