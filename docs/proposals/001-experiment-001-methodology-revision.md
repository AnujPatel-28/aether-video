# Proposal 001 — Experiment 001 methodology revision

Status: **Approved** by the project owner on 2026-10-04. Applied to `docs/research.md`, with the ExecPlan impact recorded in `docs/execplans/v0.1-foundation.md`.

Open decision 1 is resolved: P2 is approved. Open decision 2 is resolved as written: arm C runs in the pilot only if the budget allows, and it is mandatory before any published H1 claim. Decisions 3 (sources and annotators) and 4 (model and budget) must be settled before the pilot. They do not block Milestones 3–5.

Date: 2026-10-04
Affects: `docs/research.md` (Experiment 001), shared tool surface in `docs/execplans/v0.1-foundation.md`, evaluator outputs.
Does not affect: H1 wording, ProjectIR, kernel, operations, workspace semantics, evaluator independence or blind human evaluation.

## Summary

Five changes so that Experiment 001 produces an interpretable answer whether H1 holds or not:

| ID | Change | Why |
| --- | --- | --- |
| P1 | Record the **failure stage** of every missed criterion (not seen / seen but cut / intended but mis-executed) | The measured bottleneck in comparable work is retrieval, not constraint adherence |
| P2 | Add one **shared, untyped persistent notes tool** to both arms | Separates "persistent structure helps" (known) from "typed structure helps" (H1) |
| P3 | Add an optional **grounding-only ablation arm** | AETHER's `inferredRanges` grounding step can win on its own; attribution needs an ablation |
| P4 | **Multiple videos, tasks and repeated paired runs**, with a pre-registered analysis | One video and one task cannot separate H1 from model variance |
| P5 | **Binary rubric items** for semantic and human evaluation | Continuous judge scores are noisy; binary items are auditable |

## Motivation

AgenticVBench (arXiv 2605.27705) is the closest external evidence:

- The best agent stack is around 30% overall. In Repurpose, the family closest to Experiment 001, the best agent scored 0.30 against 0.95 for human experts.
- Holding the model fixed, changing the harness moved Assembly scores by up to 0.20 (0.38 / 0.37 / 0.18).
- Repurpose failures were 83% long-context information loss, 10% modality misalignment and 6% hallucinated grounding. Repair failures were 65% temporal reasoning (valid render, wrong cut window).
- Harnesses with persistent plan/todo tools kept models competitive. The authors recommend binary expert rubric items.

Implications for AETHER:

1. H1 targets planning and constraint representation. If both arms mostly fail because they never found the caveat, H1 receives a null result for reasons unrelated to H1. P1 makes that visible.
2. The current baseline may plan only "informally in ordinary dialogue" (ExecPlan, *Shared tools and information flow*), and dialogue plans are exactly what long-context loss erodes. A win for AETHER could therefore mean "any persistent plan helps," which is already known. P2 controls for it.
3. `IntentItemSchema.inferredRanges` (`packages/tools/src/orchestration.ts`) gives AETHER an explicit intent-to-source grounding stage. Under equal total budget this is a legitimate part of the treatment, but on its own it cannot show whether *typed structure* or *a forced grounding pass* caused the effect. P3 provides that attribution.

## P1 — Failure-stage attribution

Failure-stage attribution is a **separate, unblinded diagnostic pass**, not part of the blind evaluator. The ExecPlan requires the evaluator to see no planner identity, dialogue, contract/plan or rationale. Attribution needs traces and plans, and a plan reveals the condition, so it must stay outside grading.

Order and isolation:

1. Blind primary grading runs and its results are frozen and hashed.
2. Only then does the diagnostic pass read the public traces, the agent's notes/plan artifacts and the hidden spec.
3. Diagnostic output goes to its own file (`diagnostics.json` under the evaluation run). It never modifies or feeds back into graded results, and it never reaches agents.

For every retention criterion the frozen grade marks as failed, assign exactly one stage:

| Stage | Deterministic rule |
| --- | --- |
| `not_retrieved` | No content-bearing read overlapped any of the criterion's `referenceRanges` |
| `retrieved_not_kept` | A content-bearing read overlapped a reference range, but final coverage does not retain it, and no durable intent said to keep it |
| `intended_not_executed` | The agent's durable intent (an AETHER plan selection, or a notes entry naming the segment as kept) says keep it, but final coverage does not |

Definitions:

- **Content-bearing read** means only `search_transcript`, `inspect_segment` or `preview_range` results that returned transcript text or media overlapping the range.
  - `get_timeline`, `get_task` and edit receipts carry source ranges without content, so they do **not** count. Otherwise every criterion would count as retrieved at the first timeline read.
- **Precondition:** neither arm's prompt preloads the full transcript. If one did, every criterion would be "retrieved" and P1 would be meaningless. Record the prompt-construction rule in the run manifest.
- **Overlap** means any non-empty intersection of half-open source ranges. Report this rule with the results.
- **Baseline asymmetry:** `intended_not_executed` for the baseline depends on P2 notes. Without them, baseline failures resolve to the first two stages only. Report the asymmetry; do not impute.

