// Spill policy: estimation, retention geometry, store escaping, and the
// handler's exclusion contract.
//
// The exclusions are the load-bearing part: stock read/bash truncate INSIDE the
// tool before `tool_result` fires, so spilling them would bound an
// already-bounded result and point at a file that cannot restore the dropped
// bytes. The discriminator is METADATA (details.truncation / details.fullOutputPath),
// never notice text — a wrapped read of a file CONTAINING "Use offset=" must
// still spill.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHARS_PER_TOKEN,
  DEFAULT_SPILL_MAX_TOKENS,
  PI_READ_LINE_LIMIT,
  estimateTextTokens,
  estimateTokens,
  fitText,
  formatSpillNotice,
  longestLineLength,
  maxRecoveryBytes,
  retainContent,
  textSlice,
} from "../lib/spill.js";
import { encodeSegment, privateRoot, saveSpill } from "../lib/spill-store.js";

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("estimate", () => {
  it("prices text at the fixed density plus per-block overhead", () => {
    assert.equal(estimateTextTokens(""), 4);
    assert.equal(estimateTextTokens("a".repeat(CHARS_PER_TOKEN * 10)), 4 + 10);
    assert.equal(estimateTokens([{ type: "text", text: "a".repeat(40) }, { type: "image" }]), 4 + 10);
  });

  it("default budget matches DSH's base preset", () => {
    assert.equal(DEFAULT_SPILL_MAX_TOKENS, 12_500);
  });

  it("a stock-truncated read (50KB) exceeds the default budget — why metadata, not budget, discriminates", () => {
    // pi's read caps at 50KB; that is ~12,800 estimated tokens, ABOVE 12,500.
    assert.ok(estimateTextTokens("a".repeat(50 * 1024)) > DEFAULT_SPILL_MAX_TOKENS);
  });
});

