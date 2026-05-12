import type { IR } from "../types.js";
import { GEN_BANNER, jsString } from "./helpers.js";

/** Emit `api/security.gen.ts` — per-operation security requirements + scheme
 * metadata. Consumed by the generated auth plugin. */
export function emitSecurity(ir: IR): string {
  const schemes = Object.entries(ir.securitySchemes).map(([name, scheme]) => {
    return `  ${jsString(name)}: ${JSON.stringify(scheme)}`;
  });

  const perOperation = ir.operations.map((op) => {
    return `  ${jsString(op.methodName)}: ${JSON.stringify(op.security)}`;
  });

  return `${GEN_BANNER}

/** A scheme as it appears in OpenAPI \`components.securitySchemes\`, normalized. */
export type SecurityScheme =
  | { readonly kind: "bearer"; readonly bearerFormat?: string }
  | { readonly kind: "oauth2"; readonly flows: unknown }
  | { readonly kind: "openIdConnect"; readonly openIdConnectUrl?: string }
  | { readonly kind: "apiKey"; readonly in: "header" | "query" | "cookie"; readonly name: string };

export interface SecurityFlags {
  readonly hasSecurity: boolean;
  readonly bearer: boolean;
  readonly oauth2: boolean;
  readonly openIdConnect: boolean;
  readonly apiKeyHeader: boolean;
  readonly apiKeyQuery: boolean;
  readonly apiKeyCookie: boolean;
}

/** Security flags derived from the OpenAPI spec — controls which auth code is active. */
export const securityFlags: SecurityFlags = ${JSON.stringify(ir.securityFlags)};

/** Security schemes from \`components.securitySchemes\`. */
export const securitySchemes: Readonly<Record<string, SecurityScheme>> = {
${schemes.join(",\n")}
};

/** Per-operation security requirements. An empty array means no auth required.
 * Each clause is OR'd; within a clause, scheme→scope entries are AND'd. */
export const operationSecurity: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, ReadonlyArray<string>>>>>> = {
${perOperation.join(",\n")}
};
`;
}
