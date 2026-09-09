/**
 * Offline type stub for Electron.
 *
 * The real `electron` package supplies these types during a normal build. This
 * file exists only so `npm run typecheck:offline` can verify the main-process
 * sources on a machine that cannot reach the npm registry. It is never part of
 * the shipped build (see tsconfig.check.json) and must stay a strict subset of
 * the real API surface the app uses.
 */
declare module 'electron' {
  import { EventEmitter } from 'node:events';

  namespace Electron {
    interface WebPreferences {
      partition?: string;
      preload?: string;
      nodeIntegration?: boolean;
      contextIsolation?: boolean;
      sandbox?: boolean;
      javascript?: boolean;
      images?: boolean;
      webgl?: boolean;
      offscreen?: boolean;
      backgroundThrottling?: boolean;
      devTools?: boolean;
      spellcheck?: boolean;
    }

    interface WebContents extends EventEmitter {
      loadURL(url: string, options?: { userAgent?: string }): Promise<void>;
      executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
      getURL(): string;
      openDevTools(options?: { mode?: string }): void;
      send(channel: string, ...args: unknown[]): void;
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
      session: Session;
      on(event: string, listener: (...args: any[]) => void): this;
      once(event: string, listener: (...args: any[]) => void): this;
      removeListener(event: string, listener: (...args: any[]) => void): this;
    }

    interface Session {
      setUserAgent(ua: string): void;
      setPermissionRequestHandler(handler: (wc: WebContents, permission: string, cb: (granted: boolean) => void) => void): void;
      clearStorageData(options?: unknown): Promise<void>;
      webRequest: {
        onBeforeRequest(filter: unknown, listener: (details: { url: string }, cb: (r: { cancel: boolean }) => void) => void): void;
      };
    }

    interface IpcMainInvokeEvent {
      sender: WebContents;
      senderFrame: unknown;
    }
  }

  class BrowserWindow extends EventEmitter {
    constructor(options?: {
      show?: boolean;
      width?: number;
      height?: number;
      minWidth?: number;
      minHeight?: number;
      title?: string;
      backgroundColor?: string;
      titleBarStyle?: string;
      trafficLightPosition?: { x: number; y: number };
      autoHideMenuBar?: boolean;
      webPreferences?: Electron.WebPreferences;
    });
    webContents: Electron.WebContents;
    isDestroyed(): boolean;
    destroy(): void;
    close(): void;
    show(): void;
    maximize(): void;
    loadURL(url: string): Promise<void>;
    loadFile(path: string): Promise<void>;
    static getAllWindows(): BrowserWindow[];
    static fromWebContents(wc: Electron.WebContents): BrowserWindow | null;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
  }

  const app: EventEmitter & {
    whenReady(): Promise<void>;
    quit(): void;
    getPath(name: string): string;
    getVersion(): string;
    getName(): string;
    setName(name: string): void;
    isPackaged: boolean;
    requestSingleInstanceLock(): boolean;
    on(event: string, listener: (...args: any[]) => void): typeof app;
  };

  const ipcMain: {
    handle(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void;
    removeHandler(channel: string): void;
  };

  const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<any>;
    on(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
    removeListener(channel: string, listener: (...args: any[]) => void): void;
  };

  const contextBridge: {
    exposeInMainWorld(key: string, api: unknown): void;
  };

  const shell: {
    openExternal(url: string): Promise<void>;
    showItemInFolder(path: string): void;
  };

  const dialog: {
    showOpenDialog(options: unknown): Promise<{ canceled: boolean; filePaths: string[] }>;
    showOpenDialog(window: BrowserWindow | undefined, options: unknown): Promise<{ canceled: boolean; filePaths: string[] }>;
    showSaveDialog(options: unknown): Promise<{ canceled: boolean; filePath?: string }>;
    showSaveDialog(window: BrowserWindow | undefined, options: unknown): Promise<{ canceled: boolean; filePath?: string }>;
    showMessageBox(options: unknown): Promise<{ response: number }>;
  };

  const session: {
    fromPartition(partition: string, options?: { cache?: boolean }): Electron.Session;
    defaultSession: Electron.Session;
  };

  const nativeTheme: { shouldUseDarkColors: boolean };

  export { app, BrowserWindow, ipcMain, ipcRenderer, contextBridge, shell, dialog, session, nativeTheme, Electron };
}
