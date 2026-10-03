// ponytail: vendored from @bacnh85/pi-plan 0.16.6 (extensions/index.ts, command
// classification) — hardened against ~14 days of live false-block analysis, so
// keep the rules byte-faithful. Local changes: exported standalone functions,
// no plan/file state.
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
const S_COMMAND_FLAGS = /s([^\w\s])(?:\\.|(?!\1)[\s\S])*?\1(?:\\.|(?!\1)[\s\S])*?\1([a-z0-9]*)/gi;

function isSedReadOnly(inspection: string): boolean {
  if (/(?:^|\s)-[a-zA-Z]*[if][a-zA-Z]*\b|--in-place\b|--file\b/i.test(inspection)) return false;
  if (/(?<![A-Za-z])w|w(?![A-Za-z])/i.test(inspection)) return false;
  if (/(?:^|[^A-Za-z-])e(?:[\s;}]|$|['"])/i.test(inspection)) return false;
  for (const m of inspection.matchAll(S_COMMAND_FLAGS)) {
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
  if (/^(?:(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|install|truncate|dd|mktemp|command)|sudo|env|nohup|time)\b/i.test(inspection)) return "write";
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

/** Classify a full (possibly compound) command. Any known writer wins; the
 *  whole command is read only when every segment is read. */
export function classifyCommand(cmd: string): CommandDisposition {
  const c = cmd.trim();
  if (!c) return "confirm";
  // Redirections (stdout/stderr to files, here-docs) can create/modify files.
  // Discarding forms are read-safe: n>/dev/null, n>>/dev/null and fd dups
  // (2>&1, 2>&-). Command substitution and heredocs are always writes.
  const cNoDiscard = c.replace(/\d*>+\s*\/dev\/null(?![\w.\/-])|\d*>&[\d-]/g, "");
  if (/[<>]/.test(cNoDiscard) || /\$\(|`/.test(c) || /--output(?:=|\s)/i.test(c)) return "write";
  const segments = splitShellSegments(cNoDiscard);
  if (segments.length > 1) {
    if (segments.some((seg) => classifySegment(seg) === "write")) return "write";
    if (segments.every((seg) => classifySegment(seg) === "read")) return "read";
    return "confirm";
  }
  return classifySegment(c);
}
