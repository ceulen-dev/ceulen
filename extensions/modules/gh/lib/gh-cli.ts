// ponytail: ported from oh-my-pi packages/coding-agent src/utils/github.ts +
// src/tools/gh-common.ts (lean) — the sanctioned `gh` CLI runner, repo-ref
// normalization, and shared formatters. Zero deps: everything spawns `gh`.

import { spawn, spawnSync } from "node:child_process";

/** Deadline for `gh` subprocesses (OMP GH_COMMAND_TIMEOUT_MS). */
export const GH_TIMEOUT_MS = 5 * 60_000;
/** Captured-output cap — gh can emit enormous diffs/logs. */
export const GH_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const GH_TRUNCATED_MARKER = "\n[gh subprocess output truncated after 8 MiB]\n";

/** OMP's non-interactive env: gh must never hang on a prompt or colorize piped
 *  output (a CLICOLOR_FORCE=1 in the user's shell breaks JSON parsing). */
export function ghEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_ASKPASS: "true",
    GIT_EDITOR: "true",
    GIT_TERMINAL_PROMPT: "0",
    LC_MESSAGES: "C",
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
    PAGER: "cat",
    // Force color OFF — CLICOLOR_FORCE wins over gh's own TTY detection.
    NO_COLOR: "1",
    CLICOLOR: "0",
    CLICOLOR_FORCE: "0",
  };
}

export interface GhCommandOptions {
  /** Caller passed an explicit repo; suppresses "run inside a checkout" hints. */
  repoProvided?: boolean;
}

