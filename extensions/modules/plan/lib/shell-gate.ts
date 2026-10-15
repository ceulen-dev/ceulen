// ponytail: vendored from @bacnh85/pi-plan 0.16.6 (extensions/index.ts, command
// classification) — hardened against ~14 days of live false-block analysis, so
// keep the rules byte-faithful. Local changes: exported standalone functions,
// no plan/file state.
//
// 2026-10-15 rework (session-history evidence: 54 hard-blocked read-only
// commands over 2 weeks — see .pi/plans/2026-10-15T08-50-03-167Z*.md): the
// redirect/substitution pre-check became quote-aware; `$(…)`/`` `…` ``/
// `<(…)` substitutions classify their INNER command instead of blanket-write;
// heredocs feeding an interpreter drop from write to the confirm tier; bare
// `env` (no args) reads; sed's s-command flag scan no longer parses file
// PATHS as `s/pattern/repl/flags`. Deliberate deviations from upstream —
// keep them when re-vendoring.
//
// Classifies one shell command for plan mode WITHOUT attempting to interpret
// arbitrary executables:
//   read    — provably no filesystem writes → auto-run
//   write   — provably mutates → hard-block
//   confirm — unknown executable → approval prompt
import { execFile } from "node:child_process";

export type CommandDisposition = "read" | "write" | "confirm";

/** Split a shell command on separators (; & | and raw line breaks) that are OUTSIDE quotes. */
export function splitShellSegments(cmd: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (/[;&|\r\n]/.test(ch)) {
      if (cur.trim()) segments.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) segments.push(cur.trim());
  return segments;
}

// Read-only git subcommands auto-allowed in plan mode. Anything not matched here
// falls through to "write" (hard-blocked) — the conservative default.
const GIT_PREFIX = "^git\\s+(?:-C\\s+(?:\"[^\"]*\"|'[^']*'|\\S+)\\s+|-c\\s+\\S+=(?:\"[^\"]*\"|\\S+)\\s+|--no-pager\\s+)*";
const GIT_READ_ONLY = new RegExp(`${GIT_PREFIX}(?:status|rev-parse|diff|show|log|ls-files|ls-tree|ls-remote|cat-file|rev-list|shortlog|describe|for-each-ref|show-ref|symbolic-ref|name-rev|blame|annotate)\\b`, "i");
const GIT_BRANCH_READ_ONLY = new RegExp(`${GIT_PREFIX}branch\\s+(?:-[va]+|--(?:list|all|remote|merged|no-merged|contains|show-current))\\b`, "i");
const GIT_TAG_READ_ONLY = new RegExp(`${GIT_PREFIX}tag\\s+(?:--list\\b|-\\w*l\\b)`, "i");
const GIT_REMOTE_READ_ONLY = new RegExp(`${GIT_PREFIX}remote(?:\\s+(?:-[va]+|show\\b|get-url\\b)[^\\n]*)?$`, "i");
const GIT_CONFIG_READ_ONLY = new RegExp(`${GIT_PREFIX}config\\s+(?:--(?:get|get-regexp|get-all|list)|-l)\\b`, "i");
const GIT_REFLOG_READ_ONLY = new RegExp(`${GIT_PREFIX}reflog(?:\\s+show\\b.*)?$`, "i");
const GIT_EXTERNAL_DRIVER = /(?:\s--(?!no-)(?:ext-diff|textconv)\b)|(?:\s-c\s+["']?diff\.)/i;

// Patch-rendering subcommands run configured diff drivers (textconv is
// default-on for diff/show/log -p/blame when a repo .gitattributes names a
// driver the user's gitconfig defines). GIT_EXTERNAL_DRIVER catches only the
// flag-invited forms; when a driver is actually configured in this repo, these
// subcommands drop to the confirm tier unless the run explicitly disables the
// drivers. Probed once per session; empty in most repos → zero behavior change.
const GIT_PATCH_SUBCOMMANDS = /^(?:git\s+(?:-C\s+\S+\s+|-c\s+\S+=\S+\s+|--no-pager\s+)*)(?:diff|show|log|blame|annotate)\b/i;
const GIT_DRIVERS_DISABLED = /--(?:no-ext-diff|no-textconv)\b/i;
let repoHasDiffDriver = false;

export async function probeDiffDrivers(cwd: string): Promise<void> {
  repoHasDiffDriver = false;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("git", ["config", "--get-regexp", "\\.(textconv|driver)$"], { cwd }, (err, out) => (err ? reject(err) : resolve(String(out))));
    });
    repoHasDiffDriver = stdout.trim().length > 0;
  } catch { /* no driver configured (exit 1) or git unavailable */ }
}

