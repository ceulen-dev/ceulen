// ponytail: vendored from @kalera/munin-sdk 1.6.0
// (dist/{client,capabilities,errors,maintenance,types,writeQueue}.js +
// node/fileWriteQueue.js) — zero deps, so the bundle keeps its no-runtime-deps rule.
//
// Server write gate (as of 2026-11-26): the capabilities response advertises
// `clients["@kalera/munin-sdk"].minimum = 1.6.0`, and /api/mcp/action rejects a
// write whose envelope `client.version` is below it with ERR_CLIENT_OUTDATED.
// The envelope version comes from CLIENT_VERSION in client.ts, so bumping the
// vendored SDK means bumping that constant in the same commit — sdk.test.ts
// case 1 parses THIS header and fails when the two drift.
//
// Local deltas vs upstream (each marked inline):
//   1. capabilities cache is keyed `${baseUrl}|${apiKey}` — upstream cached one
//      un-keyed global, so a session that switched munin servers read the other
//      server's capabilities (and its write gate).
//   2. fetchCapabilities takes a timeoutMs and arms AbortSignal.timeout —
//      upstream could hang forever on a dead capabilities endpoint.
//   3. CLIENT_VERSION is exported (and is 1.6.0, matching the server's minimum).
//   4. NEW pre-write version gate in invoke(): when the server advertises a
//      higher minimum for this client, a write fails BEFORE the POST with
//      ERR_CLIENT_OUTDATED instead of after it. Missing/malformed minimum fails
//      open — the server stays authoritative.
//   5. types: ERR_CLIENT_OUTDATED in MuninError["code"], optional `clients` on
//      MuninCapabilities.
//
// ponytail: ceiling — this module constructs the client with `writeQueue: false`
// (see index.ts), so the maintenance/queue machinery below (maintenance.ts,
// writeQueue.ts, node/fileWriteQueue.ts) is dormant: a write during a server
// maintenance window surfaces MuninMaintenanceError with queued:false rather
// than being saved and replayed. Flipping that one boolean (and nothing else)
// turns local queueing on; the vendored files are kept so that path is real.

export * from "./types.js";
export * from "./errors.js";
export * from "./capabilities.js";
export * from "./client.js";
export * from "./maintenance.js";
export * from "./writeQueue.js";
