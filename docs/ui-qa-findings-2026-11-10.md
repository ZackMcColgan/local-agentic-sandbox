# UI QA Sweep — Findings (2026-11-10 job, executed 2026-11-12)

Findings-only sweep. No product code changed in this PR. Evidence gathered by driving the
live prod app (http://192.168.50.254) with Playwright chromium (desktop 1280x900 and mobile
390x844 contexts), watching real tool-using turns end to end, and reading the render/state
code where the screen could not reach. Scratch probes live in `D:\AI\orchestrator-scratch\`
(qa-probe-1..7.js, qa-probe-*.json, shots/).

## Method

- Watched **this job's own live tool-using turn** end to end on desktop and mobile viewports,
  sampling screen DOM vs `/api/threads/:id` record every ~2.5s (probe-3, probe-6).
- Scanned all 20 stored thread records for zombie/divergence/disconnect-narration state (probe-4, probe-6).
- Clicked through: threads list/open/delete-confirm, Settings (Host card + Memory card),
  Projects, Skills, Builds/Tasks, fresh-load default pane (probe-1, probe-5, probe-7).
- Measured reconcile-poll cadence by request interception (probe-2, probe-7).

## Ledger verification (known issues — status after this sweep)

### UI-001 Zombie "streaming" record — NOT reproduced this sweep
Full-record scan of all 20 threads: zero records with `lastMsg.status === "streaming"` older
than 5 minutes; the only streaming record was the live turn (activeTurn presence present).
Mechanism still latent: `web-ui/lib/threads/threadStore.ts:560-596` flips streaming→incomplete
only when `!isLive`, where `isLive` trusts `presence.updatedAt` within 120s (`threadStore.ts:96-101`).
A turn that dies without `clearTurnActive` (`app/api/chat/route.ts:2223`) and leaves a fresh
presence entry stays zombie until presence ages out. Severity: high when it fires; no fresh
reproduction — keep open, do not re-scope.

### UI-002 Record-vs-screen divergence — no fresh reproduction
During the watched live turn, record (`streaming`) and screen agreed at every sample. The
class remains latent via the same reconcile path above. No new evidence.

### UI-003 Tool calls do not render live during a turn — CONFIRMED, fresh evidence
Steps: mobile viewport (390x844), open a thread, watch a live tool-using turn.
Record trace count grew 1→2→4→7→10 across samples; screen trace-row count
(`main button:has-text("Details · Expand Proof")`) stayed **0** at every sample, then rows
appear only after completion (completed thread shows 16 trace buttons, probe-4/6).
Expected: tool steps render live as they execute. Actual: nothing until turn end.
Suspected: `web-ui/components/ChatStream.tsx:1059-1060` appends traces to `currentTraces`,
but the live assistant block renders via `LiveRunBlock` (`ChatStream.tsx:2526`, `2938-2941`)
and the per-message trace rows are gated on the completed message render path
(`ChatStream.tsx:2422`). Severity: high (mobile trust — owner watches runs on phone).

### UI-006 Reconcile poll: no backoff/cap — CONFIRMED, fresh evidence
`web-ui/components/ChatStream.tsx:583-614`: fixed `setTimeout(..., 1000)` re-arm, no backoff,
no attempt cap, no total-time cap; runs while `reconcilingThreadId` is set.
Measured: 5 GETs in 8s on a detached thread. **New sub-finding:** the poll keeps running while
ChatStream is *hidden* — navigating to Settings (`?tab=settings`) still issued 5 thread GETs
per 8s against the old thread (probe-7) because ChatStream stays mounted (`app/page.tsx:868`
hides via CSS, not unmount). Severity: medium (unbounded traffic on long detached turns).

### UI-007 Host-runner disconnects as bare narration — CONFIRMED, fresh evidence
Record-side: aborted/disconnected turns persist the marker as plain content text appended to
the assistant message: `⚠️ [Turn incomplete: Stream aborted or disconnected.]`
(`web-ui/app/api/chat/route.ts:469-471`), message `status: "incomplete"` (`route.ts:486`).
Found in record `thread-1794467217464-part1b2` (probe-6). Screen-side: the transient banner
exists only while actively reconciling (`ChatStream.tsx:1646-1652`, "Connection interrupted —
Reconciling..."); once reconciliation ends, the turn reads as bare narration with no distinct
recoverable-status affordance (no retry/resume affordance, marker is prose inside content).
Severity: medium.

### UI-008 Thread titles are raw prompt prefixes — CONFIRMED, fresh evidence
Sidebar labels verbatim: `Session: JOB — ui-qa-sweep (findings-only, docs-o`,
`Session: You are working on Zack's local-agentic-sandbox. This task was created by...`
(probe-7). Source: `web-ui/lib/threads/threadStore.ts:682` —
`title: task.goal.trim().slice(0, 40) || "New thread"`. Jobs indistinguishable at a glance.
Severity: medium-high (list usability).

### UI-009 Fresh load does not open most recently active thread — NOT reproduced
Fresh desktop context (no localStorage — keys empty) opened the most-recently-updated thread
(probe-7: `mainPaneShowsMostRecent: true`). Emulated mobile fresh context likewise opened the
most recent (probe-3). Zack's "opened an older thread twice" is consistent with phone-local
persisted state, which emulation cannot reproduce. Needs a real-device check before scoping a
fix; server-side default path (`app/page.tsx:304-332`) is correct.

### UI-010 Streamed narration concatenation without separators — NOT reproduced
Status events overwrite, not concatenate: `event.type === "status"` → `setStreamStatus(event.status)`
(`ChatStream.tsx:1032-1033`). Record content is token accumulation (`ChatStream.tsx:1048-1058`);
no run-on joins found in scanned records (probe-4 camelCase hits were identifier false-positives
like `compactionActions`, `PowerShell`). Keep open pending device observation; no fresh evidence.

### UI-011 Tool call as raw markup vs UI element — UI element present; new regression detail
Completed threads render tool steps as proper UI cards (16 trace buttons, badges "PowerShell",
"Host", durations, "Details · Expand Proof"; probe-4). Raw markup does not leak to screen
(`rawMarkupOnScreen: false`). Two fresh sub-findings under this class:
- **UI-011a (NEW): trace rows have no accessible name.** Zero `[aria-label*="Tool"]` elements;
  trace buttons carry only font-mono text (`ChatStream.tsx:2439-2443`). Screen readers get no
  tool identity. Severity: medium (a11y).
- **UI-011b: live-turn absence overlaps UI-003** — during a turn the cards are not shown at all
  (see UI-003), which is the "nothing" half of the owner correction.

### Already fixed — verified present, not re-reported
UI-004 compaction pill renders (completed thread shows pill + chips). UI-005 delete copy:
action sheet → Delete → confirm sheet → Cancel round-trip works, copy truthful (probe-2).

## Other surfaces exercised (clean or cosmetic)

- Settings (`?tab=settings` + rail click): Host card (Running/Stopped, Start/Restart, VRAM) and
  Memory card render; rail buttons Chat/Builds/Morning Report/Skills/Settings (probe-5).
  Note: Settings view keeps ChatStream mounted hidden → drives UI-006 sub-finding above.
- Projects: renders Register Folder / Allowlisted affordances; `/api/projects` returns `[]` and
  view shows "No subdirectories found" — empty state is honest, no bug.
- Skills: "Pending Review" + "No skills to review" states render; no bug.
- Builds/Tasks: Build Tier Ready, Gate Pending, Open Thread render; no bug.
- Scheduler/Tasks: no dedicated Scheduler view exists in the UI (`NavView` union in
  `components/NavigationDrawer.tsx:20` has no scheduler entry); tasks surface in Builds view.

## Proposed fix order (highest-value / smallest-first)

1. **UI-006 + hidden-view polling** — smallest: backoff/cap on the poll loop
   (`ChatStream.tsx:583-614`) and stop polling when ChatStream is not the active view.
2. **UI-008 titles** — small: derive a readable title (goal summary or first-line trim) at
   `threadStore.ts:682`; pure record-side change, sidebar benefits immediately.
3. **UI-003 / UI-011b live tool steps** — highest-value mobile fix: render trace rows in the
   live block path (`ChatStream.tsx:2422` gate / `LiveRunBlock` hosting at 2526, 2938-2941).
4. **UI-011a aria-labels on trace rows** — small a11y patch at `ChatStream.tsx:2439-2443`.
5. **UI-007 recoverable-status affordance** — medium: distinct status chip + retry affordance
   for `status: "incomplete"` records instead of bare `⚠️` prose (`route.ts:469-471` marker +
   render path in ChatStream).
6. **UI-001/UI-002 zombie/divergence** — class fix in reconcile logic (`threadStore.ts:560-596`,
   presence staleness window at 96-101); no fresh repro, fix defensively with a hard age cap.
7. **UI-009** — device check first (phone persisted state); server default path verified correct.
8. **UI-010** — device check; current code path overwrites status, no fresh evidence.
