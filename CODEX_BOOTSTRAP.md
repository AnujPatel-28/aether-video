# Codex Bootstrap Task

You are the primary implementation agent for AETHER, an experimental human-agent video editing research project.

Read:
1. `AGENTS.md`
2. `docs/architecture.md`
3. `docs/research.md`

## Your first task
Produce an ExecPlan for V0.1 only.

DO NOT IMPLEMENT CODE YET.

The ExecPlan must define the smallest reliable foundation required before Experiment 001.

Include:
1. proposed repository structure
2. package boundaries
3. TypeScript/Zod schemas for the minimum core objects
4. editing-kernel invariants
5. initial five edit operations
6. media-ingestion design using ffprobe/FFmpeg plus timestamped transcript input
7. Agent Workspace representation
8. reversibility/undo strategy
9. deterministic testing strategy
10. how Experiment 001 can later plug into this foundation
11. explicit non-goals
12. unresolved architectural questions and tradeoffs

## Constraints
- TypeScript + Node.js
- pnpm monorepo
- Zod for runtime validation
- FFmpeg/ffprobe for media operations
- no cloud dependency required for V0.1
- no production UI
- no Remotion yet
- no multi-agent framework
- no full Intent Graph yet
- no arbitrary model mutation of timeline state
- no arbitrary FFmpeg shell access as the normal agent edit interface

Prefer the simplest reversible design that preserves scientific comparability between Baseline and AETHER.

Save the plan as:
`docs/execplans/v0.1-foundation.md`

Stop after writing the plan. Do not scaffold packages or implement code until the plan is reviewed.
