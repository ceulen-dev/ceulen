/**
 * repair module — tool-call hardening for EVERY model.
 *
 * Ported from the tool-hardening half of @bacnh85/pi-model-tools 0.9.5. The
 * bundle's DELIBERATE deviation from upstream: upstream gated repair + guards
 * on a detected model family (deepseek-v4 / glm); here repair IS the
 * model-agnostic layer, so the deterministic half (schema argument repair,
 * read-notice decontamination, destructive-command + guessed-path guards) runs
 * for all models, and only the family-specific steering half stays out of the
 * bundle entirely.
 *
 * What it registers:
 *  - read/write/edit/grep/find/ls/bash, WRAPPED ONCE each (pi lets an
 *    extension tool override a built-in by name): schema-driven arg repair,
 *    read defaults + a note, bash no-output annotation, edit no-op guard +
 *    trim-tolerant retry + nearest-region error + apply_patch escalation.
 *  - apply_patch (Codex-style V4D diffs) and str_replace_editor (DSH Minimal
 *    pair) as new tools.
 *  - a `tool_call` guard hook and the `/repair` status command.
 *
 * Settings (`repair` section, lib/settings.ts) are read PER TOOL CALL, so the
 * /config toggles apply to the next turn. Exception: the bash description
 * clause + the auto-background mechanics bind ONCE at load (a byte-stable
 * description is required for the prompt cache), so `repair.autoBg` /
 * `repair.autoBgSecs` take effect on the next session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readDisabledTools } from "../../lib/tools.js";
import { abortAllBgJobs, bashAutoBgClause, setBgDeliveryEnabled, wrapWithAutoBg } from "./lib/auto-bg.js";
import {
  computeRetryEdit,
  isEditMismatchError,
  nearestBlock,
  normalizeToLF,
  parseFailedEditIndex,
  stripBom,
  stripReadContamination,
} from "./lib/edit-repair.js";
import { createStrReplaceEditorToolDefinition } from "./lib/editor.js";
import { checkDangerousCommand, isRecord, looksLikeCodePath } from "./lib/guards.js";
import { repairToolArguments, type RepairKind } from "./lib/input-repair.js";
import { applyPatchToFiles, parsePatch, PatchParseError } from "./lib/patch.js";
import { readRepairSettings } from "./lib/settings.js";
import {
  extractConflictBlocks,
  isMultiRange,
  peelPathSelector,
  resolveTailSelector,
  selToOffsetLimit,
  type ParsedSelector,
} from "./lib/read-selector.js";

// ── Read path selectors (OMP grammar — see lib/read-selector.ts) ──

/** Non-enumerable stash marker so host schema validation never sees it. */
function stashSelector(args: Record<string, unknown>, selector: ParsedSelector): void {
  Object.defineProperty(args, "__mtSelector", { value: selector, enumerable: false, configurable: true });
}

/**
 * Peel `path:selector` (execute-time — needs ctx.cwd for the existence
 * probes). A literal path that exists ALWAYS wins (OMP issue #4618) — the
 * selector is peeled only when the raw path is missing and the suffix parses.
 * Single-range selectors translate straight to offset/limit; tail / multi-
 * range / conflicts / raw return a stash for readWithSelector (they need the
 * file's bytes or line count).
 */