## P2 — Shared persistent notes tool

Add to the shared tool surface, identical in both arms:

- `write_notes(workspaceId, text)` replaces the workspace's free-form notes (bounded size).
- `read_notes(workspaceId)` returns them.

Rules:

- Notes are untyped text, never parsed by the kernel or compiler, and confer no privileges. They are the same as existing "notes/rationale" trace metadata, made persistent and re-readable.
- AETHER also receives the tool. Its EditContract and EditorialPlan remain its orchestration artifacts, not shared tools.
- The experimental variable becomes: **typed contract + plan + compiler versus free-form persistent notes, at equal total budget.**
- This strengthens baseline capability. Under AGENTS.md it must be declared, which this proposal does.

## P3 — Grounding-only ablation arm (optional, pilot decides)

| Arm | Description |
| --- | --- |
| A — Baseline | Shared tools + notes (P2) |
| B — AETHER | Contract → Plan → compiler, shared tools + notes |
| C — Grounding-only | Baseline plus one forced pre-edit stage: "write free-form notes mapping each requirement to source ranges you found," using the same model and budget as AETHER's grounding stage, with no typed schema or compiler |

Interpretation:

- B > C ≈ A: typed structure helps (supports H1).
- B ≈ C > A: the grounding pass helps, not the typing (H1 not supported as stated; still a useful finding).
- B ≈ C ≈ A: no effect at this scale.

Run C in the pilot only if budget allows. It becomes mandatory before any published H1 claim.

## P4 — Sample size and pre-registered design

Replace "one 3–8 minute video" in `docs/research.md` with:

**Sources.** At least 3 single-camera talking-head videos, 3–8 minutes each, from different speakers and topics. Each must contain a main argument, repetition, pauses, a tangent, one load-bearing qualification and a conclusion. Use only media we have rights and consent to use.

**Tasks.** Three task variants per video:

1. Duration only.
2. Duration + preserve one qualification.
3. Multi-constraint: duration, preserve the argument, the qualification and the recommendation, remove repetition.

**Pilot.** 3 videos × 3 tasks × 5 paired runs × 2 arms = **90 trials** (135 with arm C). Use the pilot to estimate variance, cost per trial and failure-stage distribution. Make no H1 claim from the pilot.

**Main run.** Size the main run from pilot variance and freeze it before running.

**Pairing.** Each (video, task, replicate index) runs in every arm with identical inputs and budget. Record seeds where the provider supports them, but do not rely on them: hosted APIs do not guarantee seeded determinism, so pairing by seed is mostly nominal. Interleave run order across arms rather than running each arm in a block.

**Primary metric.** Per-trial **all-hard-criteria pass**: binary; all hidden retention criteria and duration window met.

**Secondary metrics.** The existing objective metrics in `docs/research.md`, failure-stage distribution (P1), total cost, and binary semantic items (P5).

**Analysis, pre-registered before main runs.**

- **Primary:** mixed-effects logistic regression of the pass outcome on arm, with random effects for video and for task within video. This accounts for clustering of replicates within each (video, task) cell. Report odds ratios and pass-rate differences with 95% confidence intervals, not only p-values.
- **Sanity check:** McNemar's test over all matched (video, task, replicate) pairs.
- **If arm C runs:** the named comparisons are B vs A and B vs C, with a Holm correction across those two. A vs C is exploratory.
- Secondary metrics are descriptive and labelled exploratory.

**Stopping rule.** Fixed trial count; no early stopping on observed scores. Record infrastructure failures as invalid and rerun, never as selective exclusion.

## P5 — Binary rubric items

Express semantic and human checks as yes/no items, each tied to source context. For example:

- "Is the junior-engineer qualification present with its scope intact?"
- "Is any claim stated more strongly than in the source?"
- "Does any reference ('as I said earlier') lose its referent?"

Keep the five blind human questions from `docs/research.md`. Add a binary "Did either version remove an important qualification? Which?" item where it is not already binary.

## Proposed replacement text for `docs/research.md`

If approved:

- Replace the *Source material* paragraph with the P4 *Sources* text.
- Add the arms table (P2/P3) under *Baseline path* / *AETHER path*.
- Add P1 failure stages and the P4 primary metric to *Objective metrics*.
- Add an *Analysis plan* section containing the P4 analysis and stopping rule.
- Keep H1 and the null hypothesis unchanged.

## Impact on the ExecPlan

- **Milestone 5:** add `write_notes`/`read_notes` to the shared tools. Add a separate post-freeze diagnostic entry point for P1, isolated from the blind evaluator, with its own output file and versioned rules.
- **Later experiment plan:** arm C, trial counts, run order and analysis script. These live in a new ExecPlan for Experiment 001, not in the foundation plan.
- **No kernel, ProjectIR or workspace changes.**

## Open decisions for the owner

1. Approve P2: a stronger baseline capability, declared.
2. Run arm C in the pilot, or defer it to the main run?
3. Source videos: who records them or licenses them, and who writes the gold annotations independently of whoever builds the agents?
4. Model and budget per trial for the pilot.
