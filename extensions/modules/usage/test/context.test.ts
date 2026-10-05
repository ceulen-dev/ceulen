import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCtxLegend,
  computeContextBreakdown,
  shortSource,
  formatCtxTokens,
  formatCtxPercent,
  planCtxCells,
  CTX_GRID_COLS,
  CTX_GRID_ROWS,
  renderContextPanel,
  resolveReserveTokens,
  type ContextBreakdownInput,
} from "../index.ts";

/** OMP messages glyph (⛃) — kept here so the assertion reads cleanly. */
const WAFFLE_MESSAGES_GLYPH = "⛃";

/** Fixture ctx with a structured system-prompt system message + tools. */
function fixtureCtx(overrides: Partial<ContextBreakdownInput["ctx"]> = {}): ContextBreakdownInput["ctx"] {
  const systemSections: Record<string, string | null> = {
    preamble: "p".repeat(400), // 100 tokens
    project_context: "m".repeat(8000), // 2000 tokens
    skills: "<skill><name>a</name></skill>\n<skill><name>b</name></skill>" + "s".repeat(800), // ~204 tokens, 2 skills
    rules: null, // removed section — must be skipped
  };
  const tools = [
    { name: "read", description: "d".repeat(400), parameters: { type: "object" }, sourceInfo: { source: "pi" } },
    { name: "web_search", description: "d".repeat(800), parameters: { type: "object", properties: { q: {} } }, sourceInfo: { source: "@bacnh85/pi-web" } },
    { name: "web_extract", description: "d".repeat(800), parameters: {}, sourceInfo: { source: "@bacnh85/pi-web" } },
  ];
  const messages: Array<Record<string, unknown>> = [
    { role: "system", sections: systemSections },
    { role: "user", content: "u".repeat(200) }, // 50 tokens
    { role: "assistant", content: [{ type: "text", text: "a".repeat(400) }] }, // 100 tokens
  ];
  return {
    getContextUsage: () => ({ tokens: 5000, contextWindow: 200000, percent: 2.5 }),
    getSystemPrompt: () => "x".repeat(40000),
    getAllTools: () => tools as never,
    getActiveTools: () => ["read", "web_search"],
    sessionManager: { buildSessionProjection: () => ({ messages }) as never },
    ...overrides,
  };
}

function fixtureInput(overrides: Partial<ContextBreakdownInput> = {}): ContextBreakdownInput {
  const ctx = fixtureCtx();
  const { getAllTools, getActiveTools, ...rest } = ctx as Record<string, unknown>;
  return {
    ctx: rest as unknown as ContextBreakdownInput["ctx"],
    allTools: (getAllTools as () => unknown[])(),
    activeTools: (getActiveTools as () => string[])(),
    ...overrides,
  } as unknown as ContextBreakdownInput;
}

test("formatCtxTokens compact formatting", () => {
  assert.equal(formatCtxTokens(999), "999");
  assert.equal(formatCtxTokens(5340), "5.3K");
  assert.equal(formatCtxTokens(21450), "21K");
  assert.equal(formatCtxTokens(157000), "157K");
  assert.equal(formatCtxTokens(1048576), "1m");
  assert.equal(formatCtxTokens(200000), "200K");
});

test("formatCtxPercent slivers and normal cases", () => {
  assert.equal(formatCtxPercent(328, 1048576), "<0.1%");
  assert.equal(formatCtxPercent(21450, 1048576), "2.0%");
  assert.equal(formatCtxPercent(157000, 1048576), "15.0%");
  assert.equal(formatCtxPercent(500, 0), "?");
});

test("planCtxCells paints OMP's 20x10 grid with per-category colors", () => {
  const b = computeContextBreakdown(fixtureInput());
  const cells = planCtxCells(b.categories, b.contextWindow);
  assert.equal(cells.length, CTX_GRID_COLS * CTX_GRID_ROWS, "exactly 200 cells");
  // Category color map (OMP's): prompt accent, tools warning, context
  // customMessageLabel, skills success, messages userMessageText, free dim,
  // buffer warning.
  const byColor = new Map<string, number>();
  for (const c of cells) byColor.set(c.color, (byColor.get(c.color) ?? 0) + 1);
  assert.ok((byColor.get("accent") ?? 0) >= 1, "system prompt painted accent");
  assert.ok((byColor.get("warning") ?? 0) >= 2, "tools + buffer painted warning");
  assert.ok((byColor.get("success") ?? 0) >= 1, "skills painted success");
  assert.ok((byColor.get("userMessageText") ?? 0) >= 1, "messages painted userMessageText");
  assert.ok((byColor.get("customMessageLabel") ?? 0) >= 1, "system context painted customMessageLabel");
  assert.ok((byColor.get("dim") ?? 0) > 100, "most of a 2.5%-used window is free (dim)");
  // Glyphs follow the map: buffer hatches the tail, free fills the rest.
  assert.equal(cells.at(-1)!.glyph, "⛝", "autocompact buffer is the final slice");
  assert.ok(cells.some((c) => c.color === "dim" && c.glyph === "⛶"), "free cells render ⛶ dim");
});

