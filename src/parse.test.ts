import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { bearerOnly, parseSecurity, parseSpec, refToSchemaName, toMethodName } from "./parse.js";

describe("toMethodName", () => {
  it("camelCases hyphenated ids", () => {
    expect(toMethodName("gen-v1-users-id-put")).toBe("genV1UsersIdPut");
  });
  it("passes through already-camelCase ids", () => {
    expect(toMethodName("getUserById")).toBe("getUserById");
  });
  it("strips leading non-letters", () => {
    expect(toMethodName("/foo-bar")).toBe("fooBar");
  });
  it("falls back to 'operation' for empty input", () => {
    expect(toMethodName("")).toBe("operation");
  });
});

describe("refToSchemaName", () => {
  it("extracts schema name from a component $ref", () => {
    expect(refToSchemaName("#/components/schemas/User")).toBe("User");
  });
  it("returns undefined for non-component refs", () => {
    expect(refToSchemaName("#/components/responses/NotFound")).toBeUndefined();
    expect(refToSchemaName(undefined)).toBeUndefined();
  });
});

describe("parseSpec — no-auth fixture", () => {
  it("yields one operation with no security and no flags set", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec.json");
    expect(ir.operations).toHaveLength(1);
    expect(ir.operations[0]!.method).toBe("put");
    expect(ir.operations[0]!.path).toBe("/v1/users/{id}");
    expect(ir.operations[0]!.security).toEqual([]);
    expect(ir.securityFlags.hasSecurity).toBe(false);
    expect(ir.securityFlags.bearer).toBe(false);
    expect(Object.keys(ir.securitySchemes)).toEqual([]);
  });
});

describe("parseSpec — bearer fixture", () => {
  it("flags bearer + records the per-op requirement", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec-bearer.json");
    expect(ir.securityFlags.hasSecurity).toBe(true);
    expect(ir.securityFlags.bearer).toBe(true);
    expect(ir.securityFlags.oauth2).toBe(false);
    expect(ir.securityFlags.apiKeyHeader).toBe(false);
    expect(ir.operations[0]!.security).toEqual([{ bearer: ["foo", "bar"] }]);
    expect(ir.operations[0]!.methodName).toBe("genV1UsersIdPut");
  });
});

describe("parseSpec — apikey-header fixture", () => {
  it("normalizes apiKey-header to bearer", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec-apikey-header.json");
    expect(ir.securityFlags.apiKeyHeader).toBe(false);
    expect(ir.securityFlags.apiKeyQuery).toBe(false);
    expect(ir.securityFlags.apiKeyCookie).toBe(false);
    expect(ir.securityFlags.bearer).toBe(true);
    expect(ir.securitySchemes).toEqual({ bearer: { kind: "bearer" } });
    expect(ir.operations[0]!.security).toEqual([{ bearer: [] }]);
  });
});

describe("parseSpec — apikey-cookie fixture", () => {
  it("normalizes apiKey-cookie to bearer", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec-apikey-cookie.json");
    expect(ir.securityFlags.apiKeyCookie).toBe(false);
    expect(ir.securityFlags.apiKeyHeader).toBe(false);
  });
});

describe("parseSpec — oauth2 fixture", () => {
  it("normalizes oauth2 to bearer", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec-oauth2.json");
    expect(ir.securityFlags.oauth2).toBe(false);
    expect(ir.securityFlags.bearer).toBe(true);
  });
});

describe("parseSpec — openIdConnect fixture", () => {
  it("normalizes openIdConnect to bearer", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec-openIdConnect.json");
    expect(ir.securityFlags.openIdConnect).toBe(false);
    expect(ir.securityFlags.bearer).toBe(true);
  });
});

describe("parseSpec — bearer-2 fixture", () => {
  it("yields two operations (GET + PUT) on the same path", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec-bearer-2.json");
    expect(ir.operations).toHaveLength(2);
    expect(ir.operations.map((o) => o.method).sort()).toEqual(["get", "put"]);
  });
});

describe("bearerOnly", () => {
  it("unions an alternative's schemes under bearer, sorted by scheme name", () => {
    expect(bearerOnly([{ oauth2: ["b", "a"], apiKeyHeader: ["a", "c"] }])).toEqual([
      { bearer: ["a", "c", "b"] },
    ]);
  });
  it("puts empty alternatives last", () => {
    expect(bearerOnly([{}, { oidc: ["x"] }])).toEqual([{ bearer: ["x"] }, {}]);
  });
  it("leaves bearer-only alternatives unchanged", () => {
    const reqs = [{ bearer: ["a"] }, { bearer: ["b", "c"] }];
    expect(bearerOnly(reqs)).toEqual(reqs);
  });
  it("maps a scopeless scheme to an empty bearer", () => {
    expect(bearerOnly([{ x: [] }])).toEqual([{ bearer: [] }]);
  });
});

describe("parseSecurity", () => {
  // A requirement read leniently weakens it: {"oauth2": "users:write"} became
  // {bearer: []}, which any valid token satisfies, and a non-object
  // alternative vanished, leaving the operation unguarded. Fail closed.
  it.each([
    ["a scheme value that is not an array", [{ oauth2: "users:write" }]],
    ["a non-string scope", [{ oauth2: [123] }]],
    ["a null scheme value", [{ oauth2: null }]],
    ["an alternative that is not an object", ["bearer"]],
    ["a null alternative", [null]],
    ["security that is not an array", { bearer: [] }],
  ])("throws on %s", (_name, raw) => {
    expect(() => parseSecurity(raw, "security of PUT /x")).toThrow(/security of PUT \/x/);
  });

  it("reads absent or null security as none", () => {
    expect(parseSecurity(undefined, "w")).toEqual([]);
    expect(parseSecurity(null, "w")).toEqual([]);
  });

  it("keeps well-formed alternatives", () => {
    expect(parseSecurity([{ oauth2: ["a"] }, {}], "w")).toEqual([{ oauth2: ["a"] }, {}]);
  });
});

describe("parseSpec — malformed security", () => {
  it("rejects the spec, naming the operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kdex-fnnodejsgen-parse-"));
    try {
      const spec = join(dir, "spec.json");
      writeFileSync(
        spec,
        JSON.stringify({
          openapi: "3.0.0",
          info: { title: "t", version: "1" },
          paths: {
            "/x": {
              put: {
                operationId: "x",
                security: [{ oauth2: "users:write" }],
                responses: { "200": { description: "OK" } },
              },
            },
          },
        }),
        "utf8",
      );
      await expect(parseSpec(spec)).rejects.toThrow(/PUT \/x/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