export interface GhCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The seam every op goes through — swapped for a fake in tests. */
export interface GhRunner {
  /** Run `gh`; does NOT throw on non-zero exit. */
  run(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<GhCommandResult>;
  /** Run `gh` expecting JSON on stdout; throws on non-zero exit / bad JSON. */
  json<T = unknown>(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<T>;
  /** Run `gh` expecting text on stdout; throws on non-zero exit. */
  text(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<string>;
}

let availableCache: boolean | undefined;

/** True when the `gh` CLI is installed (cached after the first probe). */
export function ghAvailable(): boolean {
  if (availableCache === undefined) {
    try {
      const probe = spawnSync("gh", ["--version"], { stdio: "ignore", timeout: 10_000 });
      availableCache = !probe.error && probe.status === 0;
    } catch {
      availableCache = false;
    }
  }
  return availableCache;
}

/** The real runner over `node:child_process`. */
export const realGh: GhRunner = {
  async run(cwd, args, signal, options) {
    if (!ghAvailable()) {
      throw new Error("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/.");
    }
    const timeout = AbortSignal.timeout(GH_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return await new Promise<GhCommandResult>((resolveP, rejectP) => {
      const child = spawn("gh", args, { cwd, env: ghEnv(), stdio: ["ignore", "pipe", "pipe"], signal: combined });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outTotal = 0;
      let errTotal = 0;
      child.stdout!.on("data", (chunk: Buffer) => {
        outTotal += chunk.length;
        if (outTotal <= GH_OUTPUT_LIMIT_BYTES) out.push(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        errTotal += chunk.length;
        if (errTotal <= GH_OUTPUT_LIMIT_BYTES) err.push(chunk);
      });
      child.on("error", rejectP);
      child.on("close", (code) => {
        let stdout = Buffer.concat(out).toString("utf8");
        if (outTotal > GH_OUTPUT_LIMIT_BYTES) stdout += GH_TRUNCATED_MARKER;
        let stderr = Buffer.concat(err).toString("utf8");
        if (errTotal > GH_OUTPUT_LIMIT_BYTES) stderr += GH_TRUNCATED_MARKER;
        resolveP({ exitCode: code ?? -1, stdout, stderr });
      });
    });
  },

  async json(cwd, args, signal, options) {
    const r = await this.run(cwd, args, signal, options);
    if (r.exitCode !== 0) throw new Error(formatGhJsonFailure(args, r.stdout, r.stderr, options));
    try {
      return JSON.parse(r.stdout) as never;
    } catch {
      throw new Error(`gh ${args.join(" ")} returned invalid JSON: ${r.stdout.slice(0, 300)}`);
    }
  },

  async text(cwd, args, signal, options) {
    const r = await this.run(cwd, args, signal, options);
    if (r.exitCode !== 0) throw new Error(formatGhFailure(args, r.stdout, r.stderr, options));
    return r.stdout;
  },
};

// ── Failure formatting (OMP utils/github.ts) ──

export function formatGhFailure(args: readonly string[], stdout: string, stderr: string, options?: GhCommandOptions): string {
  const message = (stderr || stdout).trim();
  if (message.includes("gh auth login") || message.includes("not logged into any GitHub hosts")) {
    return "GitHub CLI is not authenticated. Run `gh auth login`.";
  }
  if (
    !options?.repoProvided &&
    (message.includes("not a git repository") ||
      message.includes("no git remotes found") ||
      message.includes("unable to determine current repository"))
  ) {
    return "GitHub repository context is unavailable. Pass `repo` explicitly or run the tool inside a GitHub checkout.";
  }
  if (message) return message;
  return `GitHub CLI command failed: gh ${args.join(" ")}`;
}

function describeGitHubApiError(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.message === "string") return rec.message.trim() || undefined;
  const resource = typeof rec.resource === "string" ? rec.resource.trim() : "";
  const field = typeof rec.field === "string" ? rec.field.trim() : "";
  const target = [resource, field].filter(Boolean).join(".");
  const code = typeof rec.code === "string" ? rec.code.trim() : "";
  return `${target}: ${code}` || target || code || undefined;
}

function parseGitHubApiErrorMessages(stdout: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!payload || typeof payload !== "object") return [];
  const rec = payload as Record<string, unknown>;
  const messages = new Set<string>();
  const summary = describeGitHubApiError(rec.message);
  if (summary) messages.add(summary);
  if (Array.isArray(rec.errors)) {
    for (const error of rec.errors) {
      const message = describeGitHubApiError(error);
      if (message) messages.add(message);
    }
  }
  return [...messages];
}

function formatGhJsonFailure(args: readonly string[], stdout: string, stderr: string, options?: GhCommandOptions): string {
  const rawMessage = (stderr || stdout).trim();
  const fallback = formatGhFailure(args, stdout, stderr, options);
  if (fallback !== rawMessage) return fallback;
  const details = parseGitHubApiErrorMessages(stdout).filter((message) => !fallback.includes(message));
  if (details.length === 0) return fallback;
  return `${fallback}\nGitHub details:\n${details.map((m) => `- ${m}`).join("\n")}`;
}

// ── Repo refs (OMP gh-common.ts) ──

const GITHUB_HOST = "github.com";

/**
 * A repository in `gh`'s `[HOST/]OWNER/REPO` form. A ref naming no host is
 * left for `gh` to resolve against GH_HOST (github.com by default).
 */
export interface GhRepoRef {
  host?: string;
  /** `OWNER/REPO`, never host-qualified. */
  slug: string;
}

/** Split `[HOST/]OWNER/REPO`; anything with another shape is taken as a slug. */
export function parseRepoRef(repo: string): GhRepoRef {
  const firstSlash = repo.indexOf("/");
  if (firstSlash < 0) return { slug: repo };
  const secondSlash = repo.indexOf("/", firstSlash + 1);
  if (secondSlash < 0 || repo.includes("/", secondSlash + 1)) return { slug: repo };
  return { host: repo.slice(0, firstSlash), slug: repo.slice(firstSlash + 1) };
}

/** Join a known host and `OWNER/REPO` into the form `--repo` accepts. */
export function formatRepoRef(host: string | undefined, slug: string): string {
  return host ? `${host}/${slug}` : slug;
}

/** `gh api` endpoint paths carry no host, so a ref names its host with a flag. */
export function ghApiHostArgs(ref: GhRepoRef): string[] {
  return ref.host ? ["--hostname", ref.host] : [];
}

export function defaultGhHost(): string {
  return (process.env.GH_HOST || GITHUB_HOST).toLowerCase();
}

const REPO_URL_PATTERN = /^https?:\/\/([^/]+)\/([^/]+)\/([^/?#]+)/;

/** `https://HOST/OWNER/REPO` → repository identity, keeping non-default hosts. */
export function repoFromUrl(value: string | undefined): string | undefined {
  const match = REPO_URL_PATTERN.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const host = match[1].toLowerCase();
  const slug = `${match[2]}/${match[3]}`;
  return host === defaultGhHost() ? slug : formatRepoRef(host, slug);
}

/** A full URL identifier already names host/repo/number; `--repo` would clash. */
export function appendRepoFlag(args: string[], repo: string | undefined, identifier?: string): void {
  if (!repo || identifier?.startsWith("https://")) return;
  args.push("--repo", repo);
}

function effectiveHost(ref: GhRepoRef): string {
  return ref.host?.toLowerCase() ?? defaultGhHost();
}

/** Case-insensitive repo comparison over the instance each ref resolves to. */
export function githubRepoSlugEquals(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const leftRef = parseRepoRef(left);
  const rightRef = parseRepoRef(right);
  if (effectiveHost(leftRef) !== effectiveHost(rightRef)) return false;
  return leftRef.slug.toLowerCase() === rightRef.slug.toLowerCase();
}

// ── Default-repo resolution (memoized per cwd, OMP gh-common.ts) ──

const DEFAULT_REPO_RESOLVED = new Map<string, string>();

async function resolveRepoFromCwd(cwd: string, signal?: AbortSignal): Promise<string> {
  const url = await realGh.text(cwd, ["repo", "view", "--json", "url", "-q", ".url"], signal);
  const repo = repoFromUrl(url);
  if (!repo) throw new Error(`GitHub CLI returned an unrecognized repository URL: ${url}`);
  return repo;
}

/** Current checkout → `[HOST/]OWNER/REPO`, memoized per absolute cwd. */
export async function resolveDefaultRepoMemoized(cwd: string, signal?: AbortSignal): Promise<string> {
  const key = cwd;
  const ready = DEFAULT_REPO_RESOLVED.get(key);
  if (ready) return ready;
  const value = await resolveRepoFromCwd(key, signal);
  DEFAULT_REPO_RESOLVED.set(key, value);
  return value;
}

/** Best-effort memoized cwd → repo; failures swallow to undefined. */
export async function tryResolveCurrentRepo(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await resolveDefaultRepoMemoized(cwd, signal);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective repo for an op: explicit `repo` param wins, then a
 * run/PR URL's embedded repo, then the cwd checkout. A mismatch between an
 * explicit repo and the URL's repo is an error (OMP resolveGitHubRepo).
 */
export async function resolveGitHubRepo(cwd: string, repo: string | undefined, urlRepo: string | undefined, signal?: AbortSignal): Promise<string> {
  if (repo && urlRepo && !githubRepoSlugEquals(repo, urlRepo)) {
    throw new Error("URL repository does not match the provided repo");
  }
  if (repo) return repo;
  if (urlRepo) return urlRepo;
  try {
    return await resolveDefaultRepoMemoized(cwd, signal);
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\nGitHub repository context is unavailable. Pass \`repo\` explicitly or run the tool inside a GitHub checkout.`,
    );
  }
}

// ── Shared text formatters (OMP gh-common.ts) ──

export function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trim();
}

export function normalizeBlock(value: string | null | undefined): string {
  return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trimEnd();
}

export function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

export function requireNonEmpty(value: unknown, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

/** Push `Label: value` only when value is non-empty (OMP pushLine). */
export function pushLine(lines: string[], label: string, value: string | number | boolean | undefined | null): void {
  if (value === undefined || value === null || value === "") return;
  lines.push(`${label}: ${value}`);
}

export function formatShortSha(sha: string | undefined | null): string | undefined {
  return sha ? sha.slice(0, 8) : undefined;
}

export function formatAuthor(author: { login?: string; name?: string } | null | undefined): string | undefined {
  if (!author) return undefined;
  if (author.login) return `@${author.login}`;
  if (author.name) return author.name;
  return undefined;
}

export function formatLabels(labels: { name?: string }[] | undefined): string | undefined {
  const names = labels?.map((l) => l.name).filter((n): n is string => Boolean(n)) ?? [];
  return names.length > 0 ? names.join(", ") : undefined;
}
