import { appendFile, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Every filesystem effect of the store goes through this interface, so tests can inject faults (D7). */
export interface StoreFs {
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  writeFileAtomic(path: string, data: string): Promise<void>;
  appendLine(path: string, line: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Fails with code EEXIST if the file already exists. */
  createExclusive(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Atomically move a finished file (for example a rendered output) into place. */
  rename(from: string, to: string): Promise<void>;
  /** Copy external bytes to a temp file, then rename into place. */
  copyFileAtomic(source: string, path: string): Promise<void>;
}

const RENAME_TRIES = 5;
const RENAME_BACKOFF_MS = 25;
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
let temporaryCounter = 0;

/** Rename with a bounded retry for transient Windows errors (D8). */
async function renameWithRetry(temporary: string, path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT.has(code) || attempt >= RENAME_TRIES) {
        await rm(temporary, { force: true });
        throw error;
      }
      await delay(RENAME_BACKOFF_MS);
    }
  }
}

const temporaryFor = (path: string) => `${path}.tmp-${process.pid}-${temporaryCounter++}`;

/** Write a temp file, then rename over the target. */
async function writeFileAtomic(path: string, data: string): Promise<void> {
  const temporary = temporaryFor(path);
  await writeFile(temporary, data, { encoding: 'utf8', flag: 'wx' });
  await renameWithRetry(temporary, path);
}

async function copyFileAtomic(source: string, path: string): Promise<void> {
  const temporary = temporaryFor(path);
  await copyFile(source, temporary);
  await renameWithRetry(temporary, path);
}

export const nodeStoreFs: StoreFs = {
  readFile: path => readFile(path, 'utf8'),
  exists: async path => {
    try { await stat(path); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
  writeFileAtomic,
  appendLine: (path, line) => appendFile(path, line + '\n', 'utf8'),
  mkdir: async path => { await mkdir(path, { recursive: true }); },
  createExclusive: (path, data) => writeFile(path, data, { encoding: 'utf8', flag: 'wx' }),
  remove: path => rm(path, { force: true }),
  rename: renameWithRetry,
  copyFileAtomic,
};
