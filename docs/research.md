# AETHER Research Plan

Methodology revised by approved [Proposal 001](proposals/001-experiment-001-methodology-revision.md) on 2026-10-04. H1 and the null hypothesis are unchanged.

## Primary V0 hypothesis

H1:
A structured Edit Contract + Editorial Plan improves constraint adherence and semantic preservation compared with direct model-to-tool editing.

Null hypothesis:
There is no meaningful improvement after controlling for model, media, tools, kernel, renderer and verifier.

## Experiment 001

### Source material
At least three single-camera talking-head/interview videos, 3-8 minutes each, from different speakers and topics. Each must contain:
- a clear main argument
- repetition
- pauses
- at least one tangent
- one important qualification/caveat
- a conclusion or recommendation

Use only media we have rights and consent to use.

### Task variants
Each video receives three variants:
1. Duration only.
2. Duration + preserve one qualification.
3. Multi-constraint: duration, preserve the main argument, the qualification and the recommendation, remove repetition.

Example (variant 3):
"Shorten this interview to 2:30-3:00. Preserve the speaker's main argument and final recommendation. Remove repetition and unnecessary pauses. Do not remove the qualification about junior engineers."

### Arms

| Arm | Path |
| --- | --- |
| A — Baseline | User request -> model -> shared read/edit tools + shared notes -> same kernel -> output |
| B — AETHER | User request -> Edit Contract -> Editorial Plan -> compiler -> same tools + notes -> same kernel -> output |
| C — Grounding-only (optional in pilot; required before any published H1 claim) | Baseline plus one forced pre-edit stage that writes free-form notes mapping each requirement to the source ranges found, using the same model and budget as AETHER's grounding stage. No typed schema or compiler. |

The shared notes tool (`write_notes` / `read_notes`) is untyped persistent text, identical in every arm and never parsed by the kernel or compiler. The experimental variable is **typed contract + plan + compiler versus free-form persistent notes, at equal total budget**.

Interpretation:
- B > C ≈ A: typed structure helps (supports H1).
- B ≈ C > A: the grounding pass helps, not the typing.
- B ≈ C ≈ A: no effect at this scale.

## Controls
Every arm must use the same:
- underlying model
- source video/transcript
- temperature/sampling settings where applicable
- read tools, including notes
- edit tools
- editing kernel
- renderer
- verifier
- total resource budget, as closely as practical

Neither arm's prompt preloads the full transcript. Record the prompt-construction rule in the run manifest.

Any deviation must be recorded.

## Design and analysis plan (pre-registered)

**Pilot.** 3 videos × 3 task variants × 5 paired replicates × 2 arms = 90 trials (135 with arm C). The pilot estimates variance, cost per trial and failure-stage distribution. Make no H1 claim from the pilot.

**Main run.** Size it from pilot variance and freeze its size before running.

**Pairing.** Pair by (video, task, replicate index). Record seeds where supported, but do not rely on them. Interleave run order across arms.

**Stopping.** Use a fixed trial count with no early stopping on observed scores. Record infrastructure failures as invalid and rerun them; never exclude trials selectively.

**Primary metric.** Per-trial all-hard-criteria pass (binary): all hidden retention criteria and the duration window met.

**Primary analysis.**
- Mixed-effects logistic regression of pass on arm, with random effects for video and for task within video.
- Report odds ratios and pass-rate differences with 95% confidence intervals.
- Sanity check: McNemar's test over all matched pairs.
- If arm C runs: the named comparisons are B vs A and B vs C, with Holm correction. A vs C is exploratory.

All secondary metrics are descriptive and labelled exploratory.

## Objective metrics
Track at minimum:
- all-hard-criteria pass (primary)
- target duration satisfied
- protected/required segment retained
- invalid operations
- source-range violations
- hard-constraint violations
- number of edit operations
- number of retries/repairs
- model/tool-call cost if available
- wall-clock runtime if available

## Failure-stage diagnostics
After blind grading is frozen, a separate unblinded diagnostic pass classifies each failed retention criterion:

| Stage | Rule |
| --- | --- |
| `not_retrieved` | No content-bearing read overlapped the criterion's reference ranges |
| `retrieved_not_kept` | A content-bearing read overlapped it, but final coverage dropped it and no durable intent said to keep it |
| `intended_not_executed` | Durable intent (an AETHER plan selection or a notes entry) said keep it, but final coverage dropped it |

Definitions and isolation rules:
- **Content-bearing read** means only `search_transcript`, `inspect_segment` or `preview_range` results that returned overlapping transcript text or media. Timeline, task and receipt ranges do not count.
- **Overlap** means any non-empty intersection of half-open source ranges.
- **Isolation:** diagnostics write a separate output, never modify graded results, and never reach agents.
- **Baseline asymmetry:** without baseline notes, `intended_not_executed` cannot be detected for the baseline. Report the asymmetry; do not impute.

## Semantic/model-assisted metrics
Evaluate with binary (yes/no) rubric items tied to source context:
- central argument preservation
- qualification/caveat preservation, with its scope intact
- narrative coherence: does any reference lose its referent?
- accidental meaning distortion: is any claim stated more strongly than in the source?

The verifier should be given relevant source context around edited material, not only the final cut.

## Human evaluation
Use blind labels: Version A / Version B.
Do not reveal which is Baseline or AETHER until answers are submitted.

Questions:
- Which version better preserves the speaker's meaning?
- Which version is more coherent?
- Which version feels more naturally edited?
- Which version would you publish?
- Did either version remove an important qualification? (yes/no per version, and which)

Gold annotations and human ratings must come from people independent of whoever builds and operates the agents.

## Research discipline
Do not add the full Intent Graph in Experiment 001.
First test whether the simpler structured layer (Edit Contract + Editorial Plan) creates measurable value.

Potential later experiments:
- proof-carrying semantic edits
- persistent Intent Graph for iterative revision
- uncertainty-routed human review
- preview probes / counterfactual verification
