import { describe, expect, it } from "vitest";

import { parseSpec, refToSchemaName, toMethodName } from "./parse.js";

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
  it("flags apiKey-header only", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec-apikey-header.json");
    expect(ir.securityFlags.apiKeyHeader).toBe(true);
    expect(ir.securityFlags.apiKeyQuery).toBe(false);
    expect(ir.securityFlags.apiKeyCookie).toBe(false);
    expect(ir.securityFlags.bearer).toBe(false);
  });
});

describe("parseSpec — apikey-cookie fixture", () => {
  it("flags apiKey-cookie only", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec-apikey-cookie.json");
    expect(ir.securityFlags.apiKeyCookie).toBe(true);
    expect(ir.securityFlags.apiKeyHeader).toBe(false);
  });
});

describe("parseSpec — oauth2 fixture", () => {
  it("flags oauth2", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec-oauth2.json");
    expect(ir.securityFlags.oauth2).toBe(true);
  });
});

describe("parseSpec — openIdConnect fixture", () => {
  it("flags openIdConnect", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec-openIdConnect.json");
    expect(ir.securityFlags.openIdConnect).toBe(true);
  });
});

describe("parseSpec — bearer-2 fixture", () => {
  it("yields two operations (GET + PUT) on the same path", async () => {
    const ir = await parseSpec("test-fixtures/openapi-spec-bearer-2.json");
    expect(ir.operations).toHaveLength(2);
    expect(ir.operations.map((o) => o.method).sort()).toEqual(["get", "put"]);
  });
});
