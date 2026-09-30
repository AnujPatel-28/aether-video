# AETHER V0.1 — Milestone 1

A local research foundation for comparing direct model-to-tool video editing with structured Edit Contract / Editorial Plan / compiler orchestration. Only contracts, canonical project identity, package boundaries, and deterministic tests are implemented.

## Setup and checks

Use **Node 24.12.0** and **pnpm 11.19.0** (pinned in `.node-version` and `package.json`). Dependencies are pinned to TypeScript 5.9.3, Zod 4.1.13, and `@types/node` 24.10.1; the pnpm lockfile records their exact resolution. Select the pinned Node version with your preferred version manager before running commands.

From the repository root:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

`typecheck` first builds workspace declarations so it also works from a fresh checkout. `test` uses Node's test runner on the compiled TypeScript tests; run `build` after changing sources/tests. No FFmpeg installation, media files, API keys, cloud service or database is required for Milestone 1.

pnpm settings live in `pnpm-workspace.yaml`, including engine compatibility checks against the selected Node pin. See the [pnpm settings documentation](https://pnpm.io/settings/cli). The test suite checks the actual Node runtime, not only the manifest text.

## Contract boundaries

| Entry point | Contents |
| --- | --- |
| `@aether/core` | Task-independent ProjectIR/media/timeline schemas, separate safety/user-lock and command schemas, canonical serialization and hashing |
| `@aether/tools` | Agent-visible TaskInstructions only; no tool implementation yet |
| `@aether/tools/orchestration` | Optional AETHER EditContract and EditorialPlan; not exported from the shared agent entry |
| `@aether/workspace` | SnapshotRef / AgentWorkspace shapes only; no persistence/history |
| `@aether/verification` | Public mechanical result shape only |
| `@aether/verification/evaluator` | Hidden EvaluationSpec / ExperimentConfig and editorial result shapes; no evaluator implementation |
| `@aether/media`, `@aether/harness-cli` | Empty package boundaries reserved for later milestones |

The evaluator subpath is a trusted interface, not an OS security boundary. Core/Tools dependency and import-closure tests prevent accidental imports; future model callbacks must expose only visible inputs and shared tools. Ordinary editorial requests do not create user locks. No hidden score can currently affect project content or edit behavior because no editor/evaluator is implemented.

## Canonical project identity

An asset's logical reference is `assets/<lowercase SHA-256 source digest>`, with no filename extension or host directory. Its ID is `asset-<same digest>`. Absolute paths, traversal, backslashes, alternate spellings and digest mismatches are rejected. A future trusted storage resolver may locate those assets under any local project root; the host location is outside ProjectIR.

`serializeProjectIR` validates the project, sorts assets/segments by stable ID and clips by timeline position/ID, then emits UTF-8-compatible canonical JSON with lexically sorted object keys. It does not mutate the input. Generic arrays preserve order; these project collections are treated as keyed entities. Optional undefined object fields are omitted, signed zero is normalized to zero, and Unicode bytes are preserved without text normalization. Unsupported non-JSON values/cycles are rejected.

`hashProjectIR` computes SHA-256 over that serialization. It accepts only ProjectIR, not a combined run envelope. Visible instructions, safety/locks, inferred contracts/plans, evaluator annotations and host storage location are separate objects. Source metadata, transcript content, project/sequence/clip identity and effective timeline position remain meaningful project content.

Static schemas support the approved 25 fps CFR / 48 kHz profile: source extent equals frame count × 40 ms, clip times are aligned, source references resolve, and timelines do not overlap. Transcript cue times can be off-grid. These are declarative data checks; frame alignment, operation execution, transactions, undo/history, rendering, model integration and evaluation remain unimplemented.

The [ExecPlan](docs/execplans/v0.1-foundation.md) records approval, implementation results and remaining milestones. Stop at Milestone 1 until further authorization.
