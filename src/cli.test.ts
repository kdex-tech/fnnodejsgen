import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { run } from "./cli.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = resolve(REPO_ROOT, "test-fixtures");

function makeTarget(name: string): string {
  return mkdtempSync(join(tmpdir(), `kdex-fnnodejsgen-${name}-`));
}

const ENTITLEMENTS_DIR = resolve(REPO_ROOT, "../kdex-entitlements/typescript");

/** The newest packed `@kdex-tech/entitlements` tarball beside this repo, which
 * emitted scaffolds install in place of the registry package; undefined when
 * none is packed. Globbed rather than pinned so a version bump does not
 * silently turn the scaffold tests into skips. */
function findEntitlementsTarball(): string | undefined {
  if (!existsSync(ENTITLEMENTS_DIR)) return undefined;
  const [newest] = readdirSync(ENTITLEMENTS_DIR)
    .filter((f) => /^kdex-tech-entitlements-.+\.tgz$/.test(f))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return newest === undefined ? undefined : join(ENTITLEMENTS_DIR, newest);
}

const ENTITLEMENTS_TARBALL = findEntitlementsTarball();
const NO_TARBALL =
  `no kdex-tech-entitlements-*.tgz in ${ENTITLEMENTS_DIR}; ` +
  "run `npm run build && npm pack` there to enable the scaffold tests";

/** With REQUIRE_SCAFFOLD_TESTS=1 (CI, a release check) a missing tarball fails
 * the scaffold tests instead of silently skipping them. */
const REQUIRE_SCAFFOLD_TESTS = process.env.REQUIRE_SCAFFOLD_TESTS === "1";

/** The tarball, or: skip the test (or fail it, under REQUIRE_SCAFFOLD_TESTS). */
function requireTarball(ctx: { skip: (note?: string) => never }): string {
  if (ENTITLEMENTS_TARBALL !== undefined) return ENTITLEMENTS_TARBALL;
  if (REQUIRE_SCAFFOLD_TESTS) throw new Error(`REQUIRE_SCAFFOLD_TESTS=1: ${NO_TARBALL}`);
  return ctx.skip(NO_TARBALL);
}

/** Install the emitted scaffold's dependencies, the local entitlements
 * tarball included. */
function installScaffold(target: string, tarball: string): void {
  execSync(`npm install ${tarball} --no-audit --no-fund --silent`, {
    cwd: target,
    stdio: "ignore",
  });
  execSync("npm install --no-audit --no-fund --silent", {
    cwd: target,
    stdio: "ignore",
  });
}

const ALL_FIXTURES = [
  "openapi-spec.json",
  "openapi-spec-bearer.json",
  "openapi-spec-bearer-2.json",
  "openapi-spec-oauth2.json",
  "openapi-spec-openIdConnect.json",
  "openapi-spec-apikey-header.json",
  "openapi-spec-apikey-cookie.json",
  "openapi-spec-apikey-query.json",
];

