# AETHER Editor — Low-Level Design (Phase V1)

Status: **Design only. Not implemented.** Requires an ExecPlan and owner approval before code. Gated on completion of the Experiment 001 pilot.

Date: 2026-10-14
Parent: [editor-hld.md](editor-hld.md). Invariant IDs (I1–I8) refer to HLD §2.
Builds on: Milestone 2 kernel (`packages/core`), Milestone 3 workspace store ([ExecPlan](../execplans/v0.1-milestone-3-workspace.md)), Milestone 4 renderer.

V1 scope: ProjectIR v2 and migration, v2 operations, actor-scoped capabilities, command registry, owner daemon, diff engine, review service, read-only timeline UI with branch review. Human timeline editing, analysis layers, color, co-presence and macros are V1.x/V2 and are specified only at HLD level, except where V1 schemas must leave room for them.

---

## 1. Conventions

- TypeScript strict, ESM, Zod 4, Node 24 built-ins (same as V0).
- All times are integer milliseconds on the 40 ms (25 fps) grid, half-open ranges, as in `primitives.ts` and `timing.ts`.
- Every new pure function is deterministic and has fixture tests. Every state change goes through the kernel (I1).
- New IDs that the kernel creates are hash-derived like `splitChildId`, so replay reproduces them.

## 2. ProjectIR v2

### 2.1 Why a new version, not new fields
`ProjectIRSchema` is a `strictObject` with `schemaVersion: z.literal(1)` and `assets.length(1)`, and `hashProjectIR` hashes the canonical form. Adding any field to v1 would change hashes, break fixtures and break reproducibility of Experiment 001 runs. So v2 is a separate schema and V0 stays on v1 (I7).

### 2.2 Schema

```ts
// packages/core/src/project-v2.ts
export const TrackKindSchema = z.enum(['video', 'audio', 'music', 'caption']);

export const SourceAssetV2Schema = /* SourceAssetSchema fields, except: */ z.strictObject({
  id, contentHash, mediaPath, durationMs, frameCount, presentationOriginUs,
  video: VideoStreamSchema.optional(),          // music assets have no video
  audio: AudioStreamSchema.optional(),
  role: z.enum(['primary', 'music', 'broll']),
}).superRefine(/* same digest/id/duration rules as v1; at least one of video|audio */);

export const ClipParamsSchema = z.strictObject({
  gainDb: z.number().int().min(-60).max(12).default(0),   // audio/music tracks only
  // V2 reserves: grade?: GradeParamsSchema
});

export const TimelineClipV2Schema = z.strictObject({
  id: IdSchema, assetId: IdSchema, sourceRange: RangeSchema, timelineStartMs: MsSchema,
  linkGroupId: IdSchema.optional(),
  params: ClipParamsSchema,
}).superRefine(/* same 40 ms alignment + safe-integer rules as v1 */);

export const TrackSchema = z.strictObject({
  id: IdSchema, kind: TrackKindSchema, order: UIntSchema,
  clips: z.array(TimelineClipV2Schema),
});

export const ProjectIRV2Schema = z.strictObject({
  schemaVersion: z.literal(2), id: IdSchema,
  assets: z.array(SourceAssetV2Schema).min(1), transcriptHash: DigestSchema,
  segments: z.array(MediaSegmentSchema),
  sequence: z.strictObject({ id: IdSchema, tracks: z.array(TrackSchema).min(1) }),
});
```

### 2.3 Invariants (superRefine, mapped to existing kernel error codes)

| Invariant | Error code |
| --- | --- |
| Track ids unique; track `order` unique | `schema_invalid` |
| Clip ids unique **across all tracks** | `schema_invalid` |
| Clip asset exists; source range within asset extent | `invalid_reference` / `source_bounds` |
| Clip media matches track kind: `video` needs asset video; `audio`/`music` need asset audio | `invalid_reference` |
| No overlap **within a track** (V0 checks globally over one list) | `timeline_overlap` |
| All clips of one `linkGroupId` share `assetId`, `sourceRange` and `timelineStartMs`, and lie on different tracks | new code `link_desync` |
| `params.gainDb` non-zero only on `audio`/`music` tracks | `schema_invalid` |
| Exactly one video track in V1 (multi-video is multicam territory, out of scope) | `schema_invalid` |
| Timeline ends are safe integers | `timing_alignment` |

