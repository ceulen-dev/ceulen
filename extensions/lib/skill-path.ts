// Shared skills/ root resolution for every module's resources_discover handler.
//
// `new URL("../../../skills/", import.meta.url).pathname` is WRONG on Windows:
// the WHATWG URL pathname keeps the authority-style leading slash and percent
// encoding, so a file URL like file:///C:/repo/skills/ yields "/C:/repo/skills/".
// fs.realpathSync("/C:/...") then resolves against the CURRENT drive's root
// (e.g. D:\) and load dies with `ENOENT ... lstat 'D:\C:'`.
// fileURLToPath decodes and strips the leading slash on drive-letter paths,
// giving the native `C:\repo\skills\` shape.

import { fileURLToPath } from "node:url";

// This file sits at extensions/lib/, so the repo-root skills/ dir is TWO
// levels up (modules/<name>/index.ts callers need three — they import this
// helper instead of building the URL themselves).
//
// ponytail: assumes the standard in-repo layout (extensions/lib/ next to
// skills/). A future relocated build should set an explicit package-root
// constant here rather than deepen the relative walk.
export function skillsRoot(): string {
  return fileURLToPath(new URL("../../skills/", import.meta.url));
}
