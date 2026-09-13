import type { FileAnalysis } from './types';

export interface FileInfo {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  /** Ordner für die Anzeige: relativ zur gewählten Wurzel, bei Einzeldateien der Elternordner */
  folder: string;
  /** Relativer Ordner zur gewählten Wurzel ('' in der Wurzel); fehlt bei einzeln gewählten Dateien */
  subdir?: string;
}

export interface ExportPiece {
  path: string;
  title: string;
  /** 1-basierte Seitennummern */
  pages: number[];
}

export interface ExportJob {
  /** Dateiname ohne Endung */
  fileName: string;
  /** Unterordner im Zielordner, Segmente mit "/" getrennt (Aufteilen-Modus) */
  subdir?: string;
  pieces: ExportPiece[];
}

export interface ExportRequest {
  outputDir: string;
  jobs: ExportJob[];
  /** Vorhandene Zieldateien ersetzen statt "(2)" anzuhängen */
  overwrite?: boolean;
}

export interface ExportResult {
  fileName: string;
  subdir?: string;
  outputPath: string;
  pieceCount: number;
  pageCount: number;
}

export interface ExportProgress {
  jobIndex: number;
  pieceIndex: number;
  /** Abgeschlossene Stücke über alle Aufträge */
  done: number;
  totalPieces: number;
  message: string;
}

export interface ExportExistingResult {
  count: number;
  paths: string[];
}

export interface AiClassifyRequest {
  /** JPEG/PNG data URL des Kopfbereichs */
  imageDataUrl: string;
  /** Text der lokalen OCR als Hilfe */
  ocrText?: string;
}

export interface AiClassifyResponse {
  ok: boolean;
  error?: string;
  /** Rohtext der Überschrift, wie das Modell sie liest */
  headerText?: string;
  instrument?: string;
  number?: string;
  key?: string;
  isScore?: boolean;
  usage?: { promptTokens: number; completionTokens: number };
  model?: string;
}

export interface AiProbeModel {
  id: string;
  label: string;
  isDefault: boolean;
}

/** Verbindungsstatus einer lokalen CLI – nie Token oder Schlüssel, nur Anzeige-Metadaten. */
export interface AiProbe {
  provider: 'claude' | 'codex';
  /** Aufgelöster Binary-Pfad (leer, wenn nicht gefunden) */
  target: string;
  version?: string;
  /** Login gültig – Aufrufe sind möglich */
  loggedIn: boolean;
  /** z.B. „Claude Max“, „ChatGPT Pro“ */
  authLabel?: string;
  email?: string;
  models: AiProbeModel[];
  /** Fehler oder Hinweis (nicht angemeldet, Binary fehlt …) */
  message?: string;
}

export interface CacheEntry {
  info: FileInfo;
  analysis: FileAnalysis;
}
