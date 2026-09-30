# AETHER Research Plan

## Primary V0 hypothesis

H1:
A structured Edit Contract + Editorial Plan improves constraint adherence and semantic preservation compared with direct model-to-tool editing.

Null hypothesis:
There is no meaningful improvement after controlling for model, media, tools, kernel, renderer and verifier.

## Experiment 001

### Source material
Start with one 3-8 minute, single-camera talking-head/interview video containing:
- a clear main argument
- repetition
- pauses
- at least one tangent
- one important qualification/caveat
- a conclusion or recommendation

### Example task
"Shorten this interview to 2:30-3:00. Preserve the speaker's main argument and final recommendation. Remove repetition and unnecessary pauses. Do not remove the qualification about junior engineers."

### Baseline path
User request
-> model
-> same read/edit tools
-> same kernel
-> output

### AETHER path
User request
-> Edit Contract
-> Editorial Plan
-> compiler
-> same read/edit tools
-> same kernel
-> output

## Controls
Both conditions must use the same:
- underlying model
- source video/transcript
- temperature/sampling settings where applicable
- read tools
- edit tools
- editing kernel
- renderer
- verifier
- resource budget as closely as practical

Any deviation must be recorded.

## Objective metrics
Track at minimum:
- target duration satisfied
- protected/required segment retained
- invalid operations
- source-range violations
- hard-constraint violations
- number of edit operations
- number of retries/repairs
- model/tool-call cost if available
- wall-clock runtime if available

## Semantic/model-assisted metrics
Evaluate:
- central argument preservation
- qualification/caveat preservation
- narrative coherence
- accidental meaning distortion

The verifier should be given relevant source context around edited material, not only the final cut.

## Human evaluation
Use blind labels: Version A / Version B.
Do not reveal which is Baseline or AETHER until answers are submitted.

Questions:
- Which version better preserves the speaker's meaning?
- Which version is more coherent?
- Which version feels more naturally edited?
- Which version would you publish?
- Did either version remove an important qualification?

## Research discipline
Do not add the full Intent Graph in Experiment 001.
First test whether the simpler structured layer (Edit Contract + Editorial Plan) creates measurable value.

Potential later experiments:
- proof-carrying semantic edits
- persistent Intent Graph for iterative revision
- uncertainty-routed human review
- preview probes / counterfactual verification
