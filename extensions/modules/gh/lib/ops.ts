// ponytail: ported from oh-my-pi tools/{gh-search,gh-view,gh-run-watch}.ts
// (lean) — one executor per read-only op, each returning markdown-ish text.
// All ops take the GhRunner seam so tests inject a fake.

import {
  appendRepoFlag,
  formatAuthor,
  formatLabels,
  formatRepoRef,
  formatShortSha,
  ghApiHostArgs,
  normalizeBlock,
  normalizeOptionalString,
  normalizeText,
  parseRepoRef,
  pushLine,
  requireNonEmpty,
  type GhRunner,
} from "./gh-cli.js";
import { readRunWatchTimeoutSecs } from "../configPanel.js";

export interface GhParams {
  repo?: string;
  branch?: string;
  path?: string;
  pr?: string;
  query?: string;
  since?: string;
  until?: string;
  dateField?: "created" | "updated";
  limit?: number;
  run?: string;
  tail?: number;
}

// ── Search plumbing (OMP gh-search.ts) ──

export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_MAX = 50;
const FILE_PREVIEW_LIMIT = 50;
const BODY_CAP = 4000;

function resolveSearchLimit(value: number | undefined): number {
  if (value === undefined) return SEARCH_LIMIT_DEFAULT;
  if (!Number.isFinite(value) || value <= 0) throw new Error("limit must be a positive number");
  return Math.min(Math.floor(value), SEARCH_LIMIT_MAX);
}

export function composeSearchQuery(parts: ReadonlyArray<string | undefined>): string {
  const cleaned: string[] = [];
  for (const part of parts) {
    const trimmed = part?.trim();
    if (trimmed) cleaned.push(trimmed);
  }
  if (cleaned.length === 0) throw new Error("query is required (or pass since/until to filter by date)");
  return cleaned.join(" ");
}

