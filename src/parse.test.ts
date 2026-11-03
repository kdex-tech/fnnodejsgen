import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  it("yields one operation with no security", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec.json");
    expect(ir.operations).toHaveLength(1);
    expect(ir.operations[0]!.method).toBe("put");
    expect(ir.operations[0]!.path).toBe("/v1/users/{id}");
    expect(ir.operations[0]!.security).toEqual([]);
    expect(ir.hasSecurity).toBe(false);
  });
});

describe("parseSpec — bearer fixture", () => {
  it("records the per-op requirement", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec-bearer.json");
    expect(ir.hasSecurity).toBe(true);
    expect(ir.operations[0]!.security).toEqual([{ bearer: ["foo", "bar"] }]);
    expect(ir.operations[0]!.methodName).toBe("genV1UsersIdPut");
  });
});

describe("parseSpec — non-bearer fixtures normalize to bearer", () => {
  it.each([
    ["openapi-spec-apikey-header.json", [{ bearer: [] }]],
    ["openapi-spec-apikey-cookie.json", [{ bearer: [] }]],
    ["openapi-spec-apikey-query.json", [{ bearer: [] }]],
    ["openapi-spec-oauth2.json", [{ bearer: ["users:read", "users:write"] }]],
  ])("%s", async (fixture, want) => {
    const ir = await parseSpec(`test-fixtures/${fixture}`);
    expect(ir.hasSecurity).toBe(true);
    expect(ir.operations[0]!.security).toEqual(want);
  });

  it("openapi-spec-openIdConnect.json", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec-openIdConnect.json");
    expect(ir.hasSecurity).toBe(true);
    for (const op of ir.operations) {
      for (const alt of op.security) expect(Object.keys(alt)).toEqual(["bearer"]);
    }
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

/** Parse an in-memory spec through a temp file, as the CLI would. */
async function parseDoc(
  doc: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof parseSpec>>> {
  const dir = mkdtempSync(join(tmpdir(), "kdex-fnnodejsgen-parse-"));
  try {
    const spec = join(dir, "spec.json");
    writeFileSync(
      spec,
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "t", version: "1" },
        ...doc,
      }),
      "utf8",
    );
    return await parseSpec(spec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One PUT /x operation with the given `security`. */
const withSecurity = (security: unknown): Record<string, unknown> => ({
  paths: {
    "/x": {
      put: {
        operationId: "x",
        security,
        responses: { "200": { description: "OK" } },
      },
    },
  },
});

describe("parseSpec — conformance with kdex-fngogen operationRequirements", () => {
  // Shared case list: kdex-fngogen's TestOperationRequirements_Conformance
  // (cmd/requirements_test.go) carries the same inputs. Go drops {} from its
  // table; here it stays, last.
  it.each([
    [[{ oauth2: ["b", "a"], apiKeyHeader: ["a", "c"] }], [{ bearer: ["a", "c", "b"] }]],
    [
      [{ bearer: ["a"] }, { bearer: ["b", "c"] }],
      [{ bearer: ["a"] }, { bearer: ["b", "c"] }],
    ],
    [
      [{}, { oidc: ["x"] }],
      [{ bearer: ["x"] }, {}],
    ],
    [[{ apiKeyCookie: [] }], [{ bearer: [] }]],
    [[], []],
  ])("%j → %j", async (security, want) => {
    const ir = await parseDoc(withSecurity(security));
    expect(ir.operations[0]!.security).toEqual(want);
  });
});

describe("parseSpec — scope-less non-bearer alternatives", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const warning =
    'warning: PUT /x: an alternative with no requirement strings under non-bearer schemes becomes "any valid FAT" at the function\n';

  it.each([
    ["a scope-less apiKey alternative", [{ apiKeyHeader: [] }]],
    ["two scope-less non-bearer schemes", [{ apiKeyHeader: [], oauth2: [] }]],
    ["two scope-less alternatives (warned once)", [{ apiKeyHeader: [] }, { apiKeyCookie: [] }]],
  ])("warns on %s, naming the operation", async (_name, security) => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const ir = await parseDoc(withSecurity(security));
    for (const alt of ir.operations[0]!.security) expect(alt).toEqual({ bearer: [] });
    expect(write.mock.calls).toEqual([[warning]]);
  });

  it.each([
    ["a scope-less bearer alternative", [{ bearer: [] }]],
    ["a scoped non-bearer alternative", [{ apiKeyHeader: ["a"] }]],
    ["bearer beside a scope-less non-bearer scheme", [{ bearer: [], apiKeyHeader: [] }]],
    ["an empty alternative", [{}]],
  ])("does not warn on %s", async (_name, security) => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await parseDoc(withSecurity(security));
    expect(write).not.toHaveBeenCalled();
  });
});

describe("parseSpec — path shapes the bearer rewrite cannot see", () => {
  const op = { operationId: "x", responses: { "200": { description: "OK" } } };
  it.each([
    ["$ref", { $ref: "#/components/pathItems/X" }, /path \/x: a path item \$ref is not supported/],
    ["query", { query: op }, /path \/x: the OpenAPI 3\.2 path item field "query"/],
    [
      "additionalOperations",
      { additionalOperations: { COPY: op } },
      /path \/x: the OpenAPI 3\.2 path item field "additionalOperations"/,
    ],
  ])("rejects a path item with %s", async (_name, item, want) => {
    await expect(parseDoc({ paths: { "/x": item } })).rejects.toThrow(want);
  });
});

describe("parseSpec — operationIds that are not identifiers", () => {
  it.each([
    ['x"y', /PUT \/x: operationId "x\\"y" maps to method name "x\\"y"/],
    ["get{id}", /PUT \/x: operationId "get\{id\}"/],
    ["a;b()", /PUT \/x: operationId "a;b\(\)"/],
  ])("rejects %j, naming the operation", async (operationId, want) => {
    const doc = {
      paths: {
        "/x": {
          put: { operationId, responses: { "200": { description: "OK" } } },
        },
      },
    };
    await expect(parseDoc(doc)).rejects.toThrow(want);
  });

  it("accepts a hyphenated operationId", async () => {
    const doc = {
      paths: {
        "/x": {
          put: {
            operationId: "gen-x-put",
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    expect((await parseDoc(doc)).operations[0]!.methodName).toBe("genXPut");
  });
});