function isGitReadOnly(inspection: string): boolean {
  // External diff/textconv drivers execute arbitrary commands (from user
  // gitconfig or injected via `-c diff.*=`); never auto-allow them as read.
  if (GIT_EXTERNAL_DRIVER.test(inspection)) return false;
  return GIT_READ_ONLY.test(inspection)
    || GIT_BRANCH_READ_ONLY.test(inspection)
    || GIT_TAG_READ_ONLY.test(inspection)
    || GIT_REMOTE_READ_ONLY.test(inspection)
    || GIT_CONFIG_READ_ONLY.test(inspection)
    || GIT_REFLOG_READ_ONLY.test(inspection);
}

function classifyGitSegment(inspection: string, gitEnvArmed: boolean): CommandDisposition {
  // GIT_* env assignments on a git command can arm GIT_EXTERNAL_DIFF, which
  // executes with NO flag. Other env prefixes stay read.
  if (gitEnvArmed) return "confirm";
  if (!GIT_DRIVERS_DISABLED.test(inspection) && repoHasDiffDriver && GIT_PATCH_SUBCOMMANDS.test(inspection)) {
    return "confirm";
  }
  return isGitReadOnly(inspection) ? "read" : "write";
}

// Env-assignment prefixes (`S=<file>; jq …`, `FOO=a BAR=b cmd`) set shell/env
// variables and write nothing — strip them and classify the real command.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|])*(?:\s+|$)/;

// Pure flow-control keywords carry no side effects; loop bodies still classify.
const FLOW_KEYWORD = /^(?:while|until|do|done)(?:\s+|$)/;

// sed read-only gate: `w` (file write), `e` (executes pattern space), -f
// (script file, uninspectable), -i (in-place) are the writers. Everything else
// is stdout-only.
// `s` must not follow a word char or `/` — `s/modules/plan/index` inside a
// PATH (`…/modules/plan/index.ts`, observed inside a substitution span) is
// not an s-command. Address forms (`2s/…`) missed here are backstopped by
// the standalone `w`-flag checks below.
const S_COMMAND_FLAGS = /(?<![\/\w])s([^\w\s])(?:\\.|(?!\1)[\s\S])*?\1(?:\\.|(?!\1)[\s\S])*?\1([a-z0-9]*)/gi;

/** Quoted spans of a command — sed script arguments in practice. The s-command
 *  flag scan runs over ONLY these: file path operands like
 *  `extensions/modules/plan/index.ts` must not be parsed as
 *  `s/modules/plan/index` (flags "index" contain `e` → false "not read-only",
 *  observed live: `sed -n '800,845p' …/plan/index.ts` blocked). */
