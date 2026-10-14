# AETHER Editor — High-Level Design (post-V0)

Status: **Design only. Not implemented.** Each phase needs its own ExecPlan and owner approval before code. Phase V1 is gated on completion of the Experiment 001 pilot.

Date: 2026-10-14
Source: [Proposal 002](../proposals/002-agent-native-editor-vision.md). Detailed V1 design: [editor-lld.md](editor-lld.md).
Does not change: V0 scope, ProjectIR v1, Experiment 001, H1, baseline capabilities.

## 1. Goal

One editing system with two equal clients — a human editor UI and AI agents — over a single typed kernel. Neither client can mutate state except through validated `EditBatch`es. Both see the same layers, the same history and the same verification results.

## 2. Design invariants

| ID | Invariant | Enforced by |
| --- | --- | --- |
| I1 | Only the kernel produces new project state. UI, agents and macros submit `EditBatch`es. | Owner daemon is the sole writer; no state-write endpoint exists |
| I2 | The human UI surface and the agent surface are generated from **one command registry**. Neither has a command the other lacks, except presentation-only commands. | Registry parity test |
| I3 | Agents never write the accepted head. They write workspaces; promotion is a human or policy decision. | Workspace state machine (M3) + actor permissions |
| I4 | Every state change is reversible by snapshot history, not by hand-written inverse operations. | M3 receipts + immutable snapshots |
| I5 | Analysis data (beats, loudness, shots, color stats) is derived, read-only and stored outside ProjectIR. It never changes a project hash. | Separate artifact store keyed by asset `contentHash` |
| I6 | Preview may use proxies; verification and export use the single FFmpeg render path. | Renderer boundary |
| I7 | V0 stays pinned to ProjectIR v1. New capabilities live only in v2. | Schema version literal; migration is one-way and pure |
| I8 | Agent-authored tools are data, not code. | Macro interpreter in the tools layer; no `eval` / dynamic import |

## 3. System context

```text
   ┌──────────────┐        ┌───────────────────────┐
   │ Human editor │        │ AI agent (any model)  │
   │ (browser UI) │        │ via MCP / tool calls  │
   └──────┬───────┘        └───────────┬───────────┘
          │ HTTP + WebSocket            │ MCP (stdio) / tool JSON
          │ (localhost)                 │
          ▼                             ▼
   ┌─────────────────────────────────────────────────┐
   │              OWNER DAEMON (single writer)       │
   │  ┌────────────────────────────────────────────┐ │
   │  │ Command Registry (Zod schemas, one source) │ │
   │  └───────┬───────────────┬────────────────────┘ │
   │          ▼               ▼                      │
   │   Read services     Command services            │
   │   (timeline, layers,  (edit, workspace,         │
   │    diff, search)       review, macro)           │
   │          │               │                      │
   │          │        Actor/permission check        │
   │          │               ▼                      │
   │          │     Workspace store (M3)  ◄── Event bus ──► subscribers
   │          │               │                      │
   │          │               ▼                      │
   │          │     Editing kernel (pure, @aether/core)
   │          ▼                                      │
   │   Analysis store     Verification      Renderer │
   │   (derived layers)   (critics)         (FFmpeg) │
   └─────────────────────────────────────────────────┘
                      │
                      ▼
               Local filesystem (.aether/)
```

Single process, single machine, local filesystem. No cloud, no database. This matches the V0 technology rules and the M3 single-writer `owner.lock`.

## 4. Components

| Component | Package / app | Responsibility | Phase |
| --- | --- | --- | --- |
| Kernel | `@aether/core` (existing) | Pure reducer; adds v2 schema, v2 operations, `migrateV1toV2` | V1 |
| Workspace store | `@aether/workspace` (M3) | Snapshots, heads, receipts, undo/redo, fork/freeze/promote | V0 (M3) |
| Command registry | `@aether/registry` (new) | Single declaration of every command: schema, kind (read/edit/admin), required capability | V1 |
| Owner daemon | `apps/owner-daemon` (new) | Hosts registry; HTTP/WS for UI; MCP server for agents; event bus | V1 |
| Diff engine | `@aether/diff` (new, pure) | Coverage-based diff between two snapshots; change grouping | V1 |
| Review service | in daemon | Accept all / accept selected receipts / reject / request revision | V1 |
| Analysis | `@aether/analysis` (new) | Beat grid, loudness, silence, shot cuts, color stats via FFmpeg filters | V1.x |
| Renderer | `@aether/media` (M4) | Proxies, range previews, final render | V0 (M4) + V1 proxies |
| Verification | `@aether/verification` (existing) | Critics; v2 adds per-track checks | V1 |
| Editor UI | `apps/editor-web` (new) | React + Vite; timeline, layers, diff review, constraint pins | V1 |
| Macro interpreter | `@aether/tools` | Runs data-only agent-authored macros → `EditBatch` | V2 |

