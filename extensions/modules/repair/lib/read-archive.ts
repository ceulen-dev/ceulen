// read-archive — archive members through the wrapped read (OMP
// read-archive.ts idea, ponytail shape: shell out to `tar`/`unzip`, present
// on every darwin/linux target, instead of vendoring a zip reader).
//
// Grammar (peeled progressively by index.ts when the literal path misses):
//   pkg.tgz                  → member listing
//   pkg.tgz:src/x.ts         → member content
//   pkg.tgz:src/x.ts:50-80   → member content, then the existing line ranges
// Member match: exact first, then unique substring (OMP findSuffixMatch
// semantics); ambiguous → error listing candidates. 1 MB cap before
// buffering; NUL byte in the first 8 KB → refusal (binary member).

import { execFileSync } from "node:child_process";

/** Member bytes buffered before refusing/truncating. */
export const MEMBER_MAX_BYTES = 1024 * 1024;
/** Entry-listing cap. */
export const LISTING_MAX = 500;
const TAR_TIMEOUT_MS = 10_000;

export type ArchiveKind = "tar" | "tgz" | "zip";

/** Archive extension → kind (order matters: .tar.gz before .gz-less). */
export function archiveKind(path: string): ArchiveKind | null {
  const p = path.toLowerCase();
  if (p.endsWith(".tar.gz") || p.endsWith(".tgz")) return "tgz";
  if (p.endsWith(".tar")) return "tar";
  if (p.endsWith(".zip")) return "zip";
  return null;
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { timeout: TAR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
}

/** `tar -tf` / `unzip -Z1` listing parsed to member paths. Directories and
 *  PaxHeaders are dropped. Exported for tests. */
export function listMembers(archive: string, kind: ArchiveKind): string[] {
  const out = kind === "zip" ? run("unzip", ["-Z1", archive]) : run("tar", ["-tf", archive]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.endsWith("/") &&
        !l.startsWith("PaxHeader") &&
        !l.includes("/PaxHeader") &&
        // bsdtar may print './'-prefixed members
        l !== "." && l !== "./",
    );
}

/** Match a member: exact, then unique substring (OMP findSuffixMatch). */
export function matchMember(members: string[], wanted: string): { member: string; via: "exact" | "suffix" } | { error: string } {
  const wantedNorm = wanted.replace(/^\.\//, "");
  const exact = members.find((m) => m === wantedNorm || m === `./${wantedNorm}` || m.replace(/^\.\//, "") === wantedNorm);
  if (exact) return { member: exact, via: "exact" };
  const hits = members.filter((m) => m.replace(/^\.\//, "").endsWith(wantedNorm));
  if (hits.length === 1) return { member: hits[0]!, via: "suffix" };
  if (hits.length > 1) {
    return { error: `ambiguous member "${wanted}" — ${hits.length} candidates:\n${hits.slice(0, 10).map((h) => `  ${h}`).join("\n")}` };
  }
  return { error: `no member matching "${wanted}"` };
}

/** Extract one member's bytes (tar -xOf / unzip -p). Throws on missing. */
function extractMember(archive: string, kind: ArchiveKind, member: string): Buffer {
  const cmd = kind === "zip" ? "unzip" : "tar";
  const args = kind === "zip" ? ["-p", archive, member] : ["-xOf", archive, member];
  // execFileSync with a Buffer return keeps binary bytes intact.
  return execFileSync(cmd, args, { timeout: TAR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
}

export interface ArchiveReadResult {
  text: string;
}

/** Read an archive (no selector) → listing. */
export function readArchiveListing(archive: string, kind: ArchiveKind, displayPath: string): ArchiveReadResult {
  const members = listMembers(archive, kind);
  const shown = members.slice(0, LISTING_MAX);
  const footer = members.length > shown.length ? `\n[showing ${shown.length} of ${members.length} members]` : "";
  return { text: `${displayPath} — ${members.length} member(s)\n${shown.join("\n")}${footer}` };
}

/** Read one member (optionally pre-sliced by the caller's line ranges). */
export function readArchiveMember(archive: string, kind: ArchiveKind, member: string, displayPath: string): ArchiveReadResult {
  const members = listMembers(archive, kind);
  const match = matchMember(members, member);
  if ("error" in match) return { text: `${displayPath} : ${member}\n${match.error}` };
  const buf = extractMember(archive, kind, match.member);
  if (buf.length > MEMBER_MAX_BYTES) {
    return { text: `${displayPath} : ${match.member}\nmember is ${buf.length} bytes (cap ${MEMBER_MAX_BYTES}) — extract with bash, then read the file.` };
  }
  if (buf.subarray(0, 8192).includes(0)) {
    return { text: `${displayPath} : ${match.member}\nbinary member — extract with bash (tar -xOf / unzip -p), then read the file.` };
  }
  const text = buf.toString("utf8");
  return { text: `${displayPath} : ${match.member}${match.via === "suffix" ? ` (matched ${match.member})` : ""}\n${text}` };
}
