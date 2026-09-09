import { app, BrowserWindow, shell } from 'electron';
import * as path from 'node:path';
import { initDb, db } from './db';
import { setStoreErrorHandler } from './db/store';
import { registerIpc } from './ipc';
import { ScrapeQueue } from './queue';
import { createEngine } from './scraper/engine';
import { disposeRenderer } from './scraper/renderer';
import { log } from './util/logger';

const isDev = process.env.TOTO_DEV === '1';
let mainWindow: BrowserWindow | null = null;
let queue: ScrapeQueue | null = null;

app.setName('ToTo Company');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const dataDir = path.join(app.getPath('userData'), 'data');
  const database = initDb(dataDir);

  // Route the logger into the rolling on-disk log.
  log.setSink((entry) => {
    database.logs.insert(entry);
    if (database.logs.count() > 4000) database.logs.trimTo(3000);
  });
  setStoreErrorHandler((message, err) => log.error('storage', `${message}. Your work is still in memory and will be retried.`, err));
  log.setLevel(database.getSettings().advancedMode ? 'debug' : 'info');
  log.info('app', `ToTo Company ${app.getVersion()} starting`, { dataDir });

  const { engine, fetcher } = createEngine(database.getSettings());
  queue = new ScrapeQueue({ db: database, engine });
  queue.recover();

  registerIpc({
    queue,
    engine,
    fetcher,
    mainWindow: () => mainWindow,
    dataDir
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    title: 'ToTo Company',
    backgroundColor: '#0b0d12',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 22 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      devTools: isDev,
      spellcheck: false
    }
  });

  // Never let the UI navigate itself somewhere else, and open real links in the
  // operator's own browser instead of inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event: { preventDefault(): void }, url: string) => {
    const isLocal = url.startsWith('file://') || url.startsWith('http://localhost:5273');
    if (!isLocal) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  if (isDev) {
    void mainWindow.loadURL('http://localhost:5273');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function shutdown(): void {
  try {
    queue?.pause();
    db().flushAllSync();
    db().close();
  } catch {
    /* nothing useful to do at exit */
  }
  disposeRenderer();
}

app.on('before-quit', shutdown);

app.on('window-all-closed', () => {
  shutdown();
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  log.error('app', 'Unexpected error', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('app', 'Unhandled promise rejection', reason);
});
