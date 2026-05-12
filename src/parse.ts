import SwaggerParser from "@apidevtools/swagger-parser";

import {
  HTTP_METHODS,
  type BodyOrResponse,
  type HttpMethod,
  type IR,
  type Operation,
  type Parameter,
  type SecurityFlags,
  type SecurityRequirement,
  type SecurityScheme,
} from "./types.js";

/** Convert a kebab/snake-case OpenAPI operationId to a camelCase TS method
 * name. Already-camelCase ids pass through untouched. */
export function toMethodName(operationId: string): string {
  // Strip leading non-letters; split on common separators; lowercase first chunk.
  const cleaned = operationId.replace(/^[^a-zA-Z]+/, "");
  const parts = cleaned.split(/[-_.\s/]+/).filter((p) => p.length > 0);
  if (parts.length === 0) {
    return "operation";
  }
  return parts
    .map((part, i) => {
      // Preserve embedded caps but force the leading letter casing per position.
      if (i === 0) {
        return part[0]!.toLowerCase() + part.slice(1);
      }
      return part[0]!.toUpperCase() + part.slice(1);
    })
    .join("");
}

/** Extract `"X"` from `"#/components/schemas/X"`; return undefined otherwise. */
export function refToSchemaName(ref: string | undefined): string | undefined {
  if (typeof ref !== "string") return undefined;
  const prefix = "#/components/schemas/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
}

function parseSecurityScheme(name: string, raw: unknown): SecurityScheme | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (type === "http" && r.scheme === "bearer") {
    return { kind: "bearer", bearerFormat: r.bearerFormat as string | undefined };
  }
  if (type === "oauth2") {
    return { kind: "oauth2", flows: r.flows };
  }
  if (type === "openIdConnect") {
    return {
      kind: "openIdConnect",
      openIdConnectUrl: r.openIdConnectUrl as string | undefined,
    };
  }
  if (type === "apiKey") {
    const where = r.in;
    if (where !== "header" && where !== "query" && where !== "cookie") return undefined;
    return { kind: "apiKey", in: where, name: r.name as string };
  }
  // Unknown scheme — warn the caller via undefined.
  void name;
  return undefined;
}

function flagsForSchemes(schemes: Record<string, SecurityScheme>): SecurityFlags {
  const flags: SecurityFlags = {
    hasSecurity: false,
    bearer: false,
    oauth2: false,
    openIdConnect: false,
    apiKeyHeader: false,
    apiKeyQuery: false,
    apiKeyCookie: false,
  };
  for (const s of Object.values(schemes)) {
    flags.hasSecurity = true;
    switch (s.kind) {
      case "bearer":
        flags.bearer = true;
        break;
      case "oauth2":
        flags.oauth2 = true;
        break;
      case "openIdConnect":
        flags.openIdConnect = true;
        break;
      case "apiKey":
        if (s.in === "header") flags.apiKeyHeader = true;
        if (s.in === "query") flags.apiKeyQuery = true;
        if (s.in === "cookie") flags.apiKeyCookie = true;
        break;
    }
  }
  return flags;
}

function parseParameter(raw: unknown): Parameter | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const where = r.in;
  if (where !== "path" && where !== "query" && where !== "header" && where !== "cookie") {
    return undefined;
  }
  return {
    name: String(r.name ?? ""),
    in: where,
    required: where === "path" ? true : Boolean(r.required),
    description: r.description as string | undefined,
    schema: r.schema ?? { type: "string" },
  };
}