const RELATIVE_DURATION_PATTERN = /^(\d+)\s*(m|h|d|w|mo|y)$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FIXED_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** Date bound → GitHub-search literal (`YYYY-MM-DD` or seconds-precision ISO). */
export function parseSearchDateBound(raw: string, now: Date = new Date()): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("date bound must not be empty");
  const relMatch = trimmed.match(RELATIVE_DURATION_PATTERN);
  if (relMatch) {
    const count = Number(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const fixedMs = FIXED_UNIT_MS[unit];
    let bound: Date;
    if (fixedMs !== undefined) {
      bound = new Date(now.getTime() - count * fixedMs);
    } else {
      bound = new Date(now);
      if (unit === "mo") bound.setUTCMonth(bound.getUTCMonth() - count);
      else bound.setUTCFullYear(bound.getUTCFullYear() - count);
    }
    return bound.toISOString().slice(0, 10);
  }
  if (ISO_DATE_PATTERN.test(trimmed)) return trimmed;
  const parsedMs = Date.parse(trimmed);
  if (!Number.isNaN(parsedMs)) {
    return new Date(parsedMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  throw new Error(`invalid date bound: ${raw}. Expected a relative duration like "3d", "12h", "2w", an ISO date "YYYY-MM-DD", or an ISO datetime.`);
}

export function buildSearchDateQualifier(field: string, since?: string, until?: string, now?: Date): string | undefined {
  const sinceVal = since ? parseSearchDateBound(since, now) : undefined;
  const untilVal = until ? parseSearchDateBound(until, now) : undefined;
  if (sinceVal && untilVal) return `${field}:${sinceVal}..${untilVal}`;
  if (sinceVal) return `${field}:>=${sinceVal}`;
  if (untilVal) return `${field}:<=${untilVal}`;
  return undefined;
}

export function resolveSearchDateField(command: "issues" | "prs" | "commits" | "repos", requested?: "created" | "updated"): string {
  if (command === "commits") return "committer-date";
  const dateField = requested ?? "created";
  if (command === "repos" && dateField === "updated") return "pushed";
  return dateField;
}

/** Qualifiers that already scope a search — no default `repo:<current>` on top. */
export const REPO_SCOPE_QUALIFIER_PATTERN = /(?:^|\s)-?(?:repo|org|user|owner):\S/i;

async function resolveSearchRepoScope(gh: GhRunner, cwd: string, repo: string | undefined, query: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
  if (repo) return repo;
  if (query && REPO_SCOPE_QUALIFIER_PATTERN.test(query)) return undefined;
  return await tryResolveCurrentRepoVia(gh, cwd, signal);
}

function searchScope(repo: string | undefined): { qualifier?: string; host?: string } {
  if (!repo) return {};
  const ref = parseRepoRef(repo);
  return { qualifier: `repo:${ref.slug}`, host: ref.host };
}

function buildGhApiSearchArgs(endpoint: "issues" | "code" | "commits" | "repositories", query: string, limit: number, options?: { host?: string; extraHeaders?: string[] }): string[] {
  const args = ["api"];
  if (options?.host) args.push("--hostname", options.host);
  args.push("-X", "GET", `/search/${endpoint}`, "-f", `q=${query}`, "-F", `per_page=${limit}`);
  for (const header of options?.extraHeaders ?? []) args.push("-H", header);
  return args;
}

interface GhApiUser { login?: string; name?: string }
interface GhApiLabel { name?: string }
interface GhApiSearchIssueItem {
  number?: number; title?: string; state?: string; created_at?: string; updated_at?: string;
  html_url?: string; user?: GhApiUser; labels?: GhApiLabel[];
  pull_request?: { merged_at?: string | null }; repository_url?: string;
}
interface GhApiSearchCodeItem {
  path?: string; sha?: string; html_url?: string;
  repository?: { full_name?: string }; text_matches?: { fragment?: string; property?: string }[];
}
interface GhApiSearchCommitItem {
  sha?: string; html_url?: string; node_id?: string;
  author?: GhApiUser | null; committer?: GhApiUser | null;
  repository?: { full_name?: string };
  commit?: { message?: string; author?: { name?: string; date?: string }; committer?: { name?: string; date?: string } };
}
interface GhApiSearchRepoItem {
  full_name?: string; description?: string; language?: string; html_url?: string;
  stargazers_count?: number; forks_count?: number; open_issues_count?: number;
  updated_at?: string; archived?: boolean; fork?: boolean; private?: boolean; visibility?: string;
}
interface GhApiSearchResponse<T> { total_count?: number; items?: T[] }

/** Best-effort memoized cwd → repo through the injected runner. */
async function tryResolveCurrentRepoVia(gh: GhRunner, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await resolveDefaultRepoVia(gh, cwd, signal);
  } catch {
    return undefined;
  }
}

/** Memoized cwd → repo via the runner seam (test-injectable twin of gh-cli's). */
const REPO_CACHE = new Map<string, string>();
async function resolveDefaultRepoVia(gh: GhRunner, cwd: string, signal?: AbortSignal): Promise<string> {
  const ready = REPO_CACHE.get(cwd);
  if (ready) return ready;
  const url = await gh.text(cwd, ["repo", "view", "--json", "url", "-q", ".url"], signal);
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/?#]+)/.exec(url.trim());
  if (!match) throw new Error(`GitHub CLI returned an unrecognized repository URL: ${url}`);
  const host = match[1].toLowerCase();
  const repo = host === "github.com" ? `${match[2]}/${match[3]}` : formatRepoRef(host, `${match[2]}/${match[3]}`);
  REPO_CACHE.set(cwd, repo);
  return repo;
}

function repoFromRepositoryUrl(value: string | undefined): string | undefined {
  return value ? (/\/repos\/([^/]+\/[^/]+)$/.exec(value)?.[1] ?? undefined) : undefined;
}

function formatSearchResults(kind: "issues" | "pull requests", query: string, repo: string | undefined, items: GhApiSearchIssueItem[]): string {
  const lines: string[] = [`# GitHub ${kind} search`, "", `Query: ${query}`];
  pushLine(lines, "Repository", repo);
  pushLine(lines, "Results", items.length);
  if (items.length === 0) {
    lines.push("", `No ${kind} found.`);
    return lines.join("\n").trim();
  }
  for (const item of items) {
    lines.push("");
    lines.push(`- #${item.number ?? "?"} ${item.title ?? "Untitled"}`);
    pushLine(lines, "  Repo", repoFromRepositoryUrl(item.repository_url));
    pushLine(lines, "  State", item.pull_request?.merged_at ? "merged" : item.state);
    pushLine(lines, "  Author", formatAuthor(item.user));
    pushLine(lines, "  Labels", formatLabels(item.labels));
    pushLine(lines, "  Created", item.created_at);
    pushLine(lines, "  Updated", item.updated_at);
    pushLine(lines, "  URL", item.html_url);
  }
  return lines.join("\n").trim();
}

function formatSearchCodeResults(query: string, repo: string | undefined, items: GhApiSearchCodeItem[]): string {
  const lines: string[] = [`# GitHub code search`, "", `Query: ${query}`];
  pushLine(lines, "Repository", repo);
  pushLine(lines, "Results", items.length);
  if (items.length === 0) {
    lines.push("", "No code matches found.");
    return lines.join("\n").trim();
  }
  for (const item of items) {
    lines.push("");
    lines.push(`- ${item.path ?? "(unknown path)"}`);
    pushLine(lines, "  Repo", item.repository?.full_name);
    pushLine(lines, "  Commit", formatShortSha(item.sha));
    pushLine(lines, "  URL", item.html_url);
    const fragment = item.text_matches?.find((m) => m.fragment)?.fragment;
    if (fragment) pushLine(lines, "  Match", normalizeText(fragment).split("\n", 1)[0]);
  }
  return lines.join("\n").trim();
}

function formatSearchCommitsResults(query: string, repo: string | undefined, items: GhApiSearchCommitItem[]): string {
  const lines: string[] = [`# GitHub commits search`, "", `Query: ${query}`];
  pushLine(lines, "Repository", repo);
  pushLine(lines, "Results", items.length);
  if (items.length === 0) {
    lines.push("", "No commits found.");
    return lines.join("\n").trim();
  }
  for (const item of items) {
    lines.push("");
    const sha = formatShortSha(item.sha) ?? "(unknown sha)";
    const subject = normalizeText(item.commit?.message).split("\n", 1)[0] || "(no commit message)";
    lines.push(`- ${sha} ${subject}`);
    pushLine(lines, "  Repo", item.repository?.full_name);
    pushLine(lines, "  Author", formatAuthor(item.author) ?? item.commit?.author?.name);
    pushLine(lines, "  Date", item.commit?.author?.date ?? item.commit?.committer?.date);
    pushLine(lines, "  URL", item.html_url);
  }
  return lines.join("\n").trim();
}

function formatSearchReposResults(query: string, items: GhApiSearchRepoItem[]): string {
  const lines: string[] = [`# GitHub repositories search`, "", `Query: ${query}`];
  pushLine(lines, "Results", items.length);
  if (items.length === 0) {
    lines.push("", "No repositories found.");
    return lines.join("\n").trim();
  }
  for (const item of items) {
    lines.push("");
    lines.push(`- ${item.full_name ?? "(unknown repository)"}`);
    const description = normalizeText(item.description).split("\n", 1)[0];
    if (description) pushLine(lines, "  Description", description);
    pushLine(lines, "  Language", item.language);
    pushLine(lines, "  Stars", item.stargazers_count);
    pushLine(lines, "  Forks", item.forks_count);
    pushLine(lines, "  Open issues", item.open_issues_count);
    pushLine(lines, "  Updated", item.updated_at);
    pushLine(lines, "  URL", item.html_url);
  }
  return lines.join("\n").trim();
}

async function searchIssuesOrPrs(gh: GhRunner, cwd: string, params: GhParams, kind: "is:issue" | "is:pr", signal?: AbortSignal): Promise<string> {
  const limit = resolveSearchLimit(params.limit);
  const command = kind === "is:pr" ? "prs" : "issues";
  const dateField = resolveSearchDateField(command, params.dateField);
  const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
  const displayQuery = composeSearchQuery([params.query, dateQualifier]);
  const repo = await resolveSearchRepoScope(gh, cwd, normalizeOptionalString(params.repo), displayQuery, signal);
  const scope = searchScope(repo);
  const apiQuery = composeSearchQuery([displayQuery, scope.qualifier, kind]);
  const args = buildGhApiSearchArgs("issues", apiQuery, limit, { host: scope.host });
  const response = await gh.json<GhApiSearchResponse<GhApiSearchIssueItem>>(cwd, args, signal);
  const items = response.items ?? [];
  return formatSearchResults(kind === "is:pr" ? "pull requests" : "issues", displayQuery, repo, items);
}

export async function executeSearchIssues(gh: GhRunner, cwd: string, params: GhParams, signal?: AbortSignal): Promise<string> {
  return await searchIssuesOrPrs(gh, cwd, params, "is:issue", signal);
}

export async function executeSearchPrs(gh: GhRunner, cwd: string, params: GhParams, signal?: AbortSignal): Promise<string> {
  return await searchIssuesOrPrs(gh, cwd, params, "is:pr", signal);
}

export async function executeSearchCode(gh: GhRunner, cwd: string, params: GhParams, signal?: AbortSignal): Promise<string> {
  const query = requireNonEmpty(params.query, "query");
  if (params.since !== undefined || params.until !== undefined) {
    throw new Error("search_code does not support since/until; GitHub code search has no date qualifier.");
  }
  const limit = resolveSearchLimit(params.limit);
  const repo = await resolveSearchRepoScope(gh, cwd, normalizeOptionalString(params.repo), query, signal);
  const scope = searchScope(repo);
  const apiQuery = composeSearchQuery([query, scope.qualifier]);
  const args = buildGhApiSearchArgs("code", apiQuery, limit, {
    host: scope.host,
    extraHeaders: ["Accept: application/vnd.github.text-match+json"],
  });
  const response = await gh.json<GhApiSearchResponse<GhApiSearchCodeItem>>(cwd, args, signal);
  return formatSearchCodeResults(query, repo, response.items ?? []);
}

export async function executeSearchCommits(gh: GhRunner, cwd: string, params: GhParams, signal?: AbortSignal): Promise<string> {
  const limit = resolveSearchLimit(params.limit);
  const dateField = resolveSearchDateField("commits", params.dateField);
  const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
  const displayQuery = composeSearchQuery([params.query, dateQualifier]);
  const repo = await resolveSearchRepoScope(gh, cwd, normalizeOptionalString(params.repo), displayQuery, signal);
  const scope = searchScope(repo);
  const apiQuery = composeSearchQuery([displayQuery, scope.qualifier]);
  const args = buildGhApiSearchArgs("commits", apiQuery, limit, { host: scope.host });
  const response = await gh.json<GhApiSearchResponse<GhApiSearchCommitItem>>(cwd, args, signal);
  return formatSearchCommitsResults(displayQuery, repo, response.items ?? []);
}

export async function executeSearchRepos(gh: GhRunner, cwd: string, params: GhParams, signal?: AbortSignal): Promise<string> {
  const limit = resolveSearchLimit(params.limit);
  const dateField = resolveSearchDateField("repos", params.dateField);
  const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
  const query = composeSearchQuery([params.query, dateQualifier]);
  const args = buildGhApiSearchArgs("repositories", query, limit);
  const response = await gh.json<GhApiSearchResponse<GhApiSearchRepoItem>>(cwd, args, signal);
  return formatSearchReposResults(query, response.items ?? []);
}

// ── repo_view (OMP gh-view.ts) ──

export const GH_REPO_FIELDS = [
  "nameWithOwner", "description", "url", "defaultBranchRef", "homepageUrl", "forkCount",
  "isArchived", "isFork", "primaryLanguage", "repositoryTopics", "stargazerCount",
  "updatedAt", "viewerPermission", "visibility",
].join(",");

interface GhRepoViewData {
  nameWithOwner?: string; description?: string; url?: string;
  defaultBranchRef?: { name?: string }; homepageUrl?: string; forkCount?: number;
  isArchived?: boolean; isFork?: boolean; primaryLanguage?: { name?: string };
  repositoryTopics?: { name?: string; topic?: { name?: string } }[]; stargazerCount?: number;
  updatedAt?: string; viewerPermission?: string; visibility?: string;
}

export function formatRepoView(data: GhRepoViewData, input: { repo?: string; branch?: string }): string {
  const lines: string[] = [];
  const name = data.nameWithOwner ?? input.repo ?? "GitHub Repository";
  lines.push(`# ${name}`, "");
  lines.push(normalizeText(data.description) || "No description provided.", "");
  pushLine(lines, "URL", data.url);
  pushLine(lines, "Default branch", data.defaultBranchRef?.name);
  pushLine(lines, "Branch", normalizeOptionalString(input.branch));
  pushLine(lines, "Visibility", data.visibility);
  pushLine(lines, "Viewer permission", data.viewerPermission);
  pushLine(lines, "Primary language", data.primaryLanguage?.name);
  pushLine(lines, "Stars", data.stargazerCount);
  pushLine(lines, "Forks", data.forkCount);
  pushLine(lines, "Archived", data.isArchived);
  pushLine(lines, "Fork", data.isFork);
  pushLine(lines, "Updated", data.updatedAt);
  pushLine(lines, "Homepage", data.homepageUrl);
  const topics = data.repositoryTopics?.map((t) => t.name ?? t.topic?.name).filter((v): v is string => Boolean(v)).join(", ");
  pushLine(lines, "Topics", topics || undefined);
  return lines.join("\n").trim();
}

export async function executeRepoView(gh: GhRunner, cwd: string, params: GhParams, signal?: AbortSignal): Promise<string> {
  const repo = normalizeOptionalString(params.repo);
  const branch = normalizeOptionalString(params.branch);
  const args = ["repo", "view"];
  if (repo) args.push(repo);
  if (branch) args.push("--branch", branch);
  args.push("--json", GH_REPO_FIELDS);
  const data = await gh.json<GhRepoViewData>(cwd, args, signal);
  return formatRepoView(data, { repo, branch });
}

// ── file_read (OMP gh.ts executeFileRead) ──

interface GhContentsFile {
  type?: string; encoding?: string; size?: number; content?: string; html_url?: string | null;
}

const BINARY_SNIFF_BYTES = 8000;

function isProbablyBinary(bytes: Buffer): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

/** Recognized image magic bytes — isProbablyBinary's NUL sniff is true for
 *  every real raster format, so the extension branch must win first (F10a). */
const IMAGE_MAGIC: Array<{ ext: string; test: (b: Buffer) => boolean }> = [
  { ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", test: (b) => b.subarray(0, 3).toString("latin1") === "GIF" },
  { ext: "webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

export async function executeFileRead(gh: GhRunner, cwd: string, params: GhParams, signal?: AbortSignal): Promise<{ text: string; image?: { data: string; mimeType: string } }> {
  const repo = await resolveGitHubRepoVia(gh, cwd, normalizeOptionalString(params.repo), undefined, signal);
  const filePath = requireNonEmpty(params.path, "path");
  if (filePath.startsWith("/")) throw new Error("path must be repository-relative");
  const branch = normalizeOptionalString(params.branch);
  const endpointPath = filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const ref = parseRepoRef(repo);
  const args = [
    "api",
    ...ghApiHostArgs(ref),
    `/repos/${ref.slug}/contents/${endpointPath}`,
    "--method", "GET",
    "-H", "Accept: application/vnd.github+json",
    "-H", "Accept-Encoding: identity",
  ];
  if (branch) args.push("-f", `ref=${branch}`);
  let response: GhContentsFile;
  try {
    response = await gh.json<GhContentsFile>(cwd, args, signal, { repoProvided: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub file read failed for '${repo}@${branch ?? "HEAD"}:${filePath}': ${message}`);
  }
  const fallbackHost = ref.host ?? "github.com";
  const sourceUrl = response.html_url || `https://${fallbackHost}/${ref.slug}/blob/${encodeURIComponent(branch ?? "HEAD")}/${endpointPath}`;
  if (response.encoding !== "base64" || typeof response.content !== "string") {
    return { text: `[GitHub did not return file bytes for '${filePath}'. Open ${sourceUrl} to view it.]` };
  }
  const encoded = response.content.replaceAll(/\s/g, "");
  const bytes = Buffer.from(encoded, "base64");
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const mime = IMAGE_MIME[ext];
  // Recognized image EXTENSION wins FIRST (F10a): real PNG/JPEG/GIF/WebP all
  // contain NUL bytes in the first 8KB, so the binary sniff would report
  // "Cannot read binary file" for every actual image. Magic bytes gate the
  // image block so a text file with an image extension still degrades to the
  // binary/text paths below.
  if (mime && IMAGE_MAGIC.some((m) => m.ext === ext && m.test(bytes))) {
    return { text: `Image file: ${filePath}`, image: { data: encoded, mimeType: mime } };
  }
  if (isProbablyBinary(bytes)) {
    return { text: `[Cannot read binary file '${filePath}' (${bytes.length} bytes); not valid UTF-8 text. Open ${sourceUrl} to view it.]` };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length > 100_000) {
      return { text: `${text.slice(0, 100_000)}\n[truncated after 100 KB — open ${sourceUrl} for the full file]` };
    }
    return { text };
  } catch {
    return { text: `[Cannot read binary file '${filePath}' (${bytes.length} bytes); not valid UTF-8 text. Open ${sourceUrl} to view it.]` };
  }
}

/** resolveGitHubRepo via the runner seam (tests inject; prod passes realGh). */
async function resolveGitHubRepoVia(gh: GhRunner, cwd: string, repo: string | undefined, urlRepo: string | undefined, signal?: AbortSignal): Promise<string> {
  if (repo && urlRepo && repo !== urlRepo) throw new Error("URL repository does not match the provided repo");
  if (repo) return repo;
  if (urlRepo) return urlRepo;
  try {
    return await resolveDefaultRepoVia(gh, cwd, signal);
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\nGitHub repository context is unavailable. Pass \`repo\` explicitly or run the tool inside a GitHub checkout.`);
  }
}

// ── pr_view (OMP gh-view.ts) ──

export const GH_PR_FIELDS = [
  "author", "baseRefName", "body", "createdAt", "files", "headRefName", "isDraft",
  "labels", "mergeStateStatus", "number", "reviews", "reviewDecision", "state", "title", "updatedAt", "url",
].join(",");

interface GhPrFile { path?: string; changeType?: string; additions?: number; deletions?: number }
interface GhPrReview { author?: GhApiUser | null; body?: string; submittedAt?: string; state?: string; commit?: { oid?: string } }
interface GhPrViewData {
  number?: number; title?: string; state?: string; isDraft?: boolean; author?: GhApiUser | null;
  baseRefName?: string; headRefName?: string; body?: string; createdAt?: string; updatedAt?: string;
  labels?: GhApiLabel[]; mergeStateStatus?: string; reviewDecision?: string; url?: string;
  files?: GhPrFile[]; reviews?: GhPrReview[];
}

function formatPrFiles(files: GhPrFile[] | undefined): string[] {
  if (!files || files.length === 0) return [];
  const lines: string[] = [`## Files (${files.length})`, ""];
  for (const file of files.slice(0, FILE_PREVIEW_LIMIT)) {
    lines.push(`- ${file.path ?? "(unknown file)"} [${file.changeType ?? "CHANGED"}] (+${file.additions ?? 0} -${file.deletions ?? 0})`);
  }
  if (files.length > FILE_PREVIEW_LIMIT) lines.push(`[…${files.length - FILE_PREVIEW_LIMIT} files elided…]`);
  return lines;
}

function capBody(body: string | undefined): string {
  const text = normalizeText(body) || "No description provided.";
  return text.length > BODY_CAP ? `${text.slice(0, BODY_CAP)}\n[body truncated after ${BODY_CAP} chars]` : text;
}

export function formatPrView(data: GhPrViewData, input: { pr?: string }): string {
  const lines: string[] = [];
  lines.push(`# Pull Request #${data.number ?? input.pr ?? "current"}: ${data.title ?? "Untitled"}`, "");
  pushLine(lines, "State", data.state);
  pushLine(lines, "Draft", data.isDraft);
  pushLine(lines, "Author", formatAuthor(data.author));
  pushLine(lines, "Base", data.baseRefName);
  pushLine(lines, "Head", data.headRefName);
  pushLine(lines, "Review decision", data.reviewDecision);
  pushLine(lines, "Merge state", data.mergeStateStatus);
  pushLine(lines, "Created", data.createdAt);
  pushLine(lines, "Updated", data.updatedAt);
  pushLine(lines, "Labels", formatLabels(data.labels));
  pushLine(lines, "URL", data.url);
  lines.push("", "## Body", "", capBody(data.body));
  const fileSection = formatPrFiles(data.files);
  if (fileSection.length > 0) lines.push("", ...fileSection);
  if (data.reviews && data.reviews.length > 0) {
    lines.push("", `## Reviews (${data.reviews.length})`, "");
    for (const review of data.reviews) {
      const author = formatAuthor(review.author) ?? "unknown";
      const submittedAt = review.submittedAt ? ` - ${review.submittedAt}` : "";
      const state = review.state ? ` [${review.state}]` : "";
      lines.push(`### ${author}${submittedAt}${state}`, "");
      lines.push(capBody(review.body), "");
    }
  }
  return lines.join("\n").trim();
}

export async function executePrView(gh: GhRunner, cwd: string, params: GhParams, signal?: AbortSignal): Promise<string> {
  const pr = requireNonEmpty(params.pr, "pr");
  let repo = normalizeOptionalString(params.repo);
  // A full PR URL embeds the repo — prefer it, pass the URL as the identifier.
  const urlMatch = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr);
  if (urlMatch) {
    repo = repo ?? formatRepoRef(urlMatch[1], urlMatch[2]);
  }
  if (!repo) {
    repo = await resolveGitHubRepoVia(gh, cwd, undefined, undefined, signal);
  }
  const args = ["pr", "view", pr];
  appendRepoFlag(args, repo, pr);
  args.push("--json", GH_PR_FIELDS);
  const data = await gh.json<GhPrViewData>(cwd, args, signal, { repoProvided: true });
  return formatPrView(data, { pr });
}

// ── pr_diff (OMP gh-pr-diff.ts, lean) ──

export async function executePrDiff(gh: GhRunner, cwd: string, params: GhParams, signal?: AbortSignal): Promise<string> {
  const pr = requireNonEmpty(params.pr, "pr");
  let repo = normalizeOptionalString(params.repo);
  const urlMatch = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr);
  if (urlMatch) repo = repo ?? formatRepoRef(urlMatch[1], urlMatch[2]);
  if (!repo) {
    repo = await resolveGitHubRepoVia(gh, cwd, undefined, undefined, signal);
  }
  const args = ["pr", "diff", pr];
  appendRepoFlag(args, repo, pr);
  const diff = await gh.text(cwd, args, signal, { repoProvided: true });
  if (diff.length > 100_000) {
    return `${diff.slice(0, 100_000)}\n[diff truncated after 100 KB]`;
  }
  return diff;
}

// ── run_watch (OMP gh-run-watch.ts, lean poller) ──

export const RUN_WATCH_TAIL_DEFAULT = 15;
export const RUN_WATCH_TAIL_MAX = 200;
export const RUN_WATCH_INTERVAL_DEFAULT = 3;
export const RUN_WATCH_INTERVAL_SLOW = 15;
export const RUN_WATCH_FAST_WINDOW_MS = 60_000;

const RUN_URL_PATTERN = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/.*)?$/;
const RUN_SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const RUN_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const JOB_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

export function resolveTailLimit(value: number | undefined): number {
  if (value === undefined) return RUN_WATCH_TAIL_DEFAULT;
  if (!Number.isFinite(value) || value <= 0) throw new Error("tail must be a positive number");
  return Math.min(Math.floor(value), RUN_WATCH_TAIL_MAX);
}

export function parseRunReference(value: string | undefined): { repo?: string; runId?: number } {
  const run = normalizeOptionalString(value);
  if (!run) return {};
  if (/^\d+$/.test(run)) return { runId: Number(run) };
  const match = run.match(RUN_URL_PATTERN);
  if (!match) throw new Error("run must be a numeric workflow run ID or a full GitHub Actions run URL");
  return { repo: formatRepoRef(match[1], match[2]), runId: Number(match[3]) };
}

interface GhActionsJobApi {
  id?: number; name?: string; status?: string; conclusion?: string;
  started_at?: string; completed_at?: string; html_url?: string;
}
interface GhActionsRunApi {
  id?: number; name?: string; display_title?: string; status?: string; conclusion?: string;
  head_branch?: string; head_sha?: string; created_at?: string; updated_at?: string; html_url?: string;
}
interface GhRunJobSnapshot {
  id: number; name: string; status?: string; conclusion?: string;
  startedAt?: string; completedAt?: string; url?: string;
}
interface GhRunSnapshot {
  id: number; workflowName?: string; displayTitle?: string; status?: string; conclusion?: string;
  branch?: string; headSha?: string; createdAt?: string; updatedAt?: string; url?: string;
  jobs: GhRunJobSnapshot[];
}

export function isFailedJob(job: GhRunJobSnapshot): boolean {
  return job.conclusion !== undefined && JOB_FAILURE_CONCLUSIONS.has(job.conclusion);
}

export function getRunOutcome(value: string | undefined): "success" | "failure" | "pending" {
  if (!value) return "pending";
  if (RUN_SUCCESS_CONCLUSIONS.has(value)) return "success";
  if (RUN_FAILURE_CONCLUSIONS.has(value)) return "failure";
  return "pending";
}

async function fetchRunJobs(gh: GhRunner, cwd: string, repo: string, runId: number, signal?: AbortSignal): Promise<GhRunJobSnapshot[]> {
  const ref = parseRepoRef(repo);
  const response = await gh.json<{ jobs?: GhActionsJobApi[]; total_count?: number }>(
    cwd,
    ["api", ...ghApiHostArgs(ref), "--method", "GET", `/repos/${ref.slug}/actions/runs/${runId}/jobs?per_page=100`],
    signal,
    { repoProvided: true },
  );
  return (response.jobs ?? [])
    .filter((job): job is GhActionsJobApi & { id: number } => typeof job.id === "number")
    .map((job) => ({
      id: job.id,
      name: normalizeOptionalString(job.name) ?? `job-${job.id}`,
      status: normalizeOptionalString(job.status),
      conclusion: normalizeOptionalString(job.conclusion),
      startedAt: normalizeOptionalString(job.started_at),
      completedAt: normalizeOptionalString(job.completed_at),
      url: normalizeOptionalString(job.html_url),
    }));
}

export async function fetchRunSnapshot(gh: GhRunner, cwd: string, repo: string, runId: number, signal?: AbortSignal): Promise<GhRunSnapshot> {
  const ref = parseRepoRef(repo);
  const run = await gh.json<GhActionsRunApi>(cwd, ["api", ...ghApiHostArgs(ref), "--method", "GET", `/repos/${ref.slug}/actions/runs/${runId}`], signal, { repoProvided: true });
  const jobs = await fetchRunJobs(gh, cwd, repo, runId, signal);
  if (typeof run.id !== "number") throw new Error("GitHub Actions run response did not include a run ID.");
  return {
    id: run.id,
    workflowName: normalizeOptionalString(run.name),
    displayTitle: normalizeOptionalString(run.display_title),
    status: normalizeOptionalString(run.status),
    conclusion: normalizeOptionalString(run.conclusion),
    branch: normalizeOptionalString(run.head_branch),
    headSha: normalizeOptionalString(run.head_sha),
    createdAt: normalizeOptionalString(run.created_at),
    updatedAt: normalizeOptionalString(run.updated_at),
    url: normalizeOptionalString(run.html_url),
    jobs,
  };
}

function renderJobsSection(jobs: GhRunJobSnapshot[]): string[] {
  const lines: string[] = [`## Jobs (${jobs.length})`, ""];
  for (const job of jobs) {
    const dur = job.startedAt && job.completedAt
      ? ` (${Math.max(1, Math.round((Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000))}s)`
      : "";
    lines.push(`- ${job.name}: ${job.status ?? "?"}${job.conclusion ? ` / ${job.conclusion}` : ""}${dur}`);
  }
  return lines;
}

function formatRunWatchResult(repo: string, run: GhRunSnapshot, failedJobLogs: { name: string; tail?: string }[]): string {
  const failedJobs = run.jobs.filter(isFailedJob);
  const lines: string[] = [`# GitHub Actions Run #${run.id}`, ""];
  pushLine(lines, "Repository", repo);
  pushLine(lines, "Workflow", run.workflowName);
  pushLine(lines, "Title", run.displayTitle);
  pushLine(lines, "Branch", run.branch);
  pushLine(lines, "Status", run.status);
  pushLine(lines, "Conclusion", run.conclusion);
  pushLine(lines, "URL", run.url);
  lines.push("", ...renderJobsSection(run.jobs));
  if (failedJobs.length > 0) {
    lines.push("", `## Failed job logs (tail)`, "");
    for (const log of failedJobLogs) {
      lines.push(`### ${log.name}`, "");
      lines.push(log.tail ?? "(log unavailable)", "");
    }
    lines.push("Run failed.");
  } else if (getRunOutcome(run.conclusion) === "success") {
    lines.push("", "All jobs passed.");
  } else {
    lines.push("", "Run completed without successful jobs, but no failed job logs were available.");
  }
  return lines.join("\n").trim();
}

function tailLogLines(log: string, tail: number): string | undefined {
  const normalized = normalizeBlock(log);
  if (!normalized) return undefined;
  return normalized.split("\n").slice(-tail).join("\n").trimEnd();
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolveP, rejectP) => {
    const timer = setTimeout(resolveP, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      rejectP(new Error("Operation aborted"));
    }, { once: true });
  });

