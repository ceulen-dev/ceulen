// Spill recovery must be UTF-8 clean AND terminate.
//
// Two independent failure modes are pinned here, both found by live panes:
//
//  1. RE-SPILL: a recovery page over the active budget spills again and the
//     model loops. Every page must estimate under the budget.
//  2. UTF-8 SPLIT: a raw `head -c N` cuts a multibyte character at the page
//     boundary, and bash decodes each page INDEPENDENTLY — so the character is
//     lost in BOTH pages (measured: a 3-byte `日` straddling byte 996 decoded
//     to U+FFFD at page 1's end AND page 2's start). The fix is `iconv -c` plus
//     a page that reports its OWN next offset, so paging never guesses.
//
// These tests RUN the command the notice emits, verbatim, and reassemble the
// whole payload — a text assertion cannot catch either bug.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  PAGE_BYTE_LIMIT,
  PAGE_LINE_LIMIT,
  PI_BASH_BYTE_LIMIT,
  PI_BASH_LINE_LIMIT,
  estimateTokens,
  formatSpillNotice,
  maxRecoveryBytes,
  maxRecoveryPageBytes,
  shortestLineLength,
} from "../lib/spill.js";

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function fixture(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spill-utf8-"));
  dirs.push(dir);
  const file = join(dir, "payload.txt");
  await writeFile(file, text, "utf8");
  return file;
}

/** The bash template the notice emits, with the offset argument filled in. */
function pageTemplate(file: string, budget: number): string {
  const notice = formatSpillNotice(1, file, 80, budget);
  const start = notice.indexOf("bash -c ");
  assert.ok(start >= 0, "notice must emit a bash page command");
  return notice.slice(start).trim();
}

