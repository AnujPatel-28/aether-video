# AETHER Research Repository

AETHER is an experimental human-agent video editing architecture.

## Core principle
No LLM or agent may mutate project or timeline state directly.
All project modifications must flow through typed EditOperation commands validated by the editing kernel.

## V0 research integrity
The baseline and AETHER paths must use the same:
- model
- source media
- editing tool surface
- editing kernel
- render path
- verification framework

Only the orchestration/representation layer may differ in Experiment 001.

Do not silently change:
- the research hypothesis
- evaluation methodology
- core project abstractions
- baseline capabilities

Document proposed changes before implementing them.

## Scope
V0 is a research harness, not a full video editor.

Do not add unless explicitly requested:
- multicam
- motion graphics
- generative video
- advanced object tracking
- multi-agent orchestration
- production auth/billing
- complex cloud infrastructure
- a full Premiere-like UI

## Architecture docs
Read `docs/architecture.md` before changing shared schemas or package boundaries.
Read `docs/research.md` before changing experiments or evaluation.

## Planning
For substantial work, create an ExecPlan first.
For the first task, produce the ExecPlan only. Do not implement.

## Verification
Every state-changing kernel operation must:
- validate inputs
- preserve invariants
- be reversible
- have deterministic tests
