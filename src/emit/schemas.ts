import type { IR, Operation } from "../types.js";
import { GEN_BANNER, jsString } from "./helpers.js";

/** Inline `$ref: '#/components/schemas/X'` references against the spec's
 * component schemas. Fastify's response serializer (fast-json-stringify) does
 * NOT consult `addSchema`-registered schemas; routes need fully inlined
 * schemas. We still emit `componentSchemas` separately for reuse / validation. */
function inlineRefs(
  node: unknown,
  schemas: IR["schemas"],
  seen: Set<string> = new Set(),
): unknown {
  if (Array.isArray(node)) {
    return node.map((n) => inlineRefs(n, schemas, seen));
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      const m = /^#\/components\/schemas\/(.+)$/.exec(obj.$ref);
      if (m) {
        const name = m[1]!;
        if (seen.has(name)) {
          // Cycle: leave as $ref to avoid infinite recursion.
          return { $ref: obj.$ref };
        }
        const target = schemas[name];
        if (target !== undefined) {
          const nextSeen = new Set(seen).add(name);
          return inlineRefs(target, schemas, nextSeen);
        }
      }
      return { $ref: obj.$ref };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = inlineRefs(v, schemas, seen);
    }
    return out;
  }
  return node;
}

function paramsToJsonSchema(
  op: Operation,
  schemas: IR["schemas"],
  where: "path" | "query" | "header",
): unknown | undefined {
  const params = op.parameters.filter((p) => p.in === where);
  if (params.length === 0) return undefined;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.name] = inlineRefs(p.schema, schemas);
    if (p.required) required.push(p.name);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

interface RouteSchema {
  params?: unknown;
  querystring?: unknown;
  headers?: unknown;
  body?: unknown;
  response?: Record<string, unknown>;
}

function operationSchema(op: Operation, schemas: IR["schemas"]): RouteSchema {
  const schema: RouteSchema = {};
  const params = paramsToJsonSchema(op, schemas, "path");
  if (params) schema.params = params;
  const query = paramsToJsonSchema(op, schemas, "query");
  if (query) schema.querystring = query;
  const headers = paramsToJsonSchema(op, schemas, "header");
  if (headers) schema.headers = headers;

  if (op.requestBody?.schema) {
    schema.body = inlineRefs(op.requestBody.schema, schemas);
  }

  const responseEntries: Record<string, unknown> = {};
  for (const [code, resp] of Object.entries(op.responses)) {
    if (resp.schema) {
      responseEntries[code] = inlineRefs(resp.schema, schemas);
    }
  }
  if (Object.keys(responseEntries).length > 0) {
    schema.response = responseEntries;
  }
  return schema;
}

/** Emit `api/schemas.gen.ts` — JSON Schema constants for Fastify routes. */
export function emitSchemas(ir: IR): string {
  const components = Object.entries(ir.schemas).map(([name, schema]) => {
    // componentSchemas keeps `$id` so they can be addSchema'd into AJV for
    // validation; the values themselves are already free of refs (or only
    // refer to other components, which addSchema can resolve).
    const value = { $id: `#/components/schemas/${name}`, ...(schema as object) };
    return `  ${jsString(name)}: ${JSON.stringify(value, null, 2).replace(/\n/g, "\n  ")} as const`;
  });

  const ops = ir.operations.map((op) => {
    const schema = operationSchema(op, ir.schemas);
    return `  ${jsString(op.methodName)}: ${JSON.stringify(schema, null, 2).replace(/\n/g, "\n  ")} as const`;
  });

  return `${GEN_BANNER}
/* eslint-disable */

/** Component schemas keyed by name. Registered with Fastify's ajv as $ref targets
 * for the request *validator*. The response *serializer* requires fully inlined
 * schemas — see \`operationSchemas\` below. */
export const componentSchemas = {
${components.join(",\n")}
} as const;

/** Per-operation route schemas (params / querystring / headers / body / response).
 * Component \`$ref\`s are inlined so Fastify's response serializer can use them. */
export const operationSchemas = {
${ops.join(",\n")}
} as const;
`;
}
