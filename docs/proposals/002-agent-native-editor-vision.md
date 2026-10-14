# Proposal 002 — Agent-native editor vision (post-V0 roadmap)

Status: **Decisions taken by the lead agent under owner delegation (2026-10-14).** The owner asked the lead to make the architecture decisions. Nothing is implemented; each phase still needs its own ExecPlan and owner approval before code.

Design: [HLD](../design/editor-hld.md) · [LLD (V1)](../design/editor-lld.md).

Date: 2026-10-14
Affects: long-term roadmap only; forward-compatibility notes for `docs/architecture.md`.
Does not affect: H1, Experiment 001, V0 scope, baseline capabilities, the kernel's V0 operation set, or the evaluation methodology. Nothing in this proposal is implemented in V0.

## Summary

Existing editors (Premiere, DaVinci Resolve, CapCut, Descript) were designed for a human with a mouse. AI was added afterwards as plugins, chat panels or MCP wrappers around a human-shaped UI. The agent is a guest in those tools: it cannot reliably see state, explain edits, be partially undone, or be checked.

This proposal sets the post-V0 direction: **an editor where the human UI and the agent API are two equal views over one typed editing kernel.** Neither is bolted onto the other.

The core analogy is software engineering. Coding agents work because code has three properties video lacks:

| Software | Video today | AETHER equivalent |
| --- | --- | --- |
| Text source an agent can read and write | Opaque project files and pixels | ProjectIR + semantic layers |
| Version control (branches, diffs, review) | Undo stack only | Agent Workspaces + video diff |
| Tests | Human eyeballing | Verification critics + hard constraints |

V0 already builds the first column's foundations. This proposal describes what to build on them once Experiment 001 has produced a result.

## Principles

1. **One edit language.** A human drag, a keyboard shortcut and an agent instruction all compile to the same typed `EditOperation`s. Same validation, same history, same undo, same permissions. The UI never writes state directly — exactly the rule agents already follow.
2. **Agents propose; humans and verifiers dispose.** An agent never edits the accepted timeline. It works in a workspace branch and submits it for review, like a pull request.
3. **Every layer is readable by both.** Anything the human sees as visuals (clips, waveforms, color, beats) the agent can query as data, and vice versa.
4. **Intent is visible and enforceable.** Constraints from the Edit Contract appear on the timeline (locks, pins, protected ranges). The kernel and verifiers enforce them for humans and agents alike.
5. **Autonomy is a per-layer dial, not a global switch.**

## Capabilities

### C1 — Multi-track timeline with semantic layers
Video, audio, music and caption tracks, each with a human view and an agent-queryable data form:

| Layer | Human sees | Agent reads |
| --- | --- | --- |
| Transcript | Text aligned to clips | Searchable segments with source ranges |
| Shots | Thumbnails, cut marks | Shot boundaries, framing, faces |
| Music | Waveform, beat markers | Beat grid, downbeats, tempo, sections |
| Audio | Waveform, levels | Loudness (LUFS), silence ranges, speech/music masks |
| Color | Scopes, LUT preview | Per-shot color statistics, applied grade parameters |

Requires new typed operations (e.g. `add_track`, `set_clip_audio_gain`, `apply_grade`, `snap_cut_to_beat`), each meeting the existing kernel rules: validated, invariant-preserving, reversible, deterministically tested.

### C2 — Video diff and branch review
The signature screen. An agent's workspace is shown against the accepted timeline:
- removed ranges in red, added in green, moved shown as arrows;
- each change carries the agent's rationale and the plan item it came from;
- verifier results inline (e.g. "qualification at 02:14 retained ✓");
- side-by-side or A/B preview;
- accept all, accept per change, reject, or ask for a revision.

### C3 — Intent on the timeline
Humans can pin "keep this", lock a region, or mark "must stay under 3:00". These become hard or soft constraints in the Edit Contract. When an agent cannot satisfy a constraint it reports the conflict instead of silently breaking it.

