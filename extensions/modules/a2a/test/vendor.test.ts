/** Vendor layout guard — proves the vendored bonjour tree resolves with the
 *  relative-require patches (no bare specifiers, no node_modules anywhere,
 *  no npm install needed). */
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./chai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.join(here, "..", "vendor");

describe("vendor tree", () => {
  it("resolves the vendored bonjour-service via createRequire (relative patches complete)", () => {
    const requireVendored = createRequire(import.meta.url);
    const mod: any = requireVendored(
      path.join(vendorDir, "vendored_deps", "bonjour-service", "dist", "index.js"),
    );
    const Bonjour = mod.Bonjour ?? mod.default?.Bonjour;
    assert.equal(typeof Bonjour, "function", "Bonjour constructor exported");
    // The constructor must actually run — mdns-server.js's patched requires
    // (multicast-dns, fast-deep-equal/es6) only load on instantiation.
    const instance = new Bonjour({}, () => {});
    assert.equal(typeof instance.publish, "function");
    assert.equal(typeof instance.unpublishAll, "function");
    assert.equal(typeof instance.destroy, "function");
    try { instance.destroy(); } catch { /* best-effort socket close */ }
  });

  it("ships every transitive dep in the flat vendored_deps layout", () => {
    for (const dep of ["bonjour-service", "multicast-dns", "dns-packet", "fast-deep-equal", "ip-codec", "thunky"]) {
      assert.isTrue(fs.existsSync(path.join(vendorDir, "vendored_deps", dep)), `${dep} vendored`);
    }
  });

  it("contains NO node_modules path component (pack + gitignore exclusion guard)", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    for (const file of walk(vendorDir)) {
      assert.equal(file.includes("node_modules"), false, `vendor path must not contain node_modules: ${file}`);
    }
    // And every require in the tree is either relative or a node builtin.
    for (const file of walk(vendorDir).filter((f) => /\.(js|cjs)$/.test(f))) {
      const src = fs.readFileSync(file, "utf-8");
      for (const m of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = m[1]!;
        const relative = spec.startsWith("./") || spec.startsWith("../");
        const builtin = /^(fs|os|events|dgram|net|dns|util|path|crypto|buffer|assert|stream|child_process|querystring|zlib|http|https)$/.test(spec.replace(/^node:/, ""));
        assert.isTrue(relative || builtin, `${path.relative(vendorDir, file)}: bare require("${spec}") must be localized`);
      }
    }
  });
});
