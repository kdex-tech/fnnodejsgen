import type { IR, Operation, Parameter } from "../types.js";
import { GEN_BANNER, cap } from "./helpers.js";

function tsTypeForSchema(schema: unknown, schemas: IR["schemas"]): string {
  if (!schema || typeof schema !== "object") return "unknown";
  const s = schema as Record<string, unknown>;
  if (typeof s.$ref === "string") {
    const name = s.$ref.replace(/^#\/components\/schemas\//, "");
    if (name in schemas) return `components["schemas"][${JSON.stringify(name)}]`;
    return "unknown";
  }
  const t = s.type;
  if (t === "string") return "string";
  if (t === "integer" || t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "array") {
    const item = (s.items ?? {}) as Record<string, unknown>;
    return `Array<${tsTypeForSchema(item, schemas)}>`;
  }
  if (t === "object" && s.properties && typeof s.properties === "object") {
    const props = s.properties as Record<string, unknown>;
    const required = Array.isArray(s.required) ? new Set(s.required.map(String)) : new Set<string>();
    const entries = Object.entries(props).map(([k, v]) => {
      const t = tsTypeForSchema(v, schemas);
      return `${JSON.stringify(k)}${required.has(k) ? "" : "?"}: ${t}`;
    });
    return `{ ${entries.join("; ")} }`;
  }
  return "unknown";
}

function paramsObjectType(params: Parameter[], schemas: IR["schemas"]): string {
  if (params.length === 0) return "Record<string, never>";
  const entries = params.map((p) => {
    const t = tsTypeForSchema(p.schema, schemas);
    return `${JSON.stringify(p.name)}${p.required ? "" : "?"}: ${t}`;
  });
  return `{ ${entries.join("; ")} }`;
}

function successResponseType(op: Operation, schemas: IR["schemas"]): string {
  const ordered = Object.entries(op.responses)
    .filter(([code]) => code.startsWith("2"))
    .sort(([a], [b]) => a.localeCompare(b));
  const first = ordered[0];
  if (first && first[1].schema) {
    return tsTypeForSchema(first[1].schema, schemas);
  }
  return "void";
}

function operationArgsName(op: Operation): string {
  return `${cap(op.methodName)}Args`;
}

function operationResultName(op: Operation): string {
  return `${cap(op.methodName)}Result`;
}

/** Emit `api/service.gen.ts` — per-operation arg and result types + a Service
 * interface aggregating them. The user implements Service in `src/custom.ts`. */
export function emitService(ir: IR): string {
  const argsAndResults = ir.operations.map((op) => {
    const params = paramsObjectType(
      op.parameters.filter((p) => p.in === "path"),
      ir.schemas,
    );
    const query = paramsObjectType(
      op.parameters.filter((p) => p.in === "query"),
      ir.schemas,
    );
    const headers = paramsObjectType(
      op.parameters.filter((p) => p.in === "header"),
      ir.schemas,
    );
    const body = op.requestBody?.schema
      ? tsTypeForSchema(op.requestBody.schema, ir.schemas)
      : "undefined";
    const result = successResponseType(op, ir.schemas);
    const argsName = operationArgsName(op);
    const resultName = operationResultName(op);
    return `export interface ${argsName} {
  params: ${params};
  query: ${query};
  headers: ${headers};
  body: ${body};
  claims: Record<string, unknown>;
  request: FastifyRequest;
  reply: FastifyReply;
}

export type ${resultName} = ${result};
`;
  });

  const serviceMethods = ir.operations.map(
    (op) =>
      `  ${op.methodName}(args: ${operationArgsName(op)}): Promise<${operationResultName(op)}>;`,
  );

  return `${GEN_BANNER}

import type { FastifyReply, FastifyRequest } from "fastify";
import type { components } from "./types.gen.js";

${argsAndResults.join("\n")}
export interface Service {
${serviceMethods.join("\n")}
}

// Force \`components\` to be considered used when an operation has no body or
// response schema; suppresses the unused-import warning for those specs.
type _UsesComponents = components;
`;
}
