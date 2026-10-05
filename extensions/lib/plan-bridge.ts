// Cross-module contract: the plan module publishes whether plan mode is
// currently active; the permission module reads it to stay silent while plan
// mode owns tool gating (otherwise both fire tool_call prompts on the same
// call — double prompting). Flag, not event chaining, so registration order
// never matters. Inert unless both modules are loaded: with plan disabled the
// flag simply never becomes true.
let planActive = false;

/** True while plan mode is on (plan module writes, permission module reads). */
export function isPlanActive(): boolean {
  return planActive;
}

/** Publish the plan-mode state. Called by the plan module at every
 *  `planModeEnabled` assignment site (toggle, restore, exit-for-execution). */
export function setPlanActive(active: boolean): void {
  planActive = active;
}
