import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  alignTimeMs, applyBatch, canonicalSerialize, checkProjectState, EditBatchSchema, executeEditBatch, hashProjectIR,
  KernelSafetyContextSchema, kernelFailure, ProjectIRSchema, serializeProjectIR, timelineContentFingerprint,
} from '@aether/core';
import type { KernelError, KernelSafetyContext, ProjectIR, Range } from '@aether/core';
import {
  buildInitialProject, compileRecipe, fileDigest, importTranscript, IngestionRecordSchema, MediaFailure, measureOutput,
  mediaFail, preflight, probeSource, RenderManifestSchema, RenderRequestSchema, renderToFile, resolveBinaries,
  sequenceDurationMs, timingChecks,
} from '@aether/media';
import type { Binaries, BinaryVersions, IngestionRecord, RenderManifest } from '@aether/media';
import { TaskInstructionsSchema } from '@aether/tools';
import type { TaskInstructions } from '@aether/tools';
import type { z } from 'zod';
import { nodeStoreFs } from './fs.js';
import type { StoreFs } from './fs.js';
import {
  AcceptedHeadSchema, BatchReceiptSchema, NOTES_MAX_BYTES, LedgerEventSchema, NotesSchema, OrchestrationArtifactNameSchema, StoreSegmentSchema, ToolEventSchema, WorkspaceHeadSchema,
} from './schemas.js';
import type {
  AcceptedHead, AttemptKind, AttemptRecord, BatchReceipt, Notes, SnapshotRef, StoreResult, ToolEvent, WorkspaceError, LedgerEvent, LedgerEventInput, OrchestrationArtifactName,
  WorkspaceErrorCode, WorkspaceHead,
} from './schemas.js';

/** Trusted media configuration. Binaries default to AETHER_FFMPEG/AETHER_FFPROBE or PATH (E2). */
export interface MediaOptions { binaries?: Binaries; timeoutMs?: number }
export interface StoreOptions { storeRoot: string; fs?: StoreFs; media?: MediaOptions }
export interface PreviewResult { manifest: RenderManifest; mediaPath: string; reused: boolean }
export interface ReplayReport {
  ok: boolean;
  checkedReceipts: number;
  firstMismatch?: { index: number; receiptId?: string; reason: 'before_hash' | 'kernel' | 'after_hash' | 'head_hash' };
}
export interface ProjectStore {
  readonly projectId: string;
  readAcceptedHead(): Promise<StoreResult<{ acceptedHead: AcceptedHead; project: ProjectIR }>>;
  forkWorkspace(workspaceId: string, task: unknown): Promise<StoreResult<{ workspace: WorkspaceHead }>>;
  readWorkspace(workspaceId: string): Promise<StoreResult<{ workspace: WorkspaceHead; project: ProjectIR }>>;
  readReceipt(workspaceId: string, receiptId: string): Promise<StoreResult<{ receipt: BatchReceipt }>>;
  /** The visible task bound at fork. */
  readTask(workspaceId: string): Promise<StoreResult<{ task: TaskInstructions }>>;
  /** The genuine safety context (locks and limits) shared by every workspace. */
  readSafety(): Promise<StoreResult<{ safety: KernelSafetyContext }>>;
  /** Trusted tool host only: append one tool event to the workspace trace. Never read for state. */
  appendToolEvent(workspaceId: string, event: Omit<ToolEvent, 'sequence'>): Promise<StoreResult<{ sequence: number }>>;
  /** Trusted diagnostics only: the workspace's tool trace in order. */
  readToolTrace(workspaceId: string): Promise<StoreResult<{ events: ToolEvent[] }>>;
  /** Trusted host only: append one usage-ledger event (model, tool, runtime or submission). */
  appendLedgerEvent(workspaceId: string, event: LedgerEventInput): Promise<StoreResult<{ sequence: number }>>;
  readLedger(workspaceId: string): Promise<StoreResult<{ events: LedgerEvent[] }>>;
  /** Trusted orchestration only: store a validated contract/plan while the workspace is open. Never a shared tool. */
  writeOrchestrationArtifact(workspaceId: string, name: OrchestrationArtifactName, value: unknown): Promise<StoreResult<object>>;
  readOrchestrationArtifact(workspaceId: string, name: OrchestrationArtifactName): Promise<StoreResult<{ value: unknown | undefined }>>;
  applyEditBatch(batch: unknown): Promise<StoreResult<{ outcome: 'applied' | 'no_change'; replayed: boolean; receipt: BatchReceipt; head: SnapshotRef }>>;
  undo(workspaceId: string, expectedRevision: number): Promise<StoreResult<{ head: SnapshotRef; receiptId: string }>>;
  redo(workspaceId: string, expectedRevision: number): Promise<StoreResult<{ head: SnapshotRef; receiptId: string }>>;
  replay(workspaceId: string): Promise<StoreResult<{ report: ReplayReport }>>;
  readNotes(workspaceId: string): Promise<StoreResult<{ notes: Notes }>>;
  writeNotes(workspaceId: string, expectedNotesRevision: number, text: unknown): Promise<StoreResult<{ notes: Notes }>>;
  discard(workspaceId: string): Promise<StoreResult<{ workspace: WorkspaceHead }>>;
  freezeSubmission(workspaceId: string): Promise<StoreResult<{ workspace: WorkspaceHead }>>;
  promote(workspaceId: string, expectedAcceptedRevision: number): Promise<StoreResult<{ acceptedHead: AcceptedHead }>>;
  /** Render a workspace head (or a range of it) with a fixed preset into an immutable artifact. Read-only for state. */
  renderPreview(workspaceId: string, request: unknown): Promise<StoreResult<PreviewResult>>;
  close(): Promise<void>;
}