test("planCtxCells allocation: min one cell, exact fill, disabled compaction has no buffer", () => {
  // A tiny nonzero category keeps one visible cell; zero categories get none.
  const tiny = planCtxCells(
    [
      { label: "Skills", tokens: 10 },
      { label: "Messages", tokens: 0 },
      { label: "Free space", tokens: 99990 },
    ],
    100000,
  );
  assert.equal(tiny.filter((c) => c.color === "success").length, 1, "tiny nonzero slice keeps one cell");
  assert.equal(tiny.filter((c) => c.color === "userMessageText").length, 0, "zero slice renders no cells");
  assert.equal(tiny.length, 200);

  // Disabled compaction: no buffer category → no hatch cells anywhere.
  const b = computeContextBreakdown(fixtureInput({ settings: { compaction: { enabled: false } } }));
  const noBuffer = planCtxCells(b.categories, b.contextWindow);
  assert.ok(noBuffer.every((c) => c.glyph !== "⛝"), "no buffer cells when compaction is off");

  // Unknown window → all free.
  const unknown = planCtxCells([{ label: "Skills", tokens: 5 }], 0);
  assert.ok(unknown.every((c) => c.glyph === "⛶" && c.color === "dim"));
});

test("planCtxCells overflow trims largest-first and still fills the canvas", () => {
  // Categories summing far beyond the window: trim keeps every slice ≥1 cell
  // and the grid exactly full (no phantom overflow rows).
  const cells = planCtxCells(
    [
      { label: "System prompt", tokens: 5000 },
      { label: "System tools", tokens: 5000 },
      { label: "Messages", tokens: 5000 },
      { label: "Free space", tokens: 5000 },
    ],
    4000,
  );
  assert.equal(cells.length, 200);
  const counts = new Map<string, number>();
  for (const c of cells) counts.set(c.color, (counts.get(c.color) ?? 0) + 1);
  assert.ok((counts.get("accent") ?? 0) >= 1 && (counts.get("warning") ?? 0) >= 1 && (counts.get("userMessageText") ?? 0) >= 1, "each filled category keeps ≥1 cell after trim");
});

test("resolveReserveTokens mirrors pi's resolution order", () => {
  // default when nothing configured / settings unreadable
  assert.equal(resolveReserveTokens(undefined), 16384);
  assert.equal(resolveReserveTokens({}), 16384);
  // ordinary compaction.reserveTokens
  assert.equal(resolveReserveTokens({ compaction: { reserveTokens: 50000 } }), 50000);
  // per-model override wins over the ordinary value
  assert.equal(
    resolveReserveTokens(
      { compaction: { reserveTokens: 50000, modelOverrides: { "zai/glm-5.3": { reserveTokens: 100000 } } } },
      { provider: "zai", id: "glm-5.3" },
    ),
    100000,
  );
  // invalid values fall back to the default (mirrors pi's validation skip)
  assert.equal(resolveReserveTokens({ compaction: { reserveTokens: -5 } }), 16384);
  assert.equal(resolveReserveTokens({ compaction: { reserveTokens: "big" } }), 16384);
});