function quotedSpans(cmd: string): string[] {
  const spans: string[] = [];
  let quote: "'" | '"' | null = null;
  let cur = "";
  for (const ch of cmd) {
    if (quote) {
      cur += ch;
      if (ch === quote) {
        spans.push(cur);
        cur = "";
        quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    }
  }
  return spans;
}

function isSedReadOnly(inspection: string): boolean {
  if (/(?:^|\s)-[a-zA-Z]*[if][a-zA-Z]*\b|--in-place\b|--file\b/i.test(inspection)) return false;
  // The w/e flag checks and the s-command scan apply to the SCRIPT (the
  // quoted arguments), never to file-path operands.
  const script = quotedSpans(inspection).join("\n") || inspection;
  // A runtime-computed script (`sed -n "$(grep …)p"`) is uninspectable —
  // its `w`/`e` flags are only known at execution. Same reasoning as the
  // heredoc rule: demote to confirm, never auto-read.
  if (/\$\(|`/.test(script)) return false;
  if (/(?<![A-Za-z])w|w(?![A-Za-z])/i.test(script)) return false;
  if (/(?:^|[^A-Za-z-])e(?:[\s;}]|$|['"])/i.test(script)) return false;
  for (const m of script.matchAll(S_COMMAND_FLAGS)) {
    if (/[ew]/i.test(m[2])) return false;
  }
  return true;
}

/** Strip xargs's own flags so the payload command can be classified.
 *  Deviation from upstream (pi-plan 0.16.6): only the long options that
 *  actually TAKE a value are stripped as `--opt value`; a valueless long
 *  option (`--null`) is stripped alone, so `xargs --null rm` yields `rm`
 *  (upstream ate the payload and classified the whole call as a read —
 *  silently auto-allowing a writer). */
const XARGS_LONG_VALUE = /^--(?:arg-file|delimiter|eof|max-args|max-chars|max-lines|max-procs|process-slot-var|replace)\s+(?:"[^"]*"|'[^']*'|\S+)\s*/i;

export function xargsPayload(inspection: string): string {
  let rest = inspection.replace(/^xargs\b/i, "").trim();
  for (;;) {
    const next = rest
      .replace(/^-[ILnPsaE]\s+(?:"[^"]*"|'[^']*'|\S+)\s*/i, "")
      .replace(XARGS_LONG_VALUE, "")
      .replace(/^--?[0-9A-Za-z?{}=]+\s*/, "")
      .replace(/^--[a-z-]+(?:=\S*)?\s*/i, "");
    if (next === rest) break;
    rest = next;
  }
  return rest.trim();
}

export function classifySegment(seg: string): CommandDisposition {
  let inspection = seg;
  let gitEnvArmed = false;
  for (;;) {
    const stripped = inspection.replace(ENV_ASSIGNMENT, "").replace(FLOW_KEYWORD, "");
    if (stripped === inspection) break;
    if (/^\s*GIT_[A-Z_]*=/.test(inspection)) gitEnvArmed = true;
    inspection = stripped;
  }
  inspection = inspection.replace(/^\S*\/(?=[^/\s]+(?:\s|$))/, "").trim();
  if (!inspection) return "read"; // bare env assignment — sets a variable, writes nothing
  if (/^git\s+/i.test(inspection)) {
    return classifyGitSegment(inspection, gitEnvArmed);
  }
  // xargs executes a payload command — classify the payload, not xargs itself.
  if (/^xargs\b/i.test(inspection)) {
    const payload = xargsPayload(inspection);
    if (!payload) return "read";
    return classifySegment(payload);
  }
  // command/type/which: only pure executable lookups are reads. POSIX `command NAME`
  // EXECUTES NAME, so bare `command` stays a writer wrapper; only `command -v/-V` is a lookup.
  if (/^(?:type|which)\b/i.test(inspection) || /^command\s+-[vV]\b/i.test(inspection)) return "read";
  // `env` is transparent: `env` alone (or piped — each pipe stage is its own
  // segment) PRINTS the environment; `env VAR=x cmd…` runs the remainder.
  // Observed live: `env | grep -i "PI_"` hard-blocked as a writer.
  if (/^env(?:\s|$)/i.test(inspection)) {
    const rest = inspection.replace(/^env\s*/i, "").trim();
    if (!rest) return "read";
    return classifySegment(rest);
  }
  if (/^(?:(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|install|truncate|dd|mktemp|command)|sudo|nohup|time)\b/i.test(inspection)) return "write";
  if (/^sed\b/i.test(inspection)) {
    if (/\s(?:-i\S*|--in-place(?:=\S*)?)(?:\s|$)/i.test(inspection) || /\b(?:\d+)?w\s+/i.test(inspection) || /\/w\s/i.test(inspection) || /(?:^|[^A-Za-z-])\d+w[a-zA-Z0-9.]/i.test(inspection)) return "write";
    return isSedReadOnly(inspection) ? "read" : "confirm";
  }
  if (/^tee\b/i.test(inspection)) return "write";
  // perl/ruby in-place edits are the `sed -i` equivalent.
  if (/^(?:\S+\/)?(?:perl|ruby)\b/i.test(inspection) && /(?:^|\s)-[a-zA-Z]*i[a-zA-Z]*(?:[.\w]+)?(?:\s|$)/i.test(inspection)) return "write";
  // tar: list (-t) and stdout-extract (-x…O) only read. Bare -x extracts to
  // the filesystem → confirm; writers (-c) → confirm.
  if (/^tar\b/i.test(inspection)) {
    if (/--to-command\b/i.test(inspection) || /--use-compress-program\b/i.test(inspection) || /(?:^|\s)-\S*I/i.test(inspection)) return "confirm";
    const letters = inspection.match(/^tar\s+(?:--\S+\s+)*-?([a-zA-Z]+)/i)?.[1]?.toLowerCase() ?? "";
    const toStdout = /(?:^|\s)-(?:o\b|--to-stdout\b)/i.test(inspection);
    if (letters.includes("t") || /--list\b/i.test(inspection) || (letters.includes("x") && (letters.includes("o") || toStdout))) return "read";
    return "confirm";
  }
  if (/^find\b/i.test(inspection) && /-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/i.test(inspection)) return "write";
  // Catch sort -o in any short-option form: standalone -o, combined -no/-on, and --output=.
  if (/^sort\b/i.test(inspection) && (/(?:^|\s)-[a-zA-Z]*o[a-zA-Z]*(?:\s|=|$)/i.test(inspection) || /--output(?:=|\s)/i.test(inspection))) return "write";
  // awk is a Turing-complete interpreter (system(), | getline, print>redirect) — never auto-allow.
  return /^(?:rg|grep|find|fd|ls|pwd|cat|head|tail|wc|sort|uniq|cut|echo|printf|jq|strings|stat|file|du|tree|lsof|basename|dirname|realpath|cd|read|diff|cmp)\b/i.test(inspection) ? "read" : "confirm";
}

/** Executing substitutions (`$(…)`, backticks, `<(…)`, `>(…)`) OUTSIDE single
 *  quotes (single-quoted text is literal — no substitution happens). Inner
 *  commands are classified recursively; a substitution is only as safe as
 *  what it runs. Nesting handled by depth; unclosed spans read to end. */
function findExecutingSubstitutions(cmd: string): string[] {
  const inners: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote && cmd[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    const opener = ch === "`" ? "`" : ch === "$" && cmd[i + 1] === "(" ? "$(" : (ch === "<" || ch === ">") && cmd[i + 1] === "(" ? ch + "(" : null;
    if (!opener) continue;
    // Walk to the matching close (paren depth, or the closing backtick),
    // single-quote-aware inside so `'` in the payload doesn't strand us.
    let depth = 1;
    let j = i + opener.length;
    let inner = "";
    let innerQuote: "'" | '"' | null = null;
    for (; j < cmd.length && depth > 0; j++) {
      const c = cmd[j];
      if (innerQuote) {
        if (c === innerQuote && cmd[j - 1] !== "\\") innerQuote = null;
      } else if (c === "'" || c === '"') {
        innerQuote = c;
      } else if (opener === "`") {
        if (c === "`") depth = 0;
      } else if (c === "(") depth++;
      else if (c === ")") depth--;
      inner += depth > 0 ? c : "";
    }
    inners.push(inner);
    i = j - 1;
  }
  return inners;
}

/** Disposition of every executing substitution in the command, or null when
 *  there are none. read only when EVERY inner command is read. */
function substitutionDisposition(cmd: string): CommandDisposition | null {
  const inners = findExecutingSubstitutions(cmd);
  if (inners.length === 0) return null;
  let worst: CommandDisposition = "read";
  for (const inner of inners) {
    const d = classifyCommand(inner);
    if (d === "write") return "write";
    if (d === "confirm") worst = "confirm";
  }
  return worst;
}

/** Classify a full (possibly compound) command. Any known writer wins; the
 *  whole command is read only when every segment is read, there is no
 *  file-writing redirection, and no substitution/heredoc demotes it. */
export function classifyCommand(cmd: string): CommandDisposition {
  const c = cmd.trim();
  if (!c) return "confirm";
  // File-writing redirections stay a hard write — but only REAL ones:
  // quote-aware, so `<`/`>` inside quoted strings (jq `select(.x > "1")`
  // programs, `grep -oE "[^<]"` patterns — the two biggest live false-block
  // classes) are data, not redirects. Discarding forms stay read-safe:
  // n>/dev/null and fd dups (2>&1, 2>&-).
  let quote: "'" | '"' | null = null;
  let heredocMark = false;
  let inputRedirect = false; // unquoted `<` file/process input — demotes read
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (quote) {
      if (ch === quote && c[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "<" || ch === ">") {
      const run = c.slice(i).match(/^[<>]+/)?.[0] ?? "";
      const rest = c.slice(i + run.length);
      if (ch === ">") {
        // Writers: `>`/`>>` to a file. Read-safe: n>/dev/null, 2>&1, 2>&-.
        if (/^\s*\/dev\/null(?![\w.\/-])/.test(rest) || /^\s*&[\d-]/.test(rest)) {
          i += run.length + (rest.match(/^\s*\S+/)?.[0].length ?? 0);
          continue;
        }
        return "write";
      }
      if (run.length >= 2) {
        heredocMark = true; // `<<`/`<<-` heredoc marker
        i += run.length - 1;
        continue;
      }
      inputRedirect = true; // `<` file input or `<(…)`, `>(…)` — executes/reads, demotes
    }
  }
  const sub = substitutionDisposition(c);
  if (sub === "write") return "write";
  // `sort --output` — the one flag-form file writer checked pre-split.
  if (/--output(?:=|\s)/i.test(c)) return "write";
  // Strip discard redirects before segmenting: `2>&1`'s `&` is an fd dup,
  // NOT a background separator (splitting on it yields a phantom "1"
  // segment that classifies confirm). The write-scan above already ran.
  const segments = splitShellSegments(c.replace(/\d*>+\s*\/dev\/null(?![\w.\/-])|\d*>&[\d-]/g, ""));
  if (segments.length > 1) {
    if (segments.some((seg) => classifySegment(seg) === "write")) return "write";
    if (segments.every((seg) => classifySegment(seg) === "read")) {
      if (sub === "confirm" || heredocMark || inputRedirect) return "confirm";
      return "read";
    }
    return "confirm";
  }
  const single = classifySegment(c);
  if (single === "read" && (sub === "confirm" || heredocMark || inputRedirect)) return "confirm";
  return single;
}