/** Reassemble the whole file by running the emitted command page by page. */
function recover(file: string, budget: number): { text: string; pages: number; sizes: number[] } {
  const template = pageTemplate(file, budget);
  const size = statSync(file).size;
  let offset = 1;
  let text = "";
  let pages = 0;
  const sizes: number[] = [];
  while (offset <= size && pages < 4000) {
    const out = execFileSync("/bin/sh", ["-c", template.replace("_ OFFSET", `_ ${offset}`)], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
    const marker = /\[next OFFSET = (\d+)\]\n$/.exec(out);
    assert.ok(marker, `page at ${offset} printed no next-offset marker`);
    const page = out.slice(0, marker.index);
    text += page;
    sizes.push(page.length);
    const next = Number(marker[1]);
    assert.ok(next > offset, `offset must advance (was ${offset}, page reported ${next})`);
    assert.equal(next, offset + Buffer.byteLength(page, "utf8"), "reported offset must equal offset + bytes printed");
    offset = next;
    pages++;
  }
  return { text, pages, sizes };
}

describe("recovery round trip", () => {
  const fixtures: Array<[string, string]> = [
    ["ascii", "x".repeat(5_000)],
    ["multibyte wide", `${"日本語テキスト😀 héllo wörld\n".repeat(400)}`],
    ["split at the boundary", `${"a".repeat(995)}日${"b".repeat(5_000)}`],
    ["emoji-dense", "😀🎉🚀".repeat(1_500)],
  ];

  for (const [label, payload] of fixtures) {
    it(`recovers ${label} byte-for-byte at the default budget`, async () => {
      const file = await fixture(payload);
      const { text, pages } = recover(file, 12_500);
      assert.equal(text, payload, "reassembled text must equal the original");
      assert.ok(!text.includes("\uFFFD"), "no replacement characters");
      assert.ok(pages >= 1);
    });
  }

  it("recovers a multibyte payload at a LOWERED budget", async () => {
    const payload = "日本語😀abc\n".repeat(300);
    const file = await fixture(payload);
    const { text, sizes } = recover(file, 2_000);
    assert.equal(text, payload);
    assert.ok(!text.includes("\uFFFD"));
    // And no page may re-spill.
    for (const size of sizes) {
      assert.ok(estimateTokens([{ type: "text", text: "x".repeat(size) }]) <= 2_000);
    }
  });

  it("strips only the incomplete trailing sequence, never a whole character", async () => {
    // 995 ASCII + a 3-byte char straddling the 996-byte boundary: page 1 must
    // drop exactly the 1 dangling byte and keep all 995 ASCII characters.
    const payload = `${"a".repeat(995)}日${"b".repeat(500)}`;
    const file = await fixture(payload);
    const budget = 2_000; // chunk 996
    assert.equal(maxRecoveryBytes(budget), 996);

    const template = pageTemplate(file, budget);
    const first = execFileSync("/bin/sh", ["-c", template.replace("_ OFFSET", "_ 1")], { encoding: "utf8" });
    const page = first.slice(0, first.lastIndexOf("[next OFFSET"));
    assert.equal(page, "a".repeat(995), "page 1 keeps 995 ASCII chars and drops only the dangling byte");
    assert.match(first, /\[next OFFSET = 996\]\n$/);
  });
});

describe("page line cap (pi's bash truncates the HEAD past 2000 lines)", () => {
  it("bounds the byte window by the shortest line, not just the budget", () => {
    // 1-byte lines are the worst case: 6,246 bytes would be 6,246 lines, and
    // pi's bash keeps only the LAST 2000 — dropping the head our offset has
    // already advanced past.
    const wide = maxRecoveryPageBytes(12_500, 1);
    assert.ok(wide <= PAGE_LINE_LIMIT, `${wide} must fit ${PAGE_LINE_LIMIT} one-byte lines`);
    assert.ok(wide < maxRecoveryBytes(12_500), "the line cap narrows the byte window");
    // A long minimum line cannot exceed the token budget either.
    assert.equal(maxRecoveryPageBytes(12_500, 100), maxRecoveryBytes(12_500));
  });

  it("shrinks the advertised window for short-line payloads", () => {
    const short = formatSpillNotice(1, "/tmp/x.txt", 2, 12_500, 2);
    const long = formatSpillNotice(1, "/tmp/x.txt", 2, 12_500, 100);
    const shortChunk = Number(short.match(/~(\d+)-byte/)?.[1]);
    const longChunk = Number(long.match(/~(\d+)-byte/)?.[1]);
    assert.ok(shortChunk < longChunk, `short lines must page smaller (${shortChunk} vs ${longChunk})`);
    assert.ok(shortChunk <= 2 * PAGE_LINE_LIMIT, "two-byte lines must fit the line cap");
  });

  it("caps the page with head -n so it can never overflow pi's line limit", () => {
    const notice = formatSpillNotice(1, "/tmp/x.txt", 2, 12_500, 1);
    assert.match(notice, new RegExp(`head -n ${PAGE_LINE_LIMIT}`));
    assert.ok(PAGE_LINE_LIMIT < PI_BASH_LINE_LIMIT, "headroom under pi's cap");
  });

  it("shortestLineLength ignores empty lines and defaults to 1", () => {
    assert.equal(shortestLineLength(""), 1);
    assert.equal(shortestLineLength("\n\n\n"), 1);
    assert.equal(shortestLineLength("a\nbbbb\n\ncc"), 1);
    assert.equal(shortestLineLength("abc\nde\nfghij"), 2);
  });

  // End-to-end: every page must survive pi's REAL truncation path and the
  // reassembly must equal the file. /bin/sh alone cannot see this cap.
  it("every emitted page survives pi's bash truncateTail and reassembles exactly", async () => {
    const { truncateTail } = await import(
      // Pi exposes no subpath export for this module; import it by path.
      "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js"
    );
    for (const payload of ["ab\n".repeat(6_000), "a\n".repeat(9_000), "\n".repeat(9_000)]) {
      const file = await fixture(payload);
      const budget = 12_500;
      const notice = formatSpillNotice(1, file, 80, budget, shortestLineLength(payload));
      const template = notice.slice(notice.indexOf("bash -c ")).trim();
      const size = statSync(file).size;
      let offset = 1;
      let out = "";
      let pages = 0;
      while (offset <= size && pages < 4_000) {
        const raw = execFileSync("/bin/sh", ["-c", template.replace("_ OFFSET", `_ ${offset}`)], {
          encoding: "utf8", maxBuffer: 64 << 20,
        });
        const marker = /\[next OFFSET = (\d+)\]\n$/.exec(raw);
        assert.ok(marker, `page at ${offset} printed no marker`);
        const page = raw.slice(0, marker.index);
        const t = truncateTail(page);
        assert.equal(t.truncated, false, `page at ${offset} was truncated by pi (${t.truncatedBy}) — data would be lost`);
        out += page;
        offset = Number(marker[1]);
        pages++;
      }
      assert.equal(out, payload, "reassembly must be byte-exact");
    }
  });
});

describe("page byte cap (pi's bash truncates past 50 KiB)", () => {
  it("clamps the window under pi's byte cap even at a raised budget", () => {
    // The budget alone does not bound bytes: spillMaxTokens 200,000 asks for a
    // 99,996-byte page — nearly 2x pi's 50 KiB cap, so bash drops the HEAD.
    for (const budget of [12_500, 50_000, 100_000, 200_000, 1_000_000]) {
      for (const minLine of [1, 80, 10_000, 40_000]) {
        const windowBytes = maxRecoveryPageBytes(budget, minLine);
        assert.ok(
          windowBytes <= PAGE_BYTE_LIMIT,
          `budget=${budget} minLine=${minLine} → ${windowBytes} exceeds PAGE_BYTE_LIMIT ${PAGE_BYTE_LIMIT}`,
        );
        assert.ok(windowBytes <= PI_BASH_BYTE_LIMIT, "must stay under pi's bash cap");
      }
    }
    assert.ok(PAGE_BYTE_LIMIT < PI_BASH_BYTE_LIMIT, "headroom under pi's cap");
  });

  it("advertises the clamped window in the notice at a high budget", () => {
    const notice = formatSpillNotice(1, "/tmp/big.txt", 40_000, 200_000, 40_000);
    const chunk = Number(notice.match(/head -c (\d+)/)?.[1]);
    assert.ok(chunk > 0 && chunk <= PAGE_BYTE_LIMIT, `advertised ${chunk} must be clamped`);
  });

  // The advisor's case, end to end: high budget + long lines, and the check
  // passes the page's RAW output INCLUDING the offset marker to pi's
  // truncateTail — because the marker is part of what bash evaluates against
  // its byte/line caps, not something appended after the fact.
  it("high-budget long-line pages survive truncateTail with the marker included", async () => {
    const { truncateTail } = await import(
      "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js"
    );
    // 400-char lines: long enough that the LINE window never binds, so only
    // the byte cap can protect the page.
    const payload = `${"x".repeat(399)}\n`.repeat(2_000);
    const file = await fixture(payload);
    const size = statSync(file).size;

    for (const budget of [12_500, 50_000, 200_000]) {
      const notice = formatSpillNotice(1, file, 399, budget, 400);
      const template = notice.slice(notice.indexOf("bash -c ")).trim();

      let offset = 1;
      let out = "";
      let pages = 0;
      while (offset <= size && pages < 2_000) {
        const raw = execFileSync("/bin/sh", ["-c", template.replace("_ OFFSET", `_ ${offset}`)], {
          encoding: "utf8", maxBuffer: 64 << 20,
        });
        // RAW output, marker included — the marker is part of the tool result.
        const t = truncateTail(raw);
        assert.equal(
          t.truncated, false,
          `budget=${budget} page at ${offset}: pi truncated RAW output (${t.truncatedBy}, ` +
          `${Buffer.byteLength(raw)} bytes / ${raw.split("\n").length} lines) — head would be lost`,
        );
        assert.ok(Buffer.byteLength(raw) <= PI_BASH_BYTE_LIMIT);

        const marker = /\[next OFFSET = (\d+)\]\n$/.exec(raw);
        assert.ok(marker, `budget=${budget} page at ${offset} lost its marker`);
        out += raw.slice(0, marker.index);
        offset = Number(marker[1]);
        pages++;
      }
      assert.equal(out, payload, `budget=${budget}: reassembly must be byte-exact`);
    }
  });
});

describe("byte-cap risk region is qualified by the line window", () => {
  // The byte clamp protects a region the LINE window does not: `byLines =
  // minLine * PAGE_LINE_LIMIT` binds first for short lines, so the old
  // over-cap window only exists once minLine is large enough. Pinning the
  // boundaries keeps the documentation's numbers honest.
  const budget = 200_000;
  const byBudget = maxRecoveryBytes(budget);
  const oldWindow = (minLine: number) => Math.min(byBudget, minLine * PAGE_LINE_LIMIT);

  it("the old formula only exceeds pi's byte cap from minLine 27 up", () => {
    assert.ok(oldWindow(26) <= PI_BASH_BYTE_LIMIT, `minLine=26 → ${oldWindow(26)} must already be under the cap`);
    assert.ok(oldWindow(27) > PI_BASH_BYTE_LIMIT, `minLine=27 → ${oldWindow(27)} must be the first over-cap value`);
    // Below the byte clamp the LINE window was the only protection.
    assert.equal(oldWindow(1), PAGE_LINE_LIMIT);
  });

  it("the full 99,996-byte window needs minLine >= 53", () => {
    assert.equal(Math.ceil(byBudget / PAGE_LINE_LIMIT), 53);
    assert.equal(oldWindow(52), 98_800);
    assert.equal(oldWindow(53), byBudget);
    assert.equal(oldWindow(40_000), byBudget);
  });

  it("the shipped formula clamps at every minLine", () => {
    for (const minLine of [1, 26, 27, 52, 53, 80, 1_000, 40_000]) {
      for (const b of [12_500, 50_000, 200_000, 1_000_000]) {
        assert.ok(
          maxRecoveryPageBytes(b, minLine) <= PAGE_BYTE_LIMIT,
          `budget=${b} minLine=${minLine} must be clamped`,
        );
      }
    }
  });
});