test("computeContextBreakdown splits sections, groups tools by source, reserves budget", () => {
  const b = computeContextBreakdown(fixtureInput({ model: { maxTokens: 8192, contextWindow: 200000 } }));
  // System prompt: sections only (blob fallback NOT used), null section skipped.
  // skills string = 59 chars of tags + 800 filler = 859 → 215 tokens.
  assert.equal(b.systemPrompt.total, 100 + 2000 + 215);
  assert.equal(b.systemPrompt.sections.preamble, 100);
  assert.equal(b.systemPrompt.sections.project_context, 2000);
  assert.equal(b.systemPrompt.sections.rules, undefined);
  // Tools: (400 + ~22)/4=106, (800 + ~43)/4=211, 800/4=200 → grouped by source.
  assert.equal(b.tools.registeredCount, 3);
  assert.equal(b.tools.activeCount, 2);
  assert.equal(b.tools.bySource["@bacnh85/pi-web"].count, 2);
  assert.equal(b.tools.bySource.pi.count, 1);
  assert.equal(b.tools.total, b.tools.bySource.pi.tokens + b.tools.bySource["@bacnh85/pi-web"].tokens);
  // Skills parsed from the skills section.
  assert.equal(b.skills.count, 2);
  assert.ok(b.skills.total > 0 && b.skills.total < 300);
  // Memory files: project_context (+ addendum when present).
  assert.equal(b.memoryFiles.total, 2000);
  assert.deepEqual(b.memoryFiles.files.map((f) => f.name), ["project_context"]);
  // Messages: user + assistant, system excluded (counted as systemPrompt).
  assert.equal(b.messages.count, 2);
  assert.equal(b.messages.total, 50 + 100);
  // Per-tool costs, descending (powers the top-tools list).
  assert.deepEqual(b.toolCosts.map((t) => t.name), ["web_search", "web_extract", "read"]);
  // Reserved is the compaction slice only; free space excludes it (pi's trigger:
  // tokens > window - reserveTokens). Model output is NOT reserved.
  assert.deepEqual(b.reserved, { compaction: 16384 });
  assert.equal(b.compactionDisabled, false);
  assert.equal(b.freeSpace, 200000 - 5000 - 16384);
  // Slices are disjoint and account for the window.
  assert.equal(5000 + b.reserved.compaction + b.freeSpace, 200000);
  // Authoritative usage rides through.
  assert.equal(b.usedTokens, 5000);
  assert.equal(b.percent, 2.5);
  assert.equal(b.contextWindow, 200000);
});

test("computeContextBreakdown honors configured reserve and compaction-disabled", () => {
  const configured = computeContextBreakdown(fixtureInput({
    model: { provider: "zai", id: "glm-5.3", maxTokens: 8192, contextWindow: 200000 },
    settings: { compaction: { reserveTokens: 60000, modelOverrides: { "zai/glm-5.3": { reserveTokens: 90000 } } } },
  }));
  assert.equal(configured.reserved.compaction, 90000);
  assert.equal(configured.freeSpace, 200000 - 5000 - 90000);

  const disabled = computeContextBreakdown(fixtureInput({ settings: { compaction: { enabled: false } } }));
  assert.equal(disabled.compactionDisabled, true);
  assert.equal(disabled.freeSpace, 200000 - 5000); // no reserve withheld
});

test("computeContextBreakdown falls back to whole-prompt blob before sections exist", () => {
  const ctx = fixtureCtx();
  ctx.sessionManager.buildSessionProjection = () => ({ messages: [{ role: "user", content: "hi" }] }) as never;
  const b = computeContextBreakdown(fixtureInput({ ctx }));
  assert.equal(b.systemPrompt.total, 10000); // 40000 chars / 4
  assert.equal(b.systemPrompt.sections.skills, undefined);
  assert.equal(b.skills.total, 0);
});

test("computeContextBreakdown tolerates a throwing projection and missing usage", () => {
  const ctx = fixtureCtx({
    // Real after-compaction shape: contextWindow known, tokens null.
    getContextUsage: () => ({ tokens: null, contextWindow: 200000, percent: null }),
  });
  ctx.sessionManager.buildSessionProjection = () => { throw new Error("no session"); };
  const b = computeContextBreakdown(fixtureInput({ ctx }));
  assert.equal(b.usedTokens, null);
  assert.equal(b.percent, null);
  assert.equal(b.systemPrompt.total, 10000);
  // Fallback used-tokens path: system + tools + messages, no throw.
  const lines = renderContextPanel(b);
  assert.ok(lines.some((l) => l.includes("Category splits are estimates")), lines.join("\n"));
  assert.equal(b.freeSpace, Math.max(0, 200000 - (10000 + b.tools.total) - 16384));
});

