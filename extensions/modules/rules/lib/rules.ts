// rules — RULES.md discovery, parsing, @import expansion, prompt composition.
//
// FORMAT (one rule per `## <name>` section; ported CONTRACT from OMP's
// sticky RULES.md + rulebook split):
//
//   ## never-push
//   Never commit or push unless the user explicitly asks.
//
//   ## api-style
//   description: How to write HTTP handlers in this repo.
//   Always use the shared `json()` helper and return a typed error shape.
//
// - A section whose body STARTS with a `description:` line is a RULEBOOK rule:
//   the prompt lists only `name — description`; the body is served on demand by
//   the `rule_get` tool.
// - A section with no `description:` line is a STICKY rule: its body is always
//   appended to the system prompt, under STICKY_CHAR_CAP (lowest-precedence
//   rules dropped first, with a loud marker).
// - Content BEFORE the first `##` heading (i.e. a heading-less RULES.md) is one
//   sticky rule named `RULES` — OMP's plain-prose RULES.md still works.
// - `# title` and `### x` are NOT rule headings; `##` inside a ``` fence is text.
// - `@path` tokens (at line start or after whitespace, outside fences) expand
//   inline: relative to the RULES.md's own directory, `~/` from home, absolute
//   as-is. Cycles and repeats stay literal; missing targets get a marker.
//
// SOURCES / PRECEDENCE: nearest-first walk from cwd to the filesystem root for
// `<dir>/.pi/RULES.md`, then the user-level `<agentDir>/RULES.md`. Duplicate
// rule names resolve first-wins, so a project rule overrides a user rule and a
// nearer project file overrides a farther one.
//
// DELIBERATE DEVIATIONS from OMP (documented, not accidental):
//   1. Only `##` headings split rules — no frontmatter (`description:` line
//      instead) and no `alwaysApply`/TTSR condition fields. Sticky is the
//      absence of a description, which keeps one parseable format.
//   2. A heading-less file is ONE sticky rule named `RULES` (OMP's plain-prose
//      RULES.md); a `# Title` preamble before the first `##` is dropped.
//   3. `@token` inside a FENCED block stays literal (OMP parity), but a span
//      opening with a backtick is left literal only because a backtick is not
//      whitespace — no code-span parser is worth its weight here.

import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const STICKY_CHAR_CAP = 4000;
export const MAX_IMPORT_DEPTH = 5;
export const RULES_FILE = "RULES.md";
const PROJECT_DIR = ".pi";

