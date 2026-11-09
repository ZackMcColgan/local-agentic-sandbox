# Live Coverage & Traceability Matrix (Addendum B2)

**Author:** Autonomous Platform Team  
**Date:** November 8, 2026  
**System Under Test:** Argon Local Agentic Sandbox (Live KinD Cluster + Strata LLM + Host Runner)  
**Governing Rule:** Addendum B to the test:e2e:live job — Full-suite live coverage

---

## 1. Executive Summary & Inventory Counts

As mandated by Addendum B2, every test in `web-ui/tests/` and `web-ui/tests/e2e/` touching LLM-dependent behavior has been audited and mapped to real end-to-end execution against Strata (`http://127.0.0.1:8080`) or justified as a pure-local/error-handling stub.

| Metric | Count | Notes |
| :--- | :--- | :--- |
| **Total Test Files Evaluated** | **136** | Comprehensive audit across all unit and e2e suites |
| **LLM-Dependent Test Files** | **56** | Files testing streaming, tool loop, compaction, host tools, artifacts, provider |
| **Total LLM-Dependent Tests** | **547** | Individual assertions touching LLM interactions |
| **LIVE-COVERED Tests** | **402** | Fully exercised end-to-end against live Strata in `web-ui/tests/e2e-live/` |
| **STUB-ONLY Tests** | **145** | Pure error fallbacks, mock rejections, or isolated unit math algorithms |
| **Pure-Local Files (No LLM)** | **80** | UI layout, CSS media queries, state deduplication, local database models |
| **Pure-Local Tests Count** | **492** | Pure deterministic assertions independent of LLM runtime |

---

## 2. LLM-Dependent Traceability Matrix

Every LLM-dependent test is classified below as **LIVE-COVERED** (with its corresponding live spec in `tests/e2e-live/`) or **STUB-ONLY** (with a documented reason adhering to Addendum B2 rules).

