# Changelog

## 0.15.0 — 2026-10-08

Deferred-exposure pass + config kill-switch removal (net −660 lines):

- **Deferred tools**: 56 cold tools across 19 modules now register with
  `exposure: "deferred"` — pi declares only hot direct tools in the system
  prompt (fresh session: 23 tools ≈ 438 tokens, was ~79 ≈ 21K);
  `tool_search` loads them on demand and the bundle re-activates
  `tool_search` on `session_start` whenever a deferred tier exists.
  Registry `tools?: string[]` → `deferredTools?: string[]` tier lists;
  `ceulen.disabledTools` + `lib/tools.ts` deleted outright.
- **/config**: module Enable rows, synthesized Enable-only sections, and
  per-tool toggle rows REMOVED — `ceulen.disabled` remains the
  settings-only escape hatch (no UI); Built-in tools is 9 rows
  (tool_search removed — ceulen owns its activation).
- **usage report fix**: `computeContextBreakdown` counted ALL registered
  tool schemas as "System tools" — now counts ACTIVE tools only (what the
  model actually receives) and discloses the deferred tier separately
  (`Tools (N active · X tokens in prompt · M deferred not in prompt (Y))`).
  Fresh-session prompts were never carrying the 21K the old report showed.
- Prompt-guidance updated for on-demand loading (serena guidance matches
  `tool_search`, munin protocol + rules rulebook point at `tool_search`
  first); tests updated, +1 deferred-tier disclosure suite.

## 0.14.0 — 2026-10-08

Review-wave hardening across 7 modules (round-3 findings), 8 new regression
suites, tests now 2792 (was 2750):

- **gh**: the `/config` run_watch row passed its working value BY VALUE — the
  row setter rebound its parameter and every save wrote the original value
  back with a false "Saved" notify (the module's only setting was silently
  unwritable). Now the todo-module `{ value }` box pattern with a load-bearing
  NaN guard (a garbage inline edit can no longer write JSON `null`);
  round-trip tests drive row edit → save → settings.json.
- **fff**: in override mode a `guarded()` collision on `grep`/`find` (repair
  owns the wrapped builtins) aborted the whole registration loop — override
  mode lost resolve_file/fff_multi_grep/related_files along with the two
  colliding names. Registration now degrades PER TOOL with one dim notify
  naming the skipped tools; normal mode unchanged.
- **repair** (archive/sqlite/guard hardening): `pkg.tgz:src/x.ts:50-80` peels
  the trailing lines-selector BEFORE the member lookup (member+range reads
  were reporting "no member matching"); guard × archive-member reads resolve
  the real target path; tar option-injection gate (member names starting with
  `-` are refused); the auto-generated write guard handles relative paths
  correctly; ascii rename-arrow target paths in read notices.
- **shells**: `since:"last"` cursors moved to LIFETIME line counts — a
  ring-cap shrink could strand an index cursor and permanently black out
  output; per-stream cursors (one shared offset duplicated stderr when stdout
  was longer); `kill` refuses pid 0 (`kill(-0)` would SIGTERM pi's own
  process group); session-name resolution prefers LIVE matches over lingering
  exited ones; session_start clear via `store.clear()`.
- **jfind**: file reads respect `scanLimitBytes`/`maxBytes` byte caps with
  truncation flags (a 3 MB file was read whole); a single-file scope that
  lists zero eligible files surfaces the eligibility refusal instead of a
  silent "no hits".
- **a2a**: `A2A_MAX_CONCURRENT` is now read from process env (declared env
  parity) and a garbage/`0` value falls back to the default instead of
  zeroing the admission pool (which would reject every inbound task).
- **web/read_pdf**: the lazy pdf.js engine import goes through `pathToFileURL`
  — an unencoded `file://` string broke on spaces in the install path.
- Tests: +8 regression suites/files — gh config row round-trip, fff guarded-
  collision degrade, repair hardening (A1/A2/A4/A6/A9), repair auto-bg +
  settings, shells output/store wiring, web pdf pathToFileURL, a2a env parity,
  jfind caps.

## 0.13.0 — 2026-10-08

- **Tool-parity wave** (8h OMP/industry survey plan): 4 new modules + 4
  read/write upgrades, all live-verified end-to-end (real spawns, real
  classifier round-trips, real osascript):
  - **shells** (new module): one `shell` tool — start/list/output/stdin/kill
    over persistent background processes (dev servers, watchers, long
    builds). Own process group per session (group kill via `kill(-pid)`),
    256 KB line rings (head+tail + truncation marker), 10 live/5 exited
    caps, `since:"last"` output cursor, killAll on session_shutdown.
    Plan-blocked.
  - **read-sqlite** (repair): the wrapped read opens `db.sqlite` views —
    table list, `:users` schema+rows, `:users:42` rowid, `:users:name=alice`
    key lookup, `:?SELECT…` read-only query. `node:sqlite` READ-ONLY per
    call; db is genuinely un-writable.
  - **read-archive** (repair): `.tar`/`.tgz`/`.zip` member listing +
    content through the read path; exact-then-unique-suffix member match,
    1 MB cap, binary refusal; `pkg.tgz:src/x.ts:50-80` slices the member.
  - **auto-generated guard** (repair): writes/edits to lockfiles, minified
    bundles, build dirs and snapshots are refused with a regenerate hint
    (bash stays the deliberate override); `repair.autoGenGuard` setting,
    default on, /config row on Tools → Repair.
  - **read_pdf** (web, 13th tool): local PDF text via vendored pdf.js 4.10
    (Apache-2.0, lazy import, workerless) — no external binaries; pages
    grammar `"3"`, `"1-5"`, `"2,4,6-8"`, 10-page cap/call. Plan read-only.
  - **sg** (new module): `ast_grep` (structural search, `$VAR`/`$$$ALL`
    meta-variables, multi-pattern merge+dedupe) + `ast_edit` (pattern →
    rewrite across files; DRY-RUN by default, staleness re-check after
    apply warns on self-matching rewrites). Fail-open on a missing
    ast-grep binary. Pattern-parse failures render a hint on ast-grep 0.4x
    (exit 8 "Cannot parse query") as well as legacy sg. Plan read-only
    search, blocked rewrite.
  - **jfind** (new module): semantic code find — describe a behavior, get
    files + line ranges, strongest first. OMP cascade port (lexical IDF
    prior → filename judging → sketch routing → passage verification); the
    judge routes through the router's System One classifier models. Plan
    read-only.
  - **notify** (new module): one `notify` tool — desktop notification via
    osascript/notify-send, bell fallback, harmless by construction.
- Wiring: registry entries + per-tool kill-switches + plan-mode tiers, test
  globs, /config tool-section count 16→20, composer disabled-list, AGENTS.md
  sections, `@types/node` ^24 (node:sqlite types).
- Tests: 2750 (was 2661) — suites for shells sessions, readers, sg ops,
  jfind cascade (fake-judge), notify.
- Live-verified (2026-10-08 round): shells ring/group-kill/stdin,
  sqlite+archive views + guard refusal through real pi runs, pdf extraction,
  sg dry-run/apply/staleness, jfind cascade vs the real classifier, notify
  osascript delivery; one fix shipped (sg pattern-error detection, above).

## 0.12.0 — 2026-10-08