describe("CLI — file set produced per fixture", () => {
  for (const fixture of ALL_FIXTURES) {
    it(`${fixture} emits the expected file set`, async () => {
      const target = makeTarget(fixture.replace(/\W/g, "-"));
      try {
        await run({ spec: join(FIXTURES, fixture), target });
        for (const f of [
          "api/types.gen.ts",
          "api/schemas.gen.ts",
          "api/service.gen.ts",
          "api/security.gen.ts",
          "api/routes.gen.ts",
          "src/main.ts",
          "src/auth.ts",
          "src/default.ts",
          "src/custom.ts",
          "package.json",
          "tsconfig.json",
          "project.toml",
          "openapi.json",
        ]) {
          expect(existsSync(join(target, f)), `${fixture} should emit ${f}`).toBe(true);
        }
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    });
  }
});

describe("CLI — Service interface shape", () => {
  it("has one method per operationId in the bearer-2 fixture (two ops)", async () => {
    const target = makeTarget("bearer2-shape");
    try {
      await run({ spec: join(FIXTURES, "openapi-spec-bearer-2.json"), target });
      const service = readFileSync(join(target, "api/service.gen.ts"), "utf8");
      expect(service).toMatch(/genV1UsersIdGet\s*\(/);
      expect(service).toMatch(/genV1UsersIdPut\s*\(/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("no-auth fixture exports a Service with one method and no auth import", async () => {
    const target = makeTarget("noauth-shape");
    try {
      await run({ spec: join(FIXTURES, "openapi-spec.json"), target });
      const service = readFileSync(join(target, "api/service.gen.ts"), "utf8");
      const main = readFileSync(join(target, "src/main.ts"), "utf8");
      const auth = readFileSync(join(target, "src/auth.ts"), "utf8");
      expect(service).toMatch(/genV1UsersIdPut\s*\(/);
      expect(main).not.toMatch(/auth\.js/);
      expect(auth).toMatch(/no security requirements/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("CLI — security.gen.ts reflects the spec", () => {
  it("apikey-cookie fixture emits only bearer per-operation requirements", async () => {
    const target = makeTarget("apikey-cookie-sec");
    try {
      await run({ spec: join(FIXTURES, "openapi-spec-apikey-cookie.json"), target });
      const security = readFileSync(join(target, "api/security.gen.ts"), "utf8");
      expect(security).toMatch(/genV1UsersIdPut: \[\{ bearer: \[\] \}\]/);
      // The declared schemes no longer shape the function side.
      expect(security).not.toMatch(/securitySchemes|securityFlags|apiKey/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("CLI — auth.ts verifies only the FAT bearer token", () => {
  // kdex-tech/fngogen#18: a function accepts only the host-minted JWT (FAT)
  // from `Authorization: Bearer` and authorizes on its `entitlements` claim.
  // PASETO, apiKey, cookie and `scope`/`scopes`/`scp` claims never apply.
  const FORBIDDEN = /paseto|verifyPaseto|"scp"|"scopes?"|X-API-TOKEN|api_token/;
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  for (const fixture of [
    "openapi-spec-oauth2.json",
    "openapi-spec-openIdConnect.json",
    "openapi-spec-apikey-header.json",
    "openapi-spec-apikey-cookie.json",
    "openapi-spec-apikey-query.json",
  ]) {
    it(`${fixture} emits a bearer-only auth.ts reading entitlements`, async () => {
      const target = makeTarget(`${fixture.replace(/\W/g, "-")}-fat`);
      try {
        await run({ spec: join(FIXTURES, fixture), target });
        const auth = stripComments(readFileSync(join(target, "src/auth.ts"), "utf8"));
        expect(auth).not.toMatch(FORBIDDEN);
        expect(auth).not.toMatch(/claimKeyForScheme|cookies?\b/i);
        const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
        expect(pkg.dependencies).not.toHaveProperty("paseto");
        expect(pkg.dependencies).not.toHaveProperty("@fastify/cookie");
        expect(pkg.dependencies).toHaveProperty("jose");
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    });
  }

  it("declared securitySchemes without operation-level security yield no auth plugin", async () => {
    const target = makeTarget("schemes-no-op-security");
    const spec = join(target, "spec.json");
    try {
      const doc = JSON.parse(readFileSync(join(FIXTURES, "openapi-spec-bearer.json"), "utf8"));
      delete doc.security;
      for (const item of Object.values(doc.paths) as Record<string, Record<string, unknown>>[]) {
        for (const op of Object.values(item)) {
          if (op && typeof op === "object") delete op.security;
        }
      }
      expect(doc.components.securitySchemes).toBeDefined();
      writeFileSync(spec, JSON.stringify(doc), "utf8");
      await run({ spec, target });
      expect(readFileSync(join(target, "src/auth.ts"), "utf8")).toMatch(/no security requirements/);
      const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
      expect(pkg.dependencies).not.toHaveProperty("jose");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("CLI — overwrite policy", () => {
  it("preserves src/custom.ts but refreshes the generated files on re-run", async () => {
    const target = makeTarget("regen");
    try {
      await run({ spec: join(FIXTURES, "openapi-spec-bearer.json"), target });
      const customPath = join(target, "src/custom.ts");
      const pkgPath = join(target, "package.json");
      const servicePath = join(target, "api/service.gen.ts");

      const userEdit = "// USER EDIT — must survive regen\n";
      writeFileSync(customPath, userEdit + readFileSync(customPath, "utf8"), "utf8");

      const userPkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      userPkg.dependencies["my-extra-dep"] = "^1.0.0";
      writeFileSync(pkgPath, JSON.stringify(userPkg, null, 2), "utf8");

      // Touch the service file with a sentinel to confirm it gets overwritten.
      writeFileSync(servicePath, "// THIS SHOULD BE REPLACED\n", "utf8");

      await run({ spec: join(FIXTURES, "openapi-spec-bearer.json"), target });

      expect(readFileSync(customPath, "utf8")).toContain("USER EDIT");
      const newPkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      expect(newPkg.dependencies["my-extra-dep"]).toBe("^1.0.0");
      expect(readFileSync(servicePath, "utf8")).not.toContain("THIS SHOULD BE REPLACED");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("CLI — the entitlements library floor", () => {
  // Generated auth needs @kdex-tech/entitlements >= 0.7.0: a caret range on
  // 0.1.x never leaves 0.1.x, and 0.1.24 applies ANONYMOUS_ENTITLEMENTS to
  // every caller. Same floor as kdex-fngogen's entry-point.sh (go/v0.7.0).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const pkgDeps = (target: string): Record<string, string> =>
    JSON.parse(readFileSync(join(target, "package.json"), "utf8")).dependencies;

  /** Generate, set the entitlements range, then regenerate. */
  async function regenWith(range: string): Promise<{ deps: Record<string, string>; err: string }> {
    const target = makeTarget("floor");
    try {
      const spec = join(FIXTURES, "openapi-spec-bearer.json");
      await run({ spec, target });
      const pkgPath = join(target, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      pkg.dependencies["@kdex-tech/entitlements"] = range;
      pkg.dependencies["my-extra-dep"] = "^1.0.0";
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf8");
      const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await run({ spec, target });
      const err = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      write.mockRestore();
      return { deps: pkgDeps(target), err };
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }

  it("a fresh scaffold pins ^0.7.0", async () => {
    const target = makeTarget("floor-fresh");
    try {
      await run({ spec: join(FIXTURES, "openapi-spec-bearer.json"), target });
      expect(pkgDeps(target)["@kdex-tech/entitlements"]).toBe("^0.7.0");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it.each(["^0.1.23", "~0.6.0", "0.1.24", "<0.7.0"])(
    "regeneration raises %s to ^0.7.0 and says so",
    async (range) => {
      const { deps, err } = await regenWith(range);
      expect(deps["@kdex-tech/entitlements"]).toBe("^0.7.0");
      expect(deps["my-extra-dep"]).toBe("^1.0.0");
      expect(err).toContain(`raised @kdex-tech/entitlements from ${range} to ^0.7.0`);
    },
  );

  it.each(["^0.7.0", "^0.7.3", "^1.2.0", ">=0.5.0", "file:../entitlements.tgz", "latest"])(
    "regeneration leaves %s alone",
    async (range) => {
      const { deps, err } = await regenWith(range);
      expect(deps["@kdex-tech/entitlements"]).toBe(range);
      expect(err).not.toContain("raised @kdex-tech/entitlements");
    },
  );
});

describe("CLI — emitted code passes tsc --noEmit", () => {
  // This is the most important behavioural assertion. We install the local
  // entitlements package and then run tsc against the emitted scaffold.
  // The test is slow (~30 s per fixture), so we only run it for bearer (the
  // representative auth path), a normalized non-bearer fixture and the
  // no-auth case.

  async function tscOnFixture(fixture: string, tarball: string): Promise<void> {
    const target = makeTarget(`tsc-${fixture}`);
    try {
      await run({ spec: join(FIXTURES, fixture), target });
      installScaffold(target, tarball);
      execSync("npx tsc --noEmit", { cwd: target, stdio: "pipe" });
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }

  for (const [fixture, label] of [
    ["openapi-spec.json", "no auth"],
    ["openapi-spec-bearer.json", "bearer JWT"],
    ["openapi-spec-apikey-header.json", "normalized to bearer"],
  ] as const) {
    it(`${fixture} (${label})`, { timeout: 120_000 }, async (ctx) => {
      await tscOnFixture(fixture, requireTarball(ctx));
    });
  }
});

describe("CLI — emitted auth plugin at runtime", () => {
  // kdex-tech/fngogen#18: drive the emitted auth plugin and routes in a real
  // fastify app, against a test JWKS, for an optional-auth operation
  // ([{bearer:["a"]}, {}]) and a required one ([{bearer:["a"]}]). A token that
  // is present must verify, or the call is refused, even where {} would admit
  // a caller with no token at all.
  const spec = {
    openapi: "3.0.0",
    info: { title: "auth-runtime", version: "1.0.0" },
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    paths: {
      "/optional": {
        get: {
          operationId: "optional",
          security: [{ bearer: ["a"] }, {}],
          responses: { "200": { description: "OK" } },
        },
      },
      "/required": {
        get: {
          operationId: "required",
          security: [{ bearer: ["a"] }],
          responses: { "200": { description: "OK" } },
        },
      },
      "/required-body": {
        post: {
          operationId: "requiredBody",
          security: [{ bearer: ["a"] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };

  // Runs inside the scaffold (tsx resolves its .js imports to the emitted .ts).
  // The env must be set before the auth module loads: it reads it on import.
  const driver = `
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";

const key = await generateKeyPair("ES256");
const otherKey = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(key.publicKey)), kid: "k", alg: "ES256", use: "sig" };
const jwksServer = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((r) => jwksServer.listen(0, "127.0.0.1", r));
const port = (jwksServer.address() as AddressInfo).port;
process.env.AUDIENCE = "fn";
process.env.ISSUER = "https://host.test";
process.env.JWKS_URL = \`http://127.0.0.1:\${port}/jwks\`;

const { auth } = await import("./src/auth.js");
const { routes } = await import("./api/routes.gen.js");

const app = Fastify({ logger: false });
await app.register(auth);
const echo = async ({ claims }: { claims: Record<string, unknown> }) => ({ claims });
await app.register(routes, {
  service: { optional: echo, required: echo, requiredBody: echo } as never,
});
// Routes the generator did not emit: one with no methodName passes the auth
// hook untouched; one whose methodName has no operationSecurity entry (a
// generator defect), or names an Object.prototype key, is refused.
app.get("/foreign", async () => ({ claims: {} }));
app.get("/stray", { config: { methodName: "notGenerated" } }, async () => ({ claims: {} }));
app.get("/proto", { config: { methodName: "constructor" } }, async () => ({ claims: {} }));

const now = Math.floor(Date.now() / 1000);
const base: JWTPayload = { iss: "https://host.test", aud: "fn", sub: "alice", exp: now + 3600 };
const mint = (claims: JWTPayload, signer = key.privateKey) =>
  new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "k" }).sign(signer);
const { exp: _exp, ...noExp } = base;
const { sub: _sub, ...noSub } = base;
const withEntitlements = (entitlements: unknown) =>
  mint({ ...base, entitlements } as unknown as JWTPayload);

const tokens: Record<string, string | undefined> = {
  none: undefined,
  withA: await withEntitlements(["a"]),
  withoutA: await withEntitlements(["x"]),
  badSignature: await mint({ ...base, entitlements: ["a"] }, otherKey.privateKey),
  expired: await mint({ ...base, entitlements: ["a"], exp: now - 3600 }),
  noExp: await mint({ ...noExp, entitlements: ["a"] }),
  zeroExp: await mint({ ...base, entitlements: ["a"], exp: 0 }),
  noSub: await mint({ ...noSub, entitlements: ["a"] }),
  wrongAudience: await mint({ ...base, aud: "other", entitlements: ["a"] }),
  nullEntitlements: await withEntitlements(null),
  absentEntitlements: await mint(base),
  stringA: await withEntitlements("a"),
  paddedStringA: await withEntitlements("  a "),
  emptyString: await withEntitlements("   "),
  joinedString: await withEntitlements("x a"),
  paddedArrayA: await withEntitlements([" a "]),
  nonStringElement: await withEntitlements(["a", 1]),
  number: await withEntitlements(5),
  object: await withEntitlements({ bearer: ["a"] }),
  bool: await withEntitlements(true),
};

const results: Record<string, { status: number; body: unknown }> = {};
const call = async (key: string, method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) => {
  const res = await app.inject({ method, url, headers, payload: payload as never });
  results[key] = { status: res.statusCode, body: res.json() };
};
for (const [name, token] of Object.entries(tokens)) {
  for (const route of ["optional", "required"]) {
    await call(route + ":" + name, "GET", "/" + route, token === undefined ? {} : { authorization: "Bearer " + token });
  }
}
await call("scheme:lower", "GET", "/required", { authorization: "bearer " + tokens.withA });
await call("scheme:upper", "GET", "/required", { authorization: "BEARER " + tokens.withA });
await call("body:invalidNoToken", "POST", "/required-body", {}, { nope: 1 });
await call("body:invalidWithA", "POST", "/required-body", { authorization: "Bearer " + tokens.withA }, { nope: 1 });
await call("body:validWithA", "POST", "/required-body", { authorization: "Bearer " + tokens.withA }, { name: "n" });
await call("foreign", "GET", "/foreign", {});
await call("stray", "GET", "/stray", { authorization: "Bearer " + tokens.withA });
await call("proto", "GET", "/proto", { authorization: "Bearer " + tokens.withA });
await app.close();
jwksServer.close();
process.stdout.write(JSON.stringify(results));
`;

  let target: string | undefined;
  let results: Record<string, { status: number; body: { claims?: Record<string, unknown> } }> = {};

  beforeAll(async () => {
    if (ENTITLEMENTS_TARBALL === undefined) return;
    target = makeTarget("auth-runtime");
    const specPath = join(target, "spec.json");
    writeFileSync(specPath, JSON.stringify(spec), "utf8");
    await run({ spec: specPath, target });
    installScaffold(target, ENTITLEMENTS_TARBALL);
    writeFileSync(join(target, "driver.ts"), driver, "utf8");
    results = JSON.parse(execSync("npx tsx driver.ts", { cwd: target, encoding: "utf8" }));
  }, 180_000);

  afterAll(() => {
    if (target) rmSync(target, { recursive: true, force: true });
  });

  const cases: Array<[string, number, number]> = [
    // token, optional status, required status
    ["none", 200, 401],
    ["withA", 200, 200],
    ["withoutA", 200, 403],
    ["badSignature", 401, 401],
    ["expired", 401, 401],
    ["noExp", 401, 401],
    ["zeroExp", 401, 401],
    ["noSub", 401, 401],
    ["wrongAudience", 401, 401],
    // The entitlements claim, read as the host gate's parseToStringArray
    // does (kdex-host-manager internal/auth/context.go).
    ["nullEntitlements", 200, 403],
    ["absentEntitlements", 200, 403],
    ["stringA", 200, 200],
    ["paddedStringA", 200, 200],
    ["emptyString", 200, 403],
    // A string is ONE entitlement, never split on whitespace.
    ["joinedString", 200, 403],
    ["paddedArrayA", 200, 200],
    // A malformed claim is an invalid token, never a fall-through to {}.
    ["nonStringElement", 401, 401],
    ["number", 401, 401],
    ["object", 401, 401],
    ["bool", 401, 401],
  ];
  for (const [token, optional, required] of cases) {
    it(`${token}: optional → ${optional}, required → ${required}`, (ctx) => {
      requireTarball(ctx);
      expect({
        optional: results[`optional:${token}`]?.status,
        required: results[`required:${token}`]?.status,
      }).toEqual({ optional, required });
    });
  }

  it.for([
    // The Authorization scheme is case-insensitive (RFC 9110; ogen's EqualFold).
    ["scheme:lower", 200],
    ["scheme:upper", 200],
    // Auth runs at onRequest, before body validation: an unauthenticated
    // caller learns nothing of the body schema.
    ["body:invalidNoToken", 401],
    ["body:invalidWithA", 400],
    ["body:validWithA", 200],
    ["foreign", 200],
    ["stray", 401],
    ["proto", 401],
  ] as const)("%s → %i", ([key, status], ctx) => {
    requireTarball(ctx);
    expect(results[key]?.status).toBe(status);
  });

  it("a satisfying token's claims reach the handler", (ctx) => {
    requireTarball(ctx);
    for (const route of ["optional", "required"]) {
      expect(results[`${route}:withA`]?.body.claims).toMatchObject({
        sub: "alice",
        entitlements: ["a"],
      });
    }
  });

  it("an anonymous admission carries no claims, even with a valid token", (ctx) => {
    requireTarball(ctx);
    for (const token of ["none", "withoutA", "nullEntitlements"]) {
      expect(results[`optional:${token}`]?.body.claims, token).toEqual({});
    }
  });
});
