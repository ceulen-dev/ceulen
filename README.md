# Ceulen

**The Pi coding agent, fully dressed.**

Pi's minimal core + one bundle extension carrying the complete toolkit — everything wired behind a single `/ceulen config` command. Named for Ludolph van Ceulen, who spent his life computing π to 35 digits (they're carved on his tombstone); in 17th-century Germany, π was literally called *die Ceulensche Zahl*.

## What it is

A [Pi](https://github.com/earendil-works/pi) distro in the form of one extension bundle:

- **One install** — no assembling 38 separate extensions; the suite ships as a unit
- **One command** — `/ceulen config` for every knob (or plain `/config` when ceulen is active)
- **One surface** — modules register cleanly into Pi's native UX: tools, commands, flags, events
- **Selective adoption** — every module has an individual kill-switch; disable what you don't use, keep the rest of the bundle intact
- **No core patches** — ceulen rides Pi's public extension API only, so upstream Pi upgrades stay drop-in

## Install

```sh
npm install -g ceulen
```

Then start Pi in your project directory — ceulen's modules load automatically.

## Status

**Pre-release (0.1.0).** Name reserved; module consolidation from the pi-extensions fleet in progress. Design record: [`docs/`](./docs) — architecture decision, extension audit, naming research.

## Modules

Planned (consolidating from the pi-extensions fleet — see the audit in `docs/`):

notify · cron · references · ponytail · classifier · a2a · budget · checkpoint · model-tools · permission · plan · web · memory · review · … (full list in the compatibility audit)

Each module can be disabled individually via Pi settings — see `/ceulen config` once shipped.

## License

MIT
