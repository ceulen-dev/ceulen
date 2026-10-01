/**
 * Composer shape tests — chrome builders, OMP copy parity, layout math, and
 * the cursor marker surviving chrome wrapping (the invariant that makes side
 * chrome safe: the TUI measures the marker in the FINAL rendered line).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeStatus,
  contentWidth,
  DEFAULT_SHAPE,
  formatCompact,
  ICONS,
  parseGitStats,
  gutterWidth,
  rateLine,
  IDENTITY_THEME,
  isShapeId,
  padRow,
  previewShape,
  readGitBranch,
  SHAPE_IDS,
  SHAPES,
  shapeById,
  statusSegments,
  surfacePainter,
  type ShapeTheme,
} from "../lib/shapes.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const th = IDENTITY_THEME;

describe("composer shape vocabulary (OMP parity)", () => {
  it("ships all 8 OMP shapes in OMP order with OMP ids", () => {
    assert.deepEqual(SHAPE_IDS, ["band", "box", "claude", "pi", "borderless", "rule", "field", "rail"]);
    assert.equal(DEFAULT_SHAPE, "band");
  });

  it("carries OMP's labels and descriptions verbatim", () => {
    const expected: Record<string, [string, string]> = {
      band: ["Status Band (Default)", "Flush soft-capped status band above a curved prompt, no frame"],
      box: ["Rounded Box", "Status line embedded in top border, compact 2-line prompt"],
      claude: ["Claude Code", "Full-width horizontal rules above and below, status line at bottom"],
      pi: ["Pi", "Framed horizontal rules with status line at bottom"],
      borderless: ["Borderless", "Clean prompt glyph with status line at bottom, no box borders"],
      rule: ["Top Rule Dock", "Single top rule with status docked onto it and below"],
      field: ["Compact Field", "Filled one-row field with accent end caps"],
      rail: ["Accent Rail", "Filled one-row field anchored by a single accent rail"],
    };
    for (const s of SHAPES) {
      assert.deepEqual([s.label, s.description], expected[s.id], s.id);
    }
  });

  it("unknown ids fall back to the default (stale settings can't break the editor)", () => {
    assert.equal(shapeById("nonexistent").id, "band");
    assert.equal(isShapeId("rail"), true);
    assert.equal(isShapeId("nope"), false);
    assert.equal(isShapeId(42), false);
  });
});

describe("shape geometry", () => {
  it("side chrome and gutters are subtracted from the content width", () => {
    assert.equal(contentWidth(shapeById("pi"), 80), 80, "no side chrome, no gutter");
    assert.equal(contentWidth(shapeById("band"), 80), 80 - 3, "gutter `╰─ ` = 3 cells");
    assert.equal(contentWidth(shapeById("box"), 80), 80 - 2, "1-cell border per side");
    assert.equal(contentWidth(shapeById("field"), 80), 80 - 2, "one cap per side");
    assert.equal(contentWidth(shapeById("rail"), 80), 80 - 2, "rail reserves a cell each side (single left rail)");
  });

  it("gutter is capped so narrow terminals keep a text column", () => {
    assert.ok(contentWidth(shapeById("band"), 4) >= 1);
    assert.ok(gutterWidth(shapeById("band"), 4) <= 4);
  });

  it("padRow pads to exactly the content width, marker-safe", () => {
    assert.equal(visibleWidth(padRow(10, "abc")), 10);
    const withMarker = `ab${CURSOR_MARKER}`;
    assert.equal(visibleWidth(padRow(10, withMarker)), 10, "marker is zero-width");
    assert.ok(padRow(10, withMarker).includes(CURSOR_MARKER), "marker survives padding");
  });
});

describe("chrome rendering through the shared builders", () => {
  it("every shape renders a prompt row at the full width", () => {
    for (const s of SHAPES) {
      const lines = previewShape(s.id, 60, th, { model: "M", cwd: "d", pct: 10 });
      assert.ok(lines.length >= 1, `${s.id} renders`);
      for (const l of lines) {
        assert.equal(visibleWidth(l), 60, `${s.id}: ${JSON.stringify(plain(l))}`);
      }
      assert.ok(lines.some((l) => plain(l).includes("Ask anything")), `${s.id} shows the prompt`);
    }
  });

  it("box draws corners + side bars; field/rail draw caps and rails; rail has no right cap", () => {
    // A one-row prompt: the box merges its bottom border into that row, so
    // the preview is exactly `╭…╮` + `╰─ … ─╯` (OMP's compact 2-line prompt).
    const box = previewShape("box", 30, th).map(plain);
    assert.equal(box.length, 2, box.join("\n"));
    assert.ok(box[0]!.startsWith("╭") && box[0]!.endsWith("╮"));
    assert.ok(box[1]!.startsWith("╰─") && box[1]!.endsWith("─╯"), box[1]);
    const field = previewShape("field", 30, th).map(plain);
    assert.ok(field[0]!.startsWith("▐") && field[0]!.endsWith("▌"), field[0]);
    const rail = previewShape("rail", 30, th).map(plain);
    assert.ok(rail[0]!.startsWith("▎"), rail[0]);
    assert.ok(!rail[0]!.endsWith("▌"), "rail has a single rail, no caps");
  });

  it("closing chrome glyphs survive at every width (no silent truncation)", () => {
    // Regression: the box status row was one cell over budget and
    // truncateToWidth silently ate the closing `╮`.
    for (const w of [24, 30, 40, 57, 80]) {
      const box = previewShape("box", w, th, { model: "GLM-5.3", cwd: "ceulen", pct: 42 }).map(plain);
      assert.ok(box[0]!.endsWith("╮"), `box top closes at ${w}: ${box[0]}`);
      assert.ok(box[box.length - 1]!.endsWith("─╯"), `box bottom closes at ${w}: ${box[box.length - 1]}`);
      const claude = previewShape("claude", w, th, { model: "M" }).map(plain);
      assert.equal(claude.length, 3, `claude keeps both rules at ${w}`);
      for (const l of claude) assert.equal(visibleWidth(l), w, `claude row width at ${w}`);
    }
  });

  it("status-bearing shapes show the live status line; band reserves a blank row when empty", () => {
    const box = previewShape("box", 40, th, { model: "GLM-5.3", cwd: "ceulen", pct: 42 }).map(plain);
    assert.ok(box[0]!.includes("GLM-5.3") && box[0]!.includes("ceulen") && box[0]!.includes("42.0%"), box[0]);
    const bandEmpty = previewShape("band", 40, th).map(plain);
    assert.equal(bandEmpty[0]!.trim(), "", "band row reserved (blank) without data");
    const bandFull = previewShape("band", 40, th, { model: "M" }).map(plain);
    assert.ok(bandFull[0]!.includes("╭─") && bandFull[0]!.includes("M"), bandFull[0]);
  });

  it("rules carry pi's scroll indicator when lines are hidden", () => {
    // pi shape: top/bottom rules; hidden comes from the editor. Preview has 0,
    // so assert the helper through a ctx-shaped shape def directly.
    const def = shapeById("pi");
    const line = def.top!({ w: 30, hidden: 4, theme: th })!;
    assert.ok(plain(line).includes(" ↑ 4 more "), plain(line));
    assert.equal(visibleWidth(line), 30);
  });
});

describe("git branch read (.git/HEAD)", () => {
  const withTmp = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "ceulen-branch-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("reads a normal repo's HEAD branch and walks up from a subdirectory", () => {
    withTmp((dir) => {
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      const sub = join(dir, "packages", "app");
      mkdirSync(sub, { recursive: true });
      assert.equal(readGitBranch(dir), "main");
      assert.equal(readGitBranch(sub), "main", "walk-up finds the repo root");
    });
  });

  it("resolves a linked worktree (.git is a gitdir file)", () => {
    withTmp((dir) => {
      const realGit = join(dir, "real-git");
      mkdirSync(realGit, { recursive: true });
      writeFileSync(join(realGit, "HEAD"), "ref: refs/heads/feature/x\n");
      const wt = join(dir, "worktree");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, ".git"), `gitdir: ${realGit}\n`);
      assert.equal(readGitBranch(wt), "feature/x");
    });
  });

  it("detached HEAD and non-repos degrade safely", () => {
    withTmp((dir) => {
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
      assert.equal(readGitBranch(dir), "detached");
    });
    withTmp((dir) => {
      assert.equal(readGitBranch(dir), null, "no repo → null");
    });
  });
});

describe("status line + surface fill", () => {
  it("statusSegments splits OMP's stock groups: identity left, context window right", () => {
    const s = statusSegments({ model: "M", provider: "router", thinkingLevel: "max", cwd: "~/dev/ceulen", branch: "main", rate: 46, pct: 42.6, window: 1_000_000 }, th);
    assert.equal(plain(s.left), "π · (router) M (max) · 📁 ~/dev/ceulen · ⑂ main");
    assert.equal(plain(s.right), "42.6%/1.0M");
    // Every segment carries its icon (OMP's glyph set).
    assert.ok(plain(s.left).startsWith("π "), "brand leads the group");
    assert.ok(plain(s.left).includes("📁 ~/dev/ceulen"), "folder icon on the dir");
    assert.ok(plain(s.left).includes("⑂ main"), "branch icon on the git segment");
    // Generation rate is NOT a band segment — it renders right-justified above
    // the band (rateLine).
    assert.ok(!plain(s.left).includes("tok/s"), "rate moved out of the band");
    assert.equal(plain(rateLine({ rate: 46.4 }, th, 20)), "         ⚡ 46 tok/s");
    assert.equal(rateLine(undefined, th, 20), "", "no rate → no line");
    assert.equal(rateLine({ rate: 0 }, th, 20), "", "zero rate → no line");
    // Blanks drop out — never wrong, just shorter. The brand only leads a
    // group that exists, so an empty session keeps the band blank.
    assert.equal(plain(statusSegments({ model: "M" }, th).left), "π · M");
    assert.equal(statusSegments({}, th).left, "", "no data → no brand");
    assert.equal(statusSegments(undefined, th).left, "");
    assert.equal(statusSegments(undefined, th).right, "");
    assert.equal(plain(statusSegments({ model: " ", cwd: "x" }, th).left), "π · 📁 x", "blank segments skipped");
    // Branch without a cwd still renders; detached renders as-is.
    assert.equal(plain(statusSegments({ branch: "detached" }, th).left), "π · ⑂ detached");
    // Spinner takes the brand slot while a turn runs.
    assert.equal(plain(statusSegments({ model: "M" }, th, "⟳").left), "⟳ · M");
  });

  it("model segment: (provider) prefix skips when the name carries it; off/blank level dropped", () => {
    // Direct provider whose display name already starts with provider/ — no double prefix.
    assert.equal(plain(statusSegments({ model: "zai/glm-5.3", provider: "zai" }, th).left), "π · zai/glm-5.3");
    // Prefix is case-insensitive on the check, verbatim on output.
    assert.equal(plain(statusSegments({ model: "Zai/GLM", provider: "zai" }, th).left), "π · Zai/GLM");
    assert.equal(plain(statusSegments({ model: "M", provider: "zai" }, th).left), "π · (zai) M");
    // `off` and blank levels render nothing, not "(off)".
    assert.equal(plain(statusSegments({ model: "M", thinkingLevel: "off" }, th).left), "π · M");
    assert.equal(plain(statusSegments({ model: "M", thinkingLevel: "  " }, th).left), "π · M");
    // Level without a model never renders alone.
    assert.equal(statusSegments({ thinkingLevel: "max" }, th).left, "");
  });

  it("model cluster: model only — usage/stats dropped from the band (restore: git history)", () => {
    const s = statusSegments(
      { model: "M", provider: "router", thinkingLevel: "high", branch: "main", git: { staged: 1, unstaged: 10, untracked: 4 }, usage: "(router) R:59%/2H3M W:99%/2D3H", stats: "↑1.9M ↓377k R69M CH99.7%", rate: 46 },
      th,
    );
    const left = plain(s.left);
    assert.equal(left, "π · (router) M (high) · ⑂ main *10 +1 ?4");
    // Supplied-but-dropped figures never leak into the band.
    assert.ok(!left.includes("R:59%") && !left.includes("↑1.9M") && !left.includes("tok/s"), "usage/stats/rate stay off the band");
    // Quota tone steps with the tightest window (usage module decides).
    const stepping: ShapeTheme = {
      ...th,
      warn: (t) => `W(${t})`,
      error: (t) => `E(${t})`,
    };
    // Usage data supplied but dropped — the band shows nothing, not a stale
    // quota figure (the tone-stepping segment lives in git history).
    assert.equal(plain(statusSegments({ usage: "(router) R:59%/2H3M", usageTone: "warning" }, stepping).left), "");
    assert.equal(plain(statusSegments({ usage: "(router) R:9%/1M", usageTone: "error" }, stepping).left), "");
    assert.equal(plain(statusSegments({ model: "M", usage: "  " }, th).left), "π · M");
    assert.equal(plain(statusSegments({ model: "M", stats: "" }, th).left), "π · M");
  });

  it("context window color-steps like pi's footer (>70 warn, >90 error)", () => {
    const seen = { warn: 0, error: 0 };
    const stepping: ShapeTheme = {
      ...th,
      warn: (s) => (seen.warn++, s),
      error: (s) => (seen.error++, s),
    };
    assert.equal(plain(statusSegments({ pct: 42, window: 200_000 }, stepping).right), "42.0%/200k");
    assert.equal(seen.warn, 0);
    assert.equal(plain(statusSegments({ pct: 75, window: 200_000 }, stepping).right), "75.0%/200k");
    assert.equal(seen.warn, 1);
    assert.equal(plain(statusSegments({ pct: 95, window: 200_000 }, stepping).right), "95.0%/200k");
    assert.equal(seen.error, 1);
    // Unknown pct with a known window shows the window alone.
    assert.equal(plain(statusSegments({ pct: null, window: 200_000 }, th).right), "200k/?");
    assert.equal(statusSegments({}, th).right, "");
    // pi's `(auto)` compaction marker rides the context figure (footer parity).
    assert.equal(plain(statusSegments({ pct: 42, window: 200_000, autoCompact: true }, th).right), "42.0%/200k (auto)");
    assert.equal(plain(statusSegments({ pct: 95, window: 200_000, autoCompact: true }, stepping).right), "95.0%/200k (auto)");
  });

  it("composeStatus justifies the right group; the left group yields first when narrow", () => {
    assert.equal(plain(composeStatus("L", "R", 10)), "L        R");
    assert.equal(plain(composeStatus("", "R", 10)), "R");
    assert.equal(plain(composeStatus("L", "", 10)), "L");
    // OMP priority: the context window survives; identity truncates into it.
    assert.equal(plain(composeStatus("LLLLLL", "RR", 6)), "LL… RR");
    assert.equal(plain(composeStatus("LLLLLL", "RRRR", 5)), "RRRR", "right alone when the left cannot fit");
  });

  it("formatCompact matches pi-footer/OMP token figures", () => {
    assert.equal(formatCompact(0), "0");
    assert.equal(formatCompact(999), "999");
    assert.equal(formatCompact(2_500), "2.5k");
    assert.equal(formatCompact(200_000), "200k");
    assert.equal(formatCompact(1_000_000), "1.0M");
    assert.equal(formatCompact(12_000_000), "12M");
    assert.equal(formatCompact(Number.NaN), "0");
  });

  it("status chips/bands carry dir, branch and the context window", () => {
    const data = { model: "M", cwd: "~/dev/ceulen", branch: "main", pct: 42.6, window: 1_000_000 };
    const band = previewShape("band", 60, th, data).map(plain)[0]!;
    assert.ok(band.includes("📁 ~/dev/ceulen") && band.includes("⑂ main"), band);
    assert.ok(band.includes("42.6%/1.0M"), band);
    // Right group is justified to the band's right edge (before the closing cap cells).
    assert.ok(band.trimEnd().endsWith("42.6%/1.0M"), band);
    const box = previewShape("box", 60, th, data).map(plain)[0]!;
    assert.ok(box.includes("📁 ~/dev/ceulen") && box.includes("42.6%/1.0M") && box.endsWith("╮"), box);
  });

  it("band fills the status chip only, not the whole line (OMP's band)", () => {
    // Sentinel fill makes the filled span explicit and implementation-agnostic.
    const theme: ShapeTheme = { ...th, fill: (s) => `⟦${s}⟧` };
    const c = { w: 80, hidden: 0, theme, data: { model: "M", cwd: "~/x", branch: "main", pct: 42, window: 1_000_000 } };
    const line = shapeById("band").top!(c as never)!;
    const filled = line.slice(line.indexOf("⟦") + 1, line.indexOf("⟧"));
    assert.ok(filled.includes("main"), `identity is filled: ${filled}`);
    assert.ok(!filled.includes("42.0%/1.0M"), `context figure stays on the bare surface: ${filled}`);
    // The context figure survives OUTSIDE the chip, and the line is still full width.
    assert.equal(visibleWidth(line), 80, "band still spans the full width");
    assert.ok(plain(line).includes("42.0%/1.0M"), plain(line));
    assert.ok(plain(line).indexOf("⟧") < plain(line).indexOf("42.0%/1.0M"), "fill ends before the context figure");
  });

  it("git segment renders OMP's indicators and goes warning when dirty", () => {
    assert.equal(plain(statusSegments({ branch: "main" }, th).left), "π · ⑂ main", "clean tree: branch only");
    const dirty = statusSegments({ branch: "main", git: { staged: 1, unstaged: 3, untracked: 2 } }, th).left;
    assert.ok(plain(dirty).endsWith("⑂ main *3 +1 ?2"), plain(dirty));
    // Dirty renders through the warning hook (OMP's statusLineGitDirty).
    let warned = 0;
    const th2: ShapeTheme = { ...th, warn: (s) => (warned++, s) };
    statusSegments({ branch: "main", git: { staged: 0, unstaged: 1, untracked: 0 } }, th2);
    assert.equal(warned, 1, "dirty tree warns");
    assert.equal(plain(statusSegments({ branch: "main", git: { staged: 0, unstaged: 0, untracked: 0 } }, th2).left), "π · ⑂ main");
    assert.equal(warned, 1, "clean tree does not warn again");
  });

  it("parseGitStats counts porcelain XY states like OMP's indicators", () => {
    const porcelain = [
      " M src/a.ts",
      "M  src/b.ts",
      "MM src/c.ts",
      "A  src/d.ts",
      "?? src/e.ts",
      "?? src/f.ts",
      " D src/g.ts",
      "R  a.ts -> b.ts",
    ].join("\n");
    assert.deepEqual(parseGitStats(porcelain), { staged: 4, unstaged: 3, untracked: 2 });
    assert.deepEqual(parseGitStats(""), { staged: 0, unstaged: 0, untracked: 0 });
  });

  it("surfacePainter re-applies the fill across nested resets (cursor glyph)", () => {
    const painted = surfacePainter("\x1b[44m")(`a\x1b[0mb`);
    assert.equal(painted, "\x1b[44ma\x1b[0m\x1b[44mb\x1b[39m\x1b[49m");
    assert.equal(surfacePainter("")("plain"), "plain", "empty prefix is a no-op");
  });
});

describe("theme adapter", () => {
  it("shapeTheme maps pi Theme colors and keeps bg through getBgAnsi", async () => {
    const { shapeTheme } = await import("../lib/shapes.ts");
    const seen: string[] = [];
    const t = {
      fg: (c: string, s: string) => {
        seen.push(c);
        return `<${c}>${s}`;
      },
      getBgAnsi: () => "\x1b[48m",
      getFgAnsi: () => "\x1b[38m",
      inverse: (s: string) => `[inv]${s}`,
    };
    const st: ShapeTheme = shapeTheme(t as never);
    assert.equal(st.accent("x"), "<accent>x");
    assert.equal(st.border("x"), "<borderMuted>x");
    assert.ok(st.fill("x").includes("\x1b[48m"), "bg applied");
    assert.equal(st.inverse("x"), "[inv]x");
    assert.ok(seen.length > 0, "theme colors requested through fg()");
  });
});