function applyReadSelector(args: Record<string, unknown>, cwd: string): unknown {
  if (!isRecord(args) || typeof args.path !== "string") return args;
  const raw = args.path;
  const colonIdx = raw.lastIndexOf(":");
  if (colonIdx <= 0) return args;
  if (existsSync(resolvePath(cwd, raw))) return args; // literal wins
  let peeled: { stem: string; selector?: ParsedSelector };
  try {
    peeled = peelPathSelector(raw);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  if (!peeled.selector || !existsSync(resolvePath(cwd, peeled.stem))) return args;
  const out: Record<string, unknown> = { ...args, path: peeled.stem };
  const sel = peeled.selector;
  if (sel.kind === "lines" && !isMultiRange(sel)) {
    // Single range → the built-in's own offset/limit machinery.
    const { offset, limit } = selToOffsetLimit(sel);
    if (offset !== undefined) out.offset = offset;
    if (limit !== undefined) out.limit = limit;
    if (sel.raw !== true) return out;
  }
  stashSelector(out, sel);
  return out;
}

/** In-memory slice for multi-range / raw / conflicts selectors. */
async function readWithSelector(
  stem: string,
  cwd: string,
  selector: ParsedSelector,
  paramsOffset: number | undefined,
  paramsLimit: number | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }> {
  const buf = await readFile(resolvePath(cwd, stem));
  const text = buf.toString("utf-8");
  const lines = text.split("\n");
  // A trailing newline is a terminator, not a 101st line — drop the phantom
  // empty tail element so totals and :-N tails match editor line numbers.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  let sel: Exclude<ParsedSelector, { kind: "tail" }>;
  try {
    sel = resolveTailSelector(selector, total);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }

  if (sel.kind === "conflicts") {
    const blocks = extractConflictBlocks(lines);
    if (blocks.length === 0) return { content: [{ type: "text", text: `No merge conflicts in ${stem}.` }] };
    const body = blocks.map((b) => b.join("\n")).join("\n");
    return {
      content: [{ type: "text", text: `[${blocks.length} conflict block(s) in ${stem}]\n${body}` }],
    };
  }

  if (sel.kind === "lines" && isMultiRange(sel)) {
    const parts: string[] = [];
    for (const range of sel.ranges) {
      const end = Math.min(range.endLine ?? total, total);
      const slice = lines.slice(range.startLine - 1, end);
      parts.push(`── lines ${range.startLine}-${end} of ${total} ──\n${slice.join("\n")}`);
    }
    const shown = sel.ranges.reduce((acc, r) => acc + (Math.min(r.endLine ?? total, total) - r.startLine + 1), 0);
    return {
      content: [{ type: "text", text: `[lines ${sel.ranges.map((r) => `${r.startLine}-${r.endLine ?? total}`).join(", ")} of ${total} total — ${shown} lines shown]\n\n${parts.join("\n\n")}` }],
    };
  }

  // Single range (explicit or a resolved :-N tail) or :raw — pi's read is
  // already unprefixed, so slice here from the resolved range; params
  // offset/limit only fill in when the selector carried none (:raw + args).
  const range = sel.kind === "lines" ? sel.ranges[0] : undefined;
  const offset = range?.startLine ?? paramsOffset ?? 1;
  const limit = range ? (range.endLine !== undefined ? range.endLine - range.startLine + 1 : undefined) : paramsLimit;
  const end = limit !== undefined ? offset + limit - 1 : total;
  const slice = lines.slice(offset - 1, Math.min(end, total));
  return {
    content: [{ type: "text", text: `[lines ${offset}-${Math.min(end, total)} of ${total}]\n${slice.join("\n")}` }],
  };
}

// ── Wrapper helpers (ported from upstream extensions/index.ts) ──

function addReadDefaults(args: unknown): unknown {
  if (!isRecord(args)) return args;
  if ((args.offset !== undefined) === (args.limit !== undefined)) return args;
  const defaults = args.limit !== undefined ? { offset: 1 } : { limit: 2000 };
  const note = args.limit !== undefined
    ? "Note: offset was not provided; defaulted to 1."
    : "Note: limit was not provided; defaulted to 2000 lines.";
  const out = { ...args, ...defaults } as Record<string, unknown>;
  // Non-enumerable so host-side schema validation of prepared args (which
  // walks enumerable keys) never rejects the marker; execute still reads it
  // via property access. JSON-cloning hosts drop it silently — the note is
  // cosmetic, so that degrades gracefully.
  Object.defineProperty(out, "__mtReadNote", { value: note, enumerable: false, configurable: true });
  return out;
}

function appendReadNote(result: any, note: unknown) {
  if (typeof note !== "string" || !note) return result;
  return { ...result, content: [...(Array.isArray(result?.content) ? result.content : []), { type: "text", text: note }] };
}

// Strip read-tool contamination notices from an edit's oldText fields. Mutates
// in place and reports whether anything changed.
function decontaminateEditArgs(args: any): boolean {
  if (!isRecord(args)) return false;
  const hasOld = Array.isArray(args.edits)
    ? args.edits.some((e: any) => isRecord(e) && typeof e.oldText === "string")
    : typeof args.oldText === "string";
  if (!hasOld) return false;
  let changed = false;
  const clean = (s: string): string => {
    const r = stripReadContamination(s);
    if (r.changed) changed = true;
    return r.text;
  };
  if (Array.isArray(args.edits)) {
    for (const e of args.edits) if (isRecord(e) && typeof e.oldText === "string") e.oldText = clean(e.oldText);
  }
  if (typeof args.oldText === "string") args.oldText = clean(args.oldText);
  return changed;
}

// Locate the file, read it, and report its (BOM-stripped, LF-normalized)
// content for trim-tolerant retry. Returns null on any I/O problem.
async function readFileForRetry(filePath: string, cwd: string): Promise<string | null> {
  const abs = resolvePath(cwd, filePath);
  try {
    const buf = await readFile(abs);
    return normalizeToLF(stripBom(buf.toString("utf-8")));
  } catch {
    return null;
  }
}

/** The full wrapped-tool definition factory. Exported for the wrapper
 *  integration test (a real edit tool definition + a temp file drives it). */
export function wrapToolDefinition(
  base: any,
  factory: (cwd: string) => any,
  shouldRepair: () => boolean,
  onRepair: (toolName: string, repairs: readonly RepairKind[]) => void,
  editMismatchCounts?: Map<string, number>,
  activeToolNames?: () => readonly string[],
  // Deviation from upstream: the edit retry/escalation block is gated on the
  // `repair.editRetry` toggle. Read-notice decontamination and the no-op guard
  // stay unconditional (upstream: always on — both are deterministic and safe).
  shouldEditRetry: () => boolean = () => true,
): any {
  return {
    ...base,
    // The selector grammar sits in the wrapped read's description, which binds
    // per wrapped instance (cache-safe: byte-stable for the session).
    description:
      base.name === "read"
        ? `${base.description}\n\nPath suffixes: file.ts:50 starts at line 50; :50-200 inclusive; :50+150 counts lines; :50- to EOF; :-60 last 60 lines; commas join ranges (:5-16,960-973) or single lines (:19,59); :conflicts lists merge-conflict blocks; :raw compounds with a range. A literal path that exists always wins over selector parsing.`
        : base.description,
    prepareArguments(args: unknown) {
      let prepared = base.prepareArguments ? base.prepareArguments(args as never) : args;
      if (shouldRepair()) {
        const repaired = repairToolArguments(base.name, base.parameters, prepared);
        if (repaired.repaired) { onRepair(base.name, repaired.repairs); prepared = repaired.args; }
      }
      // Strip read-tool contamination from edit oldText (always on — it's a
      // safe, deterministic fix for the documented mismatch root cause).
      if (base.name === "edit" && isRecord(prepared)) {
        if (decontaminateEditArgs(prepared)) {
          onRepair(base.name, ["read-notice-stripped"]);
        }
      }
      return base.name === "read" ? addReadDefaults(prepared) : prepared;
    },
    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      const cwd = ctx?.cwd || process.cwd();
      const freshDef = factory(cwd);
      const readNote = base.name === "read" && isRecord(params) ? params.__mtReadNote : undefined;
      if (isRecord(params)) delete params.__mtReadNote;
      const selector: ParsedSelector | undefined =
        base.name === "read" && isRecord(params) ? (params.__mtSelector as ParsedSelector | undefined) : undefined;
      if (isRecord(params)) delete params.__mtSelector;

      // Selector peel (execute-time: needs ctx.cwd for the literal-wins probe).
      if (base.name === "read" && !selector && isRecord(params) && typeof params.path === "string" && params.path.includes(":")) {
        params = applyReadSelector(params, cwd);
      }
      const peeledSelector: ParsedSelector | undefined =
        base.name === "read" && isRecord(params) ? (params.__mtSelector as ParsedSelector | undefined) : undefined;
      if (isRecord(params)) delete params.__mtSelector;

      // Selector slice path: multi-range / tail / conflicts / raw need the
      // file's bytes, which the built-in read can't hand back pre-slice.
      if (base.name === "read" && (selector ?? peeledSelector) && isRecord(params) && typeof params.path === "string") {
        const result = await readWithSelector(
          params.path,
          cwd,
          (selector ?? peeledSelector)!,
          typeof params.offset === "number" ? params.offset : undefined,
          typeof params.limit === "number" ? params.limit : undefined,
        );
        return { ...result, details: base.name === "read" ? undefined : result.details };
      }

      if (base.name !== "edit") {
        try {
          const result = await freshDef.execute(toolCallId, params, signal, onUpdate, ctx);
          return base.name === "read" ? appendReadNote(result, readNote) : result;
        } catch (err: any) {
          // Session mining: "(no output) / Command exited with code 1" after a
          // search reads as a crash, so models retry the same command. Annotate
          // it as a no-match result — but only for search-like commands; for
          // predicates (git diff --quiet, test -f, kill -0) exit 1 IS the answer.
          const message: string = err?.message ? String(err.message) : "";
          const command = typeof params?.command === "string" ? params.command : "";
          if (base.name === "bash" && /\b(rg|grep|find|fd|ls|which|whereis|ag|ack)\b/.test(command) && /^\(no output\)\s*\n*\s*Command exited with code \d+/.test(message)) {
            throw new Error(`${message}\n\nNote: no output with a non-zero exit usually means the search/lookup found no matches — change the pattern or tool instead of retrying the same command.`);
          }
          throw err;
        }
      }

      // edit: try once; on a match-failure, retry once with trim-tolerant
      // matching (copying actual file bytes) before giving up with a richer
      // error that shows the nearest region.
      // No-op guard: oldText === newText produces zero change; the core only
      // reports it post-hoc as "might indicate special characters". Fail fast
      // with the index so the model fixes targeting instead of re-sending.
      const noopIdx = (Array.isArray(params?.edits) ? params.edits : typeof params?.oldText === "string" ? [{ oldText: params.oldText, newText: params.newText }] : [])
        .findIndex((e: any) => isRecord(e) && e.oldText === e.newText);
      if (noopIdx !== -1) throw new Error(`edits[${noopIdx}] is a no-op: oldText equals newText. The replacement produces no change — check which region you meant to target.`);
      try {
        const result = await freshDef.execute(toolCallId, params, signal, onUpdate, ctx);
        editMismatchCounts?.delete(resolvePath(cwd, typeof params?.path === "string" ? params.path : ""));
        return result;
      } catch (catchedErr: any) {
        let err: any = catchedErr;
        if (!shouldEditRetry()) throw err;
        const initialMessage: string = err?.message ? String(err.message) : "";
        if (!isEditMismatchError(initialMessage)) throw err;

        const filePath = typeof params?.path === "string" ? params.path : "";
        if (!filePath) throw err;
        const fileContent = await readFileForRetry(filePath, cwd);
        if (fileContent === null) throw err;

        const edits: { oldText: string; newText: string }[] = Array.isArray(params?.edits) && params.edits.length > 0
          ? params.edits
          : (typeof params?.oldText === "string" ? [{ oldText: params.oldText, newText: params.newText }] : []);
        if (edits.length === 0) throw err;

        const retry = computeRetryEdit(fileContent, edits, parseFailedEditIndex(initialMessage));
        if (retry) {
          // Rebuild oldText from the file's real bytes (real indentation) so the
          // core exact matcher succeeds; keep the model's newText as-is.
          const fixedParams = { ...params };
          if (Array.isArray(fixedParams.edits)) fixedParams.edits = retry.fixedEdits;
          else fixedParams.oldText = retry.fixedEdits[0].oldText;
          onRepair(base.name, ["trim-match-retry"]);
          try {
            return await freshDef.execute(toolCallId, fixedParams, signal, onUpdate, ctx);
          } catch (retryErr: any) {
            // A failed trim-retry is still a miss — fall through to the
            // unresolvable path below so it counts toward escalation.
            err = retryErr;
          }
        }

        // Unresolvable: enrich the error with the nearest region so the model
        // can copy verbatim on the next turn.
        const message: string = err?.message ? String(err.message) : "";
        const failing = edits[Math.min(parseFailedEditIndex(message), edits.length - 1)];
        const nearest = failing ? nearestBlock(fileContent, stripReadContamination(failing.oldText).text) : "";
        // Session mining: 26% of mismatches fail again on retry (wrong content,
        // not whitespace). Escalate after the FIRST miss on the same file — the
        // trim-tolerant retry has already run by this point, so a second exact-
        // match attempt almost never recovers (2026-09: 8/8 next-call success
        // after the nudge; max observed retry depth 3 when gated at 2).
        const misses = editMismatchCounts ? (editMismatchCounts.get(resolvePath(cwd, filePath)) ?? 0) + 1 : 1;
        editMismatchCounts?.set(resolvePath(cwd, filePath), misses);
        const escalate = misses >= 1 && (!activeToolNames || activeToolNames().includes("apply_patch"))
          ? `\n\nedit has failed ${misses}× on this file. Switch to apply_patch with a small V4D diff (context + -/+ lines) — it does not require exact oldText.`
          : "";
        throw new Error(nearest ? `${message}\n\n${nearest}${escalate}` : `${message}${escalate}`);
      }
    },
  };
}