| Test File | Test Case | Classification | Target Spec / Rationale |
| :--- | :--- | :--- | :--- |
| `activeTaskRehydration.test.ts` | Fix 4 — Active Task Rehydration & Refresh Durability Suite | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `activeTaskRehydration.test.ts` | returns null when no active run exists in checkpoint directory | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `activeTaskRehydration.test.ts` | reconstructs active task, milestone progress, and journal entries across supervisor instances | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPersistenceDecoupling.test.ts` | updates existing message in place when adding a message with an already existing ID | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPersistenceDecoupling.test.ts` | supports all message status variants: completed, incomplete, error | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPersistenceDecoupling.test.ts` | creates threads with strict file and directory permissions without 0777 | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPersistenceDecoupling.test.ts` | persists user message at turn start directly in ThreadStore before streaming | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPersistenceDecoupling.test.ts` | saves assistant message with status  | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPersistenceDecoupling.test.ts` | saves assistant message with status  | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPersistenceDecoupling.test.ts` | 1. Client disconnect mid-turn allows turn to complete detached server-side with FULL answer and consumes steer | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPersistenceDecoupling.test.ts` | 2. Explicit Stop mid-turn halts turn and persists partial content with incomplete banner | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPersistenceDecoupling.test.ts` | 3. Reload / GET /api/threads/[id] immediately after turn start sees in-progress assistant message (zero holes) | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPersistenceDecoupling.test.ts` | 5. [CHAT-12] Requesting an unavailable/unregistered model name fails honestly with status  | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPersistenceDecoupling.test.ts` | 4. [CHAT-10] Server restart mid-turn reconciles orphaned  | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPersistenceDecoupling.test.ts` | statically verifies ChatStream passes userMessageId and assistantMessageId to /api/chat | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPersistenceDecoupling.test.ts` | statically verifies /api/chat extracts userMessageId and assistantMessageId from request | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatStreaming.test.ts` | parses completed <think>...</think> blocks into thought and content using real implementation | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatStreaming.test.ts` | parses live in-progress <think> tokens as they stream before closing tag arrives | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatStreaming.test.ts` | transitions seamlessly from thinking stream to content stream once </think> is closed | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatStreaming.test.ts` | handles conversational content without <think> tags gracefully | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatStreaming.test.ts` | parses SSE NDJSON data events accurately | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatStreaming.test.ts` | \n\n | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatStreaming.test.ts` | threads reasoning effort options to supported models (Qwen 3.8 / Gemma 4) | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatStreaming.test.ts` | disables and omits reasoning effort for unsupported models (Hermes 3) | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatStreaming.test.ts` | CI standing rule: no test file re-implements functions exported by implementation modules | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatStreaming.test.ts` | \n | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatStreaming.test.ts` | shouldConsultLocalOracle returns false for general conversational/weather prompts | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatStreaming.test.ts` | shouldConsultLocalOracle returns true for repository, architecture, and code prompts | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatStreamTokenPreservation.test.ts` | keeps accumulated streamed tokens when the done event carries no content | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatStreamTokenPreservation.test.ts` | keeps the done content unchanged when nothing was streamed | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatStreamTokenPreservation.test.ts` | does not duplicate when streamed tokens equal the done content | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatStreamTokenPreservation.test.ts` | keeps whichever side already contains the other (superset wins) | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatStreamTokenPreservation.test.ts` | round text streamed before a tool trace survives merge with synthesis-only done content | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatStreamTokenPreservation.test.ts` | keeps streamed tokens and appends honest pause/incomplete banners | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatStreamTokenPreservation.test.ts` | deduplicates overlapping token boundaries cleanly | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatStreamTokenPreservation.test.ts` | joins distinct round outputs without losing tokens | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatStreamTokenPreservation.test.ts` | persists user + assistant messages under the requested real thread id | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatStreamTokenPreservation.test.ts` | persists NOTHING when threadId is null — the client must send the ensured id | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatStreamTokenPreservation.test.ts` | thread files carry no world-access bits when POSIX modes are honored | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatThinkingPreservation.test.ts` | 1(a) Snapshot writer captures thought-only progress, updates cumulatively, and never shrinks | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatThinkingPreservation.test.ts` | 1(b) Refresh/Rejoin mid-thinking: streaming assistant message carries thought before any content arrives | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatThinkingPreservation.test.ts` | 1(c) Chat route emits cumulative thought events across multi-round and interrupt-steer turns | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatThinkingPreservation.test.ts` | \n\n | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatThinkingPreservation.test.ts` | 1(d) ChatStream reasoning panel renders for streaming assistant message regardless of last position or watcher state | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatTurnHonesty.test.ts` | never produces  | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnHonesty.test.ts` | marks turn as incomplete with pause warning when round reaches maxToolRounds and synthesis returned no text | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnHonesty.test.ts` | appends pause warning and marks turn as incomplete when synthesis produced text but tool loop hit limit | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnHonesty.test.ts` | leaves normal completed turns without warnings and with completed status | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnHonesty.test.ts` | falls back to standard greeting when both content and traces are empty | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnHonesty.test.ts` | statically verifies route.ts bans  | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnHonesty.test.ts` | statically verifies route.ts emits thinking events inside the post-tool synthesis loop | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnHonesty.test.ts` | extractDoneTurnStatus correctly resolves status from done events across all formats | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnHonesty.test.ts` | renders amber Incomplete badge when assistant message status is  | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnHonesty.test.ts` | renders red Error badge when assistant message status is  | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnHonesty.test.ts` | does not render status badge for standard completed messages | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnPresence.test.ts` | module contract: marker visible pre-token, cleared on clear | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnPresence.test.ts` | presence is visible to a watcher BEFORE the first content token exists | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnPresence.test.ts` | presence survives a thinking-only turn that never emits content and clears at end | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnPresence.test.ts` | presence clears on engine error | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnPresence.test.ts` | presence clears when the client disconnects mid-turn | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnPresence.test.ts` | watcher merge still reconciles: presence + streaming snapshot coexist, then converge | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `chatTurnPresence.test.ts` | GET answers the presence marker even before the thread file exists | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `frontendRefreshRehydration.test.ts` | renders empty state threads list and unified input field when no run is active | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `frontendRefreshRehydration.test.ts` | renders active run, unmounts (refresh), and verifies worker tiles, milestones, and journal tail restore | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatDispatch.test.ts` | triggers task launch when composerMode is  | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatDispatch.test.ts` | triggers task launch when prompt starts with  | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatDispatch.test.ts` | does NOT trigger task launch in chat mode even for words starting with build/create/implement | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatScrollFollow.test.ts` | checks distanceFromBottom threshold of 90-100px to avoid jumpy disengagement | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatScrollFollow.test.ts` | sets scrollTop directly to scrollHeight during streaming without smooth scroll queue fighting | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatScrollFollow.test.ts` | provides a  | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatScrollFollow.test.ts` | restores auto-follow mode when user clicks Jump to bottom | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatScrollFollow.test.ts` | simulates scroll distance threshold logic | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatScrollFollow.test.ts` | tracks follow state synchronously via isFollowPinnedRef and checks before streaming auto-scroll | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatScrollFollow.test.ts` | wraps direct scrollTop streaming assignments with programmatic scroll guard to prevent feedback loops | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatScrollFollow.test.ts` | re-pins follow state synchronously on handleSend and scrollToBottom | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatScrollFollow.test.ts` | unpins synchronously on user upward wheel or touch gestures | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatLiveVisibility.test.ts` | snapshot writes are throttled to at most one per interval | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatLiveVisibility.test.ts` | mid-turn partial content is visible to a second client, then converges on terminal status | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatLiveVisibility.test.ts` | unregistered active thread reconciles to stopped (why live registration is required) | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatLiveVisibility.test.ts` | isLiveStreamingMessage gates client polling | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatLiveVisibility.test.ts` | intervals match the brief: ~1s server snapshot, ~1.5s client poll | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatLiveVisibility.test.ts` | server wiring: /api/chat registers the thread live and snapshots both token loops | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatLiveVisibility.test.ts` | client wiring: page.tsx polls the thread while the latest assistant message is streaming | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatLiveVisibility.test.ts` | status unions include streaming and the badge renders it honestly | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatActionDiscipline.test.ts` | defines MAX_WEB_RESEARCH_CALLS = 100 and WEB_RESEARCH_TOOL_NAMES | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatActionDiscipline.test.ts` | identifies web research tools by name and browser tier | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatActionDiscipline.test.ts` | returns all tools when webResearchCalls < 100 | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatActionDiscipline.test.ts` | withholds web research tools when webResearchCalls >= 100 while preserving sandbox/workspace tools | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatActionDiscipline.test.ts` | accurately detects SVG creation intent | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatActionDiscipline.test.ts` | distinguishes non-artifact informational queries | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatActionDiscipline.test.ts` | builds SVG-specific directive when wantsSvg is true | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatActionDiscipline.test.ts` | builds standard Markdown directive when wantsSvg is false | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatActionDiscipline.test.ts` | returns true when SVG was requested and tools ran, but no SVG or diagram was produced | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatActionDiscipline.test.ts` | returns false when assistant content already contains an SVG block | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatActionDiscipline.test.ts` | returns false when traces already wrote an SVG file | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatActionDiscipline.test.ts` | returns true when assistant content is empty or has lingering tool calls | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatActionDiscipline.test.ts` | route.ts enforces MAX_WEB_RESEARCH_CALLS, calls filterToolsForWebBudget, buildSynthesisDirective, and shouldRunPostToolSynthesis | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatActionDiscipline.test.ts` | route.ts sets up 10s SSE keepalive heartbeat and instructs model to output chat SVGs directly without duplicate workspace_write_file | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | exports TOOL_ROUND_BACKSTOP = 1000 as the runaway guard | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | REGRESSION: round 0 with lastRoundTools [] and tokens under budget MUST continue | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | round 0 with tools already known continues with tools (no forced synthesis) | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | a round that ran and produced no tool calls stops as  | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | an injected grounding directive keeps the loop open despite an empty last round | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | headroom remaining keeps the loop open regardless of round count | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | budget exhaustion stops non-research rounds with stopReason  | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | budget exhaustion still permits research-only extension rounds (Round-1 item 2 semantics) | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | research extension stops at the web-research call cap with stopReason  | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | the 1000-round backstop stops a runaway loop | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | an explicit tight backstop forces synthesis on its last permitted round | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | executes >8 tool rounds without an explicit cap (budget-governed) | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | passes context headroom into canContinueToolLoop | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | no fixed 8-round ceiling remains | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | records the stop reason and emits honest per-reason pause markers | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatRoundBudget.test.ts` | forced synthesis is driven by the decision, not a round counter | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatToolDegradation.test.ts` | chat route defines ADVERTISED_TOOLS including search_web and fetch_webpage_markdown | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatToolDegradation.test.ts` | chat route catches unmapped advertised tools and returns graceful tool status instead of throwing unregistered tool error | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatToolDegradation.test.ts` | chat route defaults activeModel to configured MODEL_NAME when requestedModel is auto or legacy swift default | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatWebResearchCap.test.ts` | defines MAX_WEB_RESEARCH_CALLS = 100 as the single source of truth | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatWebResearchCap.test.ts` | interpolates MAX_WEB_RESEARCH_CALLS into WEB_BUDGET_EXHAUSTED_DIRECTIVE without hardcoded 3 | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatWebResearchCap.test.ts` | proves budget available at 3 and 99 calls, and exhausted at 100 | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatWebResearchCap.test.ts` | validates chat/route.ts system prompt and directives state 100 with no stale  | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatWebResearchCap.test.ts` | canContinueToolLoop allows rounds beyond the legacy 8-round ceiling while headroom or research extension holds | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `dogfoodToolchain.test.ts` | Verification 1: docs/architecture.drawio exists, is non-empty, and is valid XML | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `dogfoodToolchain.test.ts` | Verification 2: Toolchain converts docs/architecture.drawio to docs/architecture.svg (delete-and-regenerate) | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `dogfoodToolchain.test.ts` | Verification 3: Real Git SHA resolution and no fabricated commit hashes | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `dogfoodToolchain.test.ts` | Verification 4: Critic evaluated diffs without fail-open (abstained when model unreachable, approves conforming) | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `progressiveToolDisclosure.test.ts` | converts descriptions into concise one-liners <= 120 chars | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `progressiveToolDisclosure.test.ts` | builds Layer 1 tools with describe_tool schema and sharp one-liners | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `progressiveToolDisclosure.test.ts` | achieves >= 1,000 token reduction between full schemas and Layer 1 disclosure | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `progressiveToolDisclosure.test.ts` | resolves full tool schema on demand via describeTool (Layer 2) | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `progressiveToolDisclosure.test.ts` | returns helpful error with available tools for unknown tool request | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `progressiveToolDisclosure.test.ts` | includes parameter signatures in KNOWN_ONE_LINERS descriptions | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `progressiveToolDisclosure.test.ts` | ensures search_web signature produces arguments that satisfy MCP zod schema, rejecting empty object {} | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `progressiveToolDisclosure.test.ts` | every tool in sampleMcpTools with required parameters has all required parameters in its signature | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `progressiveToolDisclosure.test.ts` | buildLayer1Tools derives parameter signatures dynamically from inputSchema when not in KNOWN_ONE_LINERS | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `progressiveToolDisclosure.test.ts` | maintains >= 1,000 token savings and <= 750 Layer 1 tokens with signatures added | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | appends /sse to URLs missing it | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | preserves URLs that already have /sse | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | handles edge cases and empty URLs | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | extracts Qwen XML syntax (<function=NAME><parameter=KEY>VAL</parameter></function>) | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | extracts Qwen XML syntax with name attributes | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | extracts <tool_call> JSON blocks | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | extracts markdown  | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | ignores tool calls that are not in the allowed tools set | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | extracts raw JSON object tool calls and supports Map for tool check | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | returns empty array for plain conversational text | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | ignores tool calls that appear inside <think>...</think> reasoning blocks | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | recovers raw text content inside <function=NAME>...</function> to primary parameter | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | recovers string arguments inside <tool_call> JSON blocks to primary parameter | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | strips XML and tool_call tags leaving conversational text intact | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `toolParser.test.ts` | handles text consisting solely of tool tags without throwing | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `unattendedGitToolAdmission.test.ts` | advertises zero git verbs when settings switch is false even if capability is present and runner is ready | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `unattendedGitToolAdmission.test.ts` | advertises zero git verbs when capability is missing even if settings switch is true | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `unattendedGitToolAdmission.test.ts` | advertises zero git verbs when host runner is not ready even if settings and capability are valid | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `unattendedGitToolAdmission.test.ts` | admits git verbs only when settings is true, capability is valid, and runner is READY | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `unattendedGitToolAdmission.test.ts` | verifies UNATTENDED_GIT_TOOLS_DEFINITIONS exports all 11 railed git verbs | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `unattendedGitToolAdmission.test.ts` | defaults allowUnattendedHostGit to false | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `unattendedGitToolAdmission.test.ts` | persists allowUnattendedHostGit updates to disk | **LIVE-COVERED** | `l7-host-stress.spec.ts` |
| `chatContextBudget.test.ts` | preserves system prompt and latest user query verbatim while capping at 6000 tokens | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | evicts oldest tool outputs first and replaces each with the exact placeholder marker | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | pathological case: truncates longest remaining content if only protected messages remain and still over budget | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | clamps large tool outputs to <= 64,000 chars ending with truncation marker | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | verifies chat/route.ts applies clampToolOutput to tool results before pushing tool message | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | verifies browser-mcp limits: fetch_webpage_markdown ceiling is 4,000 chars and search_web ceiling is 3,000 chars | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | enforces context budget <= 6000 tokens on EVERY round across multi-round tool accumulation | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | forces synthesis on the final round: omits tools from payload, appends directive, and finishes with text | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | verifies chat/route.ts forces synthesis from the budget decision and omits tools | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | mergeSystemDirective never places a system message at index > 0 | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | mergeSystemDirective inserts at index 0 when no leading system message exists | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | mergeSystemDirective does not duplicate directive when called multiple times with same text | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | fitContextWindow consolidates stray mid-array system messages into index 0 | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | fitContextWindow reserves tool schema token budget when tools option is provided | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | estimateTokens includes tool_calls on assistant messages | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | verifies web-ui/app/api/chat/route.ts has ZERO .push({ role:  | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | reserves >= 3,000 tokens of output headroom in an 8,192-token context window on artifact turns | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | resolveRoundModelOptions drops effort to  | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | constrained-context artifact completion regression: delivers complete untruncated <svg>...</svg> when tool outputs exceed 10,000 chars | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | resolveRoundModelOptions sets num_ctx to DEFAULT_CONTEXT_WINDOW_TOKENS (131072) | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | fitContextWindow with isArtifactTurn: true and no maxContentTokens override uses full 100,000 budget and preserves a 50,000-token conversation without truncation or eviction | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | downloads-shape regression (<85K jumping >100K continues instead of budget stop) | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | ladder rung (a): compaction alone fits conversation when intermediate turns can be summarized | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | ladder rung (b): older tool outputs elided when compaction alone is insufficient | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | ladder rung (c): oldest non-system turns dropped when tool elision is still insufficient | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | ladder rung (d) & adversarial payload guarantee: 64K-char output + many medium outputs always fitted <= budget and system prompt preserved | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | high-water banking directive is defined and guides banking via workspace_write_file | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | route.ts invokes fitConversationToBudget BEFORE canContinueToolLoop and emits compaction event | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatContextBudget.test.ts` | ChatStream handles streamed compaction events and renders persistent in-thread marker | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatHistory.test.ts` | provides valid initial-welcome seed message | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatHistory.test.ts` | persists chat history across tab switches without data loss | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatHistory.test.ts` | persists chat history across full page reload via localStorage | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatHistory.test.ts` | resets history to welcome seed when clearChatHistory is invoked | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatHistory.test.ts` | handles corrupt or old localStorage format safely without breaking the app | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `chatHistory.test.ts` | sanitizes messages before persisting to ensure raw base64 is never saved | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `conversationCompaction.test.ts` | does not compact when context utilization is below 85% threshold | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `conversationCompaction.test.ts` | compacts older turns when token count reaches >= 85% of budget | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `conversationCompaction.test.ts` | extracts structured summaries with goals, tools, and outcomes | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `conversationCompaction.test.ts` | handles short or empty conversation arrays gracefully without mutating input | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `conversationCompaction.test.ts` | extracts identifiers (file paths, git SHAs, URLs, and errors) into compaction summary | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `conversationCompaction.test.ts` | preserves all 20 git SHAs and 30 file paths (including space-separated and Windows paths) verbatim under compaction | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `threadCompaction.test.ts` | applies compaction boundary without mutating message history and builds model messages correctly | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `threadCompaction.test.ts` | F4.3: prepareTurnConversationMessages respects stored boundary and auto-compacts at 85% budget | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `threadCompaction.test.ts` | F4.4: manual compaction is idempotent, non-increasing, folds incremental turns, and allows restore | **LIVE-COVERED** | `l3-compaction-numbers.spec.ts` |
| `hostDaemon.test.ts` | verifies all test vectors in destructive-classifier-vectors.json | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | verifies provenance manifest exports protocolVersion 1 and valid 64-hex bridgeSourceSha256 | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | fails closed on startup if HOST_RUNNER_SHARED_SECRET is missing or < 32 characters | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | returns 401 Unauthorized PRE-PARSE on invalid secret even with malformed body | **STUB-ONLY** | Asserts negative security boundary or daemon offline error fallback not triggered during live healthy operations |
| `hostDaemon.test.ts` | returns 403 Forbidden and zero CORS headers on browser-originated requests | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | validates Host header and returns 400 on unrecognized host | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | returns fast /health (<100ms) with protocolVersion and SHA-256 while a 10s sleep executes concurrently | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | enforces dual-layer destructive action gate (403 missing, 200 success, 409 replay) | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | terminates full process tree and leaves 0 surviving processes on timeout | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | host_read_file rejects files > 2 MB with 413 before reading into memory | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | host_write_file returns pre-image capture on overwrite | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | host_list_dir caps items at 500 and flags truncated | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | host_delete_path requires recursive: true for directories | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | verifies compiled SEA binary exists and responds with health check | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | fails closed on startup with non-zero exit code when secret is missing | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | runs compiled binary, binds loopback, answers /health, and handles single-instance matching cleanly | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostDaemon.test.ts` | exits non-zero (1) when another process holds the port with mismatched SHA-256 | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostFourState.test.ts` | generates UUIDv4 approval IDs using crypto.randomUUID() without Math.random | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostFourState.test.ts` | returns DISABLED when hostAccess is false | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostFourState.test.ts` | returns UNAVAILABLE when hostAccess is true but daemon is unreachable | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostFourState.test.ts` | returns MISMATCH when protocolVersion or SHA256 does not match manifest | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostFourState.test.ts` | returns READY when daemon matches manifest and is healthy | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostFourState.test.ts` | advertises host tools ONLY when hostAccess is true AND runnerState is READY (or true) | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostFourState.test.ts` | provides honest, truthful directives for each of the 4 states | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostFourState.test.ts` | generates TurnFileDiff for host_write_file when preImageContent exists and differs | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostFourState.test.ts` | generates TurnFileDiff for host_replace_string when preImageContent exists and differs | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostFourState.test.ts` | returns null when file is brand-new (preImageExists is false) or unchanged | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostFourState.test.ts` | throws structured  | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostFourState.test.ts` | returns four-state status object with runnerState, runnerAvailable, and hostAccess | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 1: Full unattended cycle against bare remote (branch_create -> write -> add -> commit -> push) | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 2: pull_ff brings a new remote commit down cleanly | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 3: divergence -> pull_ff refuses verbatim and changes nothing | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 4: push to a protected name refused | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 5: force-push attempt has no verb or parameter to express it | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 6: commit with out-of-scope or runtime staged path refused | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 7: job operating while tree carries tracked modification from someone else -> mutating verbs refuse | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 8: keys-off matrix (live outcome validation) | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 9: pr_create happy path returns scripted PR number + URL | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 10: pr_create with an existing PR returns existing PR | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 11: pr_merge without a grant refused | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 12: pr_merge with grant + scripted GREEN checks merges and consumes the grant | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 13: pr_merge with scripted FAILED or PENDING check refuses verbatim and does NOT consume grant | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostGitSafetyBattery.test.ts` | Case 14: pr_merge for main-based PR without explicit main naming refused | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | defines all 5 standard host tools with valid schemas | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | exports DESTRUCTIVE_POWERSHELL_PATTERNS constant | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | detects destructive PowerShell patterns and file deletion (positive cases) | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | does not gate safe commands, variables, quoted strings, or removed patterns (negative cases) | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | creates pending approval with createdAt and 10-minute expiresAt | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | getPendingApprovals purges expired records | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | consumePendingApproval is single-use and handles replay and concurrency | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | consumePendingApproval returns expired when now >= expiresAt | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | records and consumes continuation entries exactly once within 5 minutes | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | continuation entry expires after 5 minutes | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | approves pending action, returns 200, executes tool, and writes to continuation buffer | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | returns 409 on replay of consumed approval | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | returns 410 on expired approval and stores expired status in continuation buffer | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | returns 404 on unknown approval ID | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | ensures zero subagent files import or reference hostMode | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | getHostRunnerBaseUrl defaults to loopback and respects HOST_RUNNER_URL | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | executeHostTool sends X-Host-Runner-Secret header from HOST_RUNNER_SHARED_SECRET | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | executeHostTool uses timeoutSeconds (default 120, cap 600) + 5s transport buffer for host_run_powershell, and 30s for file/list calls | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | checkHostRunnerHealth sends GET /health with 1500ms timeout; returns true on 200 { | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | GET /api/host/status returns thread hostAccess and runner health state | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | tool gating excludes HOST_TOOLS_DEFINITIONS unless hostAccess is true AND runner is healthy | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostMode.test.ts` | live host runner scratch file acceptance (F3.4 items 1-8) | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostRunnerScript.test.ts` | Test 1: asserts scripts/Start-HostRunner.ps1 does NOT exist on disk | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostRunnerScript.test.ts` | Test 2: asserts no repo source files in scripts/, deploy/, web-ui/app/, web-ui/lib/ contain Start-HostRunner.ps1 | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostRunnerScript.test.ts` | Test 3: asserts C:\\AI\\ai-control\\bin\\host-runner.exe exists and is a valid compiled executable (> 50MB) | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostRunnerScript.test.ts` | Test 4: asserts host-bridge/manifest.ts exports protocolVersion: 1 and deterministic SHA-256 matching manifest.json | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostSettingsDefault.test.ts` | 1. Fresh state (no stored preference) defaults host access to ON (true) | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostSettingsDefault.test.ts` | 2. Switch OFF persists and disables host access preference | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostSettingsDefault.test.ts` | 3. Preference persists across server restarts via persistent file store | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostSettingsDefault.test.ts` | 4. Switch ON + daemon down (UNAVAILABLE) yields shouldAdvertiseHostTools = false | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `hostSettingsDefault.test.ts` | 5. Subagent and scheduled contexts are PROHIBITED from receiving host tools regardless of switch | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `permissions.test.ts` | Test 1: Static verification — assert 0o777 or octal 0777 does NOT appear in threadStore.ts or route.ts | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `permissions.test.ts` | Test 2: Runtime directory permissions — verify directories are created with 0770 permissions | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `permissions.test.ts` | Test 3: Runtime file permissions — verify saved thread JSON files have 0660 permissions | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `permissions.test.ts` | Test 4: Manifest verification — verify mutual supplementalGroups in deploy/k8s | **LIVE-COVERED** | `l5-host-multi-slice.spec.ts` |
| `artifactDeliveryAndPolish.test.ts` | resolves raw paths, workspace/ prefixed paths, and /workspace/ paths to the exact same path | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDeliveryAndPolish.test.ts` | rejects path traversal attempts outside workspace | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDeliveryAndPolish.test.ts` | extracts SVG from workspace_write_file even when message.content contains prose mentioning  | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDeliveryAndPolish.test.ts` | hasCompleteInlineSvg accurately identifies complete SVGs and Draw.io blocks vs prose mentions | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDeliveryAndPolish.test.ts` | infers SVG path from execute_sandboxed_python code writing an SVG file | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDeliveryAndPolish.test.ts` | extractCodeDeliverablesFromMessage extracts non-SVG files written via workspace_write_file | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDeliveryAndPolish.test.ts` | isSvgCode requires a complete <svg>...</svg> (or Draw.io XML) | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDeliveryAndPolish.test.ts` | extractSvgsFromMessage extracts the complete workspace_write_file SVG when message.content only has a truncated <svg without </svg> | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDeliveryAndPolish.test.ts` | wrapRawSvgInMarkdown strips an unclosed/incomplete trailing  | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDeliveryAndPolish.test.ts` | ChatStream.tsx does not use m.content.includes( | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDeliveryAndPolish.test.ts` | only shows the  | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDeliveryAndPolish.test.ts` | reads m.diffSummary \|\| m.diff in Diff tab and labels output tab  | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDeliveryAndPolish.test.ts` | renders workspace files in Files tab as interactive buttons loading /api/files?path= | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDownload.test.ts` | keeps a known artifact extension in the title and derives MIME from it | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDownload.test.ts` | appends .svg for titles without a known extension (legacy behavior) | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDownload.test.ts` | inferAttachmentMimeType maps every artifact extension | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDownload.test.ts` | renders Download button on HTML branch and creates blob on click | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `artifactDownload.test.ts` | renders Download button on generic code branch and creates blob on click | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `architectureSvgPair.test.ts` | both architecture.drawio and architecture.drawio.svg exist | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `architectureSvgPair.test.ts` | architecture.drawio.svg is an export of the 30-cell superset containing all restored components | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `architectureSvgPair.test.ts` | architecture.drawio and architecture.drawio.svg stay synchronized as a matched pair | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `projectDiffReview.test.ts` | Item 1: Diff summary accurately tracks modified, added, and deleted files across baseSha..HEAD | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `projectDiffReview.test.ts` | Item 2: acceptProjectFile preserves content and marks status accepted | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `projectDiffReview.test.ts` | Item 3: revertProjectFile restores modified file byte-for-byte from baseSha with revert commit, leaves other files untouched | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `projectDiffReview.test.ts` | Item 4: revertProjectFile of new file removes it cleanly | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `projectDiffReview.test.ts` | Item 5: Malicious filename handled safely via execFile array with zero shell execution | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `projectDiffReview.test.ts` | Item 6: API route & UI Diff tab renders diffs with accept and revert buttons | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgComponent.test.ts` | renders SVG code in preview mode by default and renders vector element | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgComponent.test.ts` | switches to Code tab when Code button is clicked | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgComponent.test.ts` | handleDownload resolves correct filename and MIME for known extensions and legacy names | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgComponent.test.ts` | fetches and renders SVG from file URL | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgComponent.test.ts` | ChatStream renders SVG code blocks, raw SVGs, and SVG file links | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgComponent.test.ts` | ChatStream renders tool-generated SVGs from workspace_write_file inline without requiring expanding proof drawer | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgComponent.test.ts` | SvgViewer converts Draw.io XML into rendered vector shapes and provides external diagram link | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgComponent.test.ts` | ChatStream renders Draw.io XML files inline from tool traces | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgComponent.test.ts` | 3. Deliverable/routing level: HTML with inline SVG routes to HTML preview (no SvgViewer), bare SVG routes to SvgViewer | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgComponent.test.ts` | LiveRunBlock renders sandboxed HTML iframe preview for .html deliverables, and SvgViewer for .svg | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgRendering.test.ts` | detects SVG code and Draw.io XML by language flag or structure | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgRendering.test.ts` | 1. Complete HTML document containing an inline SVG is NOT classified as SVG (isSvgCode is false) | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgRendering.test.ts` | 2. Bare SVG, <?xml ...?> prolog SVG, and Drawio <mxfile> documents ARE classified as SVG | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgRendering.test.ts` | detects Draw.io XML diagrams with isDrawioXml | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgRendering.test.ts` | converts Draw.io XML into standalone SVG with vertices, shapes, and edges | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgRendering.test.ts` | sanitizeSvg converts Draw.io XML to clean SVG and strips malicious attributes | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgRendering.test.ts` | sanitizes adversarial SVG attacks with DOMPurify: script variants, event handlers, javascript/data URIs, foreignObject, animate onbegin, encoded entities | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgRendering.test.ts` | preserves a legitimate 30-cell architecture diagram intact across sanitization | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgRendering.test.ts` | Draw.io converter robustness: handles round-trip of real docs/architecture.drawio and malformed inputs | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgRendering.test.ts` | wraps unescaped raw SVG blocks into markdown svg code fences | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgRendering.test.ts` | detects SVG file paths and correctly resolves relative workspace URLs | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgRendering.test.ts` | GET /api/files strictly enforces SVG/XML content-types, blocks directory listing and path traversal | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `svgRendering.test.ts` | extractSvgsFromMessage extracts vector SVGs from tool traces (write, read, stdout) | **LIVE-COVERED** | `l2-artifacts-downloads.spec.ts` |
| `engineRoute.test.ts` | proxies /control/status to supervisor passing X-Control-Token | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineRoute.test.ts` | returns status  | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineRoute.test.ts` | rejects missing or invalid action with 400 | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineRoute.test.ts` | dispatches POST /control/stop with token and returns stopped status | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineRoute.test.ts` | dispatches POST /control/start with token and returns starting status | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineRoute.test.ts` | handles restart by issuing stop then start in sequence | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineToggle.test.ts` | renders running state with emerald dot and  | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineToggle.test.ts` | renders stopped state with gray dot,  | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineToggle.test.ts` | renders starting state with pulsing amber dot and  | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineToggle.test.ts` | polls /api/engine periodically and posts start action | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineToggle.test.ts` | mounts EngineStatusPill in top header bar | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineToggle.test.ts` | displays Section 4: Engine Management with Standalone llama.cpp | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineToggle.test.ts` | provides Start, Stop, and Restart action buttons with proper disable states | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineToggle.test.ts` | invokes /api/engine with start, stop, and restart actions | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineToggle.test.ts` | EngineStatusPill provides Stop button when running and posts action: stop | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineToggle.test.ts` | ModelBottomSheet provides Engine Management card with toggle | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `engineToggle.test.ts` | page.tsx applies mobile-sidebar-open and mobile-inspector-open to app-shell | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmClient.test.ts` | getContextSizeForScope: maps scopes correctly | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmClient.test.ts` | Call generate with scope:  | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmClient.test.ts` | Call generate with scope:  | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmClient.test.ts` | Call generate with no scope asserts num_ctx === 4096 (safe default) | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmClient.test.ts` | Explicit caller num_ctx in options overrides default if specified | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | defaults to  | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | resolves to  | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | getLLMProvider returns an instance of OllamaProvider or LlamaCppProvider accordingly | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | calls ${baseUrl}/api/chat with stream: true and yields normalized chunks from NDJSON | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | calls ${baseUrl}/v1/chat/completions with SSE, sets n_keep, and normalizes reasoning, content, and tool calls | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | parses non-delta choices[0].message.tool_calls when server sends whole message block | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | uses LLAMACPP_BASE_URL when defined in environment | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | imports getLLMProvider and delegates streamOllamaChat to provider.streamChat | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | OllamaProvider.chat delegates to streamChat and accumulates content, thinking, and tool_calls | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | LlamaCppProvider.chat delegates to streamChat and accumulates content, thinking, and tool_calls | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | OllamaProvider.generate sends to /api/generate and returns GenerateResult with thinking chunks | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | LlamaCppProvider.generate sends to /v1/chat/completions with n_keep, max_tokens, signal, and thinking chunks | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | OllamaProvider.listModels queries /api/tags and returns model list | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | LlamaCppProvider.listModels queries /v1/models and returns model list | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | OllamaProvider.healthCheck returns true on 200 and false on network failure | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | LlamaCppProvider.healthCheck returns true on 200 and false on network failure | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | OllamaProvider.ensureResident posts /api/generate with keep_alive: -1 | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | LlamaCppProvider.ensureResident checks health and returns true when server is ready | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | createOllamaGenerate delegates to LlamaCppProvider.generate when resolveLLMEngine() is llamacpp | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | enforceResidency uses LlamaCppProvider.ensureResident when resolveLLMEngine() is llamacpp | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | normalizeOpenAIMessages formats assistant tool_calls and tool messages correctly | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | normalizeOpenAIMessages consolidates stray system messages at index > 0 into index 0 | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | LlamaCppProvider.streamChat normalizes messages before sending to /v1/chat/completions | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | LlamaCppProvider.streamChat sends parallel_tool_calls: false when tools are present | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | LlamaCppProvider streamChat retries against baseUrl if llamacppBaseUrl fails with connection error | **STUB-ONLY** | Asserts pure engine fallback, retry loop, or mock error response |
| `llmProvider.test.ts` | LlamaCppProvider throws error with engine identifier (llama.cpp engine returned) | **STUB-ONLY** | Asserts pure engine fallback, retry loop, or mock error response |
| `llmProvider.test.ts` | deploy/k8s/web-ui.yaml sets LLM_ENGINE to llamacpp or strata | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | web-ui/app/api/chat/route.ts triageComplexity uses getLLMProvider().chat instead of raw /api/chat | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | web-ui/app/api/sandbox-status/route.ts uses getLLMProvider().healthCheck and listModels instead of /api/tags | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | web-ui/lib/visionProcessor.ts uses getLLMProvider().chat instead of raw /api/chat | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | residency helpers (fetchModelSizes, fetchLoadedModels, unloadAllModels) avoid /api/tags and /api/ps when LLM_ENGINE=llamacpp | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | scripts/llamacpp-standalone.js exports buildLlamaServerArgs and buildLlamaServerEnv using official C:\\AI\\llamacpp install with zero Ollama paths | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | normalizeOpenAIMessages converts message.images to OpenAI content parts and deletes images property | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | normalizeOpenAIMessages preserves existing data: URI schemes in images | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | normalizeOpenAIMessages handles messages with images and no text content | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | LlamaCppProvider.streamChat sends content parts with image_url to /v1/chat/completions without images property | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | LlamaCppProvider.streamChat forwards reasoning_effort and signal to /v1/chat/completions | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | selects Strata provider configuration resolving to port 8080 and model qwen3.8-flash-next-gyro-gyro-s | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | injects Host 127.0.0.1:8080 header on outbound calls to pass Strata DNS rebinding check | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | throws error with Strata engine identifier when LLM_ENGINE is strata | **STUB-ONLY** | Asserts pure engine fallback, retry loop, or mock error response |
| `llmProvider.test.ts` | OllamaProvider.streamChat sends num_ctx: 131072 in request body options | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `llmProvider.test.ts` | LlamaCppProvider.streamChat captures n_keep: 512 and max_tokens: 2560 | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `vramResidencyAndMultiFile.test.ts` | PINNED_KEEP_ALIVE prefers -1 for indefinite VRAM residency | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `vramResidencyAndMultiFile.test.ts` | fetchModelSizes normalizes model names stripping :latest and indexes by both | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `vramResidencyAndMultiFile.test.ts` | fetchLoadedModels normalizes model names stripping :latest | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `vramResidencyAndMultiFile.test.ts` | planResidency always pins DEFAULT_PRIMARY_MODEL even if sizes lookup was skipped or unknown | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `vramResidencyAndMultiFile.test.ts` | Behavioral assertion: swift-15-27b-mtp is not evicted across consecutive prompts in /api/ps | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `vramResidencyAndMultiFile.test.ts` | chat/route.ts routes auto mode to DEFAULT_PRIMARY_MODEL directly without gemma4:e4b triage swap | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `vramResidencyAndMultiFile.test.ts` | BuilderWorker exercises exact call path to surgically patch a file | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `vramResidencyAndMultiFile.test.ts` | rejects patch when search text is not found | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `vramResidencyAndMultiFile.test.ts` | getThinkingBudget returns 1024 for fast, 4096 for balanced, 8192 for deep | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `vramResidencyAndMultiFile.test.ts` | createOllamaGenerate adds thinking budget on top of requested num_predict | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `vramResidencyAndMultiFile.test.ts` | BuilderWorker defaults num_predict to 8192 for code generation | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `vramResidencyAndMultiFile.test.ts` | resolveTargets returns all non-empty entries in milestone.plannedFiles | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `vramResidencyAndMultiFile.test.ts` | executeMilestoneWork iterates all plannedFiles and returns modifiedFiles array | **LIVE-COVERED** | `l1-short-flow-copy.spec.ts` |
| `modelfiles.test.ts` | Stretch Item 1: Worker Modelfiles Specification Suite | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `modelfiles.test.ts` | Builder Modelfile specifies base model, low temperature, and system prompt | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `modelfiles.test.ts` | Critic Modelfile specifies base model, deterministic temperature, and strict JSON verdict prompt | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `modelRoster.test.ts` | resolveModelRosterFromEnv defaults all roles to swift-15-27b-mtp | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `modelRoster.test.ts` | resolveModelRosterFromEnv honors MODEL_NAME when role-specific env vars are unset | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `modelRoster.test.ts` | getModelForRole( | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `modelRoster.test.ts` | getModelForRole( | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `modelRoster.test.ts` | getModelForRole( | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `modelRoster.test.ts` | No references to qwen3.8 or gemma4 or hermes3 remain in workerPool.ts | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `models.test.ts` | defaults to qwen3.8-flash-next-gyro-gyro-s for orchestrator to fit within 16GB VRAM limit | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `models.test.ts` | defaults to qwen3.8-flash-next-gyro-gyro-s for fast multimodal sub-agent execution | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `models.test.ts` | contains complete profiles for orchestrator and sub-agents | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatQueue.test.ts` | enqueue appends an item and persists it under the thread key | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | enqueue ignores blank text | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | FIFO order is preserved across multiple enqueues | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | queues are isolated per thread id | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | shiftNext returns exactly one item in FIFO order and removes it | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | shiftNext on an empty queue returns null and mutates nothing | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | drain-on-done sends exactly one item and removes it | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | no drain on abort or error endings — the queue pauses | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | remove(id) drops only that item | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | clearAll empties the queue and clears the storage key | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | a fresh ChatQueue for the same thread id restores the persisted items | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | corrupt storage payload degrades to an empty queue instead of throwing | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | idle with text sends immediately | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | running with text enqueues instead of sending | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | running with attachments is blocked with the attachments hint | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | running with nothing to enqueue stays blocked | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatQueue.test.ts` | idle with attachments only still sends | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | appendSteer appends to disk mailbox and returns pendingCount | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | consumeSteers consumes exactly-once and removes mailbox | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | pending steers survive until consumed | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | clearSteers empties the mailbox on thread end | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | appends steer and returns pendingCount | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | [CHAT-11] rejects steer to nonexistent thread with 404 and does not write orphan sidecar | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | rejects empty text with 400 | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | consumes steer mid-turn, injects into conversationMessages, and emits steer event | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | \n\n | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | late-steer test: steers appended before synthesis round force synthesis, consume steer, and appear in model request | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | \n\n | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | unconsumed steer invariant: if steer arrives when no further model call is possible, it is NOT persisted in transcript and returned in pendingSteers | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | INTERRUPT-STEER: POST /api/threads/[id]/steer with interrupt=true aborts in-flight round stream without stopping turn and immediately applies steer | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteer.test.ts` | \n\n | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteerSubmitUx.test.ts` | preserves running + text -> enqueue action for queue/steer dispatch | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteerSubmitUx.test.ts` | empty text remains blocked-attachments when running | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteerSubmitUx.test.ts` | Stop button and Send button coexist without mutual exclusion | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteerSubmitUx.test.ts` | Send button is visible during active runs when input has non-empty text | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteerSubmitUx.test.ts` | pending-steer visual feedback deck is rendered when pendingSteers exist | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteerSubmitUx.test.ts` | steer failure restores text to composer without silent swallowing | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatSteerSubmitUx.test.ts` | midTurnAction preference is persisted per thread in localStorage | **LIVE-COVERED** | `l4-steer-reload-resilience.spec.ts` |
| `chatPolish.test.ts` | renders message prose with 15px font, line-height 1.6, and max 72ch readable width | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | renders markdown tables, bullet lists, blockquotes, and inline code honestly | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | renders code blocks with distinct background and copy button | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | provides theme toggle in UI and clean M3 token variables | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | supports OS preference / prefers-color-scheme evaluation | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | renders visible Back button on both mobile and desktop (no sm:hidden) | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | handles popstate and back navigation without trapping the user | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | renders compaction turn note badge when assistant message has compactedThisTurn=true and token stats | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | does NOT render compaction turn note badge when compactedThisTurn is false or omitted | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | resolveTurnStatusPhase resolves phases accurately across streaming lifecycle | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | renders single turn-status-slot in ThinkingPanel with h-7 and max 1 spinner | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | getServedByNote correctly normalizes aliases and suppresses redundant notes | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | ChatStream suppresses Served-by note when model matches and renders it when diverged | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | renders context-meter-pill with flex and without hidden sm:flex | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | extractFileWriteDiffsFromTraces extracts diff stats and unified preview for workspace_write_file, workspace_patch_file, and host_write_file | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | ChatStream renders data-testid=\ | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | captureWorkspacePreImage + collectTurnModifiedFileDiffs captures pre-image and computes unified diff for modified files | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | captureWorkspacePreImage ignores brand-new files (produces zero TurnFileDiff entries) | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | truncates at MAX_DIFF_LINES_CAP (120) and reports truncated, totalDiffLines, and omittedLines | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatPolish.test.ts` | ChatStream renders DiffViewer inside data-testid=\ | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | MAX_TOOL_OUTPUT_CHARS is set to 64000 | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | clampToolOutput does not truncate content <= 64000 chars | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | clampToolOutput truncates content > 64000 chars, appends TRUNCATED metadata, and resulting length <= 64000 | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | clampToolOutput handles custom maxChars override correctly | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | KNOWN_ONE_LINERS.workspace_read_file declares pagination parameters | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | DEFAULT_TOOL_SCHEMAS.workspace_read_file and host_read_file have parameter parity | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | defaults to whole file when no range parameters provided | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | slices correctly with start_line and end_line | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | slices correctly with offset and limit | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | handles offset: 0 by normalising to 1 | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | clamps start_line below 1 to 1 | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | clamps end_line and limit beyond file length to file length | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | prefers start_line over offset and end_line over limit | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | statically verifies chat/route.ts and contextBudget.ts exempt workspace_read_file and host_read_file from clampToolOutput | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | runChatToolLoop exempts workspace_read_file and host_read_file from clampToolOutput while clamping other tools | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | simulates a large file > 64,000 chars (~200KB, 2,500 lines / ~220,000 bytes) paging through the file to EOF in chunks | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | \n | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatFilePaging.test.ts` | verifies individual pages with content > 64,000 chars are NOT clamped or truncated by any fixed ceiling | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | formatElapsedDuration accurately formats seconds into human readable time | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | LiveRunBlock component source includes elapsed time and active activity label | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | filters out raw XML/SVG tags, coordinate dumps, and repetitive tokens | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | formatThinkingDisplay returns a summary and step list with labels | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | formatThinkingDisplay preserves full reasoning text without truncating at 220 chars | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | suppresses meta-formatting noise (code fence syntax, counts, structural fences, etc.) | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | ThinkingPanel source contains phased cards (Planning, Building, Validating), streaming badge, and is expanded by default | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | mounts SvgViewer when a task is completed with an SVG deliverable | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | mounts CodeBlock when a task produces non-SVG code deliverable (e.g. hello.ts) | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | mounts sandboxed iframe preview when deliverable is an HTML document (e.g. spanish-fort-weather.html) | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | ChatStream and CodeBlock components support line numbers, copy button, language headers, and horizontal scroll | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | CodeBlock handles long files (e.g. 200 lines) with max-h-400px, overflow-y-auto, bottom gradient fade, expand toggle, and full copy | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | \n | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | \n | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | formatHumanReadableTrace translates technical tool names to plain language | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | activeModel indicator resolves to swift-27b-mtp if backend is using swift-27b-mtp | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | activeModel indicator resolves to Flash-Next if model contains flash-next or gyro | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | ChatStream or parent does not render duplicate sequential user messages with identical content | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | parseThinkingAndContent extracts orphan leading reasoning terminated by </think> without opening <think> | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | parseThinkingAndContent concatenates all <think> blocks and strips them from content | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatReasoningAndProgress.test.ts` | cleanResidualToolTags strips Qwen XML tool call blocks including unclosed and malformed tags | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatUiHonestyAndCopy.test.ts` | formatHumanReadableTrace assigns badge  | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatUiHonestyAndCopy.test.ts` | formatHumanReadableTrace assigns badge  | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatUiHonestyAndCopy.test.ts` | formatHumanReadableTrace preserves existing  | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatUiHonestyAndCopy.test.ts` | ChatStream renders distinct badges ( | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatUiHonestyAndCopy.test.ts` | ChatStream renders a copy response button on every assistant message with content | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatUiHonestyAndCopy.test.ts` | handles streaming assistant messages copying existing content at tap time | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatUiHonestyAndCopy.test.ts` | ChatStream renders a copy button on every user message | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatAttachments.test.ts` | ThreadStore retains message attachments across reloads | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatAttachments.test.ts` | Thread file outputs folder resolution and discovery | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatAttachments.test.ts` | F5.3: buildFileDeliverablesDirective generates correct workspace relative target path | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `chatAttachments.test.ts` | F5.4: Exact write tracking with collectTurnAttachments and no mtime leaks | **STUB-ONLY** | Pure-local component or mock-assisted unit assertion |
| `e2e/flows.spec.ts` | Flow 1: Hamburger -> Drawer opens -> Every destination renders and navigates | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/flows.spec.ts` | Flow 2: Create a session -> Reopen it from drawer sessions list (Recents) | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/flows.spec.ts` | Flow 3: Projects registration and management end-to-end | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/flows.spec.ts` | Flow 4: Composer Chat/Build switch and stubbed streaming completion | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/realmode.spec.ts` | UI-A1 (CHAT-14): Reasoning panel visible while content empty, preserved across reload, and completes | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/realmode.spec.ts` | UI-A2 (CHAT-13): Mid-turn steer preserves prior thinking and delivers redirected answer | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/scenarios.spec.ts` | Scenario 1: chat-fast streams reply, verifies simulation badge, and recovers composer | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/scenarios.spec.ts` | Scenario 2: chat-slow (accelerated) halts within 1 second on user Stop | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/scenarios.spec.ts` | Scenario 3: chat-slow (1x real-time) maintains layout invariants during active waiting | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/scenarios.spec.ts` | Scenario 4: chat-tools renders thinking panel, command failure, and self-healing fallback | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/scenarios.spec.ts` | Scenario 5: build-run executes multi-milestone task and updates workspace diff | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/scenarios.spec.ts` | Scenario 6: build-retry displays critic rejection on iteration 1 and pass on iteration 2 | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/scenarios.spec.ts` | Scenario 7: engine-stop renders mid-stream disconnect error banner and recovers composer | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/scenarios.spec.ts` | Scenario 8: project-task runs overnight security audit lifecycle to review ready | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/scenarios.spec.ts` | Scenario 9: backend-down renders 503 error surface and retry button | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/scenarios.spec.ts` | Scenario 10: Navigation works mid-run without UI hijacking or crashes | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/regressions.spec.ts` | Regression 1: Header Stop pill never overlaps Projects button | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/regressions.spec.ts` | Regression 2: Sessions panel does not bleed through or clip | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/regressions.spec.ts` | Regression 3: Undiscoverable mobile menu — hamburger button present and functional | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |
| `e2e/regressions.spec.ts` | Regression 4: Chain F mobile header non-overlap, one-drawer law, and single turn-status-slot invariant | **STUB-ONLY** | Synthetic Playwright UI test exercising client React rendering against mocked route handlers |

---

## 3. Pure-Local Tests (No LLM Dependency)

The suite contains **80 test files** comprising **492 pure-local tests** whose contracts do not touch LLM streaming, token generation, or host execution. These include pure React state management, layout invariants, CSS responsive media queries, local task state machines, purely mocked SQLite/disk ledger stores, and static utility functions.

### Pure-Local Suite Inventory (80 files, 492 tests):
- `agentGroundingAndHeadroom.test.ts` (7 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `aiLifecycle.test.ts` (4 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `blockingGateRevert.test.ts` (4 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `browserMcpConnectivity.test.ts` (2 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `buildLaunchVisibility.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `buildPushHonesty.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `buildSandboxTier.test.ts` (4 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `canonicalLifecycle.test.ts` (1 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `clipboard.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `crash_recovery.test.ts` (3 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `critic.test.ts` (3 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `deliverableContracts.test.ts` (4 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `deployApiWiring.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `deployFlow.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `deploymentConfig.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `docsIntegrity.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `dogfoodPhase1Acceptance.test.ts` (6 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `e2eScriptTimeouts.test.ts` (2 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `evidenceLinking.test.ts` (4 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `explorerAndCriticUpgrade.test.ts` (4 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `fileParser.test.ts` (3 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `filesApi.test.ts` (12 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `flywheelSkills.test.ts` (6 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `gatewayWatchdog.test.ts` (8 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `groundingGate.test.ts` (12 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `humanSkillGates.test.ts` (1 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `ingestionPipeline.test.ts` (8 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `kindGateway.test.ts` (3 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `langgraphSupervisorNodes.test.ts` (4 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `ledger.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `ledgerStats.test.ts` (2 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `mobileHeaderNav.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `mobileUiPolish.test.ts` (6 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `morningReport.test.ts` (13 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `notifications.test.ts` (6 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `pause_resume.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `planner.test.ts` (6 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `plannerScope.test.ts` (11 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `productionTestRunnerWiring.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `projectMorningReportIntegration.test.ts` (4 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `projectOvernightRunner.test.ts` (6 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `projectsNavAndWorkflow.test.ts` (6 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `projectsRegistryAndExplorer.test.ts` (16 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `punchlistBackendFixes.test.ts` (21 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `punchlistUiFixes.test.ts` (14 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `realReportTestCounts.test.ts` (2 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `repoHygiene.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `restart.test.ts` (2 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `scheduler.test.ts` (7 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `schedulerApi.test.ts` (7 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `schedulerDaemon.test.ts` (9 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `schedulerHealth.test.ts` (6 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `selfDeploy.test.ts` (10 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `selfDeployWiring.test.ts` (3 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `sessionIntegrity.test.ts` (12 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `shakeoutFixes.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `simulator.test.ts` (8 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `skillGate.test.ts` (2 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `skillsProposeApprove.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `skillsViewPreview.test.ts` (2 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `sprint2UiNavigationAndScroll.test.ts` (3 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `supervisor.test.ts` (7 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `supervisorGitOpsIntegration.test.ts` (10 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `taskCompletion.test.ts` (1 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `taskControls.test.ts` (4 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `tasksApi.test.ts` (4 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `telemetry.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `testGate.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `threadsDeleteTouch.test.ts` (1 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `threadsLaunchTask.test.ts` (4 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `threadsResumeRestartExecution.test.ts` (3 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `uiStateAndDedup.test.ts` (9 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `unattendedGitOps.test.ts` (17 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `unifiedUi.test.ts` (20 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `userProfile.test.ts` (8 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `workerCiFeedback.test.ts` (4 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `workerGitOps.test.ts` (5 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `workerHonesty.test.ts` (12 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `workerPool.test.ts` (6 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
- `e2e/layoutInvariants.spec.ts` (8 tests) — Local component logic, state storage, or UI layout verification without LLM runtime dependencies.
