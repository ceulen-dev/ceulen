# AGENTS.md — ceulen

Agent-facing guide to this repo.

## What ceulen is

One **Pi bundle extension** (npm: `ceulen`): a single install whose feature modules are loaded by one entry, each kill-switchable via the `ceulen.disabled` settings key. Users install with `pi install npm:ceulen` — never `npm install -g`. Every module registers only through Pi's public extension API (peer dep `@earendil-works/pi-coding-agent >=0.99.1 <1.1.0`), so upstream Pi upgrades stay drop-in.

## Layout

```
extensions/
  index.ts               bundle entry: guarded() conflict guard, kill-switch, /ceulen command, module load loop
  lib/                   shared code (registry.ts — MODULES list + kill-switch settings I/O; panel.ts —
                         config-panel kernel, forked in-repo from @bacnh85/pi-config-panel 0.1.10:
                         split layout + row descriptions/warnings + enum rows + type-to-search;
                         env.ts — trust-gated .env ingestion)
  modules/<name>/        one directory per module (self-contained: index.ts, lib/, commands/, test/)
skills/                  skill directories shipped with the package (each module contributes its OWN
                         skill dirs via resources_discover — ponytail the six `ponytail*`, ux the four
                         `ux-*`, munin `munin`, web `web` — never the skills/ root, so each kill-switch
                         gates its own skills)
themes/                 theme JSONs shipped with the package (declared via the package.json
                         `pi.themes` manifest — loaded by pi itself, no module, no kill-switch;
                         scripts/validate-themes.mjs runs in `npm test`)
```

## Module convention

- A module default-exports a factory `(pi: ExtensionAPI, deps?: ModuleLoadDeps) => void` (deps is rarely used — the config module reads the contribution map); it registers commands/tools/handlers and returns. Public extension API only.
- No external runtime dependencies — vendor shared code under `extensions/lib/` (with a `// ponytail: vendored from <pkg> <version>` header) rather than adding `dependencies`.
  Two sanctioned exceptions, both un-vendorable: `@ff-labs/fff-node` (fff
  module, a native FFI engine) and the web module's `jsdom` + `gemini-reverse`
  (+ `axios`, which `gemini-reverse` hard-depends on) — see the Web module
  section for what is vendored instead. pi's managed install installs real
  `dependencies` for npm packages.
- Tool registrations that should be per-tool toggleable list their canonical names on the module's `tools?: string[]` registry entry; names in `ceulen.disabledTools` (helpers in `extensions/lib/tools.ts`) register via `defaultActive: false`, and the config module's tool rows re-activate/deactivate them live with `setActiveTools` (no `/reload`).
- Tests: `node:test` + tsx, in `extensions/modules/<name>/test/`. The bundle root `package.json` `test` script globs them. Test dirs are excluded from `tsc --noEmit` when they use loose harness stubs (usage, ponytail); they run under tsx.
- To add a module: create `extensions/modules/<name>/`, append one entry to `MODULES` in `extensions/lib/registry.ts` under its category banner (each entry's `category` field is the OMP tab — the single source for /config tab placement, synthesized Enable-only sections, and /ceulen status grouping; pretty section names live in the config module's `PRETTY_OF` map). Order matters — usage reads the `router` provider, so router loads first; config loads last, it reads the contribution map. Add its test files to the `test` glob if not covered. The conflict guard covers you: a name another module already claimed throws at load.

### Classifier module (classifier)

Ported from `@bacnh85/pi-classifier` 0.2.3, rewired to the MODEL REGISTRY: the
router module (`extensions/modules/router/lib/systemone.ts` — slim vendored
System One transport, `// ponytail: vendored from @earendil-works/pi-ai 0.99.1`
header) registers `classifiers: {"typesafe-system-one": …}` on the router
provider and merges `GET <router.baseUrl>/v1/systemone/models` (404-fail-open)
into the catalog as `type: "classifier"` entries; models-store.json persists the
MIXED list and the offline restore branches on `type === "classifier"` (chat
entries keep the vision/reasoning remap). The classifier module itself has no
endpoint and no key code: the `classify` tool and the bash verdict
(audit-only — pi 1.0.0 has no per-call approval prompt, so the hook annotates
and logs, never gates) resolve models via `modelRegistry.getAvailableOfType/findOfType`
and ask through `modelRegistry.classify()` (never rejects). Settings stay in the
GLOBAL `classifier` section (`model`, `permission.{enabled,mode,threshold}` —
same keys/values as pi-classifier, migration-free; `planGate` is left untouched
and NOT consumed by the plan module — pi 1.0.0's `tool_call` can only block,
never approve, so the gate would only have trimmed prompts). Replaces the standalone package — if both are
installed, first tool registration wins.

### Advisor module (advisor)

Ported from `@bacnh85/pi-advisor` 0.3.8 (see `extensions/modules/advisor/`): the
turn-end reviewer (`agent_settled` → one isolated model call → at most ONE
severity-routed note, steered as a follow-up turn or deferred to a next-turn
aside inside the `immuneTurns` calm-down window), the emission guard
(content-free/dedupe/rate-limit, Unicode-folded normalization + omp-parity
filler list), the ordered model fallback chain, and the on-demand `advisor`
tool. OMP-parity hardening (2026-10-01 delta analysis): the reviewer SYSTEM
bans the omp noise classes (restating seen errors, intent/ceremony, scope
policing, unsolicited back-compat, second-guessing, partial work) and demands
cited evidence; `WatcherStats.usage` accumulates token/cost from the serving
`streamSimple` result (shown in `/advisor status`, per-call in the consult
tool result); `session_compact`/`session_before_switch` reseed the cursor and
clear the guard (skipped when the event's session id differs from the live
runtime's). The standalone `@bacnh85/pi-config-panel` models
editor and the `ModelSelectorComponent` picker are DROPPED — `/config` → Model
→ Advisor is the editor (`/advisor models` prints the chain, `/advisor
<provider/model[, …]>` still sets it).

**Settings**: the `advisor` section of the agent-dir settings.json (`enabled`,
`models` chain with an optional `:level` per entry,
`watch.{minToolCalls,immuneTurns}`), with a trusted project `.pi/settings.json`
overriding per field. The standalone `pi-advisor` section is a READ-ONLY legacy
alias — the new name wins per field inside a file, and the legacy
`watch.enabled` folds into `enabled` at read time so the runtime has exactly ONE
switch; the first save deletes the legacy section plus the legacy `model` string
and `watch.enabled` key (nothing left to shadow the new state). The pi-plan
`advisorModel` migration is deliberately NOT ported — pi-plan owns it when that
port lands.

**`/config` rows** (`advisor.*`; the Enable + tool rows are auto-generated):
`Review settled turns` (the background review; off = no review, the consult
tool keeps working), `Primary model`
(catalogue menu), `Thinking` (closed set, saved as the primary's `:level`
suffix), `Fallback chain` (comma-separated, inline model completions),
`watch.minToolCalls`, `watch.immuneTurns`. Saving writes the agent-dir file and
applies to the LIVE session through the module bridge (`setAdvisorBridge`: models
swapped, master → the session watch flag, cursor reseeded on a 0 → N chain, tool
availability re-synced) — no `/reload`. A trusted project file setting `advisor`
or `pi-advisor` is disclosed as shadowing the global save.

**Tool availability** is resolved by the module's `sync()` (session_start,
model_select, `/advisor on|off`): the `advisor` tool follows the CHAIN — a
configured advisor is always consultable on demand, also while `Review settled
turns`/`/advisor watch-off` has the background review off (pi-advisor's
semantics) — and it honors `ceulen.disabledTools` (its row is relabeled
`Consult tool` by the config module's `TOOL_PRETTY` map, since the bare name
`advisor` would sit right under the section of the same name). The per-tool
kill-switch always wins, so a toggle is never silently undone. The advisor
module is `core: true` (always loaded, no Enable row, `ceulen.disabled`
ignores it): its real off-switch is an empty `Primary model`.

