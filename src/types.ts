/**
 * Internal IR produced by `parse.ts` and consumed by `emit/*` emitters.
 * The IR is deliberately a thin reshape of the OpenAPI document — refs are
 * preserved by name so emitters can produce idiomatic `$ref` / TypeBox `Ref()`
 * outputs.
 */

export type HttpMethod = "get" | "put" | "post" | "delete" | "patch" | "options" | "head" | "trace";

export const HTTP_METHODS: readonly HttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
] as const;

/** Subset of OpenAPI security scheme variants this generator supports. */
export type SecurityScheme =
  | { kind: "bearer"; bearerFormat?: string }
  | { kind: "oauth2"; flows: unknown }
  | { kind: "openIdConnect"; openIdConnectUrl?: string }
  | { kind: "apiKey"; in: "header" | "query" | "cookie"; name: string };

export interface SecurityFlags {
  hasSecurity: boolean;
  bearer: boolean;
  oauth2: boolean;
  openIdConnect: boolean;
  apiKeyHeader: boolean;
  apiKeyQuery: boolean;
  apiKeyCookie: boolean;
}

/** A single requirement clause (AND of scheme→scopes). Multiple clauses on
 * an operation are OR'd. */
export type SecurityRequirement = Record<string, string[]>;

export interface Parameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema: unknown;
}

export interface BodyOrResponse {
  description?: string;
  contentType?: string;
  schema?: unknown;
  /** If the schema is a `$ref: '#/components/schemas/X'`, this is `"X"`. */
  schemaName?: string;
  /** True if requestBody.required, or always for responses. */
  required: boolean;
}

export interface Operation {
  /** Raw OpenAPI operationId (may contain hyphens or other characters). */
  operationId: string;
  /** Sanitised TypeScript-safe identifier (camelCase). */
  methodName: string;
  /** OpenAPI path template, e.g. `/v1/users/{id}`. */
  path: string;
  method: HttpMethod;
  parameters: Parameter[];
  requestBody?: BodyOrResponse;
  responses: Record<string, BodyOrResponse>;
  /** OR'd alternatives. Empty if no security required. */
  security: SecurityRequirement[];
  summary?: string;
  description?: string;
  tags: string[];
}

export interface IR {
  info: { title: string; version: string; description?: string };
  /** Component schemas keyed by name (the part after `#/components/schemas/`). */
  schemas: Record<string, unknown>;
  operations: Operation[];
  securitySchemes: Record<string, SecurityScheme>;
  securityFlags: SecurityFlags;
}