describe("retention geometry", () => {
  it("never splits a surrogate pair", () => {
    // "😀" is one code point, two UTF-16 units. A cut between them must move.
    const text = `a${"😀".repeat(20)}`;
    for (let length = 1; length < text.length; length++) {
      const head = textSlice(text, length, false);
      const tail = textSlice(text, length, true);
      assert.ok(!/[\ud800-\udbff]$/.test(head), `head ${length} ends on a lone surrogate`);
      assert.ok(!/^[\udc00-\udfff]/.test(tail), `tail ${length} starts on a lone surrogate`);
    }
  });

  it("fitText keeps the largest end under budget", () => {
    const text = "x".repeat(1000);
    const head = fitText(text, 100, false);
    assert.ok(head.length > 0 && head.length < text.length);
    assert.ok(estimateTextTokens(head) <= 100);
    assert.ok(estimateTextTokens("x".repeat(head.length + 1)) > 100);
  });

  it("splits head and tail with no overlap and reports the omitted bytes", () => {
    const texts = ["A".repeat(2000), "B".repeat(2000)];
    const retained = retainContent(texts, 200);
    const headText = retained.head.map((b) => b.text).join("");
    const tailText = retained.tail.map((b) => b.text).join("");
    assert.ok(headText.length > 0, "head retained");
    assert.ok(tailText.length > 0, "tail retained");
    const original = 4000;
    assert.equal(retained.omittedBytes, original - headText.length - tailText.length);
    assert.ok(retained.omittedBytes > 0);
    // The retained ends must not re-emit the same characters.
    assert.ok(headText.length + tailText.length <= original);
  });

  it("does not duplicate a single oversized block across both ends", () => {
    const retained = retainContent(["0123456789".repeat(100)], 100);
    const headText = retained.head.map((b) => b.text).join("");
    const tailText = retained.tail.map((b) => b.text).join("");
    assert.ok(headText.length + tailText.length <= 1000);
  });

  it("notice names the recovery file", () => {
    const notice = formatSpillNotice(1234, "/tmp/ceulen-spill-x/tool-1.txt");
    assert.match(notice, /1234 bytes omitted/);
    assert.match(notice, /Full output saved to: \/tmp\/ceulen-spill-x\/tool-1\.txt/);
    // Every branch pages by bytes now — see the "NEVER recommends read" test.
    assert.match(notice, /Retrieve it in <=1900-line, ~\d+-byte UTF-8-safe pages with bash/);
    assert.match(notice, /cat \/tmp\/ceulen-spill-x\/tool-1\.txt \| tail -c \+\$OFFSET \| head -c \d+/);
  });

  it("tells the model to page with bash when the payload is one over-limit line", () => {
    // pi's read REFUSES a single line over 50KB, so "use read" would be dead
    // advice for minified JSON / a single long log line (live finding, herdr).
    const notice = formatSpillNotice(1234, "/tmp/x/tool-1.txt", longestLineLength("a".repeat(150_000)));
    assert.match(notice, /Retrieve it in <=1900-line, ~6246-byte UTF-8-safe pages with bash/);
    assert.match(notice, /cat \/tmp\/x\/tool-1\.txt \| tail -c \+\$OFFSET \| head -c 6246/);
    assert.doesNotMatch(notice, /Use read with that path/);
  });

  it("emits a UTF-8-safe page command with a self-reporting offset", () => {
    // A raw `head -c` splits a multibyte char at the boundary, and bash decodes
    // each page independently — the char is lost in BOTH pages. `iconv -c`
    // drops the incomplete tail and the page prints the ACTUAL next offset.
    const notice = formatSpillNotice(1234, "/tmp/x/a b.txt", 80, 2_000);
    assert.match(notice, /iconv -f UTF-8 -t UTF-8 -c/);
    assert.match(notice, /\[next OFFSET = %d\]/);
    assert.match(notice, /OFFSET=\$1/, "OFFSET is a shell variable, not a pasted literal");
  });

  it("sizes the recovery chunk UNDER the active budget so it cannot re-spill", () => {
    // The advisor finding, as arithmetic: `head -c 50000` of ASCII estimates to
    // 12,504 tokens with block overhead — over the 12,500 default — so the
    // recovery would itself spill and loop the model.
    const fiftyK = estimateTokens([{ type: "text", text: "x".repeat(50_000) }]);
    assert.ok(fiftyK > DEFAULT_SPILL_MAX_TOKENS, `50KB must exceed the budget (got ${fiftyK})`);

    for (const budget of [2_000, 12_500, 40_000]) {
      const chunk = maxRecoveryBytes(budget);
      assert.ok(chunk > 0, `budget ${budget} must still leave a usable chunk`);
      const cost = estimateTokens([{ type: "text", text: "x".repeat(chunk) }]);
      assert.ok(cost <= budget, `budget ${budget}: chunk ${chunk} costs ${cost} — must not re-spill`);
    }
  });

  it("shrinks the chunk when the user lowers the budget", () => {
    assert.ok(maxRecoveryBytes(2_000) < maxRecoveryBytes(12_500));
    assert.ok(maxRecoveryBytes(12_500) < maxRecoveryBytes(40_000));
  });

  it("NEVER recommends read, even for short-line payloads", () => {
    // read is never safe here: the spill file exceeds the budget by definition.
    // pi's read caps at 50KB/2000 lines with no byte-budget parameter, and
    // 50KB alone estimates to 12,804 tokens — over the 12,500 default.
    const multiline = "line of text\n".repeat(10_000);
    const notice = formatSpillNotice(1234, "/tmp/x/tool-1.txt", longestLineLength(multiline), 12_500);
    assert.doesNotMatch(notice, /Use read with that path/);
    assert.match(notice, /Retrieve it in <=1900-line, ~\d+-byte UTF-8-safe pages with bash/);
    assert.match(notice, /read would return more than this result's budget and spill again/);
  });

  it("pages under a LOWERED budget instead of suggesting read (advisor case)", () => {
    // 9,000 ASCII chars over 100 lines fits pi's read caps but costs 2,254
    // estimated tokens — over a 2,000 budget, so an untruncated read re-spills.
    const payload = ("x".repeat(89) + "\n").repeat(100);
    assert.equal(payload.length, 9_000);
    assert.ok(estimateTextTokens(payload) > 2_000);

    const notice = formatSpillNotice(payload.length, "/tmp/x/short.txt", longestLineLength(payload), 2_000);
    assert.doesNotMatch(notice, /Use read with that path/);
    const chunk = Number(notice.match(/~(\d+)-byte UTF-8-safe pages/)?.[1]);
    assert.ok(chunk > 0, "a usable chunk survives a small budget");
    assert.ok(estimateTextTokens("x".repeat(chunk)) <= 2_000, `chunk ${chunk} must fit the 2,000 budget`);
  });

  it("measures the longest line, not the whole text", () => {
    assert.equal(longestLineLength(""), 0);
    assert.equal(longestLineLength("abc"), 3);
    assert.equal(longestLineLength("a\nbbbb\ncc"), 4);
    assert.equal(longestLineLength("trailing\n"), 8);
    assert.equal(longestLineLength(PI_READ_LINE_LIMIT > 0 ? "a".repeat(PI_READ_LINE_LIMIT) : ""), PI_READ_LINE_LIMIT);
  });
});

describe("store", () => {
  it("encodes untrusted segments injectively and never traverses", () => {
    assert.equal(encodeSegment(""), "~");
    assert.equal(encodeSegment("."), "~002E");
    assert.equal(encodeSegment(".."), "~002E~002E");
    const traversal = encodeSegment("../../etc/passwd");
    assert.ok(!traversal.includes("/"), "no separator survives");
    // `.` is a safe character (it appears in every filename), so dot PAIRS may
    // remain as a substring — what must never survive is a separator or a
    // whole-segment `..`, and the latter is escaped above.
    assert.ok(!/^\.\.$/.test(traversal), "no whole-segment dot-dot survives");
    assert.notEqual(encodeSegment("a~b"), encodeSegment("a/b"));
    assert.equal(encodeSegment("plain-name_1.txt"), "plain-name_1.txt");
  });

  it("writes the full text and returns a readable path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spill-store-"));
    dirs.push(dir);
    process.env.TMPDIR = dir;
    const full = "payload ".repeat(5000);
    const file = await saveSpill("web_extract", "call/1", full);
    assert.ok(file.startsWith(privateRoot()));
    await stat(file);
    assert.equal(await readFile(file, "utf8"), full);
  });

  it("never overwrites an earlier spill when a call id repeats", async () => {
    const first = await saveSpill("read", "same-id", "first payload");
    const second = await saveSpill("read", "same-id", "second payload");
    assert.notEqual(first, second, "each spill is immutable");
    assert.equal(await readFile(first, "utf8"), "first payload", "the earlier path still recovers its own text");
    assert.equal(await readFile(second, "utf8"), "second payload");
  });
});
