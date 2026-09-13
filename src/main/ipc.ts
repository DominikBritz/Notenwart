import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import { readPdf, scanPaths } from './files';
import { cacheStats, clearCache, getCached, setCached } from './cache';
import { getSettings, setSettings } from './settings';
import { findExisting, runExport } from './exporter';
import { aiClassify, aiProbe, fetchOpenRouterPricing } from './ai';
import type { AiClassifyRequest, ExportRequest, FileInfo } from '@shared/ipc-types';
import type { CliProvider, Settings } from '@shared/settings';
import type { FileAnalysis } from '@shared/types';

export function registerIpc(): void {
  ipcMain.handle('ping', () => 'pong');

  ipcMain.handle('dialog:openFiles', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const s = await getSettings();
    const r = await dialog.showOpenDialog(win, {
      title: 'PDFs auswählen',
      defaultPath: s.lastInputFolder,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:openFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const s = await getSettings();
    const r = await dialog.showOpenDialog(win, {
      title: 'Ordner mit Noten auswählen',
      defaultPath: s.lastInputFolder,
      properties: ['openDirectory', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return [];
    await setSettings({ ...s, lastInputFolder: r.filePaths[0] });
    return r.filePaths;
  });

  ipcMain.handle('dialog:outputFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const s = await getSettings();
    const r = await dialog.showOpenDialog(win, {
      title: 'Zielordner wählen',
      defaultPath: s.lastOutputFolder ?? s.lastInputFolder,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    await setSettings({ ...s, lastOutputFolder: r.filePaths[0] });
    return r.filePaths[0];
  });

  ipcMain.handle('files:scan', (_e, paths: string[]) => scanPaths(paths));
  ipcMain.handle('files:read', async (_e, path: string) => {
    const buf = await readPdf(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.handle('cache:get', (_e, info: FileInfo) => getCached(info));
  ipcMain.handle('cache:set', (_e, info: FileInfo, analysis: FileAnalysis) => setCached(info, analysis));
  ipcMain.handle('cache:clear', () => clearCache());
  ipcMain.handle('cache:stats', () => cacheStats());

  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, s: Settings) => setSettings(s));

  ipcMain.handle('export:run', async (e, req: ExportRequest) => {
    const sender = e.sender;
    return runExport(
      req.outputDir,
      req.jobs,
      (p) => {
        if (!sender.isDestroyed()) sender.send('export:progress', p);
      },
      { overwrite: !!req.overwrite },
    );
  });
  ipcMain.handle('export:existing', (_e, req: ExportRequest) => findExisting(req.outputDir, req.jobs));

  ipcMain.handle('ai:classify', async (_e, req: AiClassifyRequest) => aiClassify(req, await getSettings()));
  ipcMain.handle('ai:pricing', (_e, models: string[]) => fetchOpenRouterPricing(models));
  ipcMain.handle('ai:probe', (_e, provider: CliProvider, binary: string) => aiProbe(provider, binary));

  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p));
  ipcMain.handle('shell:showInFolder', (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.handle('system:cpus', () => require('node:os').cpus().length);

  // Autorun für Tests: SE_AUTORUN=<Ordner oder Datei[;Datei…]> SE_OUT=<json> [SE_QUERY="Trompete 1"] [SE_MODE=aufteilen] [SE_FORCE=1] [SE_LIMIT=n] [SE_EXPORT=<Ordner>]
  // Nur Screenshot: SE_SCREENSHOT=<png> [SE_SETTINGS=1 öffnet den Einstellungen-Dialog]
  ipcMain.handle('autorun:config', () => {
    if (!process.env.SE_AUTORUN) {
      return process.env.SE_SCREENSHOT
        ? { paths: [], out: null, query: null, force: false, limit: 0, screenshot: process.env.SE_SCREENSHOT, exportDir: null, mode: 'suchen', openSettings: process.env.SE_SETTINGS === '1' }
        : null;
    }
    return {
      paths: process.env.SE_AUTORUN.split(';').filter(Boolean),
      out: process.env.SE_OUT ?? null,
      query: process.env.SE_QUERY ?? null,
      force: process.env.SE_FORCE === '1',
      limit: process.env.SE_LIMIT ? Number(process.env.SE_LIMIT) : 0,
      screenshot: process.env.SE_SCREENSHOT ?? null,
      exportDir: process.env.SE_EXPORT ?? null,
      mode: process.env.SE_MODE === 'aufteilen' ? 'aufteilen' : 'suchen',
    };
  });
  ipcMain.handle('autorun:screenshot', async (e, path: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const img = await win.webContents.capturePage();
    await writeFile(path, img.toPNG());
  });
  ipcMain.handle('autorun:done', async (_e, out: string | null, data: unknown) => {
    if (out) await writeFile(out, JSON.stringify(data, null, 2));
    if (process.env.SE_QUIT !== '0') app.quit();
  });
  ipcMain.on('log', (_e, msg: string) => console.log('[renderer]', msg));
  // Debug: Kopfbereichs-Bilder ablegen (SE_DUMP=<Ordner>)
  ipcMain.handle('autorun:dump', async (_e, name: string, dataUrl: string) => {
    const dir = process.env.SE_DUMP;
    if (!dir) return;
    const b64 = dataUrl.split(',')[1];
    await writeFile(require('node:path').join(dir, name), Buffer.from(b64, 'base64'));
  });
  ipcMain.handle('autorun:dumpEnabled', () => !!process.env.SE_DUMP);
}
