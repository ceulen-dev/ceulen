// Ported from @bacnh85/pi-munin 0.5.12 extensions/test/unit/retry.test.ts
// (mocha/chai → node:test).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../lib/retry.js";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(async () => "ok");
    assert.equal(result, "ok");
  });

  it("retries on transient errors", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 2) throw new Error("ECONNREFUSED");
      return "recovered";
    });
    assert.equal(result, "recovered");
    assert.equal(attempts, 2);
  });

  it("retries on network errors", async () => {
    let attempts = 0;
    await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error("socket hang up");
      return "ok";
    });
    assert.equal(attempts, 3);
  });

  it("retries on timeout errors", async () => {
    let attempts = 0;
    await withRetry(async () => {
      attempts++;
      if (attempts < 2) throw new Error("ETIMEDOUT");
      return "ok";
    });
    assert.equal(attempts, 2);
  });

  it("throws after max retries", async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(async () => {
        attempts++;
        throw new Error("ECONNREFUSED");
      }),
      /ECONNREFUSED/,
    );
    assert.equal(attempts, 4); // initial + 3 retries
  });

  it("does NOT retry auth errors", async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(async () => {
        attempts++;
        throw new Error("Unauthorized");
      }),
      /Unauthorized/,
    );
    assert.equal(attempts, 1);
  });

  it("does NOT retry not_found errors", async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(async () => {
        attempts++;
        throw new Error("Memory not found");
      }),
      /not found/,
    );
    assert.equal(attempts, 1);
  });

  it("does NOT retry stale protocol errors", async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(async () => {
        attempts++;
        throw new Error("Stale protocol");
      }),
      /Stale protocol/,
    );
    assert.equal(attempts, 1);
  });

  it("does NOT retry ERR_STALE_PROTOCOL errors", async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(async () => {
        attempts++;
        throw new Error("ERR_STALE_PROTOCOL");
      }),
      /ERR_STALE_PROTOCOL/,
    );
    assert.equal(attempts, 1);
  });

  it("does NOT retry validation errors", async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(async () => {
        attempts++;
        throw new Error("Tag validation failed");
      }),
      /validation/,
    );
    assert.equal(attempts, 1);
  });

  it("retries structured transport and rate-limit errors", async () => {
    for (const error of [
      Object.assign(new Error("fetch failed"), { name: "MuninTransportError" }),
      Object.assign(new Error("slow down"), { code: "RATE_LIMITED" }),
    ]) {
      let attempts = 0;
      await withRetry(async () => {
        attempts++;
        if (attempts === 1) throw error;
        return "ok";
      });
      assert.equal(attempts, 2);
    }
  });

  it("does not retry structured auth, validation, or feature errors", async () => {
    for (const code of ["AUTH_INVALID", "VALIDATION_ERROR", "FEATURE_DISABLED"]) {
      let attempts = 0;
      await assert.rejects(
        withRetry(async () => {
          attempts++;
          throw Object.assign(new Error(code), { code });
        }),
        (error: Error) => error.message === code,
      );
      assert.equal(attempts, 1);
    }
  });
});