Track and clip arrays are canonically sorted (tracks by `order`; clips by `timelineStartMs`, then `id`), so hashing is stable. Add `hashProjectIRV2` with domain `aether.project.v2`.

### 2.4 Migration

```ts
export function migrateV1toV2(v1: ProjectIR): ProjectIRV2
```

Pure, total for any valid v1:
- asset → v2 asset with `role: 'primary'`.
- Track `v1` (`video`, order 0) holds each v1 clip with `params: { gainDb: 0 }`.
- If the asset has audio, track `a1` (`audio`, order 1) holds a copy of each clip with id `clip-a-<sha256(domain, clipId)>`. Both copies get `linkGroupId = link-<sha256(domain, clipId)>`.
- Video clip ids are unchanged, so V0 references and receipts stay meaningful.

There is no v2→v1 migration. The Experiment 001 runner rejects `schemaVersion !== 1` (I7).

## 3. Operations v2

### 3.1 Batch

```ts
export const ActorSchema = z.strictObject({
  kind: z.enum(['human', 'agent', 'macro']), id: IdSchema,
});
export const EditBatchV2Schema = z.strictObject({
  schemaVersion: z.literal(2), batchId: IdSchema, workspaceId: IdSchema,
  expectedRevision: UIntSchema, actor: ActorSchema,
  rationale: z.string().max(2000).optional(),   // shown in review; never parsed
  operations: z.array(EditOperationV2Schema).min(1),
});
```

`actor` and `rationale` are stored in receipts. History is one list for humans and agents.

### 3.2 Operation set

V0 operations carry over unchanged in shape. In v2 they act on a **link group**: if the target clip has a `linkGroupId`, the operation applies to every member atomically, and the receipt lists all affected clip ids. This keeps picture and sound in sync by default.

| Operation | Fields | Semantics |
| --- | --- | --- |
| `split`, `trim`, `delete`, `ripple_delete`, `move` | as v1 | Applied to the link group. `ripple_delete` shifts later clips on **every track that had a member removed**. Music tracks are not rippled unless they contain a member. |
| `add_track` | `trackId, kind` | Appends an empty track; `order` = max + 1. Rejects a second video track. |
| `insert_clip` | `trackId, assetId, sourceRange, timelineStartMs` | New clip id = `clip-ins-<sha256(domain, operationId)>`. Must not overlap on that track. |
| `set_gain` | `clipId, gainDb` | Audio/music only. Not propagated to the link group. |
| `link_clips` | `clipIds[2..]` | Members must satisfy the link invariant; group id hash-derived from sorted ids. |
| `unlink_clips` | `linkGroupId` | Removes the group id from all members. |

Split children of a linked clip get child link group ids derived from `(parentLinkGroupId, operationId, side)`, so the left and right halves stay linked to each other.

Normalization: extend `normalizeEditOperation` time fields for `insert_clip` (`sourceRange.*`, `timelineStartMs`). `gainDb` is an integer, so it is not aligned.

### 3.3 Reversibility
No inverse operations are written. Undo and redo use M3 snapshot history (I4). Each new operation needs only validation, invariant checks and deterministic tests.

## 4. Capabilities (per-actor autonomy)

The existing `KernelSafetyContext` is extended, not replaced:

```ts
export const CapabilityGrantSchema = z.strictObject({
  actorId: IdSchema,
  operations: z.array(OperationKindV2Schema),
  trackIds: z.array(IdSchema).min(1),          // operations may only touch these tracks
  canPromote: z.boolean(),                       // agents: always false in V1
});
export const KernelSafetyContextV2Schema = z.strictObject({
  schemaVersion: z.literal(2), projectId: IdSchema,
  maxOperationsPerBatch: PositiveIntSchema,
  userLocks: z.array(UserLockV2Schema),
  grants: z.array(CapabilityGrantSchema),
});
export const UserLockV2Schema = /* UserLockSchema + */ z.strictObject({
  ..., trackKinds: z.array(TrackKindSchema).min(1).default(['video']),
});
```

Kernel checks, per operation:
1. A grant for `batch.actor.id` exists → else `operation_not_allowed`.
2. `operation.type ∈ grant.operations` → else `operation_not_allowed`.
3. Every clip and track touched, **including link group members**, is in `grant.trackIds` → else new code `track_not_allowed`. So an agent granted only `m1` cannot ripple the dialogue.
4. Locks: coverage is checked per track kind listed in the lock, reusing the v1 interval sweep per track.

