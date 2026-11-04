/**
 * Child-session identity — inbound A2A dispatches and extension-loading
 * subagent children run child pi sessions IN THIS PROCESS. Pi re-invokes the
 * ceulen factories for each child (during the child's resourceLoader.reload),
 * but ES-module scope is shared by every factory invocation, so a child's
 * session lifecycle must never write module-scope state. Live incident
 * (2026-11): the first inbound dispatch blanked the host TUI's entire status
 * band — the child's session_shutdown cleared composer's module-scope
 * liveCtx, and the band shape had replaced pi's native footer, so model,
 * cwd, git and context vanished until restart. Same family: the child's
 * shutdown cleared the classifier registry (host classify/planGate died),
 * killed the host's background subagent tasks, stopped the shared serena
 * worker, reset the usage band stores, and re-armed cron's process timer
 * onto a disposed child.
 *
 * Two primitives:
 * - isChildSession(ctx.sessionManager): EVENT-time gate. Handlers that write
 *   module-scope state drop events from marked sessions. The child keeps
 *   everything registered at factory load plus its own per-turn handlers —
 *   only per-session bookkeeping of shared state is host-owned. pi -p and
 *   RPC hosts are never marked (no child is ever created inside them), so
 *   headless pi keeps working unchanged.
 * - childFactoryDepth(): FACTORY-LOAD-time gate (cron's process timer,
 *   router's refresh interval). Factories run during child creation; the
 *   runners open the window around resourceLoader.reload() only.
 */

const childSessionManagers = new WeakSet<object>();
let depth = 0;

/** Mark a session manager as belonging to an in-process child session. */
export function markChildSession(sm: unknown): void {
  if (sm && typeof sm === "object") childSessionManagers.add(sm as object);
}

/** Whether this ctx belongs to an in-process child session (a2a inbound
 *  dispatch, subagent SDK child). */
export function isChildSession(sm: unknown): boolean {
  return !!sm && typeof sm === "object" && childSessionManagers.has(sm as object);
}

/** Open a child-creation window: ceulen factories re-run inside it. Must be
 *  paired with endChildFactory() in a finally — a leaked depth would disarm
 *  the host's process timer for the rest of the process lifetime. */
export function beginChildFactory(): void {
  depth += 1;
}

/** Close a child-creation window. Floors at 0: a stray end must never
 *  underflow into negative depth (which would read as "host" forever). */
export function endChildFactory(): void {
  depth = Math.max(0, depth - 1);
}

/** Current child-creation depth. >0 while child factories/session_start run. */
export function childFactoryDepth(): number {
  return depth;
}