/**
 * Poll a workflow run until it completes; on failure tail each failed job's
 * logs. Watch budget comes from `timeoutMs` (gh.runWatchTimeoutSecs, default
 * 600s) — each gh poll stays bounded by gh-cli's own per-spawn deadline.
 */
export async function executeRunWatch(gh: GhRunner, cwd: string, params: GhParams, signal?: AbortSignal, timeoutMs = 600_000): Promise<string> {
  const runReference = parseRunReference(params.run);
  const runId = runReference.runId;
  if (runId === undefined) throw new Error("run_watch requires `run` (workflow run ID or Actions run URL)");
  const repo = await resolveGitHubRepoVia(gh, cwd, normalizeOptionalString(params.repo), runReference.repo, signal);
  const tail = resolveTailLimit(params.tail);
  // Honor the configured budget as-is (F10b) — the old Math.min(…, 295s) cap
  // silently halved the documented 600s default. Floor 10s so a misconfigured
  // 0/negative still terminates; each poll is bounded by gh-cli's GH_TIMEOUT_MS.
  const deadline = Date.now() + Math.max(10_000, timeoutMs);
  const watchStartMs = Date.now();
  const intervalSeconds = () => (Date.now() - watchStartMs < RUN_WATCH_FAST_WINDOW_MS ? RUN_WATCH_INTERVAL_DEFAULT : RUN_WATCH_INTERVAL_SLOW);

  let pollCount = 0;
  for (;;) {
    if (signal?.aborted) throw new Error("Operation aborted");
    pollCount += 1;
    const run = await fetchRunSnapshot(gh, cwd, repo, runId, signal);
    const failedJobs = run.jobs.filter(isFailedJob);
    const runCompleted = run.status === "completed";

    if (runCompleted || failedJobs.length > 0 || Date.now() >= deadline) {
      if (Date.now() >= deadline && !runCompleted) {
        return `${formatRunWatchResult(repo, run, [])}\n\nNote: watch budget elapsed while the run was still ${run.status}. Re-invoke run_watch with the same run id to keep watching.`;
      }
      const failedJobLogs: { name: string; tail?: string }[] = [];
      const ref = parseRepoRef(repo);
      for (const job of failedJobs) {
        const r = await gh.run(cwd, ["api", ...ghApiHostArgs(ref), `/repos/${ref.slug}/actions/jobs/${job.id}/logs`], signal);
        failedJobLogs.push({ name: job.name, tail: r.exitCode === 0 ? tailLogLines(r.stdout, tail) : undefined });
      }
      return formatRunWatchResult(repo, run, failedJobLogs);
    }
    await sleep(intervalSeconds() * 1000, signal);
  }
}