`canPromote` is enforced by the review service, not the kernel. The kernel never knows about accepted heads.

## 5. Diff engine (`@aether/diff`, pure)

### 5.1 Output

```ts
interface ReviewDiff {
  baseHash: string; headHash: string;
  tracks: TrackDiff[];
  changes: Change[];               // ordered by base timeline position
  summary: { removedMs: number; addedMs: number; movedCount: number; durationBeforeMs: number; durationAfterMs: number };
}
interface Change {
  id: string;                      // hash of (kind, trackId, sourceRef, receiptIds)
  kind: 'removed' | 'added' | 'moved' | 'retimed' | 'gain';
  trackId: string;
  source: SourceRef;               // what media this change is about
  baseTimeline?: Range; headTimeline?: Range;
  receiptIds: string[];            // which batches caused it
  rationale: string[];             // from those receipts
  dependsOn: string[];             // change ids that must be accepted first
}
```

### 5.2 Algorithm

Clip ids are **not** used for matching, because splits create new ids. The diff works on source coverage:

1. For each track in base and head, build a list of **atoms**: `(assetId, sourceRange, timelineStartMs, gainDb)`. Cut every source range at every boundary that appears in either snapshot for that asset, so atoms align one-to-one.
2. `removed` = atoms present in base but not in head. `added` = in head, not in base.
3. For atoms in both, compute the longest common subsequence of their order. Atoms outside the LCS are `moved`. Atoms inside it whose position changed only by ripple are `retimed` and are hidden by default in the UI.
4. `gain`: matched atoms whose `gainDb` differs.
5. Merge adjacent atoms of the same kind on the same track into one change.

Complexity is O(n log n) for atomization plus O(n²) for the LCS. That is fine for V1 (talking-head timelines have a few hundred clips).

### 5.3 Attribution to receipts
Replay the workspace receipts in order from `base`, through `executeEditBatch`, and diff each step against the previous one. Every atom change is tagged with the receipt that produced it. A change's `dependsOn` lists changes from earlier receipts that created clip ids its receipt references (found from `createdClipIds` and `retiredClipIds` in the operation receipts). Replay is deterministic because child ids are hash-derived.

## 6. Review service

```ts
reviewOpen(workspaceId): ReviewSession             // freezes workspace, computes diff + verification
reviewAcceptAll(sessionId, reviewer): PromoteResult
reviewAcceptSelected(sessionId, changeIds, reviewer): PromoteResult
reviewReject(sessionId, reviewer, note?): void       // workspace → discarded
reviewRequestRevision(sessionId, reviewer, note): void  // workspace → open; note delivered to agent
```

- **Accept all**: M3 `promote`. It requires accepted head == workspace base. If the accepted head has moved, this goes to a conflict (below).
- **Accept selected**:
  1. Close `changeIds` over `dependsOn`. The UI shows dependencies that were auto-added.
  2. Take the set of receipts behind those changes, in original order.
  3. Replay each receipt's batch onto the **current accepted head** with `executeEditBatch`, under the reviewer's grant and with `actor` set to the original actor. Add a `promotedBy` field to the receipt.
  4. If every replay succeeds, commit atomically as one accepted-head update. If any fails, nothing is committed.
  - Receipt granularity is the unit. A receipt that contains both wanted and unwanted operations cannot be split in V1. The UI says so, and agents are prompted to batch one intent per receipt.
- **Conflict**: any replay failure (typically `invalid_reference` because the accepted head no longer has a clip) returns `{ conflict: true, failedReceiptId, kernelError }`. The workspace stays frozen and intact. The human can request a revision, and the agent rebases by forking from the new head. There is no auto-merge, consistent with M3.
- Only actors with `canPromote` may call accept. In V1 that means humans only.

## 7. Command registry (`@aether/registry`)

### 7.1 Definition

```ts
interface CommandDef<I extends z.ZodType, O extends z.ZodType> {
  name: `${'read' | 'edit' | 'workspace' | 'review' | 'constraint' | 'analysis'}.${string}`;
  kind: 'read' | 'command';
  surfaces: ('ui' | 'agent')[];           // default both; 'ui'-only allowed for presentation
  input: I; output: O;
  requires?: OperationKindV2 | 'promote' | 'lock';
  description: string;                    // becomes the MCP tool description
  handler: (ctx: CommandContext, input: z.infer<I>) => Promise<z.infer<O>>;
}
```

