// Validates every themes/*.json loads as a pi theme: name present + unique,
// not colliding with pi's builtin names (dark/light/system are preloaded and
// win dedupe), full pi-required color token set, every value resolving to a var
// ref, #RRGGBB, 256-color index, or "", and NO unknown keys anywhere.
//
// pi 1.2.0 (dist/modes/interactive/theme/theme-schema.js) validates themes
// loaded at startup with `additionalProperties: false` at BOTH the root and
// `colors` — an unknown key throws, the loader swallows it as a diagnostic, and
// the theme silently vanishes ("Theme not found: <name>" + system fallback).
// The ALLOWED/ROOT_KEYS gates below mirror that so `npm test` catches it here.
// ponytail: adapted from @bacnh85/pi-themes scripts/validate-themes.mjs (MIT).
// Usage: node scripts/validate-themes.mjs [dir]   (dir defaults to ./themes)
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2]
  ?? join(dirname(dirname(fileURLToPath(import.meta.url))), "themes");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) {
  console.error(`no theme files found in ${dir}`);
  process.exit(1);
}

// pi's required colors token list (dist/modes/interactive/theme/theme-json.js).
const REQUIRED = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error",
  "warning", "muted", "dim", "text", "thinkingText", "selectedBg",
  "userMessageBg", "userMessageText", "customMessageBg", "customMessageText",
  "customMessageLabel", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
  "toolTitle", "toolOutput", "mdHeading", "mdLink", "mdLinkUrl", "mdCode",
  "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr",
  "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
  "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable",
  "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
  "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow",
  "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
];
// pi 1.2.0's full colors token set (THEME_TOKENS): REQUIRED plus the tokens
// that are optional because they carry a fallback.
// Source of truth: node_modules/@earendil-works/pi-coding-agent/dist/modes/
// interactive/theme/theme-tokens.js (not importable — the package `exports` map
// blocks deep subpaths). Re-derive on every pi minor bump:
//   node -p "Object.keys(require('<pi>/dist/modes/interactive/theme/theme-tokens.js').THEME_TOKENS)"
// A token pi ADDS is not a break (an unknown key only fails when we SHIP one);
// a token pi REMOVES is — this file would then allow a key pi rejects.
const ALLOWED_COLORS = new Set([
  ...REQUIRED,
  "scrollbarTrack", "scrollbarThumb", "searchMatchBg", "searchMatchText", "thinkingMax",
]);
// pi 1.2.0's root object (additionalProperties: false).
const ROOT_KEYS = new Set(["$schema", "name", "appearance", "vars", "colors", "export"]);
const EXPORT_KEYS = new Set(["pageBg", "cardBg", "infoBg"]);
const BUILTIN = new Set(["dark", "light", "system"]);

let failed = false;
const names = new Set();
const isColorValue = (v, vars) =>
  (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255)
  || v === ""
  || /^#[0-9A-Fa-f]{6}$/.test(v)
  || vars.has(v);

for (const file of files) {
  let theme;
  try {
    theme = JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch (e) {
    console.error(`${file}: not valid JSON: ${e.message}`);
    failed = true;
    continue;
  }
  const fail = (msg) => {
    console.error(`${file}: ${msg}`);
    failed = true;
  };

  if (!theme.name) fail("missing name");
  else if (BUILTIN.has(theme.name)) fail(`name collides with pi builtin: ${theme.name}`);
  else if (names.has(theme.name)) fail(`duplicate theme name: ${theme.name}`);
  else names.add(theme.name);

  const colors = theme.colors ?? {};
  const missing = REQUIRED.filter((k) => !(k in colors));
  if (missing.length) fail(`missing required tokens: ${missing.join(", ")}`);

  const unknownRoot = Object.keys(theme).filter((k) => !ROOT_KEYS.has(k));
  if (unknownRoot.length) fail(`unknown root keys: ${unknownRoot.join(", ")}`);
  const unknownColors = Object.keys(colors).filter((k) => !ALLOWED_COLORS.has(k));
  if (unknownColors.length) fail(`unknown color tokens: ${unknownColors.join(", ")}`);
  const unknownExport = Object.keys(theme.export ?? {}).filter((k) => !EXPORT_KEYS.has(k));
  if (unknownExport.length) fail(`unknown export keys: ${unknownExport.join(", ")}`);

  const vars = new Set(Object.keys(theme.vars ?? {}));
  const bad = [];
  for (const [k, v] of Object.entries({ ...theme.vars, ...colors })) {
    if (!isColorValue(v, vars)) bad.push(`${k}=${JSON.stringify(v)}`);
  }
  if (bad.length) fail(`unresolvable values: ${bad.join(", ")}`);
}

if (failed) process.exit(1);
console.log(`themes: ${files.length} files OK`);
