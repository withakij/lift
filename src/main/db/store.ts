/**
 * Embedded local storage.
 *
 * Two primitives:
 *   Collection<T> — one JSON file holding an array of small records. Fully in
 *                   memory, atomically rewritten on a debounced flush.
 *   DocStore<T>   — one JSON file per document plus an in-memory index. Used
 *                   for products, which are large and numerous.
 *
 * Both write via write-temp -> fsync -> rename, and keep a `.bak` of the last
 * good file, so an interrupted write can never leave a half-written database.
 * No native modules, no database server, nothing for the operator to install.
 */
import { promises as fs, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import * as path from 'node:path';

export interface Identified {
  id: string;
}

/**
 * A background flush can fail for reasons the caller never sees — a full disk,
 * a revoked permission, a removed folder. Losing that quietly would be the
 * worst possible failure for a data tool, so failures are reported here and the
 * record stays dirty so the next flush retries it.
 */
type StoreErrorHandler = (message: string, error: unknown) => void;

let onStoreError: StoreErrorHandler = (message, error) => {
  if (process.env.LIFT_DEV) console.error('[store]', message, error);
};

export function setStoreErrorHandler(fn: StoreErrorHandler): void {
  onStoreError = fn;
}

function atomicWriteSync(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  if (existsSync(file)) {
    try {
      renameSync(file, `${file}.bak`);
    } catch {
      /* a missing backup is not fatal */
    }
  }
  renameSync(tmp, file);
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.copyFile(file, `${file}.bak`);
  } catch {
    /* first write has no predecessor */
  }
  await fs.rename(tmp, file);
}

function readJsonSync<T>(file: string, fallback: T): T {
  for (const candidate of [file, `${file}.bak`]) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = readFileSync(candidate, 'utf8');
      if (!raw.trim()) continue;
      return JSON.parse(raw) as T;
    } catch {
      /* try the backup next */
    }
  }
  return fallback;
}

/* ------------------------------------------------------------------ */

export class Collection<T extends Identified> {
  private items: T[];
  private byId = new Map<string, T>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string, private readonly flushMs = 250) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.items = readJsonSync<T[]>(file, []);
    if (!Array.isArray(this.items)) this.items = [];
    for (const it of this.items) this.byId.set(it.id, it);
  }

  all(): T[] {
    return this.items;
  }

  find(pred: (t: T) => boolean): T[] {
    return this.items.filter(pred);
  }

  first(pred: (t: T) => boolean): T | undefined {
    return this.items.find(pred);
  }

  get(id: string): T | undefined {
    return this.byId.get(id);
  }

  count(pred?: (t: T) => boolean): number {
    return pred ? this.items.filter(pred).length : this.items.length;
  }

  insert(item: T): T {
    if (this.byId.has(item.id)) throw new Error(`Duplicate id ${item.id}`);
    this.items.push(item);
    this.byId.set(item.id, item);
    this.touch();
    return item;
  }

  insertMany(items: T[]): void {
    for (const it of items) {
      if (this.byId.has(it.id)) continue;
      this.items.push(it);
      this.byId.set(it.id, it);
    }
    this.touch();
  }

  update(id: string, patch: Partial<T>): T {
    const cur = this.byId.get(id);
    if (!cur) throw new Error(`Record ${id} not found in ${path.basename(this.file)}`);
    Object.assign(cur as object, patch);
    this.touch();
    return cur;
  }

  upsert(item: T): T {
    const cur = this.byId.get(item.id);
    if (cur) {
      Object.assign(cur as object, item);
      this.touch();
      return cur;
    }
    return this.insert(item);
  }

  remove(id: string): boolean {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    this.byId.delete(id);
    this.touch();
    return true;
  }

  removeWhere(pred: (t: T) => boolean): number {
    const keep: T[] = [];
    let removed = 0;
    for (const it of this.items) {
      if (pred(it)) {
        this.byId.delete(it.id);
        removed++;
      } else keep.push(it);
    }
    if (removed) {
      this.items = keep;
      this.touch();
    }
    return removed;
  }

  /** Keep only the newest `max` records (used for the rolling log). */
  trimTo(max: number): void {
    if (this.items.length <= max) return;
    const drop = this.items.splice(0, this.items.length - max);
    for (const d of drop) this.byId.delete(d.id);
    this.touch();
  }

  private touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
    // A pending save must never keep the app alive at exit.
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await atomicWrite(this.file, JSON.stringify(this.items));
    } catch (err) {
      this.dirty = true; // keep it dirty so the next flush tries again
      onStoreError(`Could not save ${path.basename(this.file)}`, err);
    }
  }

  /** Cancels any pending save. Used at shutdown and by tests. */
  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = false;
  }

  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      atomicWriteSync(this.file, JSON.stringify(this.items));
    } catch (err) {
      this.dirty = true;
      onStoreError(`Could not save ${path.basename(this.file)}`, err);
    }
  }
}