- The HTTP router and the MCP server are both **generated** from `registry.list()`. Neither has handwritten routes or tools.
- **Parity rule (I2)**: every `kind: 'command'` must include both surfaces. Only `kind: 'read'` commands tagged `presentation` (e.g. `read.thumbnail_strip`) may be UI-only. CI test: `registry-parity.test.ts` fails on any violation.
- Commands that touch the Experiment 001 surface (`search_transcript`, `inspect_segment`, `preview_range`, `get_timeline`, notes) keep their V0 names and schemas as aliases, so existing harness tools remain identical.

### 7.2 V1 command list

| Command | Kind | Notes |
| --- | --- | --- |
| `read.timeline` | read | v2 tracks, revision, head hash |
| `read.transcript_search`, `read.segment` | read | V0 behaviour |
| `read.preview_range` | read | Returns proxy URL (UI) or frame/text summary (agent) |
| `read.history` | read | Receipts with actor + rationale |
| `edit.apply_batch` | command | `EditBatchV2`; actor taken from the session, never from the payload |
| `workspace.fork`, `workspace.undo`, `workspace.redo`, `workspace.submit_for_review` | command | M3 operations |
| `review.open`, `review.diff`, `review.accept_all`, `review.accept_selected`, `review.reject`, `review.request_revision` | command | §6; accept requires `promote` |
| `constraint.add_lock`, `constraint.remove_lock` | command | Requires `lock`; humans only in V1 |

The session binds the actor. The daemon overwrites `batch.actor` from the authenticated session, so an agent cannot claim to be human.

## 8. Owner daemon (`apps/owner-daemon`)

- One Node process. It takes the M3 `owner.lock` on start and refuses to start if the lock is held.
- **HTTP** `POST /rpc/:command` with JSON body, validated by the registry schema. It binds to `127.0.0.1` only. A random per-launch token is passed to the UI by URL fragment and to MCP sessions by environment variable.
- **WebSocket** `/events`. Events: `head.changed {workspaceId, revision, hash}`, `workspace.state {id, state}`, `review.updated {sessionId}`, `analysis.ready {assetHash, kind}`.
- **MCP** stdio entrypoint `aether-mcp --workspace <id>`. It connects to the daemon as an agent session with that workspace's grant. Agents never get the accepted head.
- **Serialization**: commands that touch the store run on one in-process queue. Reads run concurrently against immutable snapshots.
- **Static**: serves the built `editor-web` and the proxy media under `/media/proxy/<contentHash>/...`.

## 9. Editor UI (`apps/editor-web`, V1 read-only + review)

### 9.1 Layout

```text
┌───────────────────────────────────────────────────────────────┐
│ Project ▸ Workspace selector ▸ [Review: agent-7 ●]            │
├──────────────────────────────┬────────────────────────────────┤
│  Preview (A | B | A/B wipe)  │  Changes list                  │
│                              │  ☑ Removed 00:41–00:52 "so..." │
│                              │     rationale · verifier ✓     │
│                              │  ☐ Moved recommendation  →     │
├──────────────────────────────┴────────────────────────────────┤
│ Ruler  |00:00     |00:30      |01:00 ...                      │
│ V1  ▇▇▇▇▇▇░░░▇▇▇▇▇▇▇▇▇▇  (red = removed, green = added)       │
│ A1  ~~~~~~░░░~~~~~~~~~~                                       │
│ 🔒 locks / pins row                                            │
├───────────────────────────────────────────────────────────────┤
│ Verification: duration ✓  qualification retained ✓  ...      │
│ [Accept selected]  [Accept all]  [Request revision]  [Reject] │
└───────────────────────────────────────────────────────────────┘
```

### 9.2 Structure

- State: one store (Zustand) holding `timeline`, `diff`, `selection`, `playhead`. It is refreshed from WS events, never mutated locally (I1). All mutations are registry calls.
- Timeline: one `<canvas>` per track, virtualized by visible time window. Waveform peaks come from a precomputed `peaks.json` per asset (M4 proxy step).
- Preview: an EDL player. It takes the head timeline's video track, maps playhead → (clip, source time), seeks the per-asset 540p proxy `<video>` and swaps at clip boundaries. A/B mode runs two players, base and head. It is labelled "proxy preview" (I6).
- Changes list: from `ReviewDiff.changes`. Checking a change auto-checks its `dependsOn`, with an explanation chip.
- Generated client: typed RPC functions generated from the registry. The UI imports no daemon internals.

