/**
 * todo — phased task tracking for ceulen.
 *
 * Ported from OMP's `todo` tool (packages/coding-agent/src/tools/todo.ts +
 * prompts/tools/todo.md): the CONTRACT and state machine, not the code. An
 * ORDERED list of phases (each {id, title, status, blockedBy, notes}) with
 * actions init/start/done/rm/block/unblock/append/view, one in_progress at a
 * time, blockers that never auto-start, and a compact rendered board (never
 * JSON) as the result text.
 *
 * State is branch-scoped via `pi.appendEntry(ceulen-todo, {phases})` on EVERY
 * mutation and rehydrated on session_start from the LAST such entry — the plan
 * module's pattern (appendEntry + resolve-the-last-entry on the branch).
 *
 * Zero prompt rewriting: no before_agent_start handler. The usage contract
 * rides on the tool's own promptGuidelines, so this module never enters the
 * steering load-order contract.
 *
 * DELIBERATE DEVIATIONS from OMP (enumerated, not accidental):
 * - Phase-level only: a phase IS the unit of work (OMP nests {content} tasks
 *   under phases). Nothing in the contract needs the second level.
 * - `blockedBy: phaseId[]` replaces OMP's `blocked` status + `blocker` note —
 *   blocked is DERIVED from unmet edges, so finishing a blocker unblocks its
 *   dependents with no extra call.
 * - start errors when another phase is in_progress (force:true demotes it),
 *   OMP's rule hoisted to phase granularity; the auto-advance pointer is kept.
 * - Result text is the rendered board (glyph + [id] + title + counts), not
 *   OMP's "Remaining items:" prose. Ids replace OMP's verbatim-content
 *   addressing (a 20-char title is not a stable handle).
 * - NOT ported: the `drop`/abandoned status, the Markdown round-trip
 *   (TODO.md read/write), op inference + lenientArgValidation repair, the HUD
 *   visibility state, the flat `items` init shape, and /todo edit.
 * - Persistence is ONE `ceulen-todo` entry per mutation on the branch;
 *   OMP's canonical snapshot also rides toolResult details + a HUD entry.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  createTodoWidgetController,
  renderTodoBoard,
  type WidgetTheme,
} from "./lib/render.ts";
import { readLingerSecs } from "./lib/settings.ts";

export const TODO_TOOL = "todo";
export const TODO_ENTRY_TYPE = "ceulen-todo";
export const TODO_STATUS_KEY = "ceulen-todo";
export const TODO_WIDGET_KEY = "ceulen-todo";

export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";

export interface TodoPhase {
  /** Stable handle for the list's lifetime (auto-assigned when omitted). */
  id: string;
  title: string;
  status: TodoStatus;
  /** Phase ids this phase waits on — non-empty means BLOCKED (never auto-starts). */
  blockedBy: string[];
  /** Free-form detail. */
  notes?: string;
}

/** ponytail: free-text task items are NOT ported — a phase IS the unit of
 *  work (OMP nests tasks under phases; nothing in the port's contract needs
 *  the second level). Add a nested list only if a real plan needs it. */

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "done", "blocked"];

const todoSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("init"),
      Type.Literal("start"),
      Type.Literal("done"),
      Type.Literal("rm"),
      Type.Literal("block"),
      Type.Literal("unblock"),
      Type.Literal("append"),
      Type.Literal("view"),
    ],
    {
      description:
        "init replaces the whole list · start/done mark a phase · block/unblock edit blockedBy · append adds a phase · rm removes one (or all) · view renders without mutating.",
    },
  ),
  phases: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.Optional(Type.String({ description: "Stable handle; auto-assigned as p1, p2, … when omitted." })),
        title: Type.String({ description: "Short imperative phase title." }),
        status: Type.Optional(
          Type.Union(STATUSES.map((s) => Type.Literal(s)), { description: "Defaults to pending." }),
        ),
        blockedBy: Type.Optional(
          Type.Array(Type.String(), { description: "Phase ids this phase waits on." }),
        ),
        notes: Type.Optional(Type.String()),
      }),
      { description: "init: the ordered phase list (replaces everything). append: exactly one phase." },
    ),
  ),
  id: Type.Optional(Type.String({ description: "Target phase id (start/done/rm/block/unblock)." })),
  blockedBy: Type.Optional(
    Type.Array(Type.String(), {
      description: "block: the phase ids standing in the way (required). unblock: edge(s) to drop; omit to clear them all.",
    }),
  ),
  force: Type.Optional(
    Type.Boolean({ description: "start: demote the other in_progress phase instead of erroring. Default false." }),
  ),
});

