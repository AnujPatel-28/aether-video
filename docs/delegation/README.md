# Delegating work to smaller or free models

AETHER is built mainly by agents. The **lead agent** owns architecture, invariants, research integrity and review. **Worker models** (smaller or free) take narrow, test-defined tasks. The **human owner** approves plans and does what agents must not do.

## Who does what

| Role | Owns | Never |
| --- | --- | --- |
| Human owner | Approving ExecPlans and proposals; source videos, consent and rights; recruiting independent annotators and raters; API budget; git push | — |
| Lead agent | ExecPlans; Core and kernel; invariants; evaluator; experiment design; task packets *and their acceptance tests*; review and merge | Grading its own experiment; writing gold annotations |
| Worker model | Implementing one packet so that its given tests pass | Touching anything outside the packet's file list |
| Independent annotator/rater (human) | Gold annotations; blind human ratings | Seeing which arm produced which output |

## Never delegate to a worker model

- `packages/core/**`: kernel, schemas, hashing, timing.
- `packages/verification/src/evaluator.ts` and anything that touches EvaluationSpec, gold data or diagnostics.
- `docs/research.md`, proposals and ExecPlans: workers may draft, but the lead rewrites and the owner approves.
- Experiment execution, run configuration and analysis.
- Anything that needs secrets, git push or network access.

**Never send source media, transcripts or gold data to a free provider.** Free tiers commonly allow training on inputs. Workers get synthetic fixtures only.

## Workflow

1. The lead writes the packet, **including the acceptance tests**, and commits the tests first. The tests are the contract.
2. The worker receives only the packet text and the files it lists. It returns complete file contents or a unified diff.
3. The lead applies the result on a branch, then runs `pnpm typecheck && pnpm build && pnpm test`.
4. The lead reviews the diff against the packet's file list and rules. Reject any edit outside the listed files, any test change, any new dependency or any weakened check.
5. If it fails twice, the lead implements the step itself. Do not loop a worker more than twice.

Worker output is untrusted until it has passed the tests and the lead's review.

## Packet format (copy this prompt)

````text
You are implementing one small, well-defined task in a TypeScript monorepo.
Follow every rule exactly. If anything is unclear, stop and list your questions instead of guessing.

## Project facts
- TypeScript 5.9 strict, ESM ("type": "module"), NodeNext module resolution. Relative imports end in ".js".
- Node 24 built-ins only. Zod 4 is available. NO new dependencies.
- Code style: concise, small functions, no classes unless stated, no comments that restate the code.

## Task
<one paragraph: what to build and why>

## Files you may create or edit
- <exact path>
(Do not touch any other file. Do not edit tests.)

## Exact API to implement
```ts
<signatures and types, copied from the ExecPlan>
```

## Rules / invariants
- <numbered, testable rules>

## Acceptance tests (already written; they must pass unchanged)
```ts
<test file contents, or the relevant excerpt>
```

## Context you may rely on
```ts
<only the minimal type/function excerpts the task needs>
```

## Output format
Return the complete contents of each file you created or edited, each in its own fenced block headed by its path. Then list in at most 5 bullets any assumptions you made. Do not include explanations beyond that.
````

## Milestone 3 packets

These are drafts. They are issued only after the Milestone 3 ExecPlan is approved and the lead has committed each packet's tests.

### WS-01: atomic filesystem adapter

**Task.** Implement the Node `StoreFs` used by the workspace store. Every write must be atomic: write to a temp file in the same directory, then rename it over the target.

**Files:**
- `packages/workspace/src/store-fs.ts`
- `tests/workspace-store-fs.test.ts` (lead-written; do not edit)

**API:**
```ts
export interface StoreFs {
  readFile(path: string): string | undefined;          // undefined if missing
  writeFileAtomic(path: string, text: string): void;    // temp + rename, mkdir -p parent
  appendLine(path: string, line: string): void;         // line must not contain '\n'
  exists(path: string): boolean;
  createExclusive(path: string, text: string): boolean; // false if it already exists
  remove(path: string): void;                           // no error if missing
}
export function nodeStoreFs(options?: { renameRetries?: number; retryDelayMs?: number }): StoreFs;
```

**Rules:**
1. Use synchronous `node:fs` APIs only.
2. The temp name is `<target>.tmp-<pid>-<counter>` in the same directory.
3. On `EPERM`, `EBUSY` or `EACCES` from rename, retry up to `renameRetries` (default 5) with a fixed `retryDelayMs` (default 20). Use a synchronous sleep via `Atomics.wait` on a `SharedArrayBuffer`. After the last failure, delete the temp file and throw an `Error` whose `code` is `'atomic_write_failed'`.
4. Never write the target non-atomically.
5. `appendLine` throws if the line contains `\n`.
6. `createExclusive` uses flag `'wx'` and returns false on `EEXIST`.

### WS-02: fault-injecting StoreFs wrapper (test helper)

**Task.** Wrap a `StoreFs` so that the *k*-th mutating call (`writeFileAtomic`, `appendLine`, `createExclusive`, `remove`) throws before taking effect. Tests use it to prove the store is never left half-written.

**Files:**
- `tests/support/faulty-fs.ts`
- `tests/workspace-faulty-fs.test.ts` (lead-written)

**API:**
```ts
export function faultyFs(inner: StoreFs, failAtMutation: number): StoreFs & { mutations(): number };
```

**Rules:**
1. Count mutating calls starting at 1.
2. Call number `failAtMutation` throws `Error('injected_fault')` *without* calling `inner`.
3. Later calls pass through.
4. Reads are never counted or failed.

### WS-03: workspace notes storage

**Task.** Store per-workspace free-form notes with optimistic revision checks. Notes must never affect project content.

**Files:**
- `packages/workspace/src/notes.ts`
- `tests/workspace-notes.test.ts` (lead-written)

**API:**
```ts
export const NOTES_MAX_BYTES = 16 * 1024;
export type NotesResult =
  | { ok: true; revision: number; text: string }
  | { ok: false; code: 'stale_revision' | 'notes_too_large' | 'store_corrupt' };
export function readNotes(fs: StoreFs, notesPath: string): NotesResult;               // missing → { revision: 0, text: '' }
export function writeNotes(fs: StoreFs, notesPath: string, expectedRevision: number, text: string): NotesResult;
```

**Rules:**
1. The file content is the JSON `{ "schemaVersion": 1, "revision": n, "text": "..." }`, validated with Zod `strictObject`.
2. Measure size as UTF-8 bytes (`Buffer.byteLength`), not string length.
3. A revision mismatch returns `stale_revision` and writes nothing.
4. Success writes atomically with `revision + 1`.
5. Invalid JSON or schema returns `store_corrupt`.
6. Store the text verbatim: no trimming or normalization.