const HEADING = /^##\s+(.+?)\s*$/;
const DESCRIPTION = /^description:\s*(.*)$/i;
const FENCE = /^\s*(?:```|~~~)/;
// A token only counts as an import when `@` starts a line or follows whitespace
// (so `user@example.com` and `git@github.com:o/r.git` are never imports).
const IMPORT = /(^|[ \t])@([^\s]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}"']+$/;

export interface LoadedRule {
  /** The rule's slug/heading (or `RULES` for pre-heading prose). */
  name: string;
  /** Present = rulebook rule (body on demand); absent = sticky rule. */
  description?: string;
  /** Body, with `@` imports already expanded. */
  body: string;
  /** Absolute path of the RULES.md that defined it. */
  source: string;
  sticky: boolean;
}

export interface RuleModel {
  /** Discovered RULES.md files, highest precedence first. */
  files: string[];
  /** Deduped rules in precedence order. */
  rules: LoadedRule[];
  sticky: LoadedRule[];
  rulebook: LoadedRule[];
  /** The composed prompt block, or undefined when nothing was found. */
  block?: string;
  /** Length of `block` (the char count /rules reports). */
  blockChars: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface Section {
  name: string | null;
  lines: string[];
}

function splitSections(text: string): Section[] {
  const sections: Section[] = [{ name: null, lines: [] }];
  let fenced = false;
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
    if (heading) sections.push({ name: heading[1].trim(), lines: [] });
    else sections.at(-1)!.lines.push(line);
  }
  return sections;
}

function makeRule(name: string, rawLines: string[], source: string): LoadedRule | null {
  const lines = rawLines.slice();
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();

  let description: string | undefined;
  const match = lines.length > 0 ? DESCRIPTION.exec(lines[0].trim()) : null;
  if (match && match[1].trim() !== "") {
    description = match[1].trim();
    lines.shift();
  }

  const body = lines.join("\n").trim();
  return { name, description, body, source, sticky: description === undefined };
}

/** Parse one RULES.md into rules. A heading-less file (plain prose) is ONE sticky
 *  rule named `RULES`; in a sectioned file the pre-heading preamble is document
 *  title, not a rule, so it is dropped. */
export function parseRulesFile(text: string, source: string): LoadedRule[] {
  const out: LoadedRule[] = [];
  const sections = splitSections(text);
  const sectioned = sections.some((section) => section.name !== null);
  for (const section of sections) {
    if (section.name === null && sectioned) continue;
    const rule = makeRule(section.name ?? "RULES", section.lines, source);
    if (rule && (rule.body !== "" || rule.description !== undefined)) out.push(rule);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** The user-level agent dir (pi relocates it with PI_CODING_AGENT_DIR). */
export function defaultUserRulesDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** `<dir>/.pi/RULES.md` from cwd up to the filesystem root, then the user file. */
export function discoverRuleFiles(cwd: string, userDir = defaultUserRulesDir(), trusted = true): string[] {
  const files: string[] = [];
  // Untrusted project: repo-controlled RULES.md (and its @imports) must never
  // reach the system prompt — the same gate as pi's AGENTS.md context files
  // and every other project-file consumer here (subagent agents, settings
  // overlays). Only the user-level file applies.
  if (trusted) {
    let dir = path.resolve(cwd);
    for (;;) {
      const candidate = path.join(dir, PROJECT_DIR, RULES_FILE);
      if (existsSync(candidate)) files.push(candidate);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const user = path.join(userDir, RULES_FILE);
  if (existsSync(user)) files.push(user);
  return files;
}

// ---------------------------------------------------------------------------
// @import expansion
// ---------------------------------------------------------------------------

function resolveImport(token: string, baseDir: string): string {
  const raw = token.startsWith("~/") ? path.join(os.homedir(), token.slice(2)) : token;
  return path.resolve(baseDir, raw);
}

interface ImportState {
  /** Resolved paths already pulled into this expansion tree (cycle guard). */
  seen: Set<string>;
  /** Every file actually read — feeds the cache signature. */
  read: Set<string>;
}

function expandImports(text: string, baseDir: string, state: ImportState, depth: number): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line.replace(IMPORT, (whole: string, lead: string, token: string) => {
        const cleaned = token.replace(TRAILING_PUNCTUATION, "");
        if (cleaned === "") return whole;

        const resolved = resolveImport(cleaned, baseDir);
        // ponytail: repeats/cycles stay literal (OMP parity) — only a MISSING
        // target gets a marker, so a real typo is loud and a repeat is silent.
        if (state.seen.has(resolved)) return whole;

        let content: string;
        // Track the target even when the read FAILS: a previously-missing
        // import being CREATED must invalidate the cache — signature() emits
        // `<file>:missing` for absent entries, so the existence flip changes
        // the signature and the next load re-reads (live finding, reviewer
        // 2026-10-06 — creating the file a missing-marker points at is the
        // most likely user fix, and it silently kept serving the marker).
        state.read.add(resolved);
        try {
          content = readFileSync(resolved, "utf8");
        } catch {
          return `${lead}[missing import: @${cleaned}]`;
        }
        if (depth >= MAX_IMPORT_DEPTH) {
          return `${lead}[import depth limit reached: @${cleaned}]`;
        }
        state.seen.add(resolved);
        const nested = expandImports(content.trim(), path.dirname(resolved), state, depth + 1);
        return `${lead}${nested}`;
      });
    })
    .join("\n");
}

function expandFile(raw: string, source: string, state: ImportState): string {
  state.seen.add(source);
  state.read.add(source);
  return expandImports(raw.trim(), path.dirname(source), state, 0);
}

// ---------------------------------------------------------------------------
// Model build
// ---------------------------------------------------------------------------

/** Parse one RULES.md from disk with imports expanded (used by the loader). */
export function readRulesFile(source: string, state: ImportState = { seen: new Set(), read: new Set() }): LoadedRule[] {
  let raw: string;
  try {
    raw = readFileSync(source, "utf8");
  } catch {
    return [];
  }
  return parseRulesFile(expandFile(raw, source, state), source);
}

function buildModel(files: string[], cwd: string): { model: RuleModel; imported: string[] } {
  const state: ImportState = { seen: new Set(), read: new Set() };
  const rules: LoadedRule[] = [];
  const claimed = new Set<string>();

  for (const file of files) {
    for (const rule of readRulesFile(file, state)) {
      // Name-based dedup, first-wins (precedence order = discovery order).
      if (claimed.has(rule.name)) continue;
      claimed.add(rule.name);
      rules.push(rule);
    }
  }

  const model: RuleModel = {
    files,
    rules,
    sticky: rules.filter((rule) => rule.sticky),
    rulebook: rules.filter((rule) => !rule.sticky),
    blockChars: 0,
  };
  model.block = composeRulesBlock(model, cwd);
  model.blockChars = model.block?.length ?? 0;
  return { model, imported: [...state.read] };
}

// ---------------------------------------------------------------------------
// mtime cache (ponytail's config precedent: one stat per call, re-parse only on
// change — so edits apply without /reload)
// ---------------------------------------------------------------------------

let cache: { key: string; tracked: Set<string>; sig: string; model: RuleModel } | null = null;

function signature(files: Iterable<string>): string {
  const parts: string[] = [];
  for (const file of files) {
    try {
      const stat = statSync(file);
      parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${file}:missing`);
    }
  }
  return parts.join("|");
}

