# AETHER V0.1 — Milestones 1–5

A local research foundation for comparing direct model-to-tool video editing with structured Edit Contract / Editorial Plan / compiler orchestration. Contracts, canonical identity, timing normalization, a pure atomic editing kernel, an isolated reversible workspace store, controlled media ingestion and frame/sample-exact rendering, and deterministic tests are implemented. Milestone 5 adds the shared agent tools and the offline evaluator seam; Milestone 6 (readiness demo) remains. Media features need FFmpeg and ffprobe on `PATH` (or `AETHER_FFMPEG`/`AETHER_FFPROBE`).

## Setup and checks

Use **Node 24.12.0** and **pnpm 11.19.0** (pinned in `.node-version` and `package.json`). Dependencies are pinned to TypeScript 5.9.3, Zod 4.1.13, and `@types/node` 24.10.1; the pnpm lockfile records their exact resolution. Select the pinned Node version with your preferred version manager before running commands.

From the repository root:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

`typecheck` first builds workspace declarations so it also works from a fresh checkout. `test` uses Node's test runner on the compiled TypeScript tests; run `build` after changing sources/tests. No FFmpeg installation, media files, API keys, cloud service or database is required. GitHub Actions runs these four commands on pushes and pull requests, with commit-pinned setup actions and the same Node/pnpm pins.

