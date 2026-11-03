import { intersects, validRange } from "semver";

import type { IR } from "../types.js";

/** The entitlements library generated auth needs, and the range a fresh
 * scaffold pins. A caret range on 0.x never leaves its minor: `^0.1.23`
 * resolves to 0.1.24, which applies ANONYMOUS_ENTITLEMENTS to every caller
 * and has no contextual parsing. kdex-fngogen's entry-point.sh holds
 * entitlements/go to the same floor, v0.7.0. */
const ENTITLEMENTS_PACKAGE = "@kdex-tech/entitlements";
const ENTITLEMENTS_FLOOR = "0.7.0";
const ENTITLEMENTS_RANGE = `^${ENTITLEMENTS_FLOOR}`;

/** Emit `package.json` for the generated function. Written only when no
 * package.json exists yet — preserved on regen so user can add deps. */
export function emitPackageJson(ir: IR): string {
  const usesAuth = ir.hasSecurity;

  const dependencies: Record<string, string> = {
    fastify: "^5.0.0",
  };
  if (usesAuth) {
    dependencies.jose = "^5.9.0";
    dependencies["fastify-plugin"] = "^5.0.0";
    dependencies[ENTITLEMENTS_PACKAGE] = ENTITLEMENTS_RANGE;
  }

  const pkg = {
    name: "kdex-function",
    version: "0.1.0",
    private: true,
    type: "module",
    main: "dist/main.js",
    scripts: {
      build: "tsc",
      start: "node dist/main.js",
      dev: "tsx src/main.ts",
    },
    dependencies,
    devDependencies: {
      "@types/node": "^22.10.0",
      tsx: "^4.19.0",
      typescript: "^5.7.0",
    },
    engines: {
      node: ">=22",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

/** Raise the entitlements range of a preserved package.json (its text,
 * `existing`) when no version it admits reaches the floor; return the new
 * text, or undefined to leave the file alone. A range that already admits the
 * floor or higher is never lowered, and a spec that is not a semver range
 * (`file:`, a git URL, a dist-tag) is left as is. Calls `notify` with
 * the line to print. */
export function raiseEntitlementsFloor(
  existing: string,
  notify: (line: string) => void,
): string | undefined {
  const pkg = JSON.parse(existing) as { dependencies?: Record<string, string> };
  const range = pkg.dependencies?.[ENTITLEMENTS_PACKAGE];
  if (range === undefined || validRange(range) === null) return undefined;
  // includePrerelease: without it a pre-release pin at or above the floor
  // ("1.0.0-rc.1") intersects nothing and would be rewritten DOWN to ^0.7.0.
  // A pre-release of the floor itself ("0.7.0-rc.1") is still below it.
  if (intersects(range, `>=${ENTITLEMENTS_FLOOR}`, { includePrerelease: true })) return undefined;
  pkg.dependencies![ENTITLEMENTS_PACKAGE] = ENTITLEMENTS_RANGE;
  notify(
    `raised ${ENTITLEMENTS_PACKAGE} from ${range} to ${ENTITLEMENTS_RANGE} in package.json: generated auth needs >= ${ENTITLEMENTS_FLOOR}`,
  );
  return JSON.stringify(pkg, null, 2) + "\n";
}
