/**
 * Preload bridge.
 *
 * The renderer has no Node access and no direct ipcRenderer handle. Only the
 * named methods below cross the boundary, each mapped to one allow-listed
 * channel, so a compromised page cannot reach the filesystem or the network
 * layer.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CH } from '../shared/ipc';

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(channel, ...args);

const EVENT_CHANNELS: Record<string, string> = {
  progress: CH.evtProgress,
  log: CH.evtLog,
  dataChanged: CH.evtDataChanged
};

const api = {
  projects: {
    list: () => invoke(CH.projectList),
    get: (id: string) => invoke(CH.projectGet, id),
    create: (input: unknown) => invoke(CH.projectCreate, input),
    update: (id: string, patch: unknown) => invoke(CH.projectUpdate, id, patch),
    remove: (id: string) => invoke(CH.projectDelete, id)
  },
  categories: {
    list: (projectId: string) => invoke(CH.categoryList, projectId),
    create: (input: unknown) => invoke(CH.categoryCreate, input),
    update: (id: string, patch: unknown) => invoke(CH.categoryUpdate, id, patch),
    remove: (id: string, opts?: unknown) => invoke(CH.categoryDelete, id, opts)
  },
  urls: {
    list: (projectId: string, categoryId?: string | null) => invoke(CH.urlList, projectId, categoryId),
    add: (input: unknown) => invoke(CH.urlAdd, input),
    addBulk: (input: unknown) => invoke(CH.urlAddBulk, input),
    update: (id: string, patch: unknown) => invoke(CH.urlUpdate, id, patch),
    remove: (id: string) => invoke(CH.urlDelete, id),
    removeMany: (ids: string[]) => invoke(CH.urlDeleteMany, ids),
    move: (ids: string[], categoryId: string | null) => invoke(CH.urlMove, ids, categoryId),
    importFile: (projectId: string, categoryId: string | null) => invoke(CH.urlImportFile, projectId, categoryId),
    resetState: (ids: string[]) => invoke(CH.urlResetState, ids)
  },
  scrape: {
    start: (input: unknown) => invoke(CH.scrapeStart, input),
    pause: () => invoke(CH.scrapePause),
    resume: () => invoke(CH.scrapeResume),
    cancel: () => invoke(CH.scrapeCancel),
    retryFailed: (projectId: string) => invoke(CH.scrapeRetryFailed, projectId),
    rescrape: (productIds: string[]) => invoke(CH.scrapeRescrape, productIds),
    active: () => invoke(CH.scrapeActive),
    jobs: (projectId: string) => invoke(CH.scrapeJobs, projectId),
    testUrl: (url: string) => invoke(CH.scrapeTestUrl, url)
  },
  products: {
    list: (q: unknown) => invoke(CH.productList, q),
    get: (id: string) => invoke(CH.productGet, id),
    remove: (ids: string[]) => invoke(CH.productDelete, ids),
    trace: (id: string) => invoke(CH.productTrace, id),
    patch: (id: string, patch: unknown) => invoke(CH.productPatch, id, patch)
  },
  validation: {
    run: (projectId: string) => invoke(CH.validationRun, projectId),
    list: (projectId: string, opts?: unknown) => invoke(CH.validationList, projectId, opts),
    acknowledge: (ids: string[], value: boolean) => invoke(CH.validationAck, ids, value),
    clear: (projectId: string) => invoke(CH.validationClear, projectId)
  },
  exports: {
    run: (opts: unknown) => invoke(CH.exportRun, opts),
    preview: (opts: unknown, limit?: number) => invoke(CH.exportPreview, opts, limit),
    history: (projectId: string) => invoke(CH.exportHistory, projectId),
    profiles: () => invoke(CH.exportProfiles),
    reveal: (filePath: string) => invoke(CH.exportReveal, filePath)
  },
  settings: {
    get: () => invoke(CH.settingsGet),
    set: (patch: unknown) => invoke(CH.settingsSet, patch)
  },
  dashboard: { stats: (projectId: string | null) => invoke(CH.dashboardStats, projectId) },
  logs: { list: (opts?: unknown) => invoke(CH.logsList, opts) },
  system: {
    chooseDirectory: () => invoke(CH.chooseDirectory),
    info: () => invoke(CH.appInfo),
    openExternal: (url: string) => invoke(CH.openExternal, url)
  },
  on(channel: string, cb: (payload: unknown) => void): () => void {
    const real = EVENT_CHANNELS[channel];
    if (!real) throw new Error(`Unknown event channel: ${channel}`);
    const listener = (_e: unknown, payload: unknown): void => cb(payload);
    ipcRenderer.on(real, listener);
    return () => ipcRenderer.removeListener(real, listener);
  }
};

contextBridge.exposeInMainWorld('toto', api);
