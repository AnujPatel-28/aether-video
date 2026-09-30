# Deterministic Milestone 1 fixtures

These JSON files describe synthetic contract data only. Repeated hexadecimal digests identify mock source/transcript content; there are no corresponding media binaries or live model runs.

`project.json` contains a 100-frame, 25 fps source, two non-overlapping clips, and off-grid transcript cues. `task.json`, `safety.json`, `contract.json`, `plan.json`, `evaluation.json` and `config.json` remain separate domains. The evaluator data is imported only by trusted tests, never package Core/Tools source or their public runtime entries.

Plan/config reference digests are schema-only fixture values; reference binding and runtime orchestration are deferred. Tests always load fresh objects and do not rewrite these fixtures. Actual gold-data confidentiality will require the future runtime input boundary described in the ExecPlan, not putting fixture files in an agent-accessible project.
