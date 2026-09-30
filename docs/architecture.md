# AETHER V0 Architecture

## Goal
Build the smallest research harness that can fairly compare:

### Baseline
Natural-language request -> model -> editing tools -> editing kernel

### AETHER
Natural-language request -> Edit Contract -> Editorial Plan -> compiler -> same editing tools -> same editing kernel

The objective is not to build a full editor. It is to test whether structured editorial intent improves reliability and constraint adherence.

## Core flow

Source video
-> ingestion
-> transcript + metadata
-> semantic segments / media memory

User request
-> experiment runner
-> either Baseline or AETHER planner
-> typed EditOperation[]
-> schema validation
-> editing kernel
-> workspace state
-> FFmpeg preview/render
-> verification
-> comparison report

## Core abstractions

### ProjectIR
Durable source of truth for project state. V0 should contain only what is required for a single-sequence, single-camera talking-head workflow.

### MediaSegment
A semantically useful source-media range with:
- stable id
- source asset id
- source time range
- transcript text
- optional speaker
- optional summary/tags

### EditContract
Machine-readable interpretation of a complex user request:
- objective
- target duration
- preserve
- protect
- allow
- avoid
- autonomy
- success criteria

### EditorialPlan
A structured plan derived from the contract and media memory:
- selected segments
- removed segments
- reorderings
- rationale
- unresolved questions
- estimated duration

### EditOperation
The only normal path for modifying timeline state.

Initial operation set:
- split
- trim
- delete
- ripple_delete
- move

### Editing Kernel
Applies validated operations and enforces invariants.

Required V0 invariants:
- no negative duration
- no source range outside source media
- no invalid timeline references
- protected content cannot be removed when represented as a hard constraint
- state-changing operations are reversible
- agents cannot write timeline state directly

### Agent Workspace
A temporary branch of project state used for experimentation before commit.
It may contain candidate operations and previews without mutating the accepted project state.

### VerificationResult
Structured result of a deterministic or model-assisted check:
- check id/type
- status: pass | fail | review
- evidence
- optional confidence

## Read tools matter
The agent should retrieve before editing. V0 should make room for:
- get_timeline
- get_contract
- search_transcript
- inspect_segment
- preview_range

Do not load the full source video or full transcript into every model call when retrieval can answer the question.

## Rendering
V0 uses FFmpeg/ffprobe underneath the kernel/renderer boundary.
Agents should not normally emit arbitrary FFmpeg shell commands.

## Technology
Prefer:
- TypeScript
- Node.js
- Zod runtime schemas
- pnpm monorepo
- FFmpeg / ffprobe
- local filesystem initially
- PostgreSQL only when persistence is genuinely needed

Avoid cloud architecture until the experiment requires it.
