// notify module — one `notify` tool: desktop notification for long-running
// work / when input is needed (herdr multi-pane ergonomics). Harmless:
// no fs, no network; spawn failures fall back to the terminal bell, so the
// tool always succeeds.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { notify } from "./lib/notify.js";

export default function notifyModule(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "notify",
    label: "Notify",
    description:
      "Send a desktop notification — for long-running work (announce completion) or when you need user input while the user is away. macOS uses osascript, Linux notify-send, else the terminal bell. Harmless: no fs/network access, and delivery failures fall back to a bell.",
    promptSnippet: "Send a desktop notification",
    parameters: Type.Object({
      message: Type.String({ description: "Notification body." }),
      title: Type.Optional(Type.String({ description: 'Notification title (default "pi").' })),
      sound: Type.Optional(Type.Boolean({ description: "Play a sound with the notification (macOS only, default false)." })),
    }),
    async execute(_toolCallId, params) {
      const p = params as { message: string; title?: string; sound?: boolean };
      const r = await notify(p);
      let text = `notified (via ${r.via}): ${p.title ?? "pi"} — ${p.message}`;
      if (r.note) text += `\n${r.note}`;
      return { content: [{ type: "text", text }], details: { via: r.via } };
    },
  });
}