test("renderContextPanel lays the legend beside a 20x10 grid (OMP geometry)", () => {
  const b = computeContextBreakdown(fixtureInput({ model: { provider: "zai", id: "glm-5.3", name: "GLM-5.3", maxTokens: 8192, contextWindow: 200000 } }));
  const lines = renderContextPanel(b);
  assert.equal(lines[0], "Context Usage");
  // Grid body: 10 rows of 20 space-joined cells, gutter, legend text.
  const gridRows = lines.filter((l) => l.split(" ").length >= 20 && /^⛁|^⛶/.test(l));
  assert.equal(gridRows.length, CTX_GRID_ROWS, "ten grid rows");
  const first = lines.find((l) => l.includes("GLM-5.3")) ?? lines[3];
  const gridPart = first.split("   ")[0];
  assert.equal(gridPart.split(" ").filter(Boolean).length, CTX_GRID_COLS, "20 cells per row");
  // Legend header rows ride beside the grid.
  assert.ok(lines.some((l) => l.includes("GLM-5.3") && l.includes("200K context")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("[200K]")), "bracketed model id row");
  assert.ok(lines.some((l) => l.includes("5.0K/200K tokens (2.5%)")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("Estimated usage by category")));
  // Category legend lines: glyph + label + tokens + pct, one per category.
  assert.ok(lines.some((l) => l.includes("⛁ System prompt:")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("⛁ System tools:")));
  assert.ok(lines.some((l) => l.includes("⛁ System context:")));
  assert.ok(lines.some((l) => l.includes("⛁ Skills:")));
  assert.ok(lines.some((l) => l.includes("⛃ Messages:")));
  assert.ok(lines.some((l) => l.includes("⛶ Free space:")));
  assert.ok(lines.some((l) => l.includes("⛝ Autocompact buffer:")));
  // Gutter alignment: legend lines start after the 39-char grid + 3-space gutter.
  const cat = lines.find((l) => l.includes("⛁ System prompt:"))!;
  assert.ok(/^[⛁⛶⛝ ]+   ⛁ System prompt:/.test(cat), cat);
});

test("renderContextPanel fires recommendations above thresholds", () => {
  // Tiny-ish window so the 516-token tool fixture crosses the 40% recommendation threshold.
  const b = computeContextBreakdown(fixtureInput({ ctx: fixtureCtx(), model: { maxTokens: 8192, contextWindow: 1200 } }));
  const lines = renderContextPanel(b);
  assert.ok(lines.some((l) => l.includes("5.0K/1.2K tokens (416.7%)")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("pi-web:")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("@bacnh85/")), "package labels are shortened");
  assert.ok(lines.some((l) => l.includes("project_context: 2.0K")));
  // tools (516) > 40% of the 1200-token window → recommendation fires.
  assert.ok(lines.some((l) => l.startsWith("- ") && l.includes("setActiveTools")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("trimming AGENTS.md")));
});

test("renderContextPanel fires memory + skills recommendations above thresholds", () => {
  const ctx = fixtureCtx();
  const big = "m".repeat(4 * 4000); // 4000 tokens
  (ctx.sessionManager.buildSessionProjection().messages[0] as Record<string, unknown>).sections = {
    project_context: big,
    skills: "<skill><name>a</name></skill>" + "s".repeat(4 * 2500),
  };
  const b = computeContextBreakdown(fixtureInput({ ctx }));
  const lines = renderContextPanel(b);
  assert.ok(lines.some((l) => l.includes("trimming AGENTS.md")));
  assert.ok(lines.some((l) => l.includes("disable-model-invocation")));
});

test("buildCtxLegend mirrors OMP's run structure and colors", () => {
  const b = computeContextBreakdown(fixtureInput({ model: { provider: "zai", id: "glm-5.3-flash", name: "GLM-5.3 Flash", maxTokens: 8192, contextWindow: 1_000_000 } }));
  const legend = buildCtxLegend(b);
  // Line 1: model name strong + window dim. Line 2: bare id[window] muted.
  assert.deepEqual(legend[0], [
    { t: "GLM-5.3 Flash", s: "strong" },
    { t: " (1m context)", s: "dim" },
  ]);
  assert.deepEqual(legend[1], [{ t: "glm-5.3-flash[1m]", s: "muted" }]);
  // Line 3: used strong, window dim, pct muted.
  assert.deepEqual(legend[2], [
    { t: "5.0K", s: "strong" },
    { t: "/1m tokens", s: "dim" },
    { t: " (0.5%)", s: "muted" },
  ]);
  assert.deepEqual(legend[3], []);
  assert.deepEqual(legend[4], [{ t: "Estimated usage by category", s: "muted" }]);
  // Category lines: colored glyph, strong tokens, dim pct.
  const prompt = legend.find((l) => l.some((p) => p.t === " System prompt: "))!;
  assert.equal(prompt[0].s, "accent");
  assert.ok(prompt.some((p) => p.s === "strong"), "token count is bold");
  const msgs = legend.find((l) => l.some((p) => p.t.includes("Messages")) && l.some((p) => p.t === WAFFLE_MESSAGES_GLYPH));
  assert.equal(msgs?.[0].s, "userMessageText");
  // No model → no header rows, legend still renders.
  const bare = buildCtxLegend({ ...b, modelName: undefined, modelLabel: undefined });
  assert.ok(bare[0].some((p) => p.t.includes("tokens")), "first line is the totals without a model");
});