type TodoParams = Static<typeof todoSchema>;

const GLYPH: Record<TodoStatus, string> = { pending: "○", in_progress: "▸", done: "✓", blocked: "!" };

function clonePhases(phases: readonly TodoPhase[]): TodoPhase[] {
  return phases.map((p) => ({ ...p, blockedBy: [...p.blockedBy] }));
}

/** A phase is BLOCKED when it has unmet blockers — derived, never stored. */
export function isBlocked(phase: TodoPhase, phases: readonly TodoPhase[]): boolean {
  const byId = new Map(phases.map((p) => [p.id, p]));
  return phase.blockedBy.some((dep) => {
    const depPhase = byId.get(dep);
    return depPhase !== undefined && depPhase.status !== "done";
  });
}

export function effectiveStatus(phase: TodoPhase, phases: readonly TodoPhase[]): TodoStatus {
  return isBlocked(phase, phases) ? "blocked" : phase.status;
}

/** Next actionable phase: first running one, else the first pending unblocked phase. */
function nextActionable(phases: readonly TodoPhase[]): TodoPhase | undefined {
  const byId = new Map(phases.map((p) => [p.id, p]));
  return (
    phases.find((p) => p.status === "in_progress" && !isBlocked(p, phases)) ??
    phases.find((p) => p.status === "pending" && !isBlocked(p, phases))
  );
}

function counts(phases: readonly TodoPhase[]): { done: number; total: number } {
  return { done: phases.filter((p) => p.status === "done").length, total: phases.length };
}