function parseBody(raw: unknown, alwaysRequired: boolean): BodyOrResponse | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const content = r.content as Record<string, unknown> | undefined;
  const required = alwaysRequired || Boolean(r.required);

  if (!content) {
    return { description: r.description as string | undefined, required };
  }
  // Prefer application/json.
  const jsonEntry = content["application/json"];
  if (jsonEntry && typeof jsonEntry === "object") {
    const j = jsonEntry as Record<string, unknown>;
    const schema = j.schema as Record<string, unknown> | undefined;
    return {
      description: r.description as string | undefined,
      contentType: "application/json",
      schema,
      schemaName: refToSchemaName(schema?.$ref as string | undefined),
      required,
    };
  }
  // Fallback to the first declared content type.
  const [contentType, entry] = Object.entries(content)[0] ?? [];
  if (!contentType || !entry || typeof entry !== "object") {
    return { description: r.description as string | undefined, required };
  }
  const e = entry as Record<string, unknown>;
  const schema = e.schema as Record<string, unknown> | undefined;
  return {
    description: r.description as string | undefined,
    contentType,
    schema,
    schemaName: refToSchemaName(schema?.$ref as string | undefined),
    required,
  };
}

function parseSecurity(raw: unknown): SecurityRequirement[] {
  if (!Array.isArray(raw)) return [];
  const out: SecurityRequirement[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const clause: SecurityRequirement = {};
    for (const [scheme, scopes] of Object.entries(item)) {
      clause[scheme] = Array.isArray(scopes) ? (scopes as unknown[]).map(String) : [];
    }
    out.push(clause);
  }
  return out;
}

/** Load the OpenAPI document at `specPath` and produce an IR. The document is
 * parsed (not dereferenced) so `$ref` survives for schema-by-name emission. */
export async function parseSpec(specPath: string): Promise<IR> {
  const api = (await SwaggerParser.parse(specPath)) as Record<string, unknown>;

  const components = (api.components as Record<string, unknown> | undefined) ?? {};
  const componentSchemas = (components.schemas as Record<string, unknown> | undefined) ?? {};
  const componentSecuritySchemes =
    (components.securitySchemes as Record<string, unknown> | undefined) ?? {};

  const securitySchemes: Record<string, SecurityScheme> = {};
  for (const [name, raw] of Object.entries(componentSecuritySchemes)) {
    const scheme = parseSecurityScheme(name, raw);
    if (scheme) securitySchemes[name] = scheme;
  }

  const operations: Operation[] = [];
  const paths = (api.paths as Record<string, unknown> | undefined) ?? {};
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    if (!pathItemRaw || typeof pathItemRaw !== "object") continue;
    const pathItem = pathItemRaw as Record<string, unknown>;
    const pathLevelParams = Array.isArray(pathItem.parameters)
      ? (pathItem.parameters as unknown[])
          .map(parseParameter)
          .filter((p): p is Parameter => p !== undefined)
      : [];

    for (const method of HTTP_METHODS) {
      const opRaw = pathItem[method];
      if (!opRaw || typeof opRaw !== "object") continue;
      const op = opRaw as Record<string, unknown>;
      const operationId = String(op.operationId ?? `${method}${path}`);
      const opParams = Array.isArray(op.parameters)
        ? (op.parameters as unknown[])
            .map(parseParameter)
            .filter((p): p is Parameter => p !== undefined)
        : [];
      const mergedParams = [...pathLevelParams, ...opParams];

      const responses: Record<string, BodyOrResponse> = {};
      const respRaw = (op.responses as Record<string, unknown> | undefined) ?? {};
      for (const [code, rRaw] of Object.entries(respRaw)) {
        const body = parseBody(rRaw, true);
        if (body) responses[code] = body;
      }

      operations.push({
        operationId,
        methodName: toMethodName(operationId),
        path,
        method: method as HttpMethod,
        parameters: mergedParams,
        requestBody: parseBody(op.requestBody, false),
        responses,
        security: parseSecurity(op.security),
        summary: op.summary as string | undefined,
        description: op.description as string | undefined,
        tags: Array.isArray(op.tags) ? (op.tags as unknown[]).map(String) : [],
      });
    }
  }

  const info = (api.info as Record<string, unknown> | undefined) ?? {};
  return {
    info: {
      title: String(info.title ?? "kdex-function"),
      version: String(info.version ?? "0.0.0"),
      description: info.description as string | undefined,
    },
    schemas: componentSchemas,
    operations,
    securitySchemes,
    securityFlags: flagsForSchemes(securitySchemes),
  };
}