- **Secrets never land in settings.json** (user policy: URLs fine, credentials
  not): masked `/config` rows (web's 7 keys/cookies, a2a gateway
  token/upstreamToken) persist to `<agentDir>/.env.local` (0600, ingested into
  process.env at import — env already won at read time, so effective values
  are unchanged); `migrateSecretsFromSettings` (bundle session_start) moves
  any pre-fix plaintext secrets out of settings.json and scrubs them,
  idempotently (extensions/lib/env.ts: writeSecretEnvs/readSecretEnvs; a2a's
  loader gained per-gateway env fallbacks `A2A_GATEWAY_<KEY>_TOKEN` /
  `_UPSTREAM_TOKEN`).
- **Live-incident fixes (8h herdr hang)**: systemoneClassify carries a default
  30s deadline (pi passes no timeoutMs — a silent endpoint parked dispatches
  forever); subagent routing wraps the classify ask in a 45s race
  (`deadlineMs` injectable, fail-open to the static chain); the herdr
  wall-clock cap is the opt-in hard cap or 60 min — never the 3-min idle
  window, which killed healthy long-running panes; timed-out panes report
  that they may still complete their current write.
- **Review fixes (two subagent review waves, 13 findings)**:
  - repair: the read guard no longer blocks numeric path-selector reads
    (`f.ts:50-200` — it probed the raw path while the selector peels only in
    execute); a successful `edit` (direct or trim-retry) now refreshes the
    write-freshness baseline (read → edit → write no longer false-positives);
    selector reads record the baseline too.
  - rules: project RULES.md is trust-gated — an untrusted checkout's rules
    never reach the system prompt or rule_get (same gate as pi's AGENTS.md);
    creating a previously-missing @import target now invalidates the cache.
  - router: the systemone classify URL applies the same `/v1`-append
    convention as discovery (a bare-host baseUrl silently 404'd every
    classify); the repo-scope overlay resolves from the session cwd, not
    process.cwd().
  - classifier: the bash verdict hook is bounded to a 2.5s budget (verdicts
    are annotation-only in pi 1.0.0 — never park a tool call on Jev) and
    pauses after 3 consecutive classify failures for 5 minutes (audited;
    settings change or success re-arms).
  - subagent: the dispatch verdict gates on the CHOSEN label's own
    probability (a rival no longer clears the threshold for a low-confidence
    choice, matching the tier rule); removeWorktree locks on the resolved
    repo root (subdir-cwd dispatches no longer key the per-repo lock
    differently); the tool schema no longer promises upstream's removed
    20-min lifetime cap.
  - advisor: enabling the review via /config reseeds the cursor on FIRST
    activation — an enable-only save no longer reviews the entire transcript.
  - load order: rtk is a prompt rewriter and now loads BEFORE steering (its
    note must not break the ds-anchor byte-identity); a registration-level
    guard test (extensions/lib/order.test.ts) fails if any prompt rewriter
    lands after steering.
- Tests: 2661 (was 2647) — new suites for the secrets store + migration, the
  registration-order guard, the guard×selector interaction, edit/selector
  freshness, the classifier breaker + budget, and the dispatch/deadline
  routing paths.

## 0.11.0 — 2026-10-07

- **Worktree sandbox hardening + multi-session repo safety** (subagent module;
  OMP/Claude-Code mechanisms ported at ponytail scale — no new deps, no new
  settings):
  - **Per-repo lock** (`withRepoLock`, keyed by resolved repo root):
    serializes the parent-mutating git calls — `worktree add`, `worktree
    remove`, and the `git apply --3way` merge — which previously raced on
    git's no-waiter O_EXCL locks when parallel children finished together.
  - **Owner marker + GC sweep**: each sandbox records a sibling
    `<id>.owner.json` (`{pid, id, createdAt}`, 0600) OUTSIDE the sandbox dir
    so it can never leak into the captured diff (an in-sandbox marker made
    two parallel merges add/add-conflict — caught by the live race test);
    `sweepStaleWorktrees` runs fire-and-forget on `session_start` and removes
    dead-owner sandboxes (registration-aware: `worktree remove` for
    registered entries, `rm -rf` for CoW copies). `/subagent worktrees
    [clean]` lists or forces the sweep.
  - **`<repoRoot>/.pi-worktrees/.gitignore`** (content `*`) auto-created so
    sandboxes never pollute the parent's `git status` or the untracked
    baseline capture — no user-file edits.
  - **CoW backend (darwin)**: `createWorktree` prefers a per-top-level-entry
    `cp -cR` clone staged OUTSIDE the copied tree (sibling temp dir, skip
    `.pi-worktrees`), then atomic-renames into place — BSD cp lacks GNU's
    self-copy guard, and whole-tree copies would compound prior sandboxes.
    The copy IS the working tree (uncommitted state, node_modules, .env come
    free; the copied `.git` is fully independent). Any failure/EXDEV falls
    back to the detached `git worktree add`. Linux is deliberately
    worktree-only (`--reflink=auto` silently full-copies big trees).
  - **Baseline carry** (git-worktree fallback): `captureParentBaseline`
    composes the parent's WIP as PURE READS — `git diff --cached --binary` +
    `git diff --binary` + per-untracked-file `git diff --no-index --binary
    /dev/null <f>` — never `git add`/`stash create` on the parent (both
    mutate it). 256 MiB cap (constant; OMP #8939 lesson). The child's delta
    then 3-way-merges cleanly onto a parent holding the same baseline.
  - **`.worktreeinclude`**: repo-root gitignore-style lines; matching
    gitignored files (zero-dep glob matcher, 500-file cap) copied into
    git-worktree sandboxes. Fail-open per file.
- **repair module — multi-session guards** (always-on, deterministic):
  - **Conflict-marker footer**: full-file reads append a footer naming
    detected `<<<<<<<`/`=======`/`>>>>>>>` blocks (OMP conflict-detect
    workflow; zero extra I/O; `:conflicts` stays the explicit listing path).
  - **Write freshness guard**: reads record each file's mtime (capped map);
    a `write` to a file changed since this session last read it fails BEFORE
    writing with a re-read-first error — no more blind clobbering of a
    foreign session's edit. `apply_patch`/`str_replace_editor` refresh the
    baseline via a `refreshMtime` seam; `edit` needs no guard (its
    exact-match anchor already fails loudly).
- **README**: documents every module in the bundle (subagent, repair,
  steering, zai, a2a, todo, rules, gh, attachments, cron, permission were
  missing) — the subagent section leads with the multi-session safety work.
- Live-verified end to end on this machine: baseline carry through a real
  `sandbox:"worktree"` child, GC sweep in a fresh headless `pi -p` session,
  herdr-pane load, both repair guards through real wrapped tools, and a
  concurrent two-child `merge:"3way"` race (both patches landed, no
  conflicts, no lock leftovers). 23 new tests; suite at 2639 green.

## 0.10.1 — 2026-10-07

- **Windows fix**: extension load crashed with `ENOENT ... lstat 'D:\C:'` —
  the resources_discover skill path was built with `new URL(...).pathname`,
  which on Windows yields `/C:/...` (leading slash before the drive letter);
  realpathSync resolved it against the current drive. The bug existed in FIVE
  modules (web, munin, a2a, ponytail, ux). One shared helper
  `extensions/lib/skill-path.ts` (`fileURLToPath`) now serves all call sites,
  with a regression test.

- **Security & robustness review** (12 files): three settings writers (a2a
  `writeSettingsA2A`, repair settings, a2a session registry) now write
  `mode: 0o600` like every sibling writer — the files carry API keys/tokens;
  router `refreshModels` no longer throws on null entries in a hand-edited
  models-store.json; web `--virtual-time-budget` clamped non-negative;
  subagent worktree patch temp file gets a randomUUID name + exclusive
  (`wx`) write (shared-/tmp symlink hardening; cleanup already existed).

- **composer**: status layer aligned with OMP's actual rendering (source-level
  study of `packages/tui/src/components/composer/*` + `status-line/component.ts`):
  band/box embed OMP's POWERLINE row — bg-filled left group
  `π > ⬢ model · level > 📁 dir > ⑂ git` (thin `>` separators, model icon,
  dot-joined thinking level) over the context-reactive GAUGE (accent used-
  portion, rounded `N%` label riding the used cells, `┃` at pi's compaction
  threshold (window − 16384) when armed, window figure right-justified), with
  the session-title chip on box (`─ omp ─╮`); the band starts FLUSH (OMP's
  `sep.powerlineCapLeft` is empty outside the nerd set — no `╭─` cap). claude
  and rule dock the title chip on the top rule and render the left group +
  `◫ N%/window ⟲` context segment on a standalone BOTTOM status bar (after
  the closing rule for claude, after a spacer row for rule) — pi/borderless/
  field/rail render the full bar with the title right-justified. Context
  segment steps at OMP's thresholds (>50 warning, >90 error) and carries the
  `⟲` auto-compact icon; git indicators get OMP's per-indicator colors
  (`*n` warn, `+n` success, `?n` dim; branch warns only when dirty); token
  figures use OMP's formatNumber (`200K`, `1.0M`, trailing `.0` trimmed);
  thinking level rides the model segment as `⬢ model · level` (was
  `(provider) model (level)`). Session title sourced from
  `sessionManager.getSessionName()`; line 1 (rate · token stats · quota
  windows) unchanged.

## 0.10.0 — 2026-10-05

- **gh module**: new module — ONE read-only `github` tool over the `gh` CLI
  (port of oh-my-pi's github tool surface): `repo_view`, `file_read`,
  `pr_view`, `pr_diff`, the five `search_*` flavors (issues/prs/code/commits/
  repos, with repo:/org:/user: scope detection + since/until qualifiers), and
  `run_watch` (lean JSON poller with failed-job log tails; budget
  `gh.runWatchTimeoutSecs`, default 600s, on /config → Tools → GitHub).
  Zero npm deps (`node:child_process` spawn, non-interactive env, 5-min
  deadline, 8-MB output cap, one runner seam); fails open on a missing `gh`
  binary. Mutating flows (pr_create/checkout/push) deliberately deferred to
  bash `gh` — plan-mode auto-allow stays valid via READ_ONLY_TOOLS.

- **Read path selectors** (repair module): the wrapped `read` accepts OMP-style
  suffixes — `:50`, `:50-200`, `:50+150`, `:50-`, `:-60`, comma-joined
  multi-ranges (`:5-16,960-973`, `:19,59`), `:raw` compounds, and `:conflicts`
  (one block per unresolved merge conflict). Literal-path-wins resolution (OMP
  #4618); multi-range/conflicts slice in-memory with `[lines … of N]` headers.

- **think scratchpad tool** (steering module): OMP-parity private scratchpad,
  opt-in via `steering.thinkTool` (default off; binds at load — autoBg
  precedent). The call renders as one dim `· think (N chars)` marker so
  planning notes stay out of the visible transcript while remaining in context
  for later rounds. OMP's externalThinking reasoning-suppression is NOT ported
  (providers flag the request shape as abuse; pi's thinking levels are the
  honest off-switch).

- **web_a11y** (web module, 12th tool): real rendered-page accessibility audit
  — axe-core 4.13 vendored unmodified (`vendor/axe/`, MPL-2.0, lazy-loaded,
  zero new deps) injected into local headless Chrome over the existing
  web_interact CDP lifecycle. Returns OMP-format violation reports (impact,
  rule, helpUrl, node targets, `… and N more`); `tags`/`rules`/`selector`/
  `include_incomplete` params; same-origin iframes only (axe walks them
  in-page). The runtime complement to `ux_audit`'s static CSS checks. In-page
  failures ride back through the evaluate value (the CDP connection layer
  drops top-level exceptionDetails).

## 0.9.0 — 2026-10-04

- **todo HUD**: OMP-parity live UI for the todo module — an above-editor
  widget (same placement as the subagent HUD) rendering the board as a
  nested tree (` └─ Tasks · n/m` head over `    ├─/└─` checkbox rows),
  where every connector turns accent once its phase completes — the
  completed tree reads as one lit progress path. Done rows stay visible
  (success green + strikethrough), the current phase draws mdLink blue,
  blocked rows warning + `(blocked by …)`, notes collapse to `+n`.
  The transcript tool-result row draws the same colored board. When ALL
  phases complete the board lingers `todo.lingerSecs` seconds (global
  settings.json, default 60; 0 = instant, −1 = never; closed-set row on
  `/config` → Tasks → Todo), then auto-clears; any new mutation cancels
  the timer. The LLM-facing tool-result text stays the plain board.

- **a2a**: new module — the A2A Protocol v1.0 bidirectional peer ported from
  `@bacnh85/pi-a2a` 0.7.13: 7 outbound tools (`a2a_call` with
  `async_dispatch`, `a2a_status`, `a2a_discover`, `a2a_list`, `a2a_history`,
  `a2a_orchestrate`, `a2a_peers`), 8 commands, the opt-in inbound server
  (`/a2a-server start`, isolated child sessions, transcripts, audit log,
  anti-loop, per-peer tokens), and local/mDNS/gateway discovery. `bonjour-service`
  is vendored (flat `vendor/vendored_deps/`, no `node_modules` path) — zero new
  runtime deps. Settings live on the **Tasks** tab of the central `/config`
  panel (`A2A` + `A2A peers & discovery` sections); upstream's `/a2a-config`
  is dropped, and the project `.pi/settings.json` is read only when trusted
  (security keys stay global-only even then).
- **a2a fixes found against a live switchboard**: gateway-proxied peers
  (`gw/<key>/<name>`) are never card-fetched — the proxied card advertises the
  peer's DIRECT url, which routed dispatches around the gateway and tripped the
  SSRF guard; `a2a_call`/`a2a_status`/`a2a_orchestrate` now pin to the proxy
  URL. `a2a_discover` on a configured gateway origin is allowlisted and sends
  that gateway's token (the proxy 401s an anonymous card fetch).
  The `/config` add/remove action rows re-prompt with the reason on invalid
  input instead of returning silently.

## 0.8.0 — 2026-10-04

- **todo**: new module (OMP port) — phased task tracking: one `todo` tool
  (`init/start/done/rm/block/unblock/append/view`) over an ordered phase list.
  Blocked is derived from unmet `blockedBy` edges (finishing a blocker
  auto-unblocks dependents); the earliest pending unblocked phase auto-starts
  after every mutation; `start` errors while another phase is in progress
  unless `force`. Every mutation persists (`ceulen-todo` entries, rehydrated
  on session start) and updates a `▸ n/m done · in_progress: …` status
  segment. `/todo` prints the board, `/todo clear` resets.
- **rules**: new module (OMP port) — sticky RULES.md + rulebook. Sources:
  nearest-first walk from cwd to root for `.pi/RULES.md`, then
  `~/.pi/agent/RULES.md`; project names override user. One rule per
  `## name` section — a `description:` first line makes it a rulebook rule
  (listed in the prompt, body served on demand by the `rule_get` tool);
  otherwise the body is sticky (appended to every request inside
  `<user-rules>…</user-rules>`, 4000-char cap with a loud truncation marker).
  `@path` imports expand at load (cycle-guarded); files cached by mtime so
  edits apply without `/reload`. `/rules` = status, `/rules reload` = drop
  the cache. Zero footprint when no RULES.md exists anywhere.
- **subagent**: `subagent.idleTimeoutMins` now actually reaches the timeout
  resolver (it was dead config — children always died on the env default);
  a typo'd `@alias` fails the dispatch loud on BOTH runners instead of
  silently running the child on the parent model; the classifier tier gates
  on the chosen label's own probability, not the max across all labels.
- **router**: `/config` saves re-register the provider from the EFFECTIVE
  (trust-aware) snapshot — a trusted-project endpoint is no longer clobbered
  and the catalog refresh can no longer send the API key to a saved-but-
  shadowed URL; `combo/*` thinking `off` now OMITS `reasoning_effort`
  (the upstream 422s on the literal value — found by live-testing).
- **steering**: registry reorder — steering is now genuinely the LAST
  `before_agent_start` rewriter (serena/web loaded after it and appended to
  the ds-anchor bootstrap prompt, breaking byte-identity on request #1).
- **advisor**: the "paused after 3 consecutive failures" notice actually
  reaches the user (it was defeated by its own pause flag); the cursor
  reseed fires when enable + chain are saved in one `/config` write.
- **usage**: session cost / tok-s accumulators reset on `session_start` —
  "Session cost" no longer reports whole-process totals after `/new` or
  reload.
- **zai**: config panel baseline honors project trust; the 401 ladder clears
  its signed-request marker on success so unsigned 401s no longer count
  toward signing bypass.
- **web**: garbage input on a number row is skipped instead of persisted as
  `0`; nested-shaped project `web` entries are disclosed as save shadows.
- **munin**: config panel baseline honors project trust.
- **registry**: `isProjectTrusted` walks each agent dir from cwd (a mutated
  cursor made the second dir probe at `/`).

## 0.7.0 — 2026-10-04

- **web**: new module — the 11 unified web tools ported from `@bacnh85/pi-web`
  0.17.8: `web_search` (SearXNG → Brave → Firecrawl adaptive), `web_extract`
  (static JSDOM → Firecrawl → Crawl4AI → agy), `web_map`, `web_crawl`,
  `web_screenshot` / `web_pdf` (Crawl4AI daemon, local headless Chrome for
  localhost/LAN/file URLs), `web_interact` (trusted CDP click/type/evaluate
  with device-metrics emulation), `web_research` (Gemini web ask / Deep
  Research), `web_image` (Gemini web → ChatGPT web → Z.ai GLM-Image → custom),
  `web_chat`, `web_status`. Ships the `web` skill and injects the
  backend-routing guidance only while a `web_*` tool is active.
  - Config: `/config` → Tools → Web — 16 rows over the GLOBAL `web` settings
    section (SearXNG/Brave/Firecrawl/Crawl4AI endpoints, keys and timeouts,
    Gemini web cookie/proxy, image + chat providers), read per tool call so a
    save applies with no `/reload`; a trusted project `.pi/settings.json`
    `web` section shadows per field, env vars win over both. Secrets are masked
    rows. The two timeout rows are a closed set — pi-web's loaders reject
    anything below 1000 ms by throwing.
  - Per-tool kill-switch: all 11 tools appear as toggle rows (Tools tab).
  - Dependencies: `jsdom` + `gemini-reverse` (+ `axios`, which gemini-reverse
    hard-depends on) are the module's un-vendorable engines;
    `@mozilla/readability`, `turndown`, and `turndown-plugin-gfm` are vendored
    under `extensions/modules/web/vendor/`.
  - Remove the standalone `@bacnh85/pi-web` when enabling this module — the
    conflict guard refuses the duplicate `web_*` names.

- **plan**: new module — read-only plan mode ported from `@bacnh85/pi-plan`
  0.16.6, reduced to the permission + review gate. `/plan` (also `--plan`,
  `ctrl+alt+p`) toggles planning; `write_plan` records a reviewable Markdown
  plan (default `.pi/plans/<timestamp>-<slug>.md`) and `ask_user_question`
  resolves consequential ambiguities with 2–4 options, a ★-recommended
  default, and an "Other" free-form path. `/plan-approve current|new` executes
  the approved plan here or in a fresh session; `/plan-auto` arms autonomous
  approval (a written plan executes with no keypress).
  - **Save-plans policy** (`plan.savePlans`, /config → Tasks → Plan mode):
    `all` writes every draft, `approved` keeps drafts in memory and writes the
    file at approval, `none` never persists (the conversation is the copy;
    fresh-session execution is refused because it needs a file). Plans
    directory (`plan.plansDir`, default `.pi/plans`, `{yyyymm}` supported),
    plan-only model/thinking (restored on exit), and the auto-approve toggle
    are rows too.
  - **Tool gating**: mutators (`edit`/`write`/`apply_patch`/
    `str_replace_editor`/Serena-Munin mutations) hard-block; bash writers
    hard-block, read-only bash (incl. pipelines of reads, `cd &&` chains,
    `VAR=` prefixes, read-only git) auto-runs; unknown executables and non-read
    tools take an Allow-once / Allow-for-this-session / Deny prompt (headless
    blocks). A `subagent` dispatch auto-allows only when every named agent
    resolves `sandbox: read-only`.
  - **Dropped from upstream** (ceulen covers them elsewhere): the
    implement→verify→review flow, `/rewind`, `/goal`, `/specs`, `/handoff`,
    `/btw`, `/doctor`, the fallback chain, and the Jev plan gate. Vendored
    shell classifier with one hardening deviation: `xargs --null rm` no longer
    strips to an empty payload (upstream read it as "read").
  - Config: `plan` section (GLOBAL settings.json + trusted project overlay),
    read per event so /config saves apply live; Tasks tab → Plan mode.
  - Remove the standalone `@bacnh85/pi-plan` when enabling this module — the
    conflict guard refuses the duplicate commands/tools.

- **subagent**: two runner-level upgrades for herdr-mode delegation.
  - **Classifier-chosen dispatch**: the classify round-trip can now answer a
    third question — pane or detached background — for a single dispatch
    inside herdr whose caller named neither `runner` nor `background`
    (`subagent.routing.dispatch`, default `classify`, new /config row).
    Explicit params always win, the verdict is reused for tier/effort (one
    Jev call per dispatch), and a background verdict says so on the receipt.
    Verified live: a long, self-contained audit → background; a trivial
    one-liner → visible pane.
  - **Dead `wantTier` gate fixed** (surfaced by a live routing probe): the
    tier question is now actually suppressed for an unresolvable chain
    (typo'd `@alias`), matching its comment — previously the question was
    asked unconditionally and a confident tier verdict could silently swap
    in the role pools, hiding the typo. Tier answers are also only read when
    the question was asked (defensive parse, mirroring effort/dispatch).
  - **Advisor-aware collection**: a herdr child runs full pi, so its own
    advisor reviews the settled turn and can steer corrections after the
    parent had already collected the report (observed live: draft collected,
    advisor note 16s later, child revised — the parent never saw the fix).
    The child's advisor now publishes its review cycle
    (`reviewing` → `done` + `steered`) to a sidecar named by
    `CEULEN_ADVISOR_MARKER` (passed to the pane via `herdr --env`), and the
    parent waits for the verdict before collecting: a short grace poll when no
    review starts, the steered revision's settle when one does, ≤2 rounds,
    bounded by `subagent.advisorWaitSecs` (default 120s, 0 = off; new /config
    row). Write-capable children are told to update the report file when
    follow-up feedback arrives. Results, history, and the usage line record
    folded revisions (`advisor:N revision(s)`); the widget shows
    `herdr: advisor-review` / `advisor-revise` while waiting. SDK children get
    no advisor (the watch is TUI-gated) — nothing to wait for there.

- **subagent**: classifier routing now applies to herdr dispatches too — the
  herdr runner (`prepareHerdrOne`, used by foreground single/parallel
  dispatch) resolved the model chain straight from frontmatter/pins and never
  asked the classifier, so in a live herdr session every agent silently ran
  its frontmatter default (a trivial reviewer went to `@smart`/`high` instead
  of the routed `fast`/`off`). Both runners now share one `routedChain()`
  helper, so tier, effort, pins, and `solutionSpace` behave identically
  in-process and in panes. Verified live in herdr: reviewer trivial →
  `combo/deepseek-v4.1-flash` · `off`, planner trivial →
  `combo/deepseek-v4.1-flash` · `off`, worker deep-design →
  `cmd/deepseek/deepseek-v4-pro` · `xhigh`. Alongside:
  - history entries (`.pi/subagent-history.json`, `/subagent history`) now
    record the resolved `thinking` level next to `model`, so routing decisions
    stay auditable after the run;
  - the bundled `worker` agent gains `timeout: 10` (same as planner/reviewer).
    Herdr's prompt wait falls back to the 3-min inactivity constant when the
    agent declares no timeout, and that window is a TOTAL cap there (the pane
    is cancelled), unlike the SDK path where it resets on activity — a routed
    `xhigh` worker could otherwise die at 3 min.

- **subagent**: OMP-parity live-UI surface for running agents, covering SDK,
  background, and herdr threads alike (all store-driven; pure renderers
  unit-tested in `test/widget.test.ts`):
  - the live widget gains a `Subagents · N running · M ✓ · K ✗` header, a
    `/agent to inspect` tail, per-thread token counters (`↑12k, ↓1.4k`), and
    herdr panes now render their `herdr: <state>` lifecycle label where SDK
    threads show their latest tool call (raw SDK event labels like
    `message_end` never render); failed threads count as `✗`, never `✓`;
  - a new footer status item `ceulen-subagent` (`👥 N running · …`) shows
    while any thread runs and clears on idle/session change — the widget
    controller owns set + clear, and both pi's native footer and the
    composer footer pass it through;
  - `operation: status|wait` tool rows render the OMP-style job tree
    (`⏳ waiting on N of M jobs`, waited task first, settled rows with a
    `⎿` first-line output snippet);
  - chain/parallel call rows honor Ctrl+O expansion (full task list instead
    of the cap-3 preview, with a `(Ctrl+O to expand)` hint when truncated).

- **security hardening** across the bundle:
  - **serena**: the Python worker's env no longer merges an *untrusted*
    checkout's cwd `.env` (it could set `NODE_OPTIONS`/`PYTHONPATH` and reach
    the language servers the worker spawns — RCE class). Cwd dot-files load
    only for trusted projects now, same rule as the bundle's `.env`
    ingestion; global agent-dir dot-files always load.
  - **classifier**: the bash verdict hook is reframed honestly as
    audit/annotation only. pi 1.0.0 core has no per-call approval prompt
    for `tool_call` to skip, so the previous "auto-approve/enforce" framing
    described behavior that never existed — nothing was ever approved or
    denied. Behavior is unchanged (verdict + audit +, in enforce mode, a
    transcript annotation); `classifier.log` is now written `0600`.
  - **usage**: router settings resolve through `PI_CODING_AGENT_DIR`
    (was hardcoded `~/.pi/agent/settings.json`, so usage fetches could hit
    the wrong endpoint under an alternate agent dir).
  - **munin**: the vendored SDK's `capabilities` fetch now arms the same
    timeout as `invoke()` (a dead server could hang every
    `ensureCapability` tool call forever).

- **munin** (new module, ported from `@bacnh85/pi-munin` 0.5.12): Munin
  long-term memory — eight `munin_*` tools (search/get/store/list/recent/
  delete/capabilities/share, each per-tool toggleable in `/config`),
  `/munin-status`, the Munin Memory Protocol injected into the system prompt
  while Munin is configured, the `tool_result` error sanitizer, and the `munin`
  skill (kill-switch gated via `resources_discover`). The `@kalera/munin-sdk`
  client is vendored (152 lines, zero deps; capabilities cache now keyed by
  `baseUrl|apiKey`) and dotenv dropped (ceulen's trust-gated `.env` ingestion
  covers it) — no new runtime dependency. **Config is project-level**:
  `munin.project`/`munin.baseUrl`/`munin.apiKey` saved to
  `<repo>/.pi/settings.json` via `/config` (new **Memory** tab, masked key row
  with a gitignore warning), read only when the project is trusted; precedence
  per-call params > `MUNIN_*` env > project file > global file > default.
  Applies immediately — config resolves per tool call, no reload.
- **advisor** (new module, ported from `@bacnh85/pi-advisor` 0.3.8): a
  second-model reviewer — after each settled turn an isolated reviewer reads the
  transcript and may emit ONE severity-routed note (`nit` / `concern` /
  `blocker`), steered as a follow-up turn or deferred to the next turn as an
  LLM-visible aside during the post-steer calm-down window, under the ported
  emission guard (content-free drop, dedupe with escalation, one note per
  cycle). The ordered fallback chain (per-entry `:level` thinking) backs the
  on-demand `advisor` tool (per-tool toggleable). Config: `/config` → Model →
  Advisor — **Review settled turns** (the background watch; off = no review,
  the consult tool keeps working), **Primary model** (catalogue picker),
  **Thinking**, **Fallback chain** (inline model completions), min tool calls,
  immune turns, and **Consult tool** (register the on-demand `advisor` tool);
  saved to the GLOBAL **`advisor`** settings section and applied live through a
  module bridge (no `/reload`). The module is **core**: always loaded, no
  Enable row — its off-switch is an empty primary model (a stale
  `ceulen.disabled: ["advisor"]` entry is ignored). The standalone `pi-advisor`
  section is a read-only legacy alias (legacy `watch.enabled` folds into the new
  `enabled`, the legacy section is deleted on the first save); the pi-plan
  `advisorModel` migration is dropped (pi-plan's own port owns it). The
  pi-config-panel models editor and the `ModelSelectorComponent` picker are
  gone — `/config` is the editor. Isolated calls go through the public
  `modelRegistry.streamSimple`, so no `@earendil-works/pi-ai` dependency is
  added. Watch is TUI-only, fire-and-forget, pauses after 3 consecutive
  failures, self-disarms on session shutdown, and the `advisor` tool is
  re-synced on session_start/model_select while always honoring
  `ceulen.disabledTools`. OMP-parity hardening: the reviewer prompt bans the
  production noise classes (restating errors the agent already has, user-intent
  and ceremony advice, scope policing, unsolicited back-compat, second-guessing
  committed decisions, partial-work critique) and requires cited evidence;
  token/cost accounting accumulates into `/advisor status` and the consult
  tool's result; the review cursor and guard reset on `session_compact` /
  `session_before_switch` (a re-primed reviewer may re-raise against the
  rewritten transcript); the guard folds Unicode letters/digits (full-width
  filler dedupes) and carries omp's larger content-free phrase list.
- **classifier** (new module, ported from `@bacnh85/pi-classifier` 0.2.3,
  registry-backed): System One decision models (TypeSafe Jev) — the `classify`
  tool (same name/schema, per-tool toggleable) and the bash permission
  auto-approve hook (static RISKY list first, LRU verdict cache keyed by
  command+cwd+task, observe/enforce + threshold, never denies, audit lines in
  `classifier.log`). Every ask now goes through `modelRegistry.classify()`:
  the **router** module discovers decision models from
  `GET <router.baseUrl>/v1/systemone/models` (404-fail-open — plain OmniRoute
  keeps a chat-only catalog), registers them as `type: "classifier"` models
  with a vendored System One transport (`lib/systemone.ts`, ~130 lines), and
  the mixed chat+classifier catalog persists/restores in models-store.json.
  Chat `/models` stay clean; core consumers (codemode, extensions) can use
  `router/combo/jev` via the registry. Auth is the shared ROUTER credential —
  no separate `classifier.baseUrl`/`CLASSIFIER_API_KEY`. Config: `/config` →
  Model tab → Classifier (Jev) (model menu from live discovery, auto-approve
  toggle/mode/threshold). `planGate` is dropped (pi-plan removed; returns with
  the pi-plan port). Replaces the standalone pi-classifier package — remove it
  from `packages` to avoid a duplicate `classify` tool (first registration
  wins); `/router-status` now shows the classifier model count.

- **config**: new **Tools → Built-in tools** section — one toggle per pi
  built-in tool (`read`, `bash`, `powershell`, `edit`, `write`, `grep`,
  `find`, `ls`) plus the built-in extension tools `codemode` and
  `tool_search`; the stock four (`read`, `bash`, `edit`, `write`) default on.
  Toggling writes the `defaultTools` setting (global settings.json; a
  stock-equal selection deletes the key again) and applies to the current
  session immediately — enabling grep/codemode no longer needs a settings
  edit or a restart.
- **composer**: the line above the band is now a full usage line — token
  stats + provider quota windows flush LEFT (`↑1.9M ↓377k R69M W2.0k CH99.6%
  · (router) R:59%/2H3M`), Generation Rate justified RIGHT (`⚡ N tok/s`),
  split by the composer's stock left/right groups. `CH` (cache-hit share of
  the latest assistant prompt) joins the stats figures; cost stays `/usage`-
  only. Under width pressure the left group sheds whole segments (usage →
  stats) while the rate stands; rate alone still right-justifies. The band
  itself stays identity-only (π · model · dir · git + context%).
- **ux** (new module, ported from `@bacnh85/pi-ux` 0.6.6): anti-slop UI/UX
  design discipline — `/ux off|lite|strict` (session-persisted, `stop ux` /
  `normal mode` deactivates) injects the ux-design method into the system
  prompt each turn; strict blocks handoff until the `ux_audit` tool passes
  (deterministic APCA-contrast / token / state / slop-tell gates, no model).
  Ships the four `ux-*` skills (`ux-design`, `ux-presets`, `ux-routing`,
  `ux-capture`) through `resources_discover`, gated by the module kill-switch.
  Configured in `/config` (Appearance → UX discipline: default mode,
  quiet startup; per-tool toggle for `ux_audit`) — persists to
  `~/.config/pi-ux/config.json` with `PI_UX_*` env overrides, so standalone
  pi-ux settings carry over. **No status-bar footprint** (upstream's status
  segment, `hideStatus` setting and `PI_UX_HIDE_STATUS` are dropped), and
  bare `/ux` reports status instead of resetting (ponytail #99 precedent);
  `/ux default <mode>` is gone — the central panel owns defaults. The
  ponytail module's skill contribution was narrowed from the whole `skills/`
  root to its own six `ponytail*` dirs so the ux kill-switch actually gates
  the ux skills.
- **themes** (new package resource): 104 selectable themes ship with the bundle —
  the 4 from `@bacnh85/pi-themes` (`pi-dark`, `pi-mirage`, `pi-light`,
  `pi-catppuccin-mocha`) plus 100 from oh-my-pi's collection (`dark-*` /
  `light-*` families + stone/gem one-offs). Loaded by pi itself via the
  package manifest (`pi.themes`) — no module, no kill-switch; select in
  `/theme` or `/config` (Appearance → Theme, live preview). omp copies were
  re-pointed at pi's theme schema and their 8-digit RGBA `selectedBg`
  (poimandres pair) truncated to 6-digit hex (pi's `parseColor` rejects
  alpha). `scripts/validate-themes.mjs` (in `npm test`) enforces name
  uniqueness, no builtin collisions (`dark`/`light`/`system`), the full
  pi-required token set, and resolvable color values across all 104.
- **serena, fff, rtk** (new modules, ported from the pi-extensions monorepo):
  Serena semantic code tools (`serena_*`, Python worker), FFF fuzzy
  file/content search (`ffgrep`, `ffind`, `fff_multi_grep`, `resolve_file`,
  `related_files` + @-mention completions), and RTK bash-command rewriting
  (`/rtk`). Every tool they register gets a **per-tool toggle row in /config**
  (Tools · Serena / FFF search, Shell · RTK sections): toggling writes
  `ceulen.disabledTools` and applies to the running session immediately via
  `setActiveTools` (disabled tools re-register inactive on every load, so the
  setting survives restarts without a /reload). rtk has no tools — its surface
  is the module Enable row. No status-bar entries — the modules stay silent
  in the footer. First runtime dependency: `@ff-labs/fff-node`
  (native FFI engine, unvendorable); `typebox` joins the peer deps (pi aliases
  it at runtime). Serena/fff tests converted to the repo's `node:test` + tsx
  convention; rtk's were already `node:test`.
- **config**: stock-`/settings` parity — every pi setting with a typed
  `SettingsManager` setter is now a `/config` row. New: **per-model thinking
  overrides** (one row per model + an **Add model override** row whose menu
  lists catalog models; the clear option reverts to the default — rows appear
  and disappear on commit via the kernel's new `rebuildOnCommit`), **Fullscreen
  wheel scrolling**, and the extra-resource-dir lists (**Extension dirs**,
  **Skill dirs**, **Template dirs**, **Theme dirs**). Stock choice UX: HTTP idle
  timeout renders the labeled choices (`30 sec`…`disabled`), Default project
  trust `Ask`/`Always trust`/`Never trust`, editor padding / autocomplete /
  image width as stock choice sets, and thinking levels carry their per-level
  descriptions (`off` … `max`, ~token hints). OMP taxonomy: transport →
  **Providers · Protocol**, HTTP idle timeout → **Providers · Timeouts**,
  telemetry/analytics → **Providers · Privacy**, skill commands + skill dirs →
  **Tasks · Commands & Skills**, extension dirs → **Tools · Extensions**,
  template dirs → **Context · Prompt templates**; descriptions now match pi's
  own stock `/settings` copy. Kernel: `ConfigPanelOpts.rebuildOnCommit` +
  `ConfigPanelModel.rebuild` rebuild the row set after any committed edit
  (toggle, menu pick, inline submit) — used by the dynamic per-model rows.
- **composer** (new CORE module): Composer Shape for the input editor with
  OMP's full vocabulary and copy — **Status Band** (default) · **Rounded Box**
  · **Claude Code** · **Pi** · **Borderless** · **Top Rule Dock** · **Compact
  Field** · **Accent Rail**. Browsing the Shape row renders a live preview
  block in the panel through the same chrome builders the running editor
  uses (no drift); Enter applies to the running editor immediately
  (text/autocomplete/app keybindings preserved via `CustomEditor`
  duck-typing) and persists `composer.shape`. Side borders, prompt gutters
  and filled surfaces are composed by re-laying the editor out at the
  shape's content width and wrapping each row — the cursor marker survives,
  so wrapping and hardware-cursor placement stay exact. Status-bearing
  shapes show OMP's stock status split with icons on every segment — left
  group: `π` brand · `(provider) model (thinking level)` (level live via `thinking_level_select`; `off` hidden; the provider prefix is skipped when the display name already carries it) · `📁` cwd · `⑂` branch + working-tree counts
  (`*N`/`+N`/`?N`, warning when dirty) · provider quota windows (`(router)
  R:59%/2H3M`, fed by the usage module) · session token stats (`↑40k ↓44 R64
  CH0.2%`) · `⚡` Generation Rate; right group: the context window
  (`0.0%/1.0M (auto)`, stepped at 70%/90%). The band fills the
  status chip only, not the whole line. On status-bearing
  shapes the module replaces Pi's built-in footer with a narrowed one —
  the other extensions' statuses only, since cwd/branch/
  model/context%/token-stats/quota-windows are already in the band;
  non-embedding shapes keep the
  native footer. The working spinner stays visible in every shape. Always on:
  no kill-switch (a half-configured composer is worse than none).
- **config**: rows can carry a `previewLines` hook — a read-only preview
  block under the rows pane / selection menu that follows the highlighted
  option (OMP's settings-screen preview window).
- **registry**: modules are categorized — `ModuleEntry.category` (the OMP
  tab) is now the single source for /config tab placement, synthesized
  Enable-only sections, and `/ceulen` status grouping (now rendered per
  category: `Providers: router · Appearance: usage, composer · …`).
- **config**: multi-choice rows now open an **OMP-style selection menu**
  instead of cycling — press Enter on Theme, Default thinking level, Transport,
  Mermaid mode, ponytail mode, … and the panel swaps to a full option list:
  `↑↓` browse (clamped), typing filters options live, `Enter` selects and
  `Esc` backs out (clearing the filter first). The row's description/warning
  stays visible below the menu, options can carry their own one-line
  descriptions, the current value is marked `(current)`, and the footer
  switches to the menu's key hints. **Theme previews live while browsing** —
  moving through the theme list restyles the whole terminal (panel included)
  immediately, `Esc` restores the previous theme, and `Enter` persists it.
  The Default model row opens a `provider/id` picker built from the model
  catalogue (`ctx.modelRegistry`), writing provider + model as one pair.
  Everything goes through pi's public extension API (`ctx.ui.getAllThemes`/
  `getTheme`/`setTheme`, `ctx.modelRegistry.getAvailable`).
- **config**: `/config` now spans **pi core settings + ceulen modules** under
  OMP's taxonomy — tabs are Appearance · Model · Interaction · Context · Shell ·
  Tasks · Providers · Plugins (empty categories don't render). Pi-core rows are
  backed by Pi's own public `SettingsManager` (theme, thinking, transport/retry,
  steering, trust & telemetry, shell, images, fullscreen…), so they read the
  effective global ⊕ project value and save to the global `settings.json` via
  Pi's typed setters (apply after `/reload`). The standalone **Modules** kill-switch
  tab is gone: each module's **Enabled** row now sits at the top of its own
  section — Router → Providers, ponytail → Tasks, usage → Appearance, the config
  panel → Plugins — and stays visible (and togglable) even while the module is
  off.
- **config**: OMP-parity chrome pass — the frame is a closed box
  (`╭─┤│╰─╯`, every content row `│ … │`); section headings render underlined
  in-pane beside the sidebar (OMP shows both) with rows outside the active
  section dim-washed; the sidebar width is pinned across every tab so the `│`
  rail never jumps, and hides below a 60-column rows pane (headings remain);
  changed-from-default values render warning-colored on the label too (a
  selected+changed row keeps an accent label + warning value); the tab bar
  collapses inactive tabs to icons starting farthest from the active one (the
  active tab keeps its label); and the browse footer hint now derives from the
  active tab (`Enter toggle` for toggle/enum-only tabs, no Enter pair for
  read-only tabs, no section jump for single-section tabs).
- **config**: `/config` is now a fullscreen panel (OMP `/settings` parity): the
  frame fills the terminal as a 100%×100% overlay — title border, tab row, and a
  pinned key-hint footer as the last row (the hints follow the mode: browse,
  search, inline edit, action prompt), with the unsaved-changes marker
  right-aligned on that footer. The rows pane is height-driven (it grows with a
  taller terminal instead of the fixed 18-row window), and the chat underneath
  is untouched while the panel is open.
- **router/ponytail**: individual config commands removed now that `/config` is
  the single settings surface — `/router-config` and `/router-reasoning` are the
  Providers tab's Router section, `/ponytail default <mode>` is the Tasks tab's
  Default-mode row.
  `/router-status`, `/router-model`, and `/ponytail <mode>|status` are unchanged
  (status / model picking / session-mode switching, not persisted config).
- **config**: `/config` now follows OMP's tab → section → rows hierarchy, and tab
  navigation actually works in every terminal. Fixes: `←`/`→` used raw escape-byte
  comparisons, so application-cursor-mode (SS3 `\u001bOD`) and kitty-protocol
  terminals never moved backward — navigation now goes through pi-tui's `matchesKey`
  (CSI/SS3/CSI-u all match), and tab stepping WRAPS like OMP's TabBar instead of
  clamping. Structure: adjacent groups sharing a `tab` merge into one tab
  (Router's Endpoint + Models are now one Router section under the Providers tab), each group's label renders
  as a left-sidebar section beside its detail rows, `PageUp`/`PageDown` jump
  sections, and rows outside the active section get OMP's dim wash. Plugins splits
  into Project/Global sections under one 📦 tab.
- **config**: tab bar polish — per-group icons (`PanelGroup.icon`; the bundled
  groups use 🌐 Router / 🦥 Ponytail / 📦 Plugins),
  active tab inverse-highlighted (`selectedBg`, falls back to bold accent) with
  an icon-only fallback on narrow bars, a middle accent heading naming the
  category being configured (icon + label + setting count), and footer key
  hints that color each key glyph in accent with its meaning dimmed (OMP
  style). Also fixes the description area leaking a neighbor row's text while
  the active tab is empty, and enables `←/→` category jumps during search in
  the keybinding-less input path.
- **config**: `/config` is now TABBED — one tab per category (Modules, Endpoint, Models,
  Ponytail, Plugins…) with `←/→`/`Tab`/`Shift+Tab` switching, so each category renders
  in its own view instead of one long mixed list. Per-tab selection memory, ↑/↓ clamped
  to the active tab, active-tab highlighting (inverse/selectedBg), narrow-terminal tab
  windowing with `…` edge markers, and a single-group panel that renders no tab bar.
  Search still spans all tabs; `←/→` during a search jumps between matching categories,
  and clearing it snaps the panel to the selected row's tab.
- **config**: new **Plugins** group in the `/config` panel — every installed Pi package
  (`packages` in settings.json, project entries first when trusted) gets an on/off toggle.
  Off writes Pi's whole-off form (`{source, extensions: [], skills: [], prompts: [], themes: []}`
  — the load contract's "empty array disables all resources"), on restores the plain
  string; each row writes back to the file its entry lives in, atomically, refusing a
  corrupt file. Packages carrying granular `pi config` filters or `autoload: false`
  project deltas render as read-only "custom filters" rows. New kernel `info` row kind
  (display-only derived state); `/config show` lists plugins too.
- **config**: `/config` panel v2 — OMP-style split layout (module rail + rows pane with a dim wash outside the active group, selection-derived active section, fixed 3-row help area showing the selected row's description/warning), enum rows (`Enter` cycles a closed value set — ponytail default mode no longer accepts free text), changed-vs-default values rendered warning-styled, `←→`/`Tab` section jumps, type-to-search fuzzy filter (printable text; `Esc` clears, then closes), width-dependent flat fallback below 60 pane columns. Kernel `extensions/lib/panel.ts` is now a fork evolved in-repo (was: fixed vendor snapshot of `@bacnh85/pi-config-panel` 0.1.10). Rows gain optional `description`/`warning`/`values`/`defaultValue`; `ModuleEntry.describe` feeds each module's kill-switch help line; `/config show` appends help text.
- **config** (new module): `/config` — one central settings panel for every ceulen module, on top of the vendored panel kernel. Module kill-switches (writes `ceulen.disabled` to the effective settings layer — project when trusted and it carries the section, else agent dir; disclosed in the panel), router endpoint + thinking levels (save re-registers the provider, force-refreshes the catalog, revalidates the active model), ponytail default mode / quiet startup / status bar (own config file; next session). Non-TUI/multi-arg shells get `/config show` text. `/settings` is a Pi builtin and cannot be overridden by extensions — `/config` is the ceulen surface.
- **bundle**: `MODULES` registry + kill-switch settings I/O moved from `extensions/index.ts` to `extensions/lib/registry.ts` (the config module iterates it without a circular import). Modules may now declare `config?: (pi) => ModuleConfig` — a `{ groups(), save(editedKeys, ctx) }` contribution; the loader hands each module a `ModuleLoadDeps` map whose factories close over that module's own guarded `pi`.
- **router**: panel + save logic extracted to `modules/router/configPanel.ts` (`buildRouterGroups`/`saveRouterConfig`), the central panel's single save path; `writeRouterSection` moved from `commands/commands.ts` to `lib/config.ts`.
- **ponytail**: `writeConfigBools` helper added to `lib/config.ts`; central-panel contribution for `defaultMode`/`quietStartup`/`hideStatus`.

- **usage** (renamed from **sub**): the module and its command are now `/usage` (`/sub` survives only as the deprecated kill-switch key `"sub"` → treated as `"usage"`). Status-bar key is `ceulen-usage`; message customTypes are `ceulen-usage-status` / `ceulen-usage-context`; User-Agent is `ceulen/x.y.z`. Sessions recorded before this change replay the old `pi-sub-*` messages as raw text (the renderer was renamed with the module).
- **bundle**: new cross-module duplicate-registration guard — all ceulen modules share one extension object, where a repeated name silently overwrites; a claim by a DIFFERENT module now throws at load (same-module re-claims stay legal, e.g. router's runtime provider refresh). Env ingestion (`.env.local`/`.env`, trust-gated) moved to `extensions/lib/env.ts` — bundle infrastructure, no longer exported from a feature module.
- **bundle**: trusted cwd `.env` ingestion (`loadCwdEnvFilesIfTrusted`) is now also registered at the bundle entry, before every module's `session_start` — sub previously loaded it in its own handler, which runs after router's, so a trusted repo's `.env`-provided `ROUTER_BASE_URL`/`ROUTER_ENABLE_REASONING` was invisible to router for the entire first session.
- **sub**: backported the nightly-review security fix from pi-sub — cwd `.env.local`/`.env` are no longer ingested at import time (an untrusted checkout could inject `ROUTER_MGMT_TOKEN` etc.); they now load in `session_start` only behind `ctx.isProjectTrusted()`, with global agent-dir env files still injected at import and trusted-cwd files overriding only those. Also backported the expired-Codex-JWT fix: a plan label no longer renders from a token whose `exp` has passed (shows `expired`).

## 0.5.1 — 2026-09-30

- Widened pi peer range from `^0.99.1` to `>=0.99.1 <0.101.0`: caret on a
  0.x dependency is patch-only (≥0.99.1 <0.100.0), too narrow for pi's fast
  minor releases. No other changes.

## 0.5.0 — 2026-09-30

- **pi 0.99.1 compatibility**: peer dependencies widened from
  `>=0.80.8 <0.88.0` to `^0.99.1` for both
  `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` (range
  corrected to `>=0.99.1 <0.101.0` in 0.5.1). No code changes — all surfaces verified:
  registration API (guarded() claims), composer `CustomEditor` duck-typing,
  theme Proxy/`setTheme` semantics, `session_start` re-fire, trust.json
  gating, jiti extension loading (the 0.99 tsx→type-stripping switch affects
  pi's own build only). 306 tests + live `pi --mode rpc` smoke pass.

## 0.3.0 — 2026-09-28

Wave 2: ponytail merged into the bundle.

- **ponytail** (from pi-ponytail 0.1.17, fork of DietrichGebert/ponytail 4.9.0): lazy-senior-dev mode — `/ponytail off|lite|full|ultra|review` switcher (session-persisted), status-bar indicator, per-turn system-prompt injection, subagent instruction inheritance. The six `ponytail*` skills ship in-package and register through the module's `resources_discover` handler, so the kill-switch removes them along with the commands.
- Commands: `/ponytail [mode|status|default <mode>]`, plus `/ponytail-review|audit|gain|debt|help` skill aliases.
- Config unchanged (`~/.config/ponytail/config.json`, `PONYTAIL_*` envs) — existing pi-ponytail users keep everything; kill-switch via `"ceulen": { "disabled": ["ponytail"] }`.

## 0.2.0 — 2026-09-28

Wave 1: first two production modules merged into the bundle.

- **router** (from pi-router 1.2.3): generic `router` provider for any OpenAI-compatible router (`/v1/models` + `/v1/chat/completions`), commands `/router-status`, `/router-config`, `/router-reasoning`, `/router-model`.
- **sub** (from pi-sub 0.1.52): subscription-usage footer + `/sub` + `/context`, including the Yardmaster usage display (`GET <router.baseUrl>/usage?provider=<prefix>`).
- `@bacnh85/pi-config-panel` vendored into `extensions/lib/panel.ts` — ceulen ships with zero runtime dependencies.
- Kill-switch: `"ceulen": { "disabled": ["sub"] }` in settings.json skips modules.
- Research `docs/` removed (captured in git history and project memory).

## 0.1.0 — 2026-09-21

Name reservation + bundle scaffold.
