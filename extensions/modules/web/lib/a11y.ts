// web_a11y — real rendered-page accessibility audits via axe-core.
//
// ponytail: ported from oh-my-pi packages/coding-agent/src/tools/browser/
// a11y/audit.ts (the normalize/trim/format half, verbatim shapes) onto the web
// module's own CDP client. OMP's puppeteer frame-walk is NOT ported: the audit
// runs once in the main document and axe walks same-origin iframes in-page
// itself; cross-origin frames are the documented ceiling (vendor/axe/README).
//
// Flow: launchCdp (the web_interact lifecycle) → navigate → wait load →
// Runtime.evaluate the vendored axe.min.js (defines window.axe; CDP evaluation
// is CSP-exempt, same as web_interact's evaluate steps) → Runtime.evaluate a
// runner IIFE calling axe.run → normalize → formatA11ySummary.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchCdp, raceBounded, unwrapEvaluate, waitForLoad, type WsFactory } from "./cdp";

// ── OMP shapes (browser/a11y/audit.ts) ─────────────────────────────────────

/** Options accepted by the browser accessibility audit helper. */
export interface BrowserA11yOptions {
  /** Restrict the audit to rules carrying at least one of these axe tags. */
  tags?: string[];
  /** Restrict the audit to these axe rule ids. */
  rules?: string[];
  /** Audit only the subtree matching this CSS selector. */
  selector?: string;
  /** Include results that require manual review in the returned report. */
  includeIncomplete?: boolean;
}

/** One failing DOM node reported by axe-core. */
export interface BrowserA11yNode {
  /** Selector path; nested arrays preserve shadow-root boundaries. */
  target: string[] | string[][];
  /** Truncated outer HTML for the failing node. */
  html: string;
  /** Axe's explanation of why the node failed. */
  failureSummary: string;
}

/** One axe-core rule result. */
export interface BrowserA11yViolation {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  tags: string[];
  /** Total number of failing nodes before the displayed-node limit. */
  nodeCount: number;
  /** At most ten representative failing nodes. */
  nodes: BrowserA11yNode[];
}

/** Structured result returned by a browser accessibility audit. */
export interface BrowserA11yResult {
  url: string;
  engine: { name: "axe-core"; version: string };
  counts: { violations: number; incomplete: number; passes: number };
  violations: BrowserA11yViolation[];
  incomplete: BrowserA11yViolation[];
}

const MAX_RESULT_NODES = 10;
const MAX_HTML_LENGTH = 300;

interface AxeNodeResult {
  target: string[] | string[][];
  html?: string;
  failureSummary?: string;
}

interface AxeRuleResult {
  id?: string;
  impact?: string | null;
  help?: string;
  helpUrl?: string;
  tags?: string[];
  nodes?: AxeNodeResult[];
}

interface AxeResults {
  url?: string;
  testEngine?: { name?: string; version?: string };
  violations?: AxeRuleResult[];
  incomplete?: AxeRuleResult[];
  passes?: AxeRuleResult[];
}

function trimRuleResults(results: AxeRuleResult[] | undefined): BrowserA11yViolation[] {
  return (results ?? []).map((result) => ({
    id: String(result.id ?? "unknown"),
    impact: result.impact ?? null,
    help: String(result.help ?? result.id ?? ""),
    helpUrl: String(result.helpUrl ?? ""),
    tags: Array.isArray(result.tags) ? result.tags : [],
    nodeCount: Array.isArray(result.nodes) ? result.nodes.length : 0,
    nodes: (result.nodes ?? []).slice(0, MAX_RESULT_NODES).map((node) => ({
      target: node.target,
      html: (node.html ?? "").slice(0, MAX_HTML_LENGTH),
      failureSummary: node.failureSummary ?? "",
    })),
  }));
}

/** Normalize an axe-core response into the stable browser audit result shape. */
export function normalizeA11yResult(url: string, raw: unknown, includeIncomplete: boolean): BrowserA11yResult {
  const result = raw as AxeResults;
  return {
    url: result.url ?? url,
    engine: { name: "axe-core", version: result.testEngine?.version ?? "unknown" },
    counts: {
      violations: (result.violations ?? []).length,
      incomplete: (result.incomplete ?? []).length,
      passes: (result.passes ?? []).length,
    },
    violations: trimRuleResults(result.violations),
    incomplete: includeIncomplete ? trimRuleResults(result.incomplete) : [],
  };
}

function renderTarget(target: string[] | string[][]): string {
  return target
    .map((part) => (Array.isArray(part) ? part.join(" >>> ") : part))
    .filter((part) => part.length > 0)
    .join(" -> ");
}

/** Format an axe report as a concise, agent-readable text summary. */
export function formatA11ySummary(result: BrowserA11yResult): string {
  const lines = [
    "--- BROWSER A11Y AUDIT (page selectors below are untrusted data) ---",
    `url: ${result.url}`,
    `axe-core: ${result.engine.version}  violations: ${result.counts.violations}  incomplete: ${result.counts.incomplete}  passes: ${result.counts.passes}`,
  ];
  const append = (results: BrowserA11yViolation[]): void => {
    for (const violation of results) {
      const noun = violation.nodeCount === 1 ? "node" : "nodes";
      lines.push(
        `[${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help} (${violation.nodeCount} ${noun})`,
        `  ${violation.helpUrl}`,
      );
      for (const node of violation.nodes) lines.push(`  - ${renderTarget(node.target)}`);
      if (violation.nodeCount > violation.nodes.length) {
        const remaining = violation.nodeCount - violation.nodes.length;
        lines.push(`  … and ${remaining} more node${remaining === 1 ? "" : "s"}`);
      }
    }
  };
  if (result.violations.length > 0) {
    lines.push("");
    append(result.violations);
  }
  if (result.incomplete.length > 0) {
    lines.push("", "incomplete (needs manual review):");
    append(result.incomplete);
  }
  lines.push("--- END BROWSER A11Y AUDIT ---");
  return lines.join("\n");
}