class StoreFailure extends Error {
  constructor(readonly detail: WorkspaceError) { super(detail.message); }
}
function fail(code: WorkspaceErrorCode, message: string, evidence: WorkspaceError['evidence'] = {}, kernel?: KernelError): never {
  throw new StoreFailure({ code, message, evidence, ...(kernel ? { kernel } : {}) });
}
const RECEIPT_ID = /^receipt-[a-f0-9]{64}$/;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const serialize = (value: unknown) => canonicalSerialize(value) + '\n';

function segment(value: unknown, field: 'projectId' | 'workspaceId'): string {
  const parsed = StoreSegmentSchema.safeParse(value);
  if (!parsed.success) fail('invalid_segment', `Invalid ${field}`);
  return parsed.data;
}

const files = {
  lock: 'owner.lock',
  safety: 'safety.json',
  accepted: 'accepted-head.json',
  snapshots: 'snapshots',
  snapshot: (hash: string) => `snapshots/${hash}.json`,
  workspaces: 'workspaces',
  workspace: (id: string) => `workspaces/${id}`,
  receipts: (id: string) => `workspaces/${id}/receipts`,
  task: (id: string) => `workspaces/${id}/task.json`,
  head: (id: string) => `workspaces/${id}/head.json`,
  receipt: (id: string, receiptId: string) => `workspaces/${id}/receipts/${receiptId}.json`,
  notes: (id: string) => `workspaces/${id}/notes.json`,
  attempts: (id: string) => `workspaces/${id}/attempts.jsonl`,
  toolTrace: (id: string) => `workspaces/${id}/tool-trace.jsonl`,
  ledger: (id: string) => `workspaces/${id}/ledger.jsonl`,
  orchestration: (id: string, name: string) => `workspaces/${id}/orchestration/${name}.json`,
  assets: 'assets',
  asset: (hash: string) => `assets/${hash}`,
  transcript: 'transcript.json',
  ingestion: 'ingestion.json',
  artifact: (id: string) => `artifacts/${id}`,
  manifest: (id: string) => `artifacts/${id}/manifest.json`,
};

/** Low-level reads and writes relative to one project directory. Every read fails closed (D5). */
function projectIo(fs: StoreFs, directory: string) {
  const path = (file: string) => join(directory, file);
  async function readJson<S extends z.ZodType>(file: string, schema: S): Promise<z.infer<S>> {
    let text: string;
    try { text = await fs.readFile(path(file)); } catch { fail('store_corrupt', 'Missing or unreadable store file', { file }); }
    let value: unknown;
    try { value = JSON.parse(text); } catch { fail('store_corrupt', 'Invalid JSON in store file', { file }); }
    const parsed = schema.safeParse(value);
    if (!parsed.success) fail('store_corrupt', 'Store file failed validation', { file });
    return parsed.data;
  }
  async function loadSnapshot(hash: string): Promise<ProjectIR> {
    const project = await readJson(files.snapshot(hash), ProjectIRSchema);
    if (hashProjectIR(project) !== hash) fail('store_corrupt', 'Snapshot content does not match its hash', { file: files.snapshot(hash) });
    return project;
  }
  async function writeSnapshot(project: ProjectIR): Promise<string> {
    const hash = hashProjectIR(project);
    if (!(await fs.exists(path(files.snapshot(hash))))) await fs.writeFileAtomic(path(files.snapshot(hash)), serializeProjectIR(project) + '\n');
    return hash;
  }
  return {
    path, readJson, loadSnapshot, writeSnapshot,
    exists: (file: string) => fs.exists(path(file)),
    write: (file: string, value: unknown) => fs.writeFileAtomic(path(file), serialize(value)),
  };
}

async function guarded<T>(body: () => Promise<T>): Promise<StoreResult<T>> {
  try {
    return { ok: true, ...(await body()) };
  } catch (error) {
    if (error instanceof StoreFailure) return { ok: false, error: error.detail };
    if (error instanceof MediaFailure) return { ok: false, error: { code: 'media', message: error.detail.message, evidence: {}, media: error.detail } };
    return { ok: false, error: { code: 'io_failed', message: 'Store I/O failed', evidence: {} } };
  }
}

