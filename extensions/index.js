/**
 * ceulen — the Pi coding agent, fully dressed.
 *
 * One bundle extension: consolidates the pi-extensions fleet into a single
 * factory with a unified /ceulen config command and per-module kill-switches.
 * Every module registers only through Pi's public extension API — no core
 * patches, so upstream Pi upgrades stay drop-in.
 *
 * Status: scaffold. Modules land in waves (see docs/02-extension-compatibility.md).
 */

// ponytail: module registry grows by append — one object per module, loader
// stays ~10 lines forever, no plugin framework
const MODULES = [
  // { name: "notify", load: (pi) => import("./modules/notify.js") },  // wave 1
  // { name: "cron", load: (pi) => import("./modules/cron.js") },      // wave 1
  // { name: "references", load: (pi) => import("./modules/references.js") }, // wave 1
  // { name: "ponytail", load: (pi) => import("./modules/ponytail.js") },     // wave 1
  // { name: "classifier", load: (pi) => import("./modules/classifier.js") }, // wave 1
];

export default function ceulen(pi) {
  let enabled = MODULES; // ponytail: read from settings + per-module kill-switch in wave 1

  pi.registerCommand("ceulen", {
    description: "Ceulen config — module toggles and suite settings",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Ceulen ${MODULES.length} modules registered (scaffold — config UI lands with wave 1)`,
        "info",
      );
    },
  });

  for (const m of enabled) {
    try {
      m.load(pi);
    } catch (err) {
      pi.logger?.error?.(`ceulen: module ${m.name} failed to load: ${err?.message ?? err}`);
    }
  }
}