/* ------------------------------------------------------------------ */

export interface DocIndexEntry {
  id: string;
  [k: string]: unknown;
}

/**
 * Document store: one file per record under `dir/docs/`, plus a compact index
 * file so listing/filtering never has to read every document from disk.
 */
export class DocStore<T extends Identified, I extends DocIndexEntry> {
  private index: I[];
  private indexById = new Map<string, I>();
  private cache = new Map<string, T>();
  private dirtyIndex = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly docsDir: string;
  private readonly indexFile: string;

  constructor(
    private readonly dir: string,
    private readonly summarise: (doc: T) => I,
    private readonly cacheLimit = 200
  ) {
    this.docsDir = path.join(dir, 'docs');
    this.indexFile = path.join(dir, 'index.json');
    mkdirSync(this.docsDir, { recursive: true });
    this.index = readJsonSync<I[]>(this.indexFile, []);
    if (!Array.isArray(this.index)) this.index = [];
    for (const e of this.index) this.indexById.set(e.id, e);
  }

  private docPath(id: string): string {
    return path.join(this.docsDir, `${id}.json`);
  }

  indexAll(): I[] {
    return this.index;
  }

  indexOf(id: string): I | undefined {
    return this.indexById.get(id);
  }

  has(id: string): boolean {
    return this.indexById.has(id);
  }

  count(pred?: (i: I) => boolean): number {
    return pred ? this.index.filter(pred).length : this.index.length;
  }

  get(id: string): T | null {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const file = this.docPath(id);
    if (!existsSync(file)) return null;
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as T;
      this.remember(id, doc);
      return doc;
    } catch {
      return null;
    }
  }

  put(doc: T): void {
    try {
      atomicWriteSync(this.docPath(doc.id), JSON.stringify(doc));
    } catch (err) {
      onStoreError(`Could not save record ${doc.id}`, err);
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.remember(doc.id, doc);
    const summary = this.summarise(doc);
    const existing = this.indexById.get(doc.id);
    if (existing) {
      Object.assign(existing as object, summary);
    } else {
      this.index.push(summary);
      this.indexById.set(doc.id, summary);
    }
    this.touchIndex();
  }

  patchIndex(id: string, patch: Partial<I>): void {
    const e = this.indexById.get(id);
    if (!e) return;
    Object.assign(e as object, patch);
    this.touchIndex();
  }

  remove(id: string): void {
    try {
      const p = this.docPath(id);
      if (existsSync(p)) {
        renameSync(p, `${p}.deleted`);
        void fs.unlink(`${p}.deleted`).catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    this.cache.delete(id);
    if (this.indexById.delete(id)) {
      this.index = this.index.filter((e) => e.id !== id);
      this.touchIndex();
    }
  }

  removeWhere(pred: (i: I) => boolean): number {
    const doomed = this.index.filter(pred).map((e) => e.id);
    for (const id of doomed) this.remove(id);
    return doomed.length;
  }

  /** Load full documents for the given ids (or all, when omitted). */
  loadMany(ids?: string[]): T[] {
    const list = ids ?? this.index.map((e) => e.id);
    const out: T[] = [];
    for (const id of list) {
      const d = this.get(id);
      if (d) out.push(d);
    }
    return out;
  }

  private remember(id: string, doc: T): void {
    this.cache.set(id, doc);
    if (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private touchIndex(): void {
    this.dirtyIndex = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 300);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (!this.dirtyIndex) return;
    this.dirtyIndex = false;
    try {
      await atomicWrite(this.indexFile, JSON.stringify(this.index));
    } catch (err) {
      this.dirtyIndex = true;
      onStoreError('Could not save the product index', err);
    }
  }

  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirtyIndex) return;
    this.dirtyIndex = false;
    try {
      atomicWriteSync(this.indexFile, JSON.stringify(this.index));
    } catch (err) {
      this.dirtyIndex = true;
      onStoreError('Could not save the product index', err);
    }
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirtyIndex = false;
    this.cache.clear();
  }
}

/* ------------------------------------------------------------------ */

export function nowIso(): string {
  return new Date().toISOString();
}

let counter = 0;
export function newId(prefix = ''): string {
  counter = (counter + 1) % 0xffff;
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffffff).toString(36);
  const c = counter.toString(36).padStart(3, '0');
  return `${prefix}${t}${c}${r}`;
}