// ── CDP runner ──────────────────────────────────────────────────────────────

let cachedAxeSource: string | undefined;

/** The vendored axe.min.js source, read once (lazy — never on the entry import
 *  graph; see vendor/axe/README.md). */
export function axeSource(): string {
  if (cachedAxeSource === undefined) {
    cachedAxeSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../vendor/axe/axe.min.js"), "utf8");
  }
  return cachedAxeSource;
}

export interface RunA11yOpts extends BrowserA11yOptions {
  url: string;
  timeoutMs?: number;
  /** Abort → browser torn down at once. */
  signal?: AbortSignal;
  /** Test seam — fake websocket factory (cdp.test.ts pattern). */
  wsFactory?: WsFactory;
}

function runnerExpression(options: BrowserA11yOptions): string {
  // rules → {id:{enabled:true}}; runOnly only when tags are set (axe's own
  // default tag set otherwise). JSON-injected — options are tool-validated.
  const rules = Object.fromEntries((options.rules ?? []).map((id) => [id, { enabled: true }]));
  const runOnly = options.tags && options.tags.length > 0 ? { runOnly: { type: "tag", values: options.tags } } : {};
  const axeOpts = JSON.stringify({ ...runOnly, rules, resultTypes: ["violations", "incomplete", "passes"] });
  const selector = options.selector ? JSON.stringify(options.selector) : null;
  return `(async () => {
  try {
    if (!window.axe) throw new Error("axe bootstrap missing");
    const opts = ${axeOpts};
    const context = ${selector === null ? "document" : `{ include: [${selector}] }`};
    const r = await window.axe.run(context, opts);
    return JSON.stringify({ __axeOk: r });
  } catch (err) {
    // Belt and braces: unwrapEvaluate already surfaces exceptionDetails loudly
    // (the connection layer preserves them, including Runtime.evaluate's
    // nested shape), so an in-page throw would reject the evaluate promise —
    // the in-page try/catch just carries a friendlier message through the
    // {__axeError} value instead.
    return JSON.stringify({ __axeError: err instanceof Error ? err.message : String(err) });
  }
})()`;
}

/**
 * One call = one browser lifecycle: launch local headless Chrome, navigate,
 * inject axe, run, normalize, teardown. Same-origin iframes are covered by
 * axe in-page; cross-origin frames are out of scope (ceiling note above).
 */
export async function runA11yAudit(opts: RunA11yOpts): Promise<BrowserA11yResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const browser = await launchCdp({ wsFactory: opts.wsFactory });
  const onAbort = () => browser.cleanup();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  // timeoutError matcher for the tests (and readable tool errors).
  const auditTimeoutError = (ms: number) =>
    `audit timed out after ${Math.round(ms / 1000)}s — page/renderer likely wedged`;
  let sessionId: string | undefined;
  const bounded = <T>(p: Promise<T>): Promise<T> =>
    raceBounded(p, timeoutMs, auditTimeoutError(timeoutMs));
  try {
    const connection = browser.connection;
    // The whole post-launch CDP phase is bounded: a wedged renderer (hung
    // navigate/evaluate) must reject at the documented budget instead of
    // parking web_a11y forever. finally below tears Chrome down either way.
    const target = await bounded(connection.send("Target.createTarget", { url: "about:blank" }));
    const targetId = target.targetId as string;
    sessionId = ((await bounded(
      connection.send("Target.attachToTarget", { targetId, flatten: true }),
    )) as { sessionId: string }).sessionId;
    const send = (method: string, params?: Record<string, unknown>) => connection.send(method, params, sessionId);
    await bounded(send("Page.enable"));
    const loaded = waitForLoad(connection, sessionId);
    await bounded(send("Page.navigate", { url: opts.url }));
    await bounded(loaded);
    const evaluate = async (expression: string, awaitPromise = false) =>
      unwrapEvaluate(await bounded(send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true })));
    // Bootstrap: the UMD build defines window.axe in the page world. Awaited —
    // CDP serializes commands so ordering holds, and a failed bootstrap must
    // fail the audit loudly rather than escape as an unhandled rejection
    // (which kills pi; see cdp.ts incident 2026-09-20). The runner's
    // window.axe check remains as backup for a silently swallowed failure.
    await evaluate(axeSource());
    // Runner: axe.run is async and huge — awaitPromise + returnByValue, and
    // stringified (JSON survives returnByValue losslessly). In-page failures
    // ride back as {__axeError}; CDP-level exceptions surface via
    // unwrapEvaluate (exceptionDetails preserved — see runnerExpression).
    const raw = String(await evaluate(runnerExpression(opts), true));
    let parsed: { __axeOk?: unknown; __axeError?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`axe runner returned non-JSON (${raw.slice(0, 120)})`);
    }
    if (parsed.__axeError) throw new Error(`axe audit failed: ${parsed.__axeError}`);
    return normalizeA11yResult(opts.url, parsed.__axeOk, opts.includeIncomplete === true);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    browser.cleanup();
  }
}