const safetyHash = (safety: KernelSafetyContext) => sha256(canonicalSerialize(safety));
function kernelError(error: KernelError): never {
  return fail('kernel', error.message, {}, error);
}

/** Preview endpoints follow the same frame alignment as edits (nearest frame, ties earlier). */
function alignRange(range: Range): Range {
  const start = alignTimeMs(range.startMs);
  const end = alignTimeMs(range.endMs);
  if (!start.ok || !end.ok) return mediaFail('render_out_of_bounds', 'Render range cannot be aligned');
  return { startMs: start.effectiveMs, endMs: end.effectiveMs };
}

type ProjectIo = ReturnType<typeof projectIo>;

/** Shared by init and ingest: everything before accepted-head.json is an orphan until that single commit. */
async function createProject(fs: StoreFs, storeRoot: string, projectInput: unknown, safetyInput: unknown,
  prepare: (io: ProjectIo) => Promise<void> = async () => undefined): Promise<AcceptedHead> {
  const check = checkProjectState(projectInput, safetyInput);
  if (!check.ok) kernelError(check.error);
  const project = ProjectIRSchema.parse(projectInput);
  const safety = KernelSafetyContextSchema.parse(safetyInput);
  const directory = join(storeRoot, 'projects', segment(project.id, 'projectId'));
  const io = projectIo(fs, directory);
  await fs.mkdir(directory);
  await acquireLock(fs, io.path(files.lock));
  try {
    if (await io.exists(files.accepted)) fail('already_exists', 'Project already exists');
    await fs.mkdir(io.path(files.snapshots));
    await fs.mkdir(io.path(files.workspaces));
    await prepare(io);
    const contentHash = await io.writeSnapshot(project);
    await io.write(files.safety, safety);
    const acceptedHead: AcceptedHead = { schemaVersion: 1, revision: 0, contentHash, promotions: [] };
    await io.write(files.accepted, acceptedHead);
    return acceptedHead;
  } finally {
    await fs.remove(io.path(files.lock)).catch(() => undefined);
  }
}

/** Create a new project store with accepted revision 0. Fails if the project already exists. */
export async function initProject(options: StoreOptions, projectInput: unknown, safetyInput: unknown): Promise<StoreResult<{ acceptedHead: AcceptedHead }>> {
  return guarded(async () => ({ acceptedHead: await createProject(options.fs ?? nodeStoreFs, options.storeRoot, projectInput, safetyInput) }));
}

/**
 * Trusted lifecycle command: probe one controlled source, import its transcript, copy the source into
 * content-addressed storage and create the full-source project. The user's files are only read.
 */
export async function ingestProject(options: StoreOptions, input: {
  projectId: string; sourcePath: string; transcriptPath: string; safety: unknown;
}): Promise<StoreResult<{ acceptedHead: AcceptedHead; ingestion: IngestionRecord }>> {
  const fs = options.fs ?? nodeStoreFs;
  return guarded(async () => {
    const projectId = segment(input.projectId, 'projectId');
    const binaries = options.media?.binaries ?? resolveBinaries();
    const versions = await preflight(binaries);
    const probe = await probeSource(binaries, input.sourcePath, options.media?.timeoutMs);
    const sourceHash = await fileDigest(input.sourcePath);
    let transcriptBytes: Uint8Array;
    try { transcriptBytes = await readFile(input.transcriptPath); } catch { return mediaFail('transcript_invalid', 'Transcript file is not readable'); }
    const transcriptHash = sha256(transcriptBytes);
    const { transcript, segments } = importTranscript(transcriptBytes, { assetId: `asset-${sourceHash}`, durationMs: probe.video.frameCount * 40 });
    const project = buildInitialProject({ projectId, sourceHash, transcriptHash, probe, segments });
    const ingestion = IngestionRecordSchema.parse({ schemaVersion: 1, sourceHash, transcriptHash, probe, binaries: versions });
    const acceptedHead = await createProject(fs, options.storeRoot, project, input.safety, async io => {
      await fs.mkdir(io.path(files.assets));
      await fs.copyFileAtomic(input.sourcePath, io.path(files.asset(sourceHash)));
      if (await fileDigest(io.path(files.asset(sourceHash))) !== sourceHash) fail('io_failed', 'Source changed while it was being copied');
      await io.write(files.transcript, transcript);
      await io.write(files.ingestion, ingestion);
    });
    return { acceptedHead, ingestion };
  });
}