// ── Module ──

export default function repairModule(pi: ExtensionAPI) {
  const settings = readRepairSettings();
  // The bash description half AND the auto-background mechanics bind once at
  // load: the description sits in the cache-safe request head, so it must be
  // byte-stable per session (never per-turn guidance).
  const autoBgOn = settings.autoBg;
  const autoBgSecs = settings.autoBgSecs;

  // Per-tool kill-switch: a tool named in ceulen.disabledTools registers
  // inactive, so /config's live tool toggles keep working over the wrapped
  // built-ins too. The persisted list re-applies on every load.
  const disabled = readDisabledTools();
  const repairCounts = new Map<string, number>();
  // Per-file edit-mismatch counters — escalate to apply_patch after repeated
  // unresolvable misses on the same file (26% retry-fail tail).
  const editMismatchCounts = new Map<string, number>();

  const onRepair = (toolName: string, repairs: readonly RepairKind[]) => {
    repairCounts.set(toolName, (repairCounts.get(toolName) ?? 0) + 1);
  };

  // ── Wrapped built-ins, registered ONCE each ──
  const toolFactories: Record<string, (cwd: string) => any> = {
    // The selector grammar sits in the wrapped read's description, which binds
    // ONCE at load (cache-safe request head — autoBg precedent).
    read: createReadToolDefinition,
    write: createWriteToolDefinition,
    edit: createEditToolDefinition,
    grep: createGrepToolDefinition,
    find: createFindToolDefinition,
    ls: createLsToolDefinition,
    bash: (cwd: string) => {
      const def = createBashToolDefinition(
        cwd,
        autoBgOn ? { operations: wrapWithAutoBg(createLocalBashOperations(), { pi, thresholdSecs: autoBgSecs }) } : undefined,
      );
      return { ...def, description: `${def.description}\n\n${bashAutoBgClause(autoBgOn, autoBgSecs)}` };
    },
  };
  for (const factory of Object.values(toolFactories)) {
    const template = factory(process.cwd());
    pi.registerTool({
      ...wrapToolDefinition(
        template,
        factory,
        () => readRepairSettings().arguments,
        onRepair,
        editMismatchCounts,
        () => pi.getActiveTools(),
        () => readRepairSettings().editRetry,
      ),
      defaultActive: !disabled.has(template.name),
    });
  }

  // ── apply_patch: Codex-style diff/patch tool (robust for weak models) ──
  pi.registerTool({
    ...defineTool({
      name: "apply_patch",
      label: "apply_patch",
      description: [
        "Apply a Codex-style V4D patch to edit one or more files. Emit only changed lines plus a little surrounding context (a small diff), which is easier to get right than reproducing a large verbatim block. Supported sections: `*** Add File: <path>` (only `+` lines), `*** Delete File: <path>` (no payload), `*** Update File: <path>` or `*** Update File: <old> → <new>` (rename). Inside an Update section, each hunk is preceded by a `@@` anchor line whose text is an unchanged context line, then `-` removed lines and `+` added lines. Leading-space context lines (` `) are also allowed. If the @@ anchor text is restated as the immediately-following context or removed line, the duplicate is auto-collapsed. Context+removed must match UNIQUELY in the file. Wrap the whole patch in `*** Begin Patch` ... `*** End Patch`.",
        "",
        "Example:",
        "*** Begin Patch", "*** Update File: src/foo.ts", "@@ export function foo()", "-  return 1", "+  return 2", "*** End Patch",
      ].join("\n"),
      promptSnippet: "Apply a diff/patch to edit one or more files (Codex V4D format)",
      promptGuidelines: [
        "Use apply_patch for multi-line or multi-file edits: emit a small diff (context + -/+ lines) instead of reproducing large verbatim oldText blocks.",
        "Each Update hunk needs a unique anchor: include enough unchanged context lines so the context+removed block matches exactly once in the file.",
        "If the @@ anchor repeats on the very next line (as space-context or -removed), the duplicate is auto-collapsed.",
        "For a single tiny one-line replacement, edit is fine; for anything larger or spanning multiple files, prefer apply_patch.",
      ],
      parameters: Type.Object({ patch: Type.String({ description: "The V4D patch text, wrapped in *** Begin Patch ... *** End Patch." }) }),
      renderShell: "self",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const cwd = ctx?.cwd || process.cwd();
        let parsed;
        try {
          parsed = parsePatch(params.patch);
        } catch (err) {
          const msg = err instanceof PatchParseError ? err.message : String(err);
          return { content: [{ type: "text", text: `Invalid patch: ${msg}` }], isError: true, details: undefined };
        }
        try {
          const res = await applyPatchToFiles(parsed, cwd);
          const summary = res.files.map((f) => {
            if (f.kind === "add") return `Added ${f.path}`;
            if (f.kind === "delete") return `Deleted ${f.path}`;
            return `Updated ${f.path}`;
          }).join("\n");
          const exactness = res.exact ? "" : "\nNote: some hunks matched via fuzzy (whitespace/Unicode) normalization.";
          return {
            content: [{ type: "text", text: `${summary}${exactness}` }],
            details: { diff: res.diff, files: res.files.map((f) => f.path) },
          };
        } catch (err) {
          return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true, details: undefined };
        }
      },
    }),
    defaultActive: !disabled.has("apply_patch"),
  });

  // ── str_replace_editor: DSH Minimal-pair editor (byte-faithful schema) ──
  pi.registerTool({
    ...createStrReplaceEditorToolDefinition(process.cwd()),
    defaultActive: !disabled.has("str_replace_editor"),
  });

  // ── Session lifecycle ──
  pi.on("session_start", () => {
    // Per-session — misses from a prior session must not escalate.
    editMismatchCounts.clear();
    repairCounts.clear();
  });
  if (autoBgOn) {
    pi.on("session_start", () => setBgDeliveryEnabled(true));
    // Delivery is suppressed so the aborts don't fire triggerTurn follow-ups
    // into a session that is going away (/new and /resume also fire
    // session_shutdown, so cross-session leakage can't happen).
    pi.on("session_shutdown", () => {
      abortAllBgJobs(true);
    });
  }

  // ── tool_call: destructive-bash + read-on-guessed-path guards (ALL models).
  // Upstream gated these on a detected family; repair is the model-agnostic
  // layer here, so the guards are ungated (only the `repair.guards` toggle). ──
  pi.on("tool_call", (event, ctx) => {
    if (!readRepairSettings().guards) return;
    if (event.toolName === "bash") {
      const command = isRecord(event.input) ? event.input.command : undefined;
      const danger = checkDangerousCommand(command);
      if (danger) return { block: true, reason: `Safety: ${danger}` };
    }
    if (event.toolName === "read" && isRecord(event.input) && ctx.cwd) {
      const filePath = typeof event.input.path === "string" ? event.input.path.trim() : "";
      if (filePath && looksLikeCodePath(filePath) && !existsSync(resolvePath(ctx.cwd, filePath))) {
        const filename = filePath.split("/").pop() ?? filePath;
        const relDir = dirname(filePath);
        const dirPart = relDir !== "." ? ` under ${relDir}/` : "";
        return { block: true, reason: `Path not found: "${filePath}". Use find to locate "${filename}"${dirPart}, then read.` };
      }
    }
  });

  // ── /repair (bare = status) ──
  pi.registerCommand("repair", {
    description: "Show tool-hardening status: repair counts, guards, bash auto-background.",
    handler: async (_args, ctx) => {
      const live = readRepairSettings();
      const total = [...repairCounts.values()].reduce((a, b) => a + b, 0);
      const lines = [
        "## repair status",
        "",
        "**Settings** (global settings.json ⊕ trusted project):",
        `  Argument repair: ${live.arguments ? "on" : "off"}`,
        `  Edit mismatch repair: ${live.editRetry ? "on" : "off"}`,
        `  Tool-call guards: ${live.guards ? "on" : "off"}`,
        `  Auto-background bash: ${live.autoBg ? `on @${live.autoBgSecs}s` : "off"}${live.autoBg !== autoBgOn || live.autoBgSecs !== autoBgSecs ? ` (bound at load: ${autoBgOn ? `on @${autoBgSecs}s` : "off"} — next session applies)` : ""}`,
        "",
        `**Repairs this session:** ${total} total`,
      ];
      for (const [tool, count] of [...repairCounts.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${tool}: ${count}`);
      }
      lines.push(
        "",
        `**Escalation counters (edit misses per file):** ${editMismatchCounts.size}`,
        "**Tools:** apply_patch + str_replace_editor registered; read/write/edit/grep/find/ls/bash wrapped.",
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