/** The footer indicator text; undefined when the list is empty or all done. */
export function statusLine(phases: readonly TodoPhase[]): string | undefined {
  const { done, total } = counts(phases);
  if (total === 0 || done === total) return undefined;
  const active = phases.find((p) => p.status === "in_progress" && !isBlocked(p, phases));
  const blocked = phases.filter((p) => p.status !== "done" && isBlocked(p, phases)).length;
  return [
    `▸ ${done}/${total} done`,
    active ? `in_progress: ${active.title}` : "next: " + (nextActionable(phases)?.title ?? "—"),
    blocked > 0 ? `${blocked} blocked` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The compact rendered board (never JSON). */
function renderBoard(phases: readonly TodoPhase[], note?: string): string {
  const head = note ? `${note}\n` : "";
  if (phases.length === 0) return `${head}Todo list is empty.`;
  const byId = new Map(phases.map((p) => [p.id, p]));
  const { done, total } = counts(phases);
  const lines = phases.map((p, i) => {
    const st = effectiveStatus(p, phases);
    const waiters = p.blockedBy.filter((dep) => byId.get(dep)?.status !== "done");
    const tail = [
      st === "blocked" && waiters.length > 0 ? `blocked by ${waiters.join(", ")}` : undefined,
      p.notes,
    ]
      .filter(Boolean)
      .join(" — ");
    return `${i + 1}. ${GLYPH[st]} [${p.id}] ${p.title}${tail ? ` (${tail})` : ""}`;
  });
  return `${head}${lines.join("\n")}\n▸ ${done}/${total} done`;
}

/** The batch contract, restated on every MUTATING result (OMP: never call todo alone). */
const BATCH_REMINDER = "(batch todo calls with real work; never call todo alone)";

function autoId(index: number, taken: Set<string>): string {
  let n = index + 1;
  while (taken.has(`p${n}`)) n += 1;
  return `p${n}`;
}

interface ApplyResult {
  phases: TodoPhase[];
  errors: string[];
  changed: boolean;
}

/**
 * Apply one action to a copy of the list. ALL errors leave the input
 * untouched (the caller discards the partial copy) — the state and the
 * rendered board stay at the previous value and the model retries.
 */
export function applyTodo(current: readonly TodoPhase[], params: TodoParams): ApplyResult {
  const phases = clonePhases(current);
  const errors: string[] = [];
  const fail = (message: string): ApplyResult => ({ phases, errors: [...errors, message], changed: false });
  const byId = new Map(phases.map((p) => [p.id, p]));
  const target = (): TodoPhase | undefined => {
    if (!params.id) {
      errors.push(`Missing phase id — pass the [id] shown in the board`);
      return undefined;
    }
    const hit = byId.get(params.id);
    if (!hit) errors.push(`Phase "${params.id}" not found`);
    return hit;
  };

  switch (params.action) {
    case "view":
      return { phases, errors, changed: false };

    case "init": {
      const list = params.phases;
      if (!list || list.length === 0) return fail("init needs a non-empty phases list");
      const taken = new Set<string>();
      const seenTitle = new Set<string>();
      const next: TodoPhase[] = [];
      for (const [i, p] of list.entries()) {
        const title = p.title.trim();
        if (!title) return fail("Every phase needs a title");
        // Blocked is DERIVED from unmet blockedBy edges — a stored "blocked"
        // status never clears (unblock touches blockedBy only), so refuse it.
        if (p.status === "blocked") return fail(`"${title}": status "blocked" is derived from unmet blockedBy edges and is never stored — pass blockedBy: [ids] (or omit status)`);
        if (seenTitle.has(title)) return fail(`Duplicate phase title "${title}"`);
        seenTitle.add(title);
        const id = p.id?.trim() || autoId(i, taken);
        if (taken.has(id)) return fail(`Duplicate phase id "${id}"`);
        taken.add(id);
        next.push({
          id,
          title,
          status: p.status ?? "pending",
          blockedBy: [...new Set(p.blockedBy ?? [])],
          ...(p.notes ? { notes: p.notes } : {}),
        });
      }
      return finish(next, errors);
    }

    case "append": {
      const list = params.phases;
      if (!list || list.length !== 1) return fail("append needs exactly one phase in `phases`");
      const p = list[0];
      const title = p.title.trim();
      if (!title) return fail("Every phase needs a title");
      if (p.status === "blocked") return fail(`"${title}": status "blocked" is derived from unmet blockedBy edges and is never stored — pass blockedBy: [ids] (or omit status)`);
      if (phases.some((x) => x.title === title)) return fail(`Phase "${title}" already exists`);
      const id = p.id?.trim() || autoId(phases.length, new Set(phases.map((x) => x.id)));
      if (byId.has(id)) return fail(`Phase id "${id}" already exists`);
      phases.push({
        id,
        title,
        status: p.status ?? "pending",
        blockedBy: [...new Set(p.blockedBy ?? [])],
        ...(p.notes ? { notes: p.notes } : {}),
      });
      return finish(phases, errors);
    }

    case "start": {
      const hit = target();
      if (!hit) return { phases, errors, changed: false };
      const other = phases.find((p) => p.status === "in_progress" && p !== hit);
      if (other && !params.force) {
        return fail(
          `"${other.title}" [${other.id}] is already in_progress — finish it with done (or pass force:true to demote it)`,
        );
      }
      if (other) other.status = "pending";
      hit.status = "in_progress";
      return finish(phases, errors);
    }

    case "done": {
      const hit = target();
      if (!hit) return { phases, errors, changed: false };
      hit.status = "done";
      return finish(phases, errors);
    }

    case "rm": {
      if (!params.id) {
        if (phases.length === 0) return fail("The todo list is already empty");
        return finish([], errors);
      }
      const hit = target();
      if (!hit) return { phases, errors, changed: false };
      const next = phases.filter((p) => p !== hit);
      // A removed phase must not linger as a dangling blocker elsewhere.
      for (const p of next) p.blockedBy = p.blockedBy.filter((dep) => dep !== hit.id);
      return finish(next, errors);
    }

    case "block": {
      const hit = target();
      if (!hit) return { phases, errors, changed: false };
      const deps = [...new Set(params.blockedBy ?? [])];
      if (deps.length === 0) return fail("block needs blockedBy — the phase id(s) standing in the way");
      for (const dep of deps) {
        if (dep === hit.id) return fail(`"${hit.title}" cannot block itself`);
        if (!byId.has(dep)) return fail(`blockedBy "${dep}" is not a phase in this list`);
      }
      hit.blockedBy = [...new Set([...hit.blockedBy, ...deps])];
      return finish(phases, errors);
    }

    case "unblock": {
      const hit = target();
      if (!hit) return { phases, errors, changed: false };
      const deps = params.blockedBy ?? [];
      hit.blockedBy = deps.length === 0 ? [] : hit.blockedBy.filter((dep) => !deps.includes(dep));
      return finish(phases, errors);
    }
  }
  return { phases, errors: ["Unknown action"], changed: false };
}

/**
 * Validate blocker edges once the whole list is known, then normalize the
 * pointer: no in_progress phase means the earliest PENDING, UNBLOCKED one
 * becomes active (phase order, OMP's rule). Blocked phases never auto-start,
 * and an out-of-order pointer never reopens a finished phase.
 */
function finish(phases: TodoPhase[], priorErrors: string[]): ApplyResult {
  const errors = [...priorErrors];
  const ids = new Set(phases.map((p) => p.id));
  for (const p of phases) {
    for (const dep of p.blockedBy) {
      if (dep === p.id) errors.push(`"${p.title}" cannot block itself`);
      else if (!ids.has(dep)) errors.push(`"${p.title}" is blocked by unknown phase "${dep}"`);
    }
  }
  if (errors.length > 0) return { phases, errors, changed: false };
  if (!phases.some((p) => p.status === "in_progress")) {
    const next = nextActionable(phases);
    if (next) next.status = "in_progress";
  }
  return { phases, errors, changed: true };
}

export default function todoModule(pi: ExtensionAPI): void {
  let phases: TodoPhase[] = [];
  /** Last live ctx — the status item is set through it on every mutation. */
  let liveUi: ExtensionContext["ui"] | undefined;
  /** Above-editor HUD (colored board + all-done linger). */
  const widget = createTodoWidgetController();

  const syncWidget = (ctx?: { mode?: string; ui: ExtensionContext["ui"] }): void => {
    // getPhases: the render closure reads LIVE state — a captured array would
    // freeze the HUD at the install-time snapshot (caught live in a herdr pane).
    widget.sync(ctx, phases, readLingerSecs(), () => phases);
  };

  const syncStatus = (ui: ExtensionContext["ui"] | undefined = liveUi): void => {
    if (!ui) return;
    try {
      ui.setStatus(TODO_STATUS_KEY, statusLine(phases));
    } catch {
      /* stale ctx after session replacement — the next session_start re-syncs */
    }
  };

  const commit = (next: TodoPhase[], ctx?: { mode?: string; ui: ExtensionContext["ui"] }): void => {
    phases = next;
    pi.appendEntry(TODO_ENTRY_TYPE, { phases });
    syncStatus(ctx?.ui);
    syncWidget(ctx);
  };

  const tool: ToolDefinition<typeof todoSchema, { phases: TodoPhase[] }> = {
    name: TODO_TOOL,
    label: "Todo",
    description:
      "Track a phased task list for this session: init (replace the whole list) · start/done/rm · block/unblock (blockedBy edges) · append · view. The result is the rendered board; phases are referenced by their [id].",
    promptSnippet: "Track a phased task list for this session (init/start/done/block/unblock/append/view)",
    // OMP's usage contract (prompts/tools/todo.md), verbatim in intent.
    promptGuidelines: [
      "Batch todo calls with real work: init alongside the FIRST work call, done in the SAME call that starts the next action, and NEVER call todo alone.",
      "Before work, init for 3+ steps, a requested task set, or new instructions. List EVERY user item separately (phased/numbered/bulleted) — never omit or leave leftovers to memory.",
      "After a successful mutation the earliest pending, unblocked phase auto-starts (marked in_progress); starting one while another is in_progress errors unless force:true.",
      "Blocked phases NEVER start automatically (unblock returns them to pending); mark done immediately and in phase order — out-of-order done never reopens a finished phase.",
      "External waits (user, another agent, a service): block with the blocker ids, which suppresses the stop reminder; unblock when actionable, and append a clearing phase when the blocker is agent-actionable.",
      "Phase ids are stable for the list's lifetime; when the board loses text, view it — never guess.",
    ],
    parameters: todoSchema,
    // TUI-only: the colored board (status colors, strikethrough on done).
    // The LLM-facing text content stays the plain board — this only swaps
    // what the transcript draws. No phases in details → the plain text blob.
    renderResult(result, _options, theme) {
      const detail = result.details as { phases?: TodoPhase[] } | undefined;
      const boardPhases = Array.isArray(detail?.phases) && detail!.phases!.every(isTodoPhase) ? detail!.phases! : [];
      if (boardPhases.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      return new Text(renderTodoBoard(boardPhases, theme as unknown as WidgetTheme).join("\n"), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ui = ctx.ui;
      liveUi = ui;
      const result = applyTodo(phases, params);
      const failed = result.errors.length > 0;
      if (!failed && result.changed) commit(result.phases, ctx);
      const effective = failed ? phases : result.phases;
      // Mutations restate the batch contract; a pure view stays quiet.
      const tail = failed
        ? `\n✗ ${result.errors.join("; ")}`
        : params.action === "view"
          ? ""
          : `\n${BATCH_REMINDER}`;
      return {
        content: [{ type: "text", text: renderBoard(effective, tail) }],
        details: { phases: effective },
        isError: failed ? true : undefined,
      };
    },
  };
  pi.registerTool(tool);

  pi.registerCommand("todo", {
    description: "Show the phased todo board, or /todo clear to reset it",
    getArgumentCompletions: (prefix) => {
      const q = String(prefix || "").trim().toLowerCase();
      const items = ["clear"].filter((k) => k.startsWith(q)).map((k) => ({ value: k, label: k }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "clear") {
        if (phases.length === 0) {
          ctx.ui.notify("Todo list is already empty.", "info");
          return;
        }
        commit([], ctx);
        ctx.ui.notify("Todo list cleared.", "info");
        return;
      }
      if (sub) {
        ctx.ui.notify(`Unknown subcommand: ${sub}. Use /todo (board) or /todo clear.`, "warning");
        return;
      }
      ctx.ui.notify(renderBoard(phases), "info");
    },
  });

  /** Rehydrate the LAST persisted entry, then label it. */
  pi.on("session_start", async (_event, ctx) => {
    liveUi = ctx.ui;
    const entries: unknown[] =
      (typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : undefined) ??
      (typeof ctx.sessionManager?.getEntries === "function" ? ctx.sessionManager.getEntries() : undefined) ??
      [];
    phases = resolveTodoPhases(entries);
    syncStatus(ctx.ui);
    // A resumed session with open work shows the HUD again; an all-done
    // snapshot from a previous session stays hidden (no re-linger).
    syncWidget(ctx);
  });

  // The indicator must not leak past this runtime (subagent-precedent: the
  // widget controller owns set + clear on session change).
  pi.on("session_shutdown", () => {
    widget.dispose();
    try {
      liveUi?.setStatus(TODO_STATUS_KEY, undefined);
    } catch {
      /* dead runtime */
    }
    liveUi = undefined;
    phases = [];
  });
}

/** Read the last `ceulen-todo` entry on a branch. Exported for tests. */
export function resolveTodoPhases(entries: unknown): TodoPhase[] {
  if (!Array.isArray(entries)) return [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: string; customType?: string; data?: { phases?: unknown } } | undefined;
    if (entry?.type !== "custom" || entry?.customType !== TODO_ENTRY_TYPE) continue;
    const raw = entry.data?.phases;
    if (!Array.isArray(raw)) continue; // malformed entry — fall back to the previous one
    return raw.filter(isTodoPhase).map((p) => ({ ...p }));
  }
  return [];
}

export function isTodoPhase(value: unknown): value is TodoPhase {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Partial<TodoPhase>;
  return (
    typeof p.id === "string" &&
    typeof p.title === "string" &&
    typeof p.status === "string" &&
    (STATUSES as readonly string[]).includes(p.status) &&
    Array.isArray(p.blockedBy) &&
    p.blockedBy.every((d) => typeof d === "string")
  );
}