test("categories are disjoint, reconcile with usage, and partition the window", () => {
  const b = computeContextBreakdown(fixtureInput());
  const core = b.categories.find((c) => c.label === "System prompt")!.tokens;
  const context = b.categories.find((c) => c.label === "System context")!.tokens;
  const skills = b.categories.find((c) => c.label === "Skills")!.tokens;
  // No double-counting: core + context + skills reconstruct the system prompt.
  assert.equal(core + context + skills, b.systemPrompt.total);
  // The buffer is a fixed reserve — estimation drift must never inflate it.
  assert.equal(b.categories.find((c) => c.label === "Autocompact buffer")?.tokens, 16384);
  // Whatever the drift sign, the slices always add up to the whole window.
  assert.equal(b.categories.reduce((a, c) => a + c.tokens, 0), b.contextWindow);
});

test("Messages is a residual so no row exceeds the headline total", () => {
  // Authoritative total far above the prompt-side estimates → the difference is
  // real transcript weight and lands on Messages (the residual row).
  const high = computeContextBreakdown(fixtureInput({ ctx: fixtureCtx({ getContextUsage: () => ({ tokens: 60000, contextWindow: 200000, percent: 30 }) }) }));
  const msgsHigh = high.categories.find((c) => c.label === "Messages")!.tokens;
  assert.ok(msgsHigh > 0, "residual messages weight is reported");
  assert.ok(high.categories.every((c) => c.tokens <= high.contextWindow), "no row exceeds the window");
  assert.ok(high.usedTokens! >= msgsHigh, "Messages never exceeds the measured total");
  assert.equal(high.categories.reduce((a, c) => a + c.tokens, 0), 200000, "rows partition the window");

  // Estimates ABOVE the measured total (chars/4 over-counts thinking blocks):
  // the prompt rows stay as measured, Messages floors at 0, no phantom row.
  const low = computeContextBreakdown(fixtureInput({ ctx: fixtureCtx({ getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }) }) }));
  assert.equal(low.categories.find((c) => c.label === "Messages")!.tokens, 0, "residual floors at zero");
  assert.equal(low.categories.reduce((a, c) => a + c.tokens, 0), 200000);
  assert.ok(low.categories.every((c) => c.tokens <= 200000));

  // A stale figure above the window cannot make the partition over-sum.
  const over = computeContextBreakdown(fixtureInput({ ctx: fixtureCtx({ getContextUsage: () => ({ tokens: 999999, contextWindow: 200000, percent: 500 }) }) }));
  assert.equal(over.categories.reduce((a, c) => a + c.tokens, 0), 200000);
});