/** The dispatcher — maps op → executor. Order mirrors OMP's switch. */
export async function executeOp(op: string, gh: GhRunner, cwd: string, params: GhParams, signal?: AbortSignal): Promise<{ text: string; image?: { data: string; mimeType: string } }> {
  switch (op) {
    case "repo_view":
      return { text: await executeRepoView(gh, cwd, params, signal) };
    case "file_read":
      return await executeFileRead(gh, cwd, params, signal);
    case "pr_view":
      return { text: await executePrView(gh, cwd, params, signal) };
    case "pr_diff":
      return { text: await executePrDiff(gh, cwd, params, signal) };
    case "search_issues":
      return { text: await executeSearchIssues(gh, cwd, params, signal) };
    case "search_prs":
      return { text: await executeSearchPrs(gh, cwd, params, signal) };
    case "search_code":
      return { text: await executeSearchCode(gh, cwd, params, signal) };
    case "search_commits":
      return { text: await executeSearchCommits(gh, cwd, params, signal) };
    case "search_repos":
      return { text: await executeSearchRepos(gh, cwd, params, signal) };
    case "run_watch":
      return { text: await executeRunWatch(gh, cwd, params, signal, readRunWatchTimeoutSecs() * 1000) };
    default:
      throw new Error(`Unknown github op: ${op}`);
  }
}