## 10. Analysis artifacts (schema reserved now, built in V1.x)

```text
.aether/analysis/<contentHash>/
  peaks.v1.json        { samplesPerPeak, peaks: int8[] }                 (V1, for waveforms)
  beats.v1.json        { tempoBpm, beatsMs: int[], downbeatsMs: int[] }  (V1.x, 40 ms grid)
  loudness.v1.json     { integratedLufs, shortTermLufs: {tMs, lufs}[] }  (V1.x)
  silence.v1.json      { ranges: Range[], thresholdDb, minMs }           (V1.x)
  shots.v1.json        { cutsMs: int[] }                                 (V1.x)
```

Keyed by asset content hash, versioned by file name, never part of ProjectIR (I5). Produced by FFmpeg filters (`astats`, `ebur128`, `silencedetect`, `scdet`). The beat tracker is a deterministic onset-autocorrelation implementation in `@aether/analysis`. Its output is fixture-tested.

## 11. Agent-authored macros (V2; grammar reserved)

Only the shape is fixed now, to guarantee I8:

```ts
type Macro = { id, version, author: ActorId, params: ZodJsonSchema, body: Step[], tests: MacroTest[] };
type Step =
  | { read: ReadCommandName, args: Expr, bind: string }
  | { forEach: string, as: string, do: Step[] }        // over a bound array; bounded
  | { emit: EditOperationTemplate }                    // fields are Expr
  | { if: Expr, then: Step[], else?: Step[] };
type Expr = closed JSON expression language: literals, bound vars, + - * min max, field access, frame-snap
```

The interpreter has no I/O except registry read commands, enforces `emitted ≤ maxOperationsPerBatch` and a step budget, and returns one `EditBatchV2` with `actor.kind = 'macro'`, which then goes through the kernel normally. A macro is promoted to the shared library only by a human, after its `tests` pass.

## 12. Errors

New kernel error codes: `link_desync`, `track_not_allowed`. Daemon-level errors (not kernel): `unauthorized`, `stale_revision` (from M3), `review_conflict`, `not_promotable`. Every error follows `KernelError`'s rule: fixed messages and known evidence fields only, never raw input echo.

## 13. Test plan

| Area | Tests |
| --- | --- |
| v2 schema | Each invariant in §2.3 has a passing and a failing fixture |
| Migration | Every V0 fixture migrates; result validates; video clip ids preserved; deterministic hash |
| v2 operations | Per op: happy path, each failure code, linked-group atomicity, ripple across member tracks only, split child id determinism |
| Capabilities | Agent with `m1`-only grant cannot touch a linked `v1/a1` clip; actor spoofing overwritten |
| Diff | Golden diffs for split-then-delete, move, ripple, gain; ids not used for matching; attribution matches receipts |
| Review | Accept-selected with dependency closure; atomic failure on conflict; accepted head unchanged on failure |
| Registry | Parity test (I2); generated MCP tool list snapshot; V0 tool aliases byte-identical in schema |
| Isolation | Experiment runner rejects v2 projects; V0 test suite unchanged and green |

## 14. V1 acceptance criteria

1. Opening a V0 project in the editor migrates it (in memory or as a new project id; V0 files untouched) and shows V1/A1 tracks with waveforms.
2. An MCP agent session, granted one workspace, can read, edit and submit for review. It cannot touch the accepted head.
3. The review screen shows a coverage-based diff with rationale and verification per change, and A/B proxy preview.
4. Accept-all, accept-selected (with dependencies), reject and request-revision all work. Conflicts are reported, never merged.
5. `pnpm typecheck && pnpm build && pnpm test` is green, including the registry parity test, and Experiment 001 artifacts are bit-for-bit unaffected.

## 15. Open items for the V1 ExecPlan

- Proxy and peaks generation belong to M4 or to V1. The default is to add them in V1 without changing the M4 render path.
- Whether UI-to-daemon authentication needs more than a per-launch token. Local-only V1 says no.
- Exact LCS tie-breaking rule for equal-cost alignments. Pick one deterministic rule and document it in the diff golden tests.