pnpm settings live in `pnpm-workspace.yaml`, including engine compatibility checks against the selected Node pin. See the [pnpm settings documentation](https://pnpm.io/settings/cli). The test suite checks the actual Node runtime, not only the manifest text.

## Contract boundaries

| Entry point | Contents |
| --- | --- |
| `@aether/core` | Task-independent schemas, separate safety/user locks, commands, canonical hashing, timing normalization, pure atomic kernel and timeline-content fingerprint |
| `@aether/tools` | Agent-visible TaskInstructions and the nine shared tool schemas and limits, identical for every arm |
| `@aether/harness` | Trusted tool host (one workspace, frozen limits, budget, traced calls); `./evaluation` runs blind offline grading and Proposal 001 diagnostics |
| `@aether/tools/orchestration` | Optional AETHER EditContract and EditorialPlan; not exported from the shared agent entry |
| `@aether/workspace` | Local filesystem store (Milestone 3): owner lock, workspaces, revision checks, batch deduplication, undo/redo/replay from hash-verified snapshots, notes storage, freeze, discard and promotion; Milestone 4 adds `ingestProject` and `renderPreview` with immutable content-addressed artifacts |
| `@aether/verification` | Public mechanical result shape only |
| `@aether/verification/evaluator` | Hidden EvaluationSpec / ExperimentConfig and the deterministic evaluator (duration, retention, all-hard-criteria; semantic → review) |
| `@aether/verification/diagnostics` | Trusted post-freeze failure-stage diagnostics (`diagnostics.v1`) |
| `@aether/media` | Milestone 4: FFmpeg preflight, strict 25 fps/48 kHz source probing, transcript import, pure render-recipe compiler, rendering and timing measurement. No store or mutation authority |
| `@aether/harness-cli` | Empty package boundary reserved for Milestone 6 |

The evaluator subpath is a trusted interface, not an OS security boundary. Core/Tools dependency and import-closure tests prevent accidental imports; Core imports only local Core modules, Zod and standard crypto. Future model callbacks must expose only visible inputs and shared tools. Ordinary editorial requests do not create user locks. The kernel accepts neither task instructions nor evaluation annotations; unlocked editorial content can be deleted successfully.

## Canonical project identity

An asset's logical reference is `assets/<lowercase SHA-256 source digest>`, with no filename extension or host directory. Its ID is `asset-<same digest>`. Absolute paths, traversal, backslashes, alternate spellings and digest mismatches are rejected. A future trusted storage resolver may locate those assets under any local project root; the host location is outside ProjectIR.

`serializeProjectIR` validates the project, sorts assets/segments by stable ID and clips by timeline position/ID, then emits UTF-8-compatible canonical JSON with lexically sorted object keys. It does not mutate the input. Generic arrays preserve order; these project collections are treated as keyed entities. Optional undefined object fields are omitted, signed zero is normalized to zero, and Unicode bytes are preserved without text normalization. Unsupported non-JSON values/cycles are rejected.

`hashProjectIR` computes SHA-256 over that serialization. It accepts only ProjectIR, not a combined run envelope. Visible instructions, safety/locks, inferred contracts/plans, evaluator annotations and host storage location are separate objects. Source metadata, transcript content, opaque project/sequence/clip/**segment** IDs and effective timeline position remain meaningful project content. This is exact state identity and must not be used as proof that independently produced timelines render equivalent content.

`timelineContentFingerprint` describes the single-source content schedule using source byte digest, selected video/audio metadata, presentation origin, source ranges and timeline starts. It sorts by timeline position and merges adjacent ranges contiguous in both source and timeline, so splitting alone does not change it. Gaps remain significant; administrative IDs, unused transcript metadata and segmentation are excluded. It is a versioned schedule identity for this profile, not a decoded-render or semantic equivalence proof; no experiment comparison is implemented.

## Pure editing API

`applyBatch(project, effectiveOperations, safety)` accepts only effective frame-aligned operations. `executeEditBatch(project, requestedBatch, safety)` aligns requested integer milliseconds once: nearest 40 ms frame, with exact 20 ms ties rounding earlier. `alignTimeMs` and `normalizeEditOperation` expose the same deterministic rule. Receipts retain requested/effective operations and individual alignment deltas. Neither API silently clamps boundaries; raw out-of-range split/trim requests fail even when rounding would put them back inside the clip.

Operations follow the reviewed plan: split requires a strict interior source point; trim only shortens and keeps timeline start fixed; delete leaves other starts unchanged; ripple-delete shifts later clips by the deleted duration and preserves pre-existing gaps; move sets an absolute start and rejects overlap. Effective ranges are half-open, non-empty, nonnegative safe integers on the 40 ms grid. Transcript cues and genuine user-selected lock ranges may be off-grid.

Every operation runs against a private provisional project, validated structurally after each step. Genuine source-retention locks are checked initially and against the completed candidate's union of source coverage, so adjacent split children and moves preserve locks. Safety context must come from a trusted user lifecycle owner; schemas cannot authenticate who actually created a record. Task text never creates locks.

Success returns detached `beforeProject`/`nextProject`, exact before/after hashes, `changed`, operation receipts (`applied` or `no_change`) and parent-to-child mappings. Failure returns only `ok: false` plus a typed mechanical error; there is no partial project or receipt. Errors distinguish schema, references, source bounds, timing, overlap, permission, batch limit, genuine locks and child identity collisions. The original input is never mutated. Snapshots permit later exact restoration; no history/undo service exists yet.

Split child ID is `clip-split-<SHA-256>` of UTF-8 `canonicalSerialize` applied to exactly:

```ts
{
  domain: 'aether.split-child.v1',
  parentClipId: parent.id,
  assetId: parent.assetId,
  parentSourceRange: parent.sourceRange,
  operationId: operation.operationId,
  effectiveAtSourceMs: operation.atSourceMs,
  side: 'left' // or 'right'
}
```

There are no timestamps or random IDs. Replaying identical effective edits from the same starting project yields identical state and IDs; this does not implement request deduplication. Operations may address children produced earlier in a batch. `workspaceId` and `expectedRevision` in EditBatch are validated correlation metadata only at this layer; the Milestone 3 workspace store enforces ownership, revision and deduplication before invoking the pure API.

The [ExecPlan](docs/execplans/v0.1-foundation.md) records approval, actual results and remaining milestones. Milestones 3–5 are recorded in their ExecPlans ([M3](docs/execplans/v0.1-milestone-3-workspace.md), [M4](docs/execplans/v0.1-milestone-4-media.md), [M5](docs/execplans/v0.1-milestone-5-tools-evaluator.md)). Live model adapters, the AETHER planner/compiler, evaluation/experiments, UI and cloud infrastructure are not implemented.
