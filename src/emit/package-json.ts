import type { IR } from "../types.js";

/** Emit `package.json` for the generated function. Written only when no
 * package.json exists yet — preserved on regen so user can add deps. */
export function emitPackageJson(ir: IR): string {
  const usesPaseto =
    ir.securityFlags.apiKeyHeader ||
    ir.securityFlags.apiKeyQuery ||
    ir.securityFlags.apiKeyCookie;
  const usesAuth = ir.securityFlags.hasSecurity;
  const usesCookieScheme = ir.securityFlags.apiKeyCookie;

  const dependencies: Record<string, string> = {
    fastify: "^5.0.0",
  };
  if (usesAuth) {
    dependencies.jose = "^5.9.0";
    dependencies["fastify-plugin"] = "^5.0.0";
    dependencies["@kdex-tech/entitlements"] = "^0.1.23";
  }
  if (usesPaseto) {
    dependencies.paseto = "^3.1.4";
  }
  if (usesCookieScheme) {
    dependencies["@fastify/cookie"] = "^11.0.0";
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
