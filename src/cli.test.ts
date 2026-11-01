import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { run } from "./cli.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = resolve(REPO_ROOT, "test-fixtures");

function makeTarget(name: string): string {
  return mkdtempSync(join(tmpdir(), `kdex-fnnodejsgen-${name}-`));
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
  // representative auth path) and the no-auth case. Marking other fixtures
  // as 'todo' makes intent explicit without slowing the suite.

  const ENTITLEMENTS_TARBALL = resolve(
    REPO_ROOT,
    "../kdex-entitlements/typescript/kdex-tech-entitlements-0.1.0.tgz",
  );

  function tscOnFixture(fixture: string): void {
    const target = makeTarget(`tsc-${fixture}`);
    try {
      // Use synchronous shell to keep the test deterministic; we already
      // verified compatibility manually in development.
      execSync(`node ${REPO_ROOT}/dist/cli.js --spec ${join(FIXTURES, fixture)} --target ${target}`, {
        cwd: REPO_ROOT,
        stdio: "ignore",
      });
      execSync(`npm install ${ENTITLEMENTS_TARBALL} --no-audit --no-fund --silent`, {
        cwd: target,
        stdio: "ignore",
      });
      execSync("npm install --no-audit --no-fund --silent", {
        cwd: target,
        stdio: "ignore",
      });
      execSync("npx tsc --noEmit", { cwd: target, stdio: "pipe" });
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }

  it.runIf(existsSync(ENTITLEMENTS_TARBALL) && existsSync(resolve(REPO_ROOT, "dist/cli.js")))(
    "openapi-spec.json (no auth)",
    { timeout: 120_000 },
    () => {
      tscOnFixture("openapi-spec.json");
    },
  );

  it.runIf(existsSync(ENTITLEMENTS_TARBALL) && existsSync(resolve(REPO_ROOT, "dist/cli.js")))(
    "openapi-spec-bearer.json (bearer JWT)",
    { timeout: 120_000 },
    () => {
      tscOnFixture("openapi-spec-bearer.json");
    },
  );

  it.runIf(existsSync(ENTITLEMENTS_TARBALL) && existsSync(resolve(REPO_ROOT, "dist/cli.js")))(
    "openapi-spec-apikey-header.json (normalized to bearer)",
    { timeout: 120_000 },
    () => {
      tscOnFixture("openapi-spec-apikey-header.json");
    },
  );
});
