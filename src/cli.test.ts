import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
      expect(auth).toMatch(/no securitySchemes/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("CLI — security.gen.ts reflects the spec", () => {
  it("apikey-cookie fixture is normalized to apiKeyCookie:false and bearer:true", async () => {
    const target = makeTarget("apikey-cookie-sec");
    try {
      await run({ spec: join(FIXTURES, "openapi-spec-apikey-cookie.json"), target });
      const security = readFileSync(join(target, "api/security.gen.ts"), "utf8");
      expect(security).toMatch(/apiKeyCookie: false/);
      expect(security).toMatch(/bearer: true/);
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
        // The emitted source is prettier-formatted, so tolerate wrapping.
        expect(auth).toMatch(/entitlementsFromClaims\(\s*claims,\s*"entitlements",?\s*\)/);
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
      expect(readFileSync(join(target, "src/auth.ts"), "utf8")).toMatch(/no securitySchemes/);
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
      if (ENTITLEMENTS_TARBALL === undefined) return ctx.skip(NO_TARBALL);
      await tscOnFixture(fixture, ENTITLEMENTS_TARBALL);
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
await app.register(routes, { service: { optional: echo, required: echo } as never });

const now = Math.floor(Date.now() / 1000);
const base: JWTPayload = { iss: "https://host.test", aud: "fn", sub: "alice", exp: now + 3600 };
const mint = (claims: JWTPayload, signer = key.privateKey) =>
  new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "k" }).sign(signer);
const { exp: _exp, ...noExp } = base;
const { sub: _sub, ...noSub } = base;

const tokens: Record<string, string | undefined> = {
  none: undefined,
  withA: await mint({ ...base, entitlements: ["a"] }),
  withoutA: await mint({ ...base, entitlements: ["x"] }),
  badSignature: await mint({ ...base, entitlements: ["a"] }, otherKey.privateKey),
  expired: await mint({ ...base, entitlements: ["a"], exp: now - 3600 }),
  noExp: await mint({ ...noExp, entitlements: ["a"] }),
  zeroExp: await mint({ ...base, entitlements: ["a"], exp: 0 }),
  noSub: await mint({ ...noSub, entitlements: ["a"] }),
  wrongAudience: await mint({ ...base, aud: "other", entitlements: ["a"] }),
  nullEntitlements: await mint({ ...base, entitlements: null } as unknown as JWTPayload),
};

const results: Record<string, { status: number; body: unknown }> = {};
for (const [name, token] of Object.entries(tokens)) {
  for (const route of ["optional", "required"]) {
    const res = await app.inject({
      method: "GET",
      url: "/" + route,
      headers: token === undefined ? {} : { authorization: "Bearer " + token },
    });
    results[route + ":" + name] = { status: res.statusCode, body: res.json() };
  }
}
await app.close();
jwksServer.close();
process.stdout.write(JSON.stringify(results));
`;

  let target: string | undefined;
  let results: Record<string, { status: number; body: { claims?: Record<string, unknown> } }> =
    {};

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
    ["nullEntitlements", 200, 403],
  ];
  for (const [token, optional, required] of cases) {
    it(`${token}: optional → ${optional}, required → ${required}`, (ctx) => {
      if (ENTITLEMENTS_TARBALL === undefined) return ctx.skip(NO_TARBALL);
      expect({
        optional: results[`optional:${token}`]?.status,
        required: results[`required:${token}`]?.status,
      }).toEqual({ optional, required });
    });
  }

  it("a satisfying token's claims reach the handler", (ctx) => {
    if (ENTITLEMENTS_TARBALL === undefined) return ctx.skip(NO_TARBALL);
    for (const route of ["optional", "required"]) {
      expect(results[`${route}:withA`]?.body.claims).toMatchObject({
        sub: "alice",
        entitlements: ["a"],
      });
    }
  });

  it("an anonymous admission carries no claims, even with a valid token", (ctx) => {
    if (ENTITLEMENTS_TARBALL === undefined) return ctx.skip(NO_TARBALL);
    for (const token of ["none", "withoutA", "nullEntitlements"]) {
      expect(results[`optional:${token}`]?.body.claims, token).toEqual({});
    }
  });
});
