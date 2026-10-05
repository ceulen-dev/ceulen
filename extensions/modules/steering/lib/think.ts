// think — OMP's private scratchpad tool, ported into steering.
//
// ponytail: ported from oh-my-pi packages/coding-agent/src/tools/think.ts —
// scratchpad only. OMP's companion `externalThinking` mode (suppressing native
// provider reasoning and replacing it with this tool) is deliberately NOT
// ported: OMP ships a "providers flagged this request shape as abuse" warning
// on that setting, and pi's per-model thinking levels are the honest off-switch.
//
// Value: models running with thinking off (cheap router tiers) get a place to
// plan that renders as one dim marker in the transcript instead of rambling
// assistant prose. The call args still reach the model on later rounds (that's
// the scratchpad); the user sees a dot.
//
// Renderers MUST return a pi-tui Component (Text), not a raw string — a string
// crashes ToolExecutionComponent with "this.child.render is not a function"
// (uncaughtException, live 2026-10-05). The todo module's renderResult is the
// precedent.

import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { readDisabledTools } from "../../../lib/tools.js";

/** The dim marker shown in place of the thoughts. */
export const THINK_MARKER = "·";

/** Minimal theme shim (todo lib/render.ts pattern) — pi's Theme is cast to
 *  this at the call site. */
export interface ThinkTheme {
  fg(token: string, text: string): string;
}

export interface ThinkParams {
  thoughts: string;
}

/** The `think` tool definition. Renderers receive pi's theme at render time —
 *  no theme captured at registration. */
export function thinkTool() {
  return {
    name: "think" as const,
    label: "Think",
    description:
      "Private scratchpad for planning notes. The transcript shows only a dim marker — the user never sees the content. " +
      "Use it to organize multi-step work before acting, especially on complex refactors or debugging.",
    promptGuidelines: ["Use the think tool to plan before complex multi-step work."],
    // kill-switch: ceulen.disabledTools names it → registers inactive (the
    // config module's tool rows flip it live via setActiveTools).
    defaultActive: !readDisabledTools().has("think"),
    parameters: Type.Object(
      { thoughts: Type.String({ description: "private scratchpad; not shown to user" }) },
      { additionalProperties: false },
    ),
    async execute() {
      return { content: [{ type: "text" as const, text: "—" }] };
    },
    renderCall(args: ThinkParams, theme?: ThinkTheme) {
      const n = typeof args?.thoughts === "string" ? args.thoughts.length : 0;
      const line = theme?.fg ? theme.fg("dim", `· think${n > 0 ? ` (${n} chars)` : ""}`) : `· think${n > 0 ? ` (${n} chars)` : ""}`;
      return new Text(line, 0, 0);
    },
    renderResult(_result: unknown, _options: unknown, theme?: ThinkTheme) {
      return new Text(theme?.fg ? theme.fg("dim", THINK_MARKER) : THINK_MARKER, 0, 0);
    },
  };
}