## 5. Key flows

### 5.1 Human edit
UI gesture → registry command (e.g. `edit.move`) → daemon builds `EditBatch { actor: human, expectedRevision }` → permission check → workspace store → kernel → new head → event `head.changed` → all clients refresh. A drag that lands off-grid is snapped by the existing `normalizeEditOperation`; the UI shows the alignment receipt.

### 5.2 Agent edit and review (the signature flow)
1. Human or policy forks a workspace for the agent with a capability set (e.g. tracks `a1, m1`; operations `trim, split, ripple_delete`).
2. Agent reads layers and transcript through registry read commands, then submits batches to **its** workspace.
3. Agent calls `workspace.submit_for_review` → state `frozen`.
4. Diff engine computes `ReviewDiff(acceptedHead, workspaceHead)`; verification runs on the workspace head.
5. UI shows the diff: per-change rationale, verifier results, A/B preview.
6. Human accepts all (promote), accepts selected changes (replay selected receipts onto accepted head through the kernel), rejects, or requests revision (comment → agent; workspace reopens).
7. If the accepted head moved since the fork and replay fails, the result is a **conflict report**, never an auto-merge.

### 5.3 Constraint pin
Human pins a range "keep" → registry command `constraint.add_lock` → becomes a `userLock` in the safety context of new workspaces and the accepted head → kernel rejects any batch that drops coverage. Soft constraints ("prefer under 3:00") go into the Edit Contract and are checked by verification, not the kernel.

### 5.4 Analysis
On ingest (M4) and on demand: `@aether/analysis` runs FFmpeg filters over the source asset, writes `analysis/<contentHash>/<kind>.v<n>.json`. Read commands expose them to UI and agents identically. Beat times are snapped to the 40 ms frame grid.

## 6. Data model overview

- **ProjectIR v2**: multiple tracks (`video`, `audio`, `music`, `caption`); clips belong to a track; per-clip typed parameter blocks (`gainDb`, later `grade`). Overlap is checked per track. Detail in LLD §2.
- **EditBatch v2**: adds `actor` and `rationale`; new operations `add_track`, `insert_clip`, `set_gain`, `link_clips`, `unlink_clips`. Detail in LLD §3.
- **Capability**: extends the existing `KernelSafetyContext.allowedOperations` with a track scope, issued per actor. This is the per-layer autonomy dial (C4); there is no second permission system.
- **ReviewDiff**: derived, never stored as truth. Detail in LLD §5.

## 7. Technology decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| UI framework | React 19 + Vite, TypeScript | Mainstream, matches monorepo language; no SSR needed |
| Timeline rendering | HTML canvas for tracks/waveforms; DOM for panels | Thousands of frames/markers; DOM would be slow |
| Client ↔ daemon | HTTP JSON for commands, WebSocket for events | Local only; simplest that supports live updates |
| Agent surface | MCP server (stdio) generated from the registry | Works with any MCP-capable model; same schemas as UI |
| Preview playback | Per-clip 540p H.264 proxies + client-side sequencing in `<video>` | No server-side render per edit; exact render stays in FFmpeg |
| Persistence | Local filesystem `.aether/` (M3 layout) | V0 rule; no database until needed |
| Schemas | Zod 4, shared by daemon, UI and MCP | One source of truth (I2) |

## 8. Phasing

| Phase | Deliverables | Gate |
| --- | --- | --- |
| V0 | Experiment 001 as specified | — |
| V1 | v2 schema + migration; registry; daemon; read-only timeline; branch review with accept-all / accept-selected / reject | Experiment 001 pilot complete |
| V1.x | Audio and music tracks; analysis (beats, loudness, silence); `snap_cut_to_beat` macro-free command; constraint pins in UI; human editing from the UI | V1 usable end to end |
| V2 | Per-actor autonomy UI; live co-presence; color stats + `apply_grade`; agent-authored macros (C7) | V1 review screen in use; H2 study designed |
| Later | Preference learning (C6) | Usage data |

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| v2 work leaks into V0 and confounds Experiment 001 | I7: V0 pinned to v1; v2 lives behind a separate schema literal; experiment runner rejects v2 projects |
| Proxy preview differs from final render | I6; export and verification always via FFmpeg path; UI labels preview as proxy |
| Partial accept produces surprising results | Replay through kernel; on any failure show conflict and keep the workspace intact |
| Agent-authored macros become code execution | I8; closed JSON grammar; bounded operation count; tests required before promotion |
| Registry parity drifts as UI grows | I2 parity test in CI fails on any unmatched command |