**Isolated calls** go through the PUBLIC `ctx.modelRegistry.streamSimple`
(pi's own `prepareRequest` path: request-time auth + provider wiring) — no
`@earendil-works/pi-ai` import, so the bundle keeps zero runtime dependencies.
The entry/message customType is `ceulen-advisor`; the opencode session header
rides in the request options because the main loop's `transformHeaders` closure
is unreachable from an extension. The watch is TUI-only, fire-and-forget off the
settle barrier, pauses after 3 consecutive failures (`/advisor on` resumes), and
self-disarms on `session_shutdown` so an in-flight review never leaks into a
replaced session. omp's roster / per-advisor tool grants /
`maxNotesPerUpdate` / `syncBacklog` are NOT ported — an isolated advisor
`ToolSession` is not part of pi's public extension API.

## Munin module (munin)

Ported from `@bacnh85/pi-munin` 0.5.12 (see `extensions/modules/munin/`). Eight
`munin_*` tools (per-tool kill-switchable), `/munin-status`, the Munin Memory
Protocol injection (`before_agent_start`, only when configured), the `tool_result`
error sanitizer, and the `munin` skill (own `resources_discover` dir). The SDK is
VENDORED to `lib/sdk.ts` (`// ponytail: vendored from @kalera/munin-sdk 1.5.0`;
local change: capabilities cache keyed by `baseUrl|apiKey` — upstream cached one
global). dotenv was dropped: the bundle's `env.ts` already ingests trusted `.env`.

Config is PROJECT-level (unlike router's global writes): `munin.apiKey`,
`munin.project`, `munin.baseUrl` live in `<repo>/.pi/settings.json` under a
`munin` section, surfaced by `/config` on the **Memory** tab (`PRETTY_OF` icon
🪶 — fills the previously empty Memory slot in `PI_TAB_ORDER`). Precedence:
per-call params > `MUNIN_*` env > trusted project file > global agent-dir file >
default baseUrl. The project file is read ONLY when trusted (router's rule — an
untrusted checkout must not redirect where the API key is sent); the /config
save always targets `<ctx.cwd>/.pi/settings.json` and warns when the project is
untrusted (pi ignores the file until trusted). `/munin-status` discloses each
field's source without printing the key. Env contract is stable `MUNIN_*`
(same policy as `ponytail.*`).

### Subagent module (subagent)

Ported from `@bacnh85/pi-subagent` 0.23.2 (see `extensions/modules/subagent/`):
in-process SDK subagents — the `subagent` tool (single / parallel 8@4 / chain
`{previous}` / background + `operation: status|cancel|wait`), the `herdr`
tool (oversight of herdr-delegated panes), `/subagent` + `/agent` commands,
a live progress widget (`ceulen-subagent`), and `.pi/subagent-history.json`.

**Live-UI surface** (OMP parity; all store-driven, so it covers SDK and herdr
threads alike — pure renderers unit-tested in `test/widget.test.ts`):
the above-editor widget renders a `Subagents · N running · M ✓ · K ✗` header
plus one line per running thread (spinner · agent · elapsed · tool/token
counters · latest tool call; herdr panes show their `herdr: <state>` lifecycle
label instead) with a `/agent to inspect` tail; the FOOTER carries the
`ceulen-subagent` setStatus item (`👥 N running · …`) while any thread runs,
cleared on idle/session change (the widget controller owns set + clear, and
the composer footer passes the item through — it filters only `ceulen-usage`);
`operation: status|wait` tool rows render the job tree (`⏳ waiting on N of M
jobs`, waited task first, then ✓ settled rows with a `⎿` output snippet);
chain/parallel call rows honor Ctrl+O expansion (full task list instead of the
cap-3 preview). Raw SDK event labels (`message_end`…) never render — only
`herdr:`-prefixed lifecycle labels do.

- **Five bundled agents** (`agents/*.md`: scout, tester, worker, planner,
  reviewer); user `~/.pi/agent/agents/*.md` and trusted project
  `.pi/agents/*.md` override. Upstream's `general-purpose` is dropped (worker
  already inherits all parent tools). Project agents require interactive
  approval (headless fails closed; `allowUnconfirmedProjectAgents` opt-in).
- **Role-based model pools**: `subagent.roles.{fast,coder,smart}` — ordered
  fallback chains over the router catalogue, `*` = parent model; agents
  reference `@role` in frontmatter; `subagent.agentModels` /
  `subagent.agentThinking` pin individual agents (stable `subagent.*`
  settings contract — standalone pi-subagent settings carry over; REMOVE the
  standalone package or the conflict guard refuses the duplicate tool).
  /config → Tasks → Subagents edits roles + routing + timeouts; saves write
  the GLOBAL settings.json with roles diff-based (pristine defaults never
  frozen; clear-to-empty deletes the key = default restored) and apply live
  (settings are read per execute() call).
- **Classifier routing** (`subagent.routing.mode`, default `classify`): one
  Jev round-trip per task picks model tier (fast/coder/smart) + thinking
  (score ladder off…xhigh); `subagent.routing.threshold` (0.6) gates tier on
  the CHOSEN LABEL'S OWN probability (`probabilities[choice]` — a
  high-probability rival must not clear the threshold; a missing/out-of-range
  value fails open) and effort on the score answer's `confidence`; `solutionSpace`
  per task feeds the state. Precedence — pins beat dynamic, dynamic beats
  defaults: chain-entry `:level` > `agentModels` pin (disables both; no
  classify call) > `agentThinking` pin (disables effort only) > classifier >
  frontmatter defaults. An unresolvable chain (typo'd `@alias`) suppresses the
  tier question — the dispatch fails loud on the typo instead of a tier
  verdict silently swapping in the role pools: the shared `routedChain()`
  returns an error listing the unresolved roles when the chain resolves to
  NOTHING, and BOTH runners surface it (an empty candidate list would otherwise
  read as "use the parent model" in `resolveModel`). A resolvable chain plus an
  unknown extra role still dispatches — that is a diagnostic, not a failure.
  Fail-open: classifier off/error/below-threshold →
  static role chain. Both runners share ONE `routedChain()` (index.ts): the
  herdr path (`prepareHerdrOne`) used to resolve the chain straight from
  frontmatter, so routing only ever applied to in-process/SDK dispatches —
  don't reintroduce a second resolution path. Completed runs record the
  resolved `model` + `thinking` in `.pi/subagent-history.json` and
  `/subagent history`. The same round-trip can answer a third question:
  `subagent.routing.dispatch` (default `classify`) lets it pick pane vs
  detached background for a single dispatch inside herdr whose caller named
  neither `runner` nor `background` — explicit params always win, the verdict
  is reused for tier/effort (one Jev call per dispatch), and a background
  verdict prepends a note to the receipt.
- **Advisor-aware collection** (herdr panes only): a child pane runs full pi,
  so its OWN advisor reviews each settled turn and can steer corrections
  *after* the parent would otherwise collect (observed live: report collected
  at the draft, advisor note 16s later, child revised — the parent never saw
  it). The child's advisor publishes a review-cycle marker (`phase`
  `reviewing`/`done` + `steered`, shared contract in
  `extensions/lib/advisor-marker.ts`, path handed to the pane via
  `herdr --env CEULEN_ADVISOR_MARKER`); `executeHerdrTask` waits for `done`
  before collecting — a grace poll when no review starts (skip paths publish
  nothing), the steered revision's settle when one does, ≤2 rounds, all
  bounded by `subagent.advisorWaitSecs` (default 120, 0 = off). Write-capable
  children are told by the delivery contract to update the report file when
  follow-up feedback arrives. `SubAgentResult.advisorRounds` + history + the
  usage line (`advisor:N revision(s)`) record folded revisions; the widget
  shows `herdr: advisor-review` / `advisor-revise` while waiting. SDK children
  get no advisor at all (the watch is TUI-gated), so there is nothing to wait
  for there.