### C4 — Per-layer autonomy
Examples: the agent owns color matching and beat-synced music cuts while the human owns story; or full auto; or suggest-only. Autonomy is part of the Edit Contract (the `autonomy` field already exists) and is enforced by the kernel's permission check, not by prompt wording.

### C5 — Live co-presence
The agent's cursor and active workspace are visible on the timeline (Figma-style). The human can pause, interrupt or take over at any time. Human edits made while an agent works are rebased into its workspace or flagged as conflicts.

### C6 — Preference learning from corrections
When a human repeatedly overrides the same kind of agent edit (undoes J-cuts, warms grades, tightens pauses), the system proposes a saved preference. Accepted preferences become soft constraints in future contracts. Nothing is learned silently.

### C7 — Agent-authored tools (self-extending tool surface)
When an agent hits a recurring difficulty it may author a **composite tool** for it — for example `remove_filler_words`, `tighten_pauses(maxGap)`, or `cut_on_beat(track, every)`.

Safety model:
- A composite tool is a **program over existing typed operations and read tools only**. It compiles to ordinary `EditOperation[]`; it can never call FFmpeg, touch files, or write state directly.
- It runs only inside a workspace and goes through the same validation and verification as any other edit.
- It is versioned, has deterministic tests the agent must write alongside it, and starts as **workspace-local**.
- Promotion to the shared tool library requires human approval (and passing tests). Promoted tools show their author, version and test results.
- A tool library is a confound for research: any experiment must freeze the tool set per run and record it in the run manifest, with the same set given to every arm.

This is the "AI builds what it needs for the problem it is solving" idea, without giving up the core rule that only the kernel mutates state.

## Research angle (future, not Experiment 001)

Possible later hypotheses, each needing its own proposal and pre-registration:
- **H2 (review):** branch-and-diff review lets humans reach a target edit with fewer corrections and less time than chat-based editing with the same agent.
- **H3 (self-extension):** agents allowed to author verified composite tools outperform agents with a fixed tool surface on repeated task families, at equal budget.

## Phasing

| Phase | Scope | Gate |
| --- | --- | --- |
| V0 (now) | Experiment 001 exactly as specified. No UI, no new layers. | — |
| V0 forward-compat | Keep ProjectIR and operation schemas extensible (track ids, typed parameter blocks) so C1 does not require a rewrite. Document only; no new V0 operations. | Owner approval of this proposal |
| V1 | Minimal web UI: read-only timeline + C2 branch review over the V0 kernel. | Experiment 001 pilot complete |
| V1.x | C1 audio/music layers and beat grid; C3 pins/locks in UI. | V1 usable end to end |
| V2 | C4 autonomy dial, C5 co-presence, C1 color, C7 agent-authored tools. | H2 study design approved |
| Later | C6 preference learning. | Enough usage data |

## Out of scope even in this vision (per AGENTS.md, unless separately requested)
Multicam, motion graphics, generative video, advanced object tracking, production auth/billing, complex cloud infrastructure. A Premiere-like UI is only pursued through the phased, gated plan above.

## Decisions (lead agent, delegated by owner on 2026-10-14)

1. **Phasing: approved as written, with audio and music before color.** The Experiment 001 material is talking-head video that already has an audio stream, so audio and music layers reuse existing media and analysis (FFmpeg `ebur128`, `silencedetect`). Color needs new grade parameters, scopes and a render-path change. It is the higher-risk layer, so it moves to V2.
2. **Forward compatibility: no fields are added to ProjectIR v1.** v1 is a `strictObject` with `schemaVersion: 1` and is hashed canonically. Adding fields would change hashes and break Experiment 001 reproducibility. Instead, ProjectIR v2 is a separate schema with a pure, one-way `migrateV1toV2` (LLD §2). `docs/architecture.md` gets only a pointer section marked post-V0.
3. **C7 (agent-authored tools): on the roadmap, gated to V2.** It changes the tool surface, which is a research confound, so it starts only after the V1 review screen is in use and the H2 study is designed. Macros are data-only JSON interpreted by the tools layer, never executed code (HLD I8, LLD §11).