async function acquireLock(fs: StoreFs, lockPath: string): Promise<void> {
  try {
    await fs.createExclusive(lockPath, serialize({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('owner_locked', 'Another owner holds this project');
    throw error;
  }
}

/** Open the single owner session for a project (D4). A stale owner.lock must be removed manually. */
export async function openProjectStore(options: StoreOptions & { projectId: string }): Promise<StoreResult<{ store: ProjectStore }>> {
  const fs = options.fs ?? nodeStoreFs;
  return guarded(async () => {
    const projectId = segment(options.projectId, 'projectId');
    const io = projectIo(fs, join(options.storeRoot, 'projects', projectId));
    if (!(await io.exists(files.accepted))) fail('project_not_found', 'Project does not exist');
    await acquireLock(fs, io.path(files.lock));
    try {
      await repairPromotedWorkspaces(io);
    } catch (error) {
      await fs.remove(io.path(files.lock)).catch(() => undefined);
      throw error;
    }
    return { store: createStore(fs, io, projectId, options.media ?? {}) };
  });
}

/** The only automatic repair: a promotion recorded in accepted-head.json marks its workspace committed. */
async function repairPromotedWorkspaces(io: ProjectIo): Promise<void> {
  const accepted = await io.readJson(files.accepted, AcceptedHeadSchema);
  for (const promotion of accepted.promotions) {
    if (!StoreSegmentSchema.safeParse(promotion.workspaceId).success) fail('store_corrupt', 'Invalid promoted workspace identity', { file: files.accepted });
    const head = await io.readJson(files.head(promotion.workspaceId), WorkspaceHeadSchema);
    if (head.state !== 'committed') await io.write(files.head(promotion.workspaceId), { ...head, state: 'committed' });
  }
}

function createStore(fs: StoreFs, io: ProjectIo, projectId: string, media: MediaOptions): ProjectStore {
  let closed = false;
  const binaries = media.binaries ?? resolveBinaries();
  let binaryVersions: BinaryVersions | undefined;
  let assetVerified = false;
  let temporaryCounter = 0;

  async function loadSafety() {
    const safety = await io.readJson(files.safety, KernelSafetyContextSchema);
    if (safety.projectId !== projectId) fail('store_corrupt', 'Safety context belongs to another project', { file: files.safety });
    return { safety, hash: safetyHash(safety) };
  }
  async function loadAccepted() {
    const acceptedHead = await io.readJson(files.accepted, AcceptedHeadSchema);
    return { acceptedHead, project: await io.loadSnapshot(acceptedHead.contentHash) };
  }
  async function loadReceipt(workspaceId: string, receiptId: string): Promise<BatchReceipt> {
    // Stored IDs are re-checked before they become path components, so a tampered head cannot escape the store.
    if (!RECEIPT_ID.test(receiptId)) fail('store_corrupt', 'Invalid stored receipt identity', { file: files.head(workspaceId) });
    const file = files.receipt(workspaceId, receiptId);
    const receipt = await io.readJson(file, BatchReceiptSchema);
    if (receipt.receiptId !== receiptId || receipt.workspaceId !== workspaceId) fail('store_corrupt', 'Receipt identity mismatch', { file });
    for (const hash of [receipt.beforeContentHash, receipt.afterContentHash]) {
      if (!(await io.exists(files.snapshot(hash)))) fail('store_corrupt', 'Receipt references a missing snapshot', { file });
    }
    return receipt;
  }
  /** Load and validate a workspace from its commit point. State is the effective state (promotions win). */
  async function loadWorkspace(workspaceIdInput: string) {
    const workspaceId = segment(workspaceIdInput, 'workspaceId');
    if (!(await io.exists(files.head(workspaceId)))) fail('workspace_mismatch', 'Workspace does not exist in this project');
    const stored = await io.readJson(files.head(workspaceId), WorkspaceHeadSchema);
    if (stored.id !== workspaceId || stored.projectId !== projectId) fail('store_corrupt', 'Workspace identity mismatch', { file: files.head(workspaceId) });
    await io.loadSnapshot(stored.base.contentHash);
    const project = await io.loadSnapshot(stored.head.contentHash);
    const receipts = new Map<string, BatchReceipt>();
    for (const receiptId of new Set([...stored.undoReceiptIds, ...stored.redoReceiptIds, ...stored.committedBatches.map(entry => entry.receiptId)])) {
      receipts.set(receiptId, await loadReceipt(workspaceId, receiptId));
    }
    for (const entry of stored.committedBatches) {
      const receipt = receipts.get(entry.receiptId)!;
      if (receipt.batchId !== entry.batchId || receipt.payloadDigest !== entry.payloadDigest) {
        fail('store_corrupt', 'Committed batch does not match its receipt', { file: files.head(workspaceId) });
      }
    }
    const accepted = await io.readJson(files.accepted, AcceptedHeadSchema);
    const promoted = accepted.promotions.some(promotion => promotion.workspaceId === workspaceId);
    const head: WorkspaceHead = promoted ? { ...stored, state: 'committed' } : stored;
    return { workspaceId, head, project, receipts };
  }
  function requireOpen(head: WorkspaceHead): void {
    if (head.state !== 'open') fail('workspace_not_open', 'Workspace is not open', { workspaceId: head.id });
  }
  async function requireSafetyBinding(head: WorkspaceHead) {
    const loaded = await loadSafety();
    if (loaded.hash !== head.safetyContextHash) fail('safety_changed', 'Safety context changed since fork', { workspaceId: head.id });
    return loaded.safety;
  }
  async function writeHead(head: WorkspaceHead): Promise<void> {
    await io.write(files.head(head.id), WorkspaceHeadSchema.parse(head));
  }
  async function readNotesFile(workspaceId: string): Promise<Notes> {
    if (!(await io.exists(files.notes(workspaceId)))) return { revision: 0, text: '' };
    return io.readJson(files.notes(workspaceId), NotesSchema);
  }

  interface Trace { workspaceId?: string; receiptId?: string; outcome?: AttemptRecord['outcome'] }
  /** Run one owner command; afterwards append a best-effort attempt line that is never read for state. */
  async function command<T>(kind: AttemptKind | undefined, body: (trace: Trace) => Promise<T>): Promise<StoreResult<T>> {
    const started = performance.now();
    const trace: Trace = {};
    const result = closed
      ? { ok: false as const, error: { code: 'owner_locked' as const, message: 'Store session is closed', evidence: {} } }
      : await guarded(() => body(trace));
    if (kind && trace.workspaceId) {
      try {
        const file = io.path(files.attempts(trace.workspaceId));
        const sequence = (await fs.exists(file)) ? (await fs.readFile(file)).split('\n').filter(Boolean).length : 0;
        const record: AttemptRecord = {
          sequence, kind, outcome: result.ok ? trace.outcome ?? 'ok' : 'error',
          ...(result.ok ? {} : { errorCode: result.error.kernel?.code ?? result.error.code }),
          ...(trace.receiptId ? { receiptId: trace.receiptId } : {}),
          elapsedMs: Math.max(0, performance.now() - started),
        };
        await fs.appendLine(file, canonicalSerialize(record));
      } catch {
        // Trace data only: a failed append never changes the outcome of a committed command.
      }
    }
    return result;
  }

  async function step(workspaceId: string, expectedRevision: number, direction: 'undo' | 'redo', trace: Trace) {
    const { head, receipts } = await loadWorkspace(workspaceId);
    trace.workspaceId = head.id;
    requireOpen(head);
    const safety = await requireSafetyBinding(head);
    if (expectedRevision !== head.head.revision) fail('stale_revision', 'Workspace revision changed', { expected: head.head.revision, actual: expectedRevision });
    const stack = direction === 'undo' ? head.undoReceiptIds : head.redoReceiptIds;
    const receiptId = stack.at(-1);
    if (receiptId === undefined) fail(direction === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo', `Nothing to ${direction}`);
    const receipt = receipts.get(receiptId)!;
    const [from, to] = direction === 'undo'
      ? [receipt.afterContentHash, receipt.beforeContentHash] : [receipt.beforeContentHash, receipt.afterContentHash];
    if (from !== head.head.contentHash) fail('store_corrupt', 'History does not match the workspace head', { receiptId });
    // Restore only a stored, hash-verified snapshot, re-checked against the genuine locks.
    const check = checkProjectState(await io.loadSnapshot(to), safety);
    if (!check.ok) kernelError(check.error);
    const nextHead: WorkspaceHead = {
      ...head, head: { revision: head.head.revision + 1, contentHash: to },
      undoReceiptIds: direction === 'undo' ? head.undoReceiptIds.slice(0, -1) : [...head.undoReceiptIds, receiptId],
      redoReceiptIds: direction === 'undo' ? [...head.redoReceiptIds, receiptId] : head.redoReceiptIds.slice(0, -1),
    };
    await writeHead(nextHead);
    trace.receiptId = receiptId;
    return { head: nextHead.head, receiptId };
  }

  return {
    projectId,

    readAcceptedHead: () => command(undefined, loadAccepted),

    forkWorkspace: (workspaceIdInput, taskInput) => command(undefined, async () => {
      const workspaceId = segment(workspaceIdInput, 'workspaceId');
      const task = TaskInstructionsSchema.safeParse(taskInput);
      if (!task.success) fail('invalid_input', 'Invalid task instructions');
      const { acceptedHead } = await loadAccepted();
      const { hash } = await loadSafety();
      if (await io.exists(files.head(workspaceId))) fail('already_exists', 'Workspace already exists', { workspaceId });
      await fs.mkdir(io.path(files.receipts(workspaceId)));
      await io.write(files.task(workspaceId), task.data);
      const ref = { revision: acceptedHead.revision, contentHash: acceptedHead.contentHash };
      const workspace: WorkspaceHead = {
        schemaVersion: 1, id: workspaceId, projectId, base: ref, head: ref, safetyContextHash: hash, taskId: task.data.id,
        state: 'open', undoReceiptIds: [], redoReceiptIds: [], proposedBatches: [], previewIds: [], committedBatches: [],
      };
      await writeHead(workspace);
      return { workspace };
    }),

    readWorkspace: workspaceId => command(undefined, async () => {
      const { head, project } = await loadWorkspace(workspaceId);
      return { workspace: head, project };
    }),

    readTask: workspaceId => command(undefined, async () => {
      const { head } = await loadWorkspace(workspaceId);
      return { task: await io.readJson(files.task(head.id), TaskInstructionsSchema) };
    }),

    readSafety: () => command(undefined, async () => ({ safety: (await loadSafety()).safety })),

    appendToolEvent: (workspaceId, eventInput) => command(undefined, async () => {
      const { head } = await loadWorkspace(workspaceId);
      const file = files.toolTrace(head.id);
      const sequence = (await io.exists(file)) ? (await fs.readFile(io.path(file))).split('\n').filter(Boolean).length : 0;
      const event = ToolEventSchema.safeParse({ ...eventInput, sequence });
      if (!event.success) fail('invalid_input', 'Invalid tool event');
      await fs.appendLine(io.path(file), canonicalSerialize(event.data));
      return { sequence };
    }),

    appendLedgerEvent: (workspaceId, eventInput) => command(undefined, async () => {
      const { head } = await loadWorkspace(workspaceId);
      const file = files.ledger(head.id);
      const sequence = (await io.exists(file)) ? (await fs.readFile(io.path(file))).split('\n').filter(Boolean).length : 0;
      const event = LedgerEventSchema.safeParse({ ...eventInput, sequence });
      if (!event.success) fail('invalid_input', 'Invalid ledger event');
      await fs.appendLine(io.path(file), canonicalSerialize(event.data));
      return { sequence };
    }),

    readLedger: workspaceId => command(undefined, async () => {
      const { head } = await loadWorkspace(workspaceId);
      const file = files.ledger(head.id);
      if (!(await io.exists(file))) return { events: [] };
      const events = (await fs.readFile(io.path(file))).split('\n').filter(Boolean).map(line => {
        let value: unknown;
        try { value = JSON.parse(line); } catch { return fail('store_corrupt', 'Invalid ledger line', { file }); }
        const parsed = LedgerEventSchema.safeParse(value);
        if (!parsed.success) fail('store_corrupt', 'Invalid ledger event', { file });
        return parsed.data;
      });
      return { events };
    }),

    writeOrchestrationArtifact: (workspaceId, nameInput, value) => command(undefined, async () => {
      const name = OrchestrationArtifactNameSchema.parse(nameInput);
      const { head } = await loadWorkspace(workspaceId);
      requireOpen(head);
      await fs.mkdir(io.path(`${files.workspace(head.id)}/orchestration`));
      await io.write(files.orchestration(head.id, name), value);
      return {};
    }),

    readOrchestrationArtifact: (workspaceId, nameInput) => command(undefined, async () => {
      const name = OrchestrationArtifactNameSchema.parse(nameInput);
      const { head } = await loadWorkspace(workspaceId);
      const file = files.orchestration(head.id, name);
      if (!(await io.exists(file))) return { value: undefined };
      let value: unknown;
      try { value = JSON.parse(await fs.readFile(io.path(file))); } catch { fail('store_corrupt', 'Invalid orchestration artifact', { file }); }
      return { value };
    }),

    readToolTrace: workspaceId => command(undefined, async () => {
      const { head } = await loadWorkspace(workspaceId);
      const file = files.toolTrace(head.id);
      if (!(await io.exists(file))) return { events: [] };
      const lines = (await fs.readFile(io.path(file))).split('\n').filter(Boolean);
      const events = lines.map(line => {
        let value: unknown;
        try { value = JSON.parse(line); } catch { return fail('store_corrupt', 'Invalid tool trace line', { file }); }
        const parsed = ToolEventSchema.safeParse(value);
        if (!parsed.success) fail('store_corrupt', 'Invalid tool trace event', { file });
        return parsed.data;
      });
      return { events };
    }),

    readReceipt: (workspaceId, receiptId) => command(undefined, async () => {
      const { receipts } = await loadWorkspace(workspaceId);
      const receipt = receipts.get(receiptId);
      if (!receipt) fail('workspace_mismatch', 'Receipt is not part of this workspace history');
      return { receipt };
    }),

    applyEditBatch: batchInput => command('edit', async trace => {
      const parsed = EditBatchSchema.safeParse(batchInput);
      if (!parsed.success) kernelError(kernelFailure('schema_invalid', 'batch', 'Invalid edit batch').error);
      const batch = parsed.data;
      const { head, project, receipts } = await loadWorkspace(batch.workspaceId);
      trace.workspaceId = head.id;
      requireOpen(head);
      const safety = await requireSafetyBinding(head);
      const payloadDigest = sha256(canonicalSerialize(batch));
      const committed = head.committedBatches.find(entry => entry.batchId === batch.batchId);
      if (committed) {
        if (committed.payloadDigest !== payloadDigest) fail('batch_id_conflict', 'Batch ID was already used with a different payload');
        const receipt = receipts.get(committed.receiptId)!;
        trace.receiptId = receipt.receiptId;
        trace.outcome = 'replayed';
        return { outcome: receipt.changed ? 'applied' as const : 'no_change' as const, replayed: true, receipt, head: head.head };
      }
      if (batch.expectedRevision !== head.head.revision) {
        fail('stale_revision', 'Workspace revision changed', { expected: head.head.revision, actual: batch.expectedRevision });
      }
      const result = executeEditBatch(project, batch, safety);
      if (!result.ok) kernelError(result.error);
      const receiptId = 'receipt-' + sha256(canonicalSerialize({
        domain: 'aether.receipt.v1', workspaceId: head.id, batchId: batch.batchId, payloadDigest,
      }));
      const toRevision = head.head.revision + (result.changed ? 1 : 0);
      const receipt: BatchReceipt = BatchReceiptSchema.parse({
        schemaVersion: 1, receiptId, workspaceId: head.id, batchId: batch.batchId, payloadDigest,
        fromRevision: head.head.revision, toRevision,
        beforeContentHash: result.beforeContentHash, afterContentHash: result.afterContentHash, safetyContextHash: head.safetyContextHash,
        operationReceipts: result.operationReceipts, clipMappings: result.clipMappings, changed: result.changed,
      });
      if (result.changed) await io.writeSnapshot(result.nextProject);
      await io.write(files.receipt(head.id, receiptId), receipt);
      const entry = { batchId: batch.batchId, payloadDigest, receiptId };
      const nextHead: WorkspaceHead = result.changed
        ? { ...head, head: { revision: toRevision, contentHash: result.afterContentHash },
          undoReceiptIds: [...head.undoReceiptIds, receiptId], redoReceiptIds: [], committedBatches: [...head.committedBatches, entry] }
        : { ...head, committedBatches: [...head.committedBatches, entry] };
      await writeHead(nextHead);
      trace.receiptId = receiptId;
      trace.outcome = result.changed ? 'ok' : 'no_change';
      return { outcome: result.changed ? 'applied' as const : 'no_change' as const, replayed: false, receipt, head: nextHead.head };
    }),

    undo: (workspaceId, expectedRevision) => command('undo', trace => step(workspaceId, expectedRevision, 'undo', trace)),
    redo: (workspaceId, expectedRevision) => command('redo', trace => step(workspaceId, expectedRevision, 'redo', trace)),

    replay: workspaceId => command(undefined, async () => {
      const { head, receipts } = await loadWorkspace(workspaceId);
      const safety = await requireSafetyBinding(head);
      let project = await io.loadSnapshot(head.base.contentHash);
      let hash = head.base.contentHash;
      for (const [index, receiptId] of head.undoReceiptIds.entries()) {
        const receipt = receipts.get(receiptId)!;
        const mismatch = (reason: NonNullable<ReplayReport['firstMismatch']>['reason']) =>
          ({ report: { ok: false, checkedReceipts: index, firstMismatch: { index, receiptId, reason } } });
        if (receipt.beforeContentHash !== hash) return mismatch('before_hash');
        const result = applyBatch(project, receipt.operationReceipts.map(row => row.effective), safety);
        if (!result.ok) return mismatch('kernel');
        if (result.afterContentHash !== receipt.afterContentHash) return mismatch('after_hash');
        project = result.nextProject;
        hash = result.afterContentHash;
      }
      const checkedReceipts = head.undoReceiptIds.length;
      if (hash !== head.head.contentHash) {
        return { report: { ok: false, checkedReceipts, firstMismatch: { index: checkedReceipts, reason: 'head_hash' as const } } };
      }
      return { report: { ok: true, checkedReceipts } };
    }),

    readNotes: workspaceId => command(undefined, async () => {
      const { head } = await loadWorkspace(workspaceId);
      return { notes: await readNotesFile(head.id) };
    }),

    writeNotes: (workspaceId, expectedNotesRevision, text) => command('notes', async trace => {
      const { head } = await loadWorkspace(workspaceId);
      trace.workspaceId = head.id;
      requireOpen(head);
      if (typeof text !== 'string') fail('invalid_input', 'Notes must be text');
      if (Buffer.byteLength(text, 'utf8') > NOTES_MAX_BYTES) fail('notes_too_large', 'Notes exceed the size limit', { expected: NOTES_MAX_BYTES });
      const current = await readNotesFile(head.id);
      if (expectedNotesRevision !== current.revision) {
        fail('stale_revision', 'Notes revision changed', { expected: current.revision, actual: expectedNotesRevision });
      }
      const notes: Notes = { revision: current.revision + 1, text };
      await io.write(files.notes(head.id), notes);
      return { notes };
    }),

    discard: workspaceId => command('discard', async trace => {
      const { head } = await loadWorkspace(workspaceId);
      trace.workspaceId = head.id;
      requireOpen(head);
      const workspace: WorkspaceHead = { ...head, state: 'discarded' };
      await writeHead(workspace);
      return { workspace };
    }),

    freezeSubmission: workspaceId => command('freeze', async trace => {
      const { head } = await loadWorkspace(workspaceId);
      trace.workspaceId = head.id;
      requireOpen(head);
      const notes = await readNotesFile(head.id);
      const workspace: WorkspaceHead = {
        ...head, state: 'frozen',
        submission: { revision: head.head.revision, contentHash: head.head.contentHash, notesRevision: notes.revision },
      };
      await writeHead(workspace);
      return { workspace };
    }),

    promote: (workspaceId, expectedAcceptedRevision) => command('promote', async trace => {
      const { head, project } = await loadWorkspace(workspaceId);
      trace.workspaceId = head.id;
      requireOpen(head);
      const { acceptedHead } = await loadAccepted();
      if (acceptedHead.revision !== expectedAcceptedRevision || acceptedHead.revision !== head.base.revision
        || acceptedHead.contentHash !== head.base.contentHash) {
        fail('stale_base', 'Accepted state changed since this workspace was forked', { expected: acceptedHead.revision, actual: expectedAcceptedRevision });
      }
      const safety = await requireSafetyBinding(head);
      const check = checkProjectState(project, safety);
      if (!check.ok) kernelError(check.error);
      if (project.sequence.clips.length === 0) fail('empty_timeline', 'Cannot promote an empty timeline');
      const revision = acceptedHead.revision + 1;
      const next: AcceptedHead = {
        ...acceptedHead, revision, contentHash: head.head.contentHash,
        promotions: [...acceptedHead.promotions, { revision, workspaceId: head.id, workspaceRevision: head.head.revision }],
      };
      await io.write(files.accepted, AcceptedHeadSchema.parse(next));
      // Commit point is written. The workspace's own state is derived from promotions, so this is best-effort.
      await writeHead({ ...head, state: 'committed' }).catch(() => undefined);
      return { acceptedHead: next };
    }),

    renderPreview: (workspaceId, requestInput) => command(undefined, async () => {
      const request = RenderRequestSchema.safeParse(requestInput);
      if (!request.success) fail('invalid_input', 'Invalid render request');
      const { head, project } = await loadWorkspace(workspaceId);
      // Evidence must describe the head the caller saw; a newer head needs a new render.
      if (request.data.contentHash !== head.head.contentHash) fail('stale_content', 'Render request names a different content hash', { workspaceId: head.id });
      if (!(await io.exists(files.ingestion))) fail('media_unavailable', 'Project has no ingested media');
      const ingestion = await io.readJson(files.ingestion, IngestionRecordSchema);
      const asset = project.assets[0]!;
      if (asset.contentHash !== ingestion.sourceHash) fail('store_corrupt', 'Ingestion record does not match the project asset', { file: files.ingestion });
      const assetPath = io.path(files.asset(asset.contentHash));
      if (!assetVerified) {
        if (!(await io.exists(files.asset(asset.contentHash))) || await fileDigest(assetPath) !== asset.contentHash) {
          fail('store_corrupt', 'Stored source asset is missing or altered', { file: files.asset(asset.contentHash) });
        }
        assetVerified = true;
      }
      binaryVersions ??= await preflight(binaries);
      const effectiveRange: Range = request.data.range ? alignRange(request.data.range) : { startMs: 0, endMs: sequenceDurationMs(project) };
      const recipe = compileRecipe(project, effectiveRange, request.data.preset, ingestion.probe);
      const artifactId = 'artifact-' + sha256(canonicalSerialize({
        domain: 'aether.artifact.v1', contentHash: head.head.contentHash, range: effectiveRange, preset: recipe.preset, binaries: binaryVersions,
      }));
      const mediaPath = io.path(`${files.artifact(artifactId)}/${recipe.mediaFile}`);
      if (await io.exists(files.manifest(artifactId))) {
        const manifest = await io.readJson(files.manifest(artifactId), RenderManifestSchema);
        if (manifest.artifactId !== artifactId || !(await fs.exists(mediaPath))) fail('store_corrupt', 'Artifact does not match its identity', { file: files.manifest(artifactId) });
        return { manifest, mediaPath, reused: true };
      }
      await fs.mkdir(io.path(files.artifact(artifactId)));
      const temporary = `${mediaPath}.tmp-${process.pid}-${temporaryCounter++}`;
      try {
        await renderToFile(binaries, recipe, assetPath, temporary, media.timeoutMs);
        const measured = await measureOutput(binaries, temporary, media.timeoutMs);
        const outputDigest = await fileDigest(temporary);
        await fs.rename(temporary, mediaPath);
        const manifest: RenderManifest = RenderManifestSchema.parse({
          schemaVersion: 1, artifactId, contentHash: head.head.contentHash, timelineContentFingerprint: timelineContentFingerprint(project),
          ...(request.data.range ? { requestedRange: request.data.range } : {}), effectiveRange, preset: recipe.preset,
          binaries: binaryVersions, mediaFile: recipe.mediaFile, expected: recipe.expected, measured,
          checks: timingChecks(recipe, measured), outputDigest,
        });
        // The manifest is the artifact's commit point; a directory without one is an orphan.
        await io.write(files.manifest(artifactId), manifest);
        return { manifest, mediaPath, reused: false };
      } finally {
        await fs.remove(temporary).catch(() => undefined);
      }
    }),

    async close() {
      if (closed) return;
      closed = true;
      await fs.remove(io.path(files.lock));
    },
  };
}