- **Liveness timeouts** (upstream's always-on 20-min hard cap is GONE):
  `subagent.hardTimeoutMins` defaults 0 = OFF — a child producing events is
  never hard-killed; the idle window (`subagent.idleTimeoutMins`, default 3,
  every SDK event resets it) is the hang detector. The setting reaches the
  resolver as `resolveChildTimeouts({ idleTimeoutMins })` — >0 replaces the
  env-derived default (`PI_SUBAGENT_INACTIVITY_TIMEOUT_MINS`); 0/undefined keeps
  it, and an explicit per-call `timeout` / frontmatter `timeout:` still wins.
  `operation:"wait"` blocks
  up to 600s on a background task and reports liveness age (STALLED flag)
  from the thread store.
- herdr delegation (visible panes when pi runs inside herdr; `runner:"sdk"`
  forces in-process) and the git-worktree sandbox + `merge:"3way"` are
  vendored unchanged. Auto-review is NOT ported (advisor covers turn-end
  review; a diff-reviewer belongs to a future model-tools port).

### Repair module (repair)

Ported from the tool-hardening half of `@bacnh85/pi-model-tools` 0.9.5 (see
`extensions/modules/repair/`). Wraps the 7 built-in tools (read, write, edit,
grep, find, ls, bash) EXACTLY ONCE each (pi lets an extension tool override a
built-in by name) and adds `apply_patch` (Codex-style V4D diff tool) and
`str_replace_editor` (byte-faithful DSH Minimal-pair editor — the schema text
is load-bearing for the steering module's anchor).

DELIBERATE DEVIATION from upstream: the deterministic half is MODEL-AGNOSTIC
here — schema argument repair, read-notice decontamination, and the tool_call
guards (destructive bash + read-on-guessed-path) run for ALL models (upstream
gated them on a detected deepseek/glm family; the family-gated steering half
lives in the steering module, a different file set). Edit mismatch repair
(strip read-notice contamination, trim-tolerant retry, nearest-region error,
apply_patch escalation) is gated on `repair.editRetry`.

Settings: the `repair` section (`arguments`, `editRetry`, `guards` — read PER
TOOL CALL; `autoBg`, `autoBgSecs` — bind at module LOAD because the wrapped
bash description sits in the cache-safe request head, so those rows take
effect next session; `/repair` status discloses the load-bound values).
Layering: defaults → global settings.json → trusted project file. Per-tool
kill-switch: wrapped tools honor `ceulen.disabledTools` at registration
(`defaultActive: false`), so /config's live tool toggles work over the
wrapped built-ins too.

### Plan module (plan)

Ported from `@bacnh85/pi-plan` 0.16.6 (see `extensions/modules/plan/`), reduced
to the **permission + review gate**: `/plan` toggle (+ `--plan` flag,
ctrl+alt+p), tool gating, `write_plan`, `ask_user_question`, plan
model/thinking, approval handoff, and the save-plans policy. Registration
surface: `/plan`, `/plan-approve current|new`, `/plan-model`, `/plan-thinking`,
`/plan-auto`, the two tools, the `ceulen-plan` state entry + status key.

DELIBERATE DROPS from upstream (enumerated, not accidental): the
implement→verify→review flow (`/flow`, [verification: pass] loop, workspace
leases, worktree `flowIsolation` — ceulen's subagent `sandbox:"worktree"` +
`merge:"3way"` and the advisor reviewer already cover it), `/rewind` +
checkpoints, `/goal`, `/specs`, `/handoff`, `/btw`, `/doctor`,
`/plan-fallback` (the advisor module's fallback chain covers overloads), and
the Jev plan gate — the classifier module's `tool_call` note holds:
pi 1.0.0's `tool_call` can only block, never approve, so the gate could only
have trimmed confirm prompts; wire it in only if prompt fatigue shows up.

**Plan files**: `<repo>/.pi/plans/<timestamp>-<slug>.md` by default
(`plan.plansDir`, `{yyyymm}` expands to the UTC month). `plan.savePlans`
decides WHICH plans hit disk: `all` (every `write_plan`, default), `approved`
(drafts stay in the module's state, the file is written at approval), `none`
(never — the conversation is the only copy, and fresh-session execution is
refused because it needs a plan file). Refinements of the same draft reuse its
file, containment-checked against the resolved plans dir; an approved plan is
cleared on the next plan-mode entry.

**Tool gating** (`tool_call`): `BLOCKED_TOOLS` hard-error, bash writers
hard-block, bash reads + `READ_ONLY_TOOLS` auto-allow, everything else takes a
confirm tier (`Allow once` / `Allow for this session` / `Deny`, keyed by tool
name or `bash:<first token>`, full command for interpreter first tokens —
cleared on every mode toggle). Headless confirm-tier calls block. A `subagent`
call auto-allows only when EVERY named agent resolves `sandbox: read-only`
(via `discoverAgents`, the subagent module's loader). The bash classifier is
vendored from upstream (`lib/shell-gate.ts`) with ONE deviation: a valueless
xargs long option (`xargs --null rm`) no longer eats the payload — upstream
read it as "read" and auto-allowed a writer.

**Settings** (`plan` section, GLOBAL agent-dir settings.json, trusted project
overlay; read per event so /config saves are live): `/config` → Tasks → Plan
mode rows `plan.savePlans` (closed set), `plan.plansDir`, `plan.planModel`
(catalogue menu), `plan.planThinking` (closed set), `plan.autoApprove`. The
plan model/thinking apply only while planning and the pre-plan values are
restored on exit; `/plan-model` and `/plan-thinking` remain as command
surfaces. `plan.autoApprove` (or bare `/plan-auto`) approves a written plan
and executes it in the current session on settle, no keypress.

LOAD ORDER: the registry places plan AFTER subagent (its gating reads subagent
agent frontmatter) and BEFORE steering (steering must stay the last
`before_agent_start` rewriter). Standalone `@bacnh85/pi-plan` must be removed
when ceulen's plan module is enabled — the conflict guard refuses the
duplicate commands/tools.

### Steering module (steering)

Ported from the model-family half of `@bacnh85/pi-model-tools` 0.9.5 (see
`extensions/modules/steering/`): provider-agnostic family detection
(deepseek-v4 | glm — substring matching, works through the router proxy:
`combo/deepseek-v4.1-flash` matches), first-tool hints (bash-first / clone-
first / find-first — user-message tail ONLY, first provider round of the
turn), reasoning strip + leaked-content cleaning (the biggest prefix-cache-
stability factor), error categorization + recovery hints, DeepSeek selection
guidance / superpower (off by default) / strict-Serena steering, and the
**ds-anchor** (deepseek-v4-pro minimal-mode two-phase bootstrap, on by
default: request #1 gets the byte-identical DSH minimal prompt +
bash/str_replace_editor only, max_tokens 256000; promotes on the first
durable assistant reply; fail-open everywhere; `/steering` shows the anchor
trace ring).

LOAD-ORDER CONTRACT (the reason steering is its own registry entry, placed
last of the prompt rewriters — after every before_agent_start composer
(ponytail/plan/subagent/munin/advisor/ux/fff/serena/web) and immediately
before rtk/config): pi chains
`before_agent_start` results — each handler's returned systemPrompt becomes
the next handler's event.systemPrompt. Steering registers LAST of the prompt
rewriters, so during the anchor bootstrap its returned minimal prompt
REPLACES everything ponytail/advisor/subagent composed (the only place a
ceulen module clobbers instead of composes); on the normal path it composes
onto `event.systemPrompt` and never drops existing content. Do not add a
second system-prompt-rewriting module after it.

Settings: the `steering` section (`firstToolHints`, `selectionGuidance`,
`superpower`, `superpowerPrompt`, `strictSerena`, `stripReasoning`,
`dsAnchor`, `weNeed`), read per turn. The steering reminder customType is
`ceulen-steering`. `/steering` = status (family, flags, cache stats,
anchor state + trace). The zai-provider payload hooks (fast-mode body,
throttle, signing) are NOT here — the zai module owns them, gated on provider
id, not model family.

### Z.AI provider module (zai)

Ported from `@bacnh85/pi-model-tools` 0.9.5's provider plumbing (see
`extensions/modules/zai/`): the `zai-anthropic` provider — GLM-5.x through
Z.ai's Anthropic Messages endpoint (`https://api.z.ai/api/anthropic`),
giving explicit `cache_control` prompt caching, the `speed:"fast"` serving
tier, and effort-based reasoning that the OpenAI-compatible endpoint lacks.
Registered UNCONDITIONALLY (`apiKey: "$ZAI_ANTHROPIC_API_KEY"` keeps `/login
zai-anthropic` reachable). Includes the cross-process dispatch throttle
(file lock, default 1000 ms, Z.ai 429/1302 rate-limit guard, fail-open) and
**ZCode Client-Signing V4** (identity headers + X-Session-Id + per-request
Ed25519 signatures + PoW, ported from TriDefender/zcode-api, fail-open
everywhere: gate unreachable / handshake failure / legacy single-part key /
two consecutive 401s → unsigned bypass).

Settings: the `zai` section (`baseUrl` — menu over the 4 known endpoints;
`speed` fast|standard; `signing` on by default; `minIntervalMs`), layered
env `ZAI_ANTHROPIC_*` > trusted project > global. All values are read PER
REQUEST except the provider registration itself (a `baseUrl` save live-
re-registers the provider, router precedent). `/zai` = status, never prints
the key. ZCode signing only matters on the `zcode.z.ai/api/v1/ultra-zai`
route — `api.z.ai` ignores the `X-Client-*` headers.

### Web module (web)

Ported from `@bacnh85/pi-web` 0.17.8 (see `extensions/modules/web/`): the 11
unified web tools — `web_search` (SearXNG → Brave → Firecrawl adaptive),
`web_extract` (static JSDOM → Firecrawl → Crawl4AI → agy), `web_map`,
`web_crawl` (Firecrawl light / Crawl4AI full), `web_screenshot` + `web_pdf`
(Crawl4AI daemon, local headless Chrome for localhost/LAN/file URLs),
`web_interact` (CDP headless Chrome: trusted click/type/press, evaluate,
dialog answers, device-metrics emulation + overflow probe), `web_research`
(Gemini web ask / Deep Research), `web_image` (Gemini web → ChatGPT web →
Z.ai GLM-Image → custom endpoint, inline image blocks), `web_chat`
(ChatGPT web / OpenAI-compatible gateway), `web_status`. Plus the
conditional `WEB_ROUTING_GUIDANCE` injection (`before_agent_start`, only when
a `web_*` tool is active — append-only, the fff precedent) and the `web`
skill via its own `resources_discover` dir (kill-switch gated). No slash
command — `web_status` covers status.

**Dependencies** — this module is ceulen's SECOND sanctioned dependency
exception (after `@ff-labs/fff-node`): `jsdom` and `gemini-reverse` cannot be
vendored (jsdom's transitive tree; a maintained reverse-engineering client),
and `axios` rides along because `gemini-reverse` hard-depends on it (its
proxy support backs `GEMINI_WEB_PROXY` in the cookie-rotation POST).
Everything else is VENDORED under `extensions/modules/web/vendor/`
(`// ponytail: vendored from ...` headers): `@mozilla/readability`,
`turndown`, `turndown-plugin-gfm` — all pure-JS. The vendored turndown carries
ONE local delta: its `createHTMLParser` falls back to `jsdom`'s `DOMParser`
instead of the un-vendored `@mixmark-io/domino`. `vendor/package.json`
(`{"type":"commonjs"}`) keeps the CJS vendor files CJS under the bundle's
`type: module`. All heavy imports stay lazy (`createRequire` in
`lib/content.ts`, dynamic `import()` for gemini-reverse), so the entry import
graph is unchanged.

**Config is `/config`-editable** (Tools tab, `Web` section 🌍): 16 provider
rows over the GLOBAL agent-dir `settings.json` `web` section, read PER TOOL
CALL (a save applies without `/reload`), with a trusted project
`.pi/settings.json` `web` section shadowing per field. Precedence: per-call
params > `process.env` (ceulen's bundle `env.ts` already ingests agent-dir +
trusted-cwd `.env*` into it — pi-web's own dotenv file-walking was DELETED,
see `lib/config.ts`) > trusted project > global > built-in default. Secrets
are masked rows; the save notify discloses env overrides and project shadows.
The env names are the stable contract (unchanged from pi-web): `SEARXNG_BASE_URL`,
`BRAVE_API_KEY`, `FIRECRAWL_API_URL`/`_API_KEY`/`_TIMEOUT_MS`,
`CRAWL4AI_API_URL`/`_API_TOKEN`/`_API_TIMEOUT_MS`, `GEMINI_WEB_SECURE_1PSID`,
`GEMINI_WEB_PROXY`, `ZAI_API_KEY`, `WEB_IMAGE_API_BASE_URL`/`_API_KEY`/`_DAILY_CAP`,
`WEB_CHAT_API_BASE_URL`/`_API_KEY`. Env-only (no row): `GEMINI_WEB_SECURE_1PSIDTS`,
`GEMINI_WEB_COOKIE_STORE`, `GEMINI_WEB_KEEPALIVE`, `GEMINI_WEB_ROTATE_INTERVAL_MS`,
`CHATGPT_WEB_*`, `WEB_IMAGE_API_LABEL`, `WEB_IMAGE_MIN_INTERVAL_MS`, `CHROME_PATH`.
The two timeout rows are a CLOSED SET (15s/30s/1m/2m/5m) because pi-web's
loaders reject a value < 1000 ms by throwing — a free-text row could brick
every Firecrawl/Crawl4AI-backed tool.

Per-tool kill-switch: all 11 tools register `defaultActive` from
`ceulen.disabledTools` (registry `tools` list) — /config re-activates them
live. Standalone `@bacnh85/pi-web` must be removed when this module is enabled
(the conflict guard refuses the duplicate `web_*` names).

### Todo module (todo)

Ported from OMP's phased task tracking (see
`/Volumes/Dev/agents/omp/packages/coding-agent/src/tools/todo.ts`), reduced to
phase granularity (see `extensions/modules/todo/index.ts` header for the
enumerated deviations). One `todo` tool: `init/start/done/rm/block/unblock/
append/view` over an ordered list of phases `{title, status:
pending|in_progress|done, blockedBy?, notes?}`. Blocked is DERIVED from unmet
`blockedBy` edges (finishing a blocker auto-unblocks dependents); after every
successful mutation the earliest pending unblocked phase auto-starts;
`start` errors while another phase is `in_progress` (unless `force`). Every
mutation persists via `pi.appendEntry` (customType `ceulen-todo`, one entry
per mutation, session_start rehydrates the LAST via `getBranch()` — the plan
module's pattern) and updates the `ceulen-todo` status segment (`▸ 2/5 done ·
in_progress: …`), cleared on all-done/empty and on session_shutdown. The
result text is the rendered board + OMP's batch contract in promptGuidelines
(batch todo calls with real work, never call todo alone) — no
`before_agent_start` handler, so the module stays OUTSIDE the steering
load-order contract. `/todo` prints the board; `/todo clear` resets.

### Rules module (rules)

Ported from OMP's sticky context files + rulebook (see
`/Volumes/Dev/agents/omp/docs/context-files.md`), lean (format documented at
the top of `extensions/modules/rules/lib/rules.ts`). Sources, nearest-first:
`<dir>/.pi/RULES.md` walking cwd → root, then `~/.pi/agent/RULES.md`;
duplicate names resolve first-wins (project beats user). Format: one rule per
`## <name>` section; a body whose first line is `description: …` is a
RULEBOOK rule (the prompt carries only `- name: description`; the body is
served on demand by the `rule_get` tool); no description line = STICKY rule
whose body is appended to EVERY request inside `<user-rules>…</user-rules>`,
capped at 4000 chars (lowest-precedence dropped first under a loud truncation
marker). `@path` imports expand at load (relative to the importing file,
5-hop limit, cycle-guarded, missing → literal marker). The
`before_agent_start` handler is APPEND-ONLY (the fff precedent) and returns
`undefined` when no RULES.md exists anywhere — zero footprint by default; it
loads immediately BEFORE steering in the registry (it is a prompt composer,
so it must precede the last rewriter). Rule files are cached by mtime (the
ponytail config pattern) — edits apply without /reload; `/rules` = status,
`/rules reload` = drop the cache.

### Conflict rules (all modules share ONE extension object — duplicates silently overwrite without the guard)

- The bundle entry wraps each module's `pi` in `guarded()` (extensions/index.ts, one shared ownership map for the whole load loop): a name claimed by a DIFFERENT module throws at load; same-module re-claims pass (router re-registers its provider at runtime — that's the supported update path). Contract tests: `extensions/modules/router/test/guard.test.ts`.
- Generic slash-command subcommands take the module prefix (`router-status`, not `status`); distinctive bare names are fine (`/usage`, `/context`, `/ponytail`).
- Message/entry-renderer customTypes and status-bar keys take the `ceulen-` prefix (`ceulen-usage-status`).
- Settings keys are namespaced by module (`router.baseUrl`, `ceulen.disabled`); cross-extension names (customTypes, User-Agent) use `ceulen`, never `pi-<module>`.

## Commands

- `npm install` — set up (dev deps only: tsx, typescript, @types/node, pi peer packages)
- `npm run typecheck` — `tsc --noEmit` over `extensions/**` (usage tests excluded: loose harness stubs don't typecheck; they run under tsx)
- `npm test` — router unit + guard suites, usage suites, ponytail suites, config suites, subagent suites (node --test via tsx)
- `npm pack --dry-run` — verify the shipped file list (extensions/, skills/, README, LICENSE, CHANGELOG; no docs/)

## Settings / kill-switch

`ceulen.disabled: string[]` in `~/.pi/agent/settings.json`, or `.pi/settings.json` in a **trusted** project (trust is read from `<agentDir>/trust.json`, walking up like pi; untrusted repos can't toggle modules). `/config` writes to whichever file currently carries the `ceulen` section (see the config-module section) — never a shadowed layer. The deprecated `"sub"` key is still treated as `"usage"`. **CORE modules** (`ModuleEntry.core: true`, today `composer`, `advisor`, `router`, `classifier`, `usage`, `ux`, `config`) are always loaded: `readDisabled`/`writeDisabled` filter them (a stale entry can't disable one), `nextDisabled` never lists them, and the config panel adds no Enable row. Note: Pi's SDK `ExtensionAPI` has no `getSetting` — `extensions/lib/registry.ts` reads settings.json directly.

## Yardmaster usage contract (usage module)

With `router.baseUrl` set to a yardmaster instance, the usage module polls `GET <baseUrl>/usage?provider=<prefix>` (Bearer = the router API key), falling back to aggregate `GET /usage` on per-provider 404, and to OmniRoute `GET <origin>/api/usage/om-usage` when no JSON usage endpoint exists. Response shape: `{windows: {session|weekly|monthly: {remaining_pct, reset_at}}, credits: {currency, balance}}`. The key needs yardmaster's usage permission. Renderer + parser live in `extensions/modules/usage/index.ts` (`parseGenericUsage`).

## Ponytail config (ponytail module)

Ponytail resolves its default mode from `PONYTAIL_DEFAULT_MODE`, then `~/.config/ponytail/config.json` (`{"defaultMode": "full", "quietStartup": false}`; XDG_CONFIG_HOME respected), then `full`. `PONYTAIL_QUIET_STARTUP`, `PONYTAIL_SUBAGENT_SCOPE=off` override the config booleans. The module renders NO status-bar segment (the mode is visible via `/ponytail status`), so upstream's `PONYTAIL_HIDE_STATUS` env and the `hideStatus` config key are dropped. Config surface is deliberately NOT namespaced to `ceulen.*` — the `ponytail.*`/`PONYTAIL_*` names are the module's stable contract.

## UX config (ux module)

Ported from `@bacnh85/pi-ux` 0.6.6 (see `extensions/modules/ux/UPSTREAM`). Resolves its default mode from `PI_UX_DEFAULT_MODE`, then `~/.config/pi-ux/config.json` (`{"defaultMode": "strict", "quietStartup": false}`; XDG_CONFIG_HOME respected), then `strict`. `PI_UX_QUIET_STARTUP` overrides the saved boolean — same stable-contract policy as ponytail (standalone pi-ux settings carry over). **No status-bar footprint**: the module never calls `setStatus`, and upstream's `hideStatus` setting / `PI_UX_HIDE_STATUS` env are dropped. Bare `/ux` reports status (not upstream's reset-to-default); the default mode is owned by `/config` (Appearance → UX discipline), not a `/ux default` subcommand.

## Release flow

Bump `version` in `package.json` → commit → `git tag vX.Y.Z` → push → `gh release create vX.Y.Z` — the GitHub **release** (not the tag push) triggers `publish.yml` (npm publish, provenance on). CI (`ci.yml`) runs typecheck + tests on every push/PR.

## Central config panel (config module)

The `config` module owns `/config` — a central settings panel rendered from
pi core settings + per-module contributions on top of `extensions/lib/panel.ts`,
categorized under OMP's settings taxonomy: **Appearance · Model · Interaction ·
Context · Files · Shell · Tools · Tasks · Providers · Plugins** (Memory is
omitted — pi exposes no writable memory settings; empty tabs don't render).
`/settings` is a Pi builtin; an extension command with that name is skipped in
autocomplete and renamed (`/settings:1`), never an override — `/config` is
unused by pi core.

Mechanism (registry + loader):

- `extensions/lib/registry.ts` owns `MODULES` (`{ name, load, config? }`);
  `extensions/index.ts` imports it and, for each enabled module, builds a
  `configContribs` map of `() => ModuleConfig` factories — each closing over
  THAT module's *guarded* `pi` (a save that re-registers a provider, e.g.
  router's, stays the owner's claim). The map is passed to every module factory
  as a second arg (`ModuleLoadDeps`); only the config module reads it.
- A contribution is `{ groups: () => PanelGroup[], save(editedKeys, ctx) }`.
  Row keys MUST be prefixed `<module>.` — `save()` receives the set of edited
  keys and no-ops unless one of its own is present.
- Row contract beyond `key/label/kind/value/set` (all optional, `row()` opts):
  `description` (one-liner in the panel's fixed 3-row footer), `warning`
  (caveat rendered warning-styled above the description + a ⚠ glyph on the
  row; reserve for real risk — reload requirements, env precedence), `values`
  (closed set: Enter opens the selection submenu, no free-text editing),
  `menu` (dynamic option provider — themes, models; overrides `values` for the
  submenu and is called LAZILY at open time), `preview` (live-preview hook
  fired per highlighted option while the submenu is open) + `previewCancel`
  (fired once on Esc so the row undoes its live preview — the row owns the
  restore; `set` owns the committed effect),
  `defaultValue` (values differing from it render warning-styled),
  `completions` (inline suggestion picker for comma-separated free text),
  `mask` (secret row: value renders `••••` in the panel AND the `/config show`
  summary (config/index.ts masks in summaryLines; panel.ts:369 only blanks it
  for search filterText) — edit starts EMPTY, never prefills the secret,
  empty submit is a no-op).
  `ModuleEntry.describe` gives the module one-liner used by its kill-switch row.
- Panel layout (v4, fullscreen BOXED frame + OMP's tab → section → rows
  hierarchy):
  the panel opens as a 100%×100% top-left OVERLAY (`ctx.ui.custom` with
  `{ overlay: true, overlayOptions: … }`) and renders a fixed-chrome frame
  exactly `max(14, getHeight())` rows tall — rounded top border with the title
  inset (`╭─ Title ─╮`) → boxed tab row → tee divider (`├──┤`) → boxed body →
  boxed description area → tee divider → boxed pinned key-hint footer →
  rounded bottom border (`╰──╯`); every content row is `│ … │` (OMP's
  overlay-box). `ConfigPanelModel.getHeight` reads `process.stdout.rows`
  (40 fallback; tests inject a constant). The body absorbs the remaining height
  (window budget derives from it — no fixed row cap); `FRAME_ROWS = 7 +
  DESC_ROWS` chrome rows. Adjacent `PanelGroup`s sharing a `tab` key merge into
  ONE tab (the tab chip shows the tab name + first icon); each group's `label`
  renders BOTH as a left-sidebar SECTION entry and as an in-pane underlined
  heading above its rows (OMP renders both). The sidebar width is PINNED across
  every tab (`min(22, longest section label) + 4`) so the `│` rail never jumps
  between tabs; it shows on any tab with sections and hides when the rows pane
  falls below 60 columns (OMP's threshold) — headings remain. Tabs show
  per-tab icons (`PanelGroup.icon`).
  `←/→`/`Tab`/`Shift+Tab` switch tabs (WRAPPING ring, OMP's TabBar) and use
  `matchesKey` from pi-tui — never raw byte compares (SS3 `\u001bOD` and kitty
  CSI-u otherwise break `←`). `PageUp`/`PageDown` jump sections (wrap; with one
  section they page through rows). The ACTIVE tab renders ` icon Label ` in
  `selectedBg`/bold-accent; on overflow, inactive tabs collapse to icon-only
  starting with those FARTHEST from the active one (OMP's TabBar) — the active
  tab keeps its full label. Rows OUTSIDE the active section get a dim wash
  (headings included). Each
  tab remembers its own selection; ↑/↓ is clamped to the tab. Fixed-height
  description area (3 rows: ⚠ warning, then description; hidden while the
  active tab is empty), type-to-search fuzzy filter across ALL tabs (flat
  match list; `←/→` jumps between matching categories; `Esc` clears first,
  snapping the tab to the selected row, a second `Esc` closes). The footer
  hint is PINNED as the frame's last content row and follows the mode
  (browse / filter / prompt / completions-edit / menu), with the dirty marker
  right-aligned on the same line; hints render `key` in accent + meaning in
  dim. The BROWSE hint derives from the active tab's row kinds: `Enter toggle`
  for toggle-only tabs, `Enter choose` when every actionable row is a
  toggle/enum/menu, `Enter change` otherwise, no Enter pair for info-only
  tabs, and no section jump with fewer than 2 sections (OMP's plugins tab
  shows different guidance than its setting tabs for the same reason).
  Row colors (OMP's settings-list theme): selected → accent; changed vs
  `defaultValue` → `warning` (label and value; on a selected+changed row the
  label stays accent, the value warns).
- Selection submenu (OMP's select submenu): Enter on a row with `values` or
  `menu` opens an in-frame option list — the row's label as an accent-bold
  heading, the highlighted option (`›` + text), per-option `description` in
  dim, `(current)` on the row's value, a `Type to search` line (live query
  with match count while typing). ↑/↓ browse (CLAMPED, no wrap), PageUp/Dn
  page, printable text filters option labels/values, ⌫ edits the query, Enter
  commits (the normal set + dirty + editedKeys path), Esc clears the query
  first and backs out on the second press. `preview` fires per highlighted
  option and `previewCancel` once on Esc — never on commit. The menu
  consumes every key while open (tabs can't switch beneath it), and the row
  stays selected so the fixed description area keeps rendering its
  description/warning (OMP keeps the setting context visible). An empty
  `menu()` falls back to the inline editor (string/number rows) or no-ops.
  The panel's own chrome follows a live preview for free: pi's theme object is
  a Proxy over a globalThis slot (`theme.js`), so every `theme.fg()` call reads
  the CURRENT theme — no refresh hook needed, the preview's `requestRender()`
  repaints with the new colors.
- Theme and Default-model rows upgrade to menus when the /config command
  supplies a `PiMenuLookup` built from its live `ExtensionContext`
  (`ctx.ui.getAllThemes/getTheme/setTheme`, `ctx.modelRegistry.getAvailable`):
  Theme previews via the Theme-INSTANCE form of `ctx.ui.setTheme` (live, no
  settings.json write) and commits via the NAME form (live + persist; the row
  also persists through the panel's own SettingsManager so the normal flush
  path stays authoritative). Default model renders/commits `provider/id`
  (`setDefaultModelAndProvider`); malformed values are ignored. Headless
  contexts (empty theme list, no model registry) fall back to plain text rows.
- Pi core settings are rows too (`extensions/modules/config/piSettings.ts`),
  backed by pi's OWN public `SettingsManager` (`SettingsManager.create(cwd,
  agentDir)`): typed getters give effective values (global ⊕ project), typed
  setters persist to the GLOBAL settings.json with pi's locking/atomicity, and
  `flush()` drains the write queue on save. Only settings WITH a typed setter
  are surfaced (`externalEditor`, `sessionDir`, `branchSummary.*`,
  `httpProxy` have none — they stay config-file-only). THE ONE SANCTIONED
  EXCEPTION is `defaultTools` (extensions/modules/config/defaultTools.ts):
  SettingsManager exposes `getDefaultTools()` but no setter, so the Tools →
  "Built-in tools" section renders one toggle per built-in tool (read, bash,
  powershell, edit, write, grep, find, ls + the built-in extension tools
  codemode, tool_search; stock four default-on) over a working Set, and the
  save path hand-writes the resolved absolute list into the GLOBAL
  settings.json with the shared atomic-write pattern — stock-equal lists
  DELETE the key (pi's reset semantics; an empty array would mean NO tools).
  The same save applies the delta to the live session via
  `applyToolSwitches`, so a toggle needs no /reload. A plain defaultTools
  list only replaces the BUILT-IN startup selection — extension tools with
  `defaultActive: true` self-activate regardless, so ceulen's tools are
  never touched. `STOCK_DEFAULT_TOOLS` replicates pi's unexported
  DEFAULT_TOOL_NAMES.
  Coverage is full stock-`/settings` parity plus the setter-only extras:
  per-model thinking overrides (one row per override — `pi.modelThinkingLevels.
  <provider/id>` — plus an **Add model override** menu row; the clear option
  reverts to the default), Fullscreen wheel scrolling, and the extra
  resource-dir lists (extensions/skills/prompts/themes). Friendly choice forms
  mirror stock (`30 sec`…`disabled`, `Ask`/`Always trust`/`Never trust`, the
  padding/autocomplete/image-width sets, per-level thinking descriptions) —
  those constants are replicated locally because pi does not export them from
  its package root. OMP taxonomy holds: Providers · Protocol/Timeouts/Privacy,
  Tasks · Commands & Skills, Tools · Extensions, Context · Prompt templates.
- The panel kernel supports dynamic row sets via `ConfigPanelOpts
  .rebuildOnCommit` (`ConfigPanelModel.rebuild`): after any committed edit
  (toggle, menu pick, inline submit) the groups are rebuilt from `build` and
  swapped in — that is how per-model override rows appear/disappear on commit.
  `/config` turns it on; static row sets leave it off.
- `/config` builds the panel per open: pi-settings groups + every module's
  groups (Enable row prepended to the module's first section) + plugins, sorted
  by `PI_TAB_ORDER`. Every contribution renders even while its module is
  DISABLED — the Enable row must stay reachable; only bundle load honors the
  kill-switch (after /reload). On save it writes the kill-switch first, flushes
  the pi SettingsManager, saves plugins, then runs each contribution's `save()`
  in its own try/catch — one failure never blocks the others.

Plugins group (`extensions/modules/config/plugins.ts`) — Pi-package on/off,
the "whole PI plugins" tab. Pi stores installed packages in the `packages`
array of settings.json; the load contract (Pi's `package-manager.js`
RESOURCE_TYPES / applyPackageFilter) is: string entry = load everything;
object with ALL FOUR resource arrays empty = "Empty array explicitly disables
all resources of this type" (the off form); patterns or partial empty arrays =
granular `pi config` setup; `autoload: false` = project filter delta. The
group renders one toggle row per package (project entries first, then global
— each row writes back to the file it came from), classifies filtered/delta
entries as read-only `info` rows ("custom filters"), and `/config show` lists
the same set. `flipPackage` encodes the string ⇄ all-empty-array forms.
Scope: global agent-dir file always; project `.pi/settings.json` only when
trusted (untrusted packages never load, so they must not show as active).
- `writeDisabled`/`readDisabled` resolve through ONE `disabledSource()`
  (trusted project `.pi/settings.json` when it carries a `ceulen` section,
  else the agent-dir file) so a toggle can never be shadowed by a higher-
  precedence layer. The project-file case is disclosed in the group label and
  the save notify.

Contributions today: **router** (`router.baseUrl`, `router.enableReasoning` —
save re-registers the provider, force-refreshes the catalog, revalidates the
active model; **Providers** tab, `Router` section) and **ponytail**
(`ponytail.defaultMode`, `ponytail.quietStartup` —
writes its own `~/.config/ponytail/config.json`; applies next session;
**Tasks** tab, `Ponytail` section) and **munin** (`munin.project`,
`munin.baseUrl`, `munin.apiKey` (masked, gitignore warning) — writes the
PROJECT `.pi/settings.json` `munin` section, effective immediately (config is
read per tool call, no reload); **Memory** tab, `Munin` section) and
**advisor** (`advisor.enabled`, `advisor.model`, `advisor.thinking`,
`advisor.fallbacks`, `advisor.watch.{minToolCalls,immuneTurns}` — writes the
GLOBAL `advisor` section (legacy `pi-advisor` migrated on first save), applied
live through the module bridge; **Model** tab, `Advisor` section) and
**classifier** (`classifier.model`, `classifier.permission.*`; **Model** tab,
`Classifier (Jev)` section) and **subagent** (`subagent.routing.{mode,model,
threshold}`, `subagent.roles.{fast,coder,smart}` (diff-based — pristine
defaults never written; clear-to-empty deletes = default restored),
`subagent.{idle,hard}TimeoutMins` — writes the GLOBAL `subagent` section,
applied live (settings read per execute()); **Tasks** tab, `Subagents`
section) and **steering** (`steering.{firstToolHints,selectionGuidance,
superpower,superpowerPrompt,strictSerena,stripReasoning,dsAnchor,weNeed}` —
writes the GLOBAL `steering` section, read per turn so saves apply live;
**Model** tab, `Steering` section) and **repair** (`repair.{arguments,
editRetry,guards,autoBg,autoBgSecs}` — writes the GLOBAL `repair` section;
first three apply next turn, the bash pair binds at load = next session,
disclosed by row warning + save notify; **Tools** tab, `Repair` section) and
**zai** (`zai.{baseUrl,speed,signing,minIntervalMs}` — writes the GLOBAL
`zai` section; baseUrl save live-re-registers the provider, the rest read
per request; **Providers** tab, `Z.AI (Anthropic)` section) and
**plan** (`plan.{savePlans,plansDir,planModel,planThinking,autoApprove}` —
writes the GLOBAL `plan` section, read per event so saves apply live;
**Tasks** tab, `Plan mode` section) and **web** (`web.{searxng.baseUrl,
brave.apiKey, firecrawl.*, crawl4ai.*, gemini.cookie, gemini.proxy,
image.zaiKey, image.customUrl, image.customKey, image.dailyCap, chat.baseUrl,
chat.apiKey}` — writes the GLOBAL `web` section, read per tool call so saves
apply live; the two timeout rows are a closed set; **Tools** tab, `Web`
section 🌍). A NON-CORE module
without a contribution factory gets
a synthesized Enable-only section (serena → **Tools** · `Serena`, fff →
**Tools** · `FFF search`, rtk → **Shell** · `RTK`). The per-module kill-switch
rows are
NOT a standalone tab: `withEnableRow()` prepends the module's Enable row (key
`ceulen.disabled.<name>`, warning "Takes effect after /reload") to its own
section — a feature is turned on where it is configured. **composer**
(bundle-level, not a module contribution): Pi-package enable/disable, see
above.

Adding a contribution (the ONLY supported mechanism — there is no
`describeConfig()`; the loader wires this one):

1. Export a factory from the module: `export function myConfig(pi: ExtensionAPI): ModuleConfig`
   returning `{ groups: () => PanelGroup[]; save: (edited: Set<string>, ctx) => Promise<void> }`.
2. List it on the module's MODULES entry in `extensions/lib/registry.ts`:
   `{ name: "mymod", load: myModule, config: myConfig }`.

The loader calls the factory per `/config` open with the module's OWN guarded
`pi`, and only when the module is enabled. `save()` must no-op unless one of
its `<module>.`-prefixed keys is in `edited`. No config-module change is needed.
Usage has no writable settings and contributes nothing.
