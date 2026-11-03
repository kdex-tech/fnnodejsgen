import SwaggerParser from "@apidevtools/swagger-parser";

import {
  BEARER_SCHEME,
  HTTP_METHODS,
  type BodyOrResponse,
  type HttpMethod,
  type IR,
  type Operation,
  type Parameter,
  type SecurityRequirement,
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

/** A method name is interpolated raw into emitted TypeScript (`service.X(`,
 * `XArgs`), so it must be a plain identifier. ASCII only, to fail closed. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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

/** Read an operation's `security` (absent or null: none). A value that is not
 * an array of objects whose scheme values are arrays of strings throws, naming
 * `where`: read leniently, `{"oauth2": "users:write"}` became `{bearer: []}`,
 * which any valid token satisfies, and a non-object alternative vanished.
 * Exported for tests. */
export function parseSecurity(raw: unknown, where: string): SecurityRequirement[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${where}: want an array of requirement objects, got ${typeof raw}`);
  }
  return raw.map((item: unknown, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${where}: alternative ${i}: want an object, got ${JSON.stringify(item)}`);
    }
    const clause: SecurityRequirement = {};
    for (const [scheme, scopes] of Object.entries(item)) {
      if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string")) {
        throw new Error(
          `${where}: security scheme ${JSON.stringify(scheme)}: want an array of strings, got ${JSON.stringify(scopes)}`,
        );
      }
      clause[scheme] = [...scopes];
    }
    return clause;
  });
}

/** Normalize security alternatives to bearer-only. Generated functions accept
 * only the host-minted JWT (FAT) and authorize on its `entitlements` claim, so
 * whatever scheme an alternative was declared under, the function side sees a
 * bearer. Each non-empty alternative becomes `{bearer: union of its scopes}`
 * (scheme names sorted, first occurrence kept: same rule as fngogen's
 * `unionAlternative`). `{}` alternatives (anonymous) stay and go last, so a
 * valid FAT populates claims before the empty alternative admits. */
export function bearerOnly(reqs: SecurityRequirement[]): SecurityRequirement[] {
  const nonEmpty: SecurityRequirement[] = [];
  const empty: SecurityRequirement[] = [];
  for (const req of reqs) {
    const names = Object.keys(req).sort();
    if (names.length === 0) {
      empty.push({});
      continue;
    }
    const union = new Set<string>();
    for (const name of names) for (const scope of req[name] ?? []) union.add(scope);
    nonEmpty.push({ [BEARER_SCHEME]: [...union] });
  }
  return [...nonEmpty, ...empty];
}

/** Warn, once per operation, when a non-empty alternative is made only of
 * non-bearer schemes with no requirement strings, e.g. `[{"apiKeyHeader":
 * []}]`: the bearer rewrite turns it into `{bearer: []}`, which any valid FAT
 * satisfies. Such specs are normal (knowdb's, for one), so it is not an error.
 * A scheme counts as bearer by its name. Its counterpart, with the same
 * wording, is kdex-fngogen's `scopelessNonBearerWarnings`
 * (cmd/prepare_security.go). */
function warnScopelessNonBearer(reqs: SecurityRequirement[], where: string): void {
  const scopeless = reqs.some((req) => {
    const names = Object.keys(req);
    if (names.length === 0 || names.includes(BEARER_SCHEME)) return false;
    return names.every((name) => (req[name] ?? []).length === 0);
  });
  if (scopeless) {
    process.stderr.write(
      `warning: ${where}: an alternative with no requirement strings under non-bearer schemes becomes "any valid FAT" at the function\n`,
    );
  }
}

/** Refuse path item shapes whose operations the bearer rewrite cannot see: a
 * `$ref` path item, and OpenAPI 3.2's `query` and `additionalOperations`.
 * Their operations would get no route and no requirement entry. That fails
 * closed, but without saying why; fail at generation instead, naming the
 * shape. Its counterpart, with the same wording, is kdex-fngogen's
 * `eachOperation` (cmd/prepare_security.go). */
function refuseUnseenPathShapes(path: string, pathItem: Record<string, unknown>): void {
  if ("$ref" in pathItem) {
    throw new Error(
      `path ${path}: a path item $ref is not supported: generation cannot see the operations it points to; declare them inline`,
    );
  }
  for (const field of ["query", "additionalOperations"]) {
    if (field in pathItem) {
      throw new Error(
        `path ${path}: the OpenAPI 3.2 path item field ${JSON.stringify(field)} is not supported: generation cannot see the operations it holds`,
      );
    }
  }
}

/** Load the OpenAPI document at `specPath` and produce an IR. The document is
 * parsed (not dereferenced) so `$ref` survives for schema-by-name emission. */
export async function parseSpec(specPath: string): Promise<IR> {
  const api = (await SwaggerParser.parse(specPath)) as Record<string, unknown>;

  const components = (api.components as Record<string, unknown> | undefined) ?? {};
  const componentSchemas = (components.schemas as Record<string, unknown> | undefined) ?? {};

  const operations: Operation[] = [];
  const paths = (api.paths as Record<string, unknown> | undefined) ?? {};
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    if (!pathItemRaw || typeof pathItemRaw !== "object") continue;
    const pathItem = pathItemRaw as Record<string, unknown>;
    refuseUnseenPathShapes(path, pathItem);
    const pathLevelParams = Array.isArray(pathItem.parameters)
      ? (pathItem.parameters as unknown[])
          .map(parseParameter)
          .filter((p): p is Parameter => p !== undefined)
      : [];

    for (const method of HTTP_METHODS) {
      const opRaw = pathItem[method];
      if (!opRaw || typeof opRaw !== "object") continue;
      const op = opRaw as Record<string, unknown>;
      const where = `${method.toUpperCase()} ${path}`;
      const operationId = String(op.operationId ?? `${method}${path}`);
      const methodName = toMethodName(operationId);
      if (!IDENTIFIER.test(methodName)) {
        throw new Error(
          `${where}: operationId ${JSON.stringify(operationId)} maps to method name ${JSON.stringify(methodName)}, which is not a JavaScript identifier`,
        );
      }
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

      const security = parseSecurity(op.security, `security of ${where}`);
      warnScopelessNonBearer(security, where);

      operations.push({
        operationId,
        methodName,
        path,
        method: method as HttpMethod,
        parameters: mergedParams,
        requestBody: parseBody(op.requestBody, false),
        responses,
        security: bearerOnly(security),
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
    // Every surviving alternative is bearer, so the declared
    // components.securitySchemes no longer shape the function side.
    hasSecurity: operations.some((o) => o.security.some((r) => Object.keys(r).length > 0)),
  };
}
