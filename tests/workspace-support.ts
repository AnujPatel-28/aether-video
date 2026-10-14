import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { ProjectIRSchema } from '@aether/core';
import type { EditOperation, ProjectIR } from '@aether/core';
import { initProject, nodeStoreFs, openProjectStore } from '@aether/workspace';
import type { ProjectStore, StoreFs, StoreResult } from '@aether/workspace';
import { projectFixture, safetyFixture, taskFixture } from './fixtures.js';

export const PROJECT_ID = 'project-fixture';

/** Three adjacent 1 s clips A, B, C on one asset. */
export function threeClipProject(): ProjectIR {
  const value = projectFixture();
  value.sequence.clips = ['A', 'B', 'C'].map((id, i) => ({
    id, assetId: value.assets[0]!.id, sourceRange: { startMs: i * 1000, endMs: (i + 1) * 1000 }, timelineStartMs: i * 1000,
  }));
  return ProjectIRSchema.parse(value);
}
export const task = () => taskFixture();
export const safety = () => safetyFixture();

export async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'aether-m3-'));
}
export async function removeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
export const projectDir = (root: string) => join(root, 'projects', PROJECT_ID);
export const lockPath = (root: string) => join(projectDir(root), 'owner.lock');

export function ok<T>(result: StoreResult<T>): { ok: true } & T {
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.error));
  return result;
}
export function err<T>(result: StoreResult<T>, code: string, kernelCode?: string) {
  assert.ok(!result.ok, `Expected ${code}, got success`);
  assert.equal(result.error.code, code, JSON.stringify(result.error));
  if (kernelCode) assert.equal(result.error.kernel?.code, kernelCode);
  return result.error;
}

/** Initialize a project, open its owner store and fork the given workspaces. */
export async function setup(root: string, workspaces: string[] = ['ws-a'], project: ProjectIR = threeClipProject(), fs?: StoreFs): Promise<ProjectStore> {
  ok(await initProject({ storeRoot: root, ...(fs ? { fs } : {}) }, project, { ...safety(), projectId: project.id }));
  const { store } = ok(await openProjectStore({ storeRoot: root, projectId: project.id, ...(fs ? { fs } : {}) }));
  for (const id of workspaces) ok(await store.forkWorkspace(id, task()));
  return store;
}
export async function reopen(root: string, fs?: StoreFs): Promise<ProjectStore> {
  return ok(await openProjectStore({ storeRoot: root, projectId: PROJECT_ID, ...(fs ? { fs } : {}) })).store;
}

export function batch(workspaceId: string, batchId: string, expectedRevision: number, operations: EditOperation[]) {
  return { schemaVersion: 1 as const, batchId, workspaceId, expectedRevision, operations };
}
export const del = (clipId: string, operationId = 'op-delete'): EditOperation => ({ type: 'delete', clipId, operationId });
export const ripple = (clipId: string, operationId = 'op-ripple'): EditOperation => ({ type: 'ripple_delete', clipId, operationId });
export const moveTo = (clipId: string, destinationTimelineStartMs: number, operationId = 'op-move'): EditOperation =>
  ({ type: 'move', clipId, operationId, destinationTimelineStartMs });

/** Every file under the directory, keyed by relative path. Attempt traces are excluded unless asked for. */
export async function tree(directory: string, includeAttempts = false): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (includeAttempts || entry.name !== 'attempts.jsonl') {
        result[relative(directory, path).split(sep).join('/')] = await readFile(path, 'utf8');
      }
    }
  }
  await walk(directory);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a < b ? -1 : 1));
}

export class SimulatedCrash extends Error {}

/** Counts writes. After arm(k), the k-th following write fails and every later write fails too, like a dead process. */
export function faultFs() {
  let writes = 0;
  let failAt = Number.POSITIVE_INFINITY;
  let dead = false;
  async function gate(): Promise<void> {
    if (dead) throw new SimulatedCrash('dead');
    writes++;
    if (writes === failAt) { dead = true; throw new SimulatedCrash(`write ${writes}`); }
  }
  const fs: StoreFs = {
    readFile: path => nodeStoreFs.readFile(path),
    exists: path => nodeStoreFs.exists(path),
    async writeFileAtomic(path, data) {
      if (dead) throw new SimulatedCrash('dead');
      writes++;
      if (writes === failAt) {
        // Crash after the temp file exists but before the rename.
        await nodeStoreFs.createExclusive(`${path}.tmp-crash-${writes}`, data);
        dead = true;
        throw new SimulatedCrash(`write ${writes}`);
      }
      await nodeStoreFs.writeFileAtomic(path, data);
    },
    async appendLine(path, line) { await gate(); await nodeStoreFs.appendLine(path, line); },
    async mkdir(path) { await gate(); await nodeStoreFs.mkdir(path); },
    async createExclusive(path, data) { await gate(); await nodeStoreFs.createExclusive(path, data); },
    async remove(path) { await gate(); await nodeStoreFs.remove(path); },
  };
  return { fs, writes: () => writes, crashed: () => dead, arm: (k: number) => { failAt = writes + k; } };
}