/** Drop the mtime cache (`/rules reload`, tests). */
export function clearRuleCache(): void {
  cache = null;
}

export function loadRules(cwd = process.cwd(), userDir = defaultUserRulesDir(), trusted = true): RuleModel {
  const key = `${path.resolve(cwd)}\u0000${userDir}\u0000${trusted ? "t" : "u"}`;
  const files = discoverRuleFiles(cwd, userDir, trusted);
  // Track RULES.md files AND previously imported files, so editing an imported
  // doc invalidates the cache too.
  const tracked = new Set([...files, ...(cache?.tracked ?? [])]);
  const sig = signature(tracked);
  if (cache && cache.key === key && cache.sig === sig) return cache.model;

  const { model, imported } = buildModel(files, cwd);
  const nextTracked = new Set([...tracked, ...imported]);
  cache = { key, tracked: nextTracked, sig: signature(nextTracked), model };
  return model;
}

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

export function displayPath(file: string, cwd: string): string {
  const rel = path.relative(cwd, file);
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? file : rel;
}

function renderSticky(rules: LoadedRule[], cwd: string, cap = STICKY_CHAR_CAP): string {
  const parts: string[] = [];
  let used = 0;
  let dropped = 0;

  for (const rule of rules) {
    const part = `### ${rule.name} (${displayPath(rule.source, cwd)})\n${rule.body}\n`;
    if (used + part.length > cap) {
      if (used === 0) {
        // First rule alone blows the cap — truncate it rather than dump it all.
        parts.push(part.slice(0, Math.max(0, cap - 80)) + "\n[rule body truncated at the sticky cap]\n");
        used = cap;
      }
      dropped++;
      continue;
    }
    parts.push(part);
    used += part.length;
  }

  const marker = dropped > 0
    ? `⚠ STICKY RULES TRUNCATED — ${dropped} rule(s) omitted: the always-appended block exceeded ${cap} chars. Trim RULES.md, or move detail into rulebook rules (add a \`description:\` line so the body is served on demand by rule_get).`
    : "";
  return [parts.join("\n"), marker].filter((text) => text !== "").join("\n").trim();
}

/** The `<user-rules>` block, or undefined when no RULES.md exists anywhere. */
export function composeRulesBlock(model: RuleModel, cwd: string): string | undefined {
  if (model.rules.length === 0) return undefined;

  const sections: string[] = [];
  if (model.sticky.length > 0) {
    sections.push(`Sticky rules — ALWAYS in effect for this session:\n\n${renderSticky(model.sticky, cwd)}`);
  }
  if (model.rulebook.length > 0) {
    const lines = model.rulebook.map((rule) => `- ${rule.name}: ${rule.description}`).join("\n");
    sections.push(`Rulebook — read the full body with rule_get("<name>") before applying one (rule_get is deferred: if not yet declared, load it with one tool_search call for "rule_get"):\n${lines}`);
  }
  return `<user-rules>\n${sections.join("\n\n")}\n</user-rules>`;
}
