// Parent side of the advisor marker protocol (subagent herdr runner):
// contract pin + parse behaviour. A malformed marker must read as "no
// signal" — never as "review in progress" (that would stall a dispatch).

import assert from "node:assert/strict";
import { test } from "node:test";

import { ADVISOR_MARKER_ENV, parseAdvisorMarker } from "../../../lib/advisor-marker.ts";

test("marker protocol wire name is the documented contract", () => {
  assert.equal(ADVISOR_MARKER_ENV, "CEULEN_ADVISOR_MARKER");
});

test("parseAdvisorMarker: valid reviewing/done payloads round-trip", () => {
  assert.deepEqual(parseAdvisorMarker(JSON.stringify({ phase: "reviewing", steered: false, at: 123 })), {
    phase: "reviewing",
    steered: false,
    at: 123,
  });
  assert.deepEqual(parseAdvisorMarker(JSON.stringify({ phase: "done", steered: true, at: 456 })), {
    phase: "done",
    steered: true,
    at: 456,
  });
});

test("parseAdvisorMarker: corrupt/absent/unknown shapes are 'no signal'", () => {
  assert.equal(parseAdvisorMarker(undefined), undefined);
  assert.equal(parseAdvisorMarker(""), undefined);
  assert.equal(parseAdvisorMarker(null), undefined);
  assert.equal(parseAdvisorMarker("{not json"), undefined);
  assert.equal(parseAdvisorMarker(JSON.stringify({ phase: "nope", at: 1 })), undefined);
  assert.equal(parseAdvisorMarker(JSON.stringify({ phase: "done" })), undefined, "missing timestamp");
  assert.equal(parseAdvisorMarker(JSON.stringify({ phase: "done", at: "soon" })), undefined, "non-numeric timestamp");
});

test("parseAdvisorMarker: steered coerces to a strict boolean", () => {
  assert.equal(parseAdvisorMarker(JSON.stringify({ phase: "done", at: 1 }))?.steered, false);
  assert.equal(parseAdvisorMarker(JSON.stringify({ phase: "done", at: 1, steered: "yes" }))?.steered, false);
});