test("/context handler posts v2 grid+legend; renderer paints live theme; legacy lines still render", async () => {
  const { default: extension } = await import("../index.ts");
  const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
  const renderers: Record<string, (m: unknown, o: unknown, t: unknown) => { render(w: number): string[] } | undefined> = {};
  type SentMsg = { customType: string; content: string; display?: boolean; details?: { grid?: unknown[][]; legend?: unknown[][]; lines?: string[] } };
  const sent: SentMsg[] = [];
  const fakePi = {
    on: () => {},
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands[name] = def; },
    registerTool: () => {},
    registerMessageRenderer: (type: string, renderer: never) => { renderers[type] = renderer; },
    sendMessage: (msg: SentMsg) => { sent.push(msg); },
    getAllTools: () => (fixtureCtx() as never as { getAllTools(): unknown[] }).getAllTools(),
    getActiveTools: () => ["read", "web_search"],
  };
  (extension as unknown as (pi: unknown) => void)(fakePi);
  const handler = commands.context?.handler;
  assert.ok(handler, "/context registered");
  assert.ok(renderers["ceulen-usage-context"], "transcript renderer registered");

  const mkCtx = () => ({
    mode: "tui",
    model: { provider: "zai", id: "glm-5.3", name: "GLM-5.3", maxTokens: 8192, contextWindow: 200000 },
    getContextUsage: () => ({ tokens: 5000, contextWindow: 200000, percent: 2.5 }),
    getSystemPrompt: () => "x".repeat(40000),
    sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
    ui: { notify: () => {}, theme: { fg: (_c: string, s: string) => s } },
  });

  // TUI: panel posted as a displayable transcript message carrying v2 details.
  await handler!("", mkCtx());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, "ceulen-usage-context");
  assert.equal(sent[0].display, true, "message is displayed in the transcript");
  const grid = sent[0].details?.grid as Array<Array<{ glyph: string; color: string }>> | undefined;
  const legend = sent[0].details?.legend as Array<Array<{ t: string; s?: string }>> | undefined;
  assert.ok(Array.isArray(grid) && grid.length === CTX_GRID_ROWS, "details.grid is 10 rows");
  assert.ok(grid!.every((row) => row.length === CTX_GRID_COLS), "every row has 20 cells");
  assert.ok(Array.isArray(legend) && legend.length >= 8, "details.legend carries the full legend");
  assert.ok(legend![0].some((p) => p.t === "GLM-5.3" && p.s === "strong"), "legend header is styled");
  // Plain-text content always rides along as the renderer-less fallback.
  assert.ok(sent[0].content.includes("Context Usage"), "content carries a plain-text fallback");
  assert.ok(sent[0].content.includes("⛁ System prompt:"), sent[0].content);

  // v2 renderer: paints cell colors + legend runs from the live theme, clamps.
  // Real ANSI wrappers (like pi's theme) so visible-width assertions exercise the actual measure.
  const theme = { fg: (c: string, s: string) => `\u001b[38;5;${c.length}m${s}\u001b[0m`, bold: (s: string) => `\u001b[1m${s}\u001b[0m` };
  const comp = renderers["ceulen-usage-context"]!({ details: { grid, legend } }, {}, theme);
  const out = comp!.render(400);
  assert.ok(out[0].includes("\u001b[38;5;6m⛁"), `grid cell painted: ${out[0].slice(0, 80)}`);
  assert.ok(out[0].includes("\u001b[1mGLM-5.3\u001b[0m"), "legend header bolded");
  assert.ok(out.some((l) => l.includes("\u001b[38;5;3m⛶")), "free cells dim");
  assert.ok(out.some((l) => l.includes("\u001b[38;5;7m⛝")), "buffer cells warning");
  const cat = out.find((l) => l.includes("System prompt:"))!;
  assert.ok(cat.includes("\u001b[38;5;6m⛁"), "legend glyph painted with its category color");
  // Narrow width: clamp applies (display clamp, not data loss).
  const narrow = comp!.render(30);
  const visible = (l: string) => [...l.replace(/\u001b\[[0-9;]*m/g, "")].length;
  assert.ok(narrow.every((l) => visible(l) <= 30), "rows clamp to the visible width");
  // Regression: escape-code inflation once shredded the grid to ~7 cells at any width.
  assert.ok(visible(out[0]) >= 50, "grid + legend header fit at width 400");

  // Legacy details.lines (old transcripts) keep the glyph-tint path.
  const legacy = renderers["ceulen-usage-context"]!({ details: { lines: [" ⛁ System prompt: 1K tokens (1.0%)"] } }, {}, theme);
  const legacyOut = legacy!.render(200);
  assert.ok(legacyOut[0].includes("\u001b[38;5;6m⛁"), legacyOut[0]);
  assert.ok(legacyOut[0].includes("System prompt: 1K tokens"), legacyOut[0]);
  const legacyNarrow = legacy!.render(10);
  assert.ok(legacyNarrow[0].includes("⛁"), "glyph survives the clamp");
  assert.ok(!legacyNarrow[0].includes("System prompt"), "body beyond the width is dropped");
});

test("shortSource reduces local paths and scoped specs to a short label", () => {
  assert.equal(shortSource("../../../../Volumes/Dev/agents/pi-extensions/pi-web"), "pi-web");
  assert.equal(shortSource("@bacnh85/pi-web"), "pi-web");
  assert.equal(shortSource("pi"), "pi");
  assert.equal(shortSource("builtin"), "builtin");
  assert.equal(shortSource(""), "");
});
