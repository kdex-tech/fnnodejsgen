import type { IR } from "../types.js";
import { GEN_BANNER, jsString } from "./helpers.js";

/** Emit `api/security.gen.ts` — the per-operation security requirements the
 * generated auth plugin enforces. Every alternative is bearer-only (see
 * `bearerOnly`), so the spec's declared schemes are not carried. */
export function emitSecurity(ir: IR): string {
  const perOperation = ir.operations.map((op) => {
    return `  ${jsString(op.methodName)}: ${JSON.stringify(op.security)}`;
  });

  return `${GEN_BANNER}

/** Per-operation security requirements. An empty array means no auth required.
 * Each clause is OR'd; within a clause, scheme→scope entries are AND'd. */
export const operationSecurity: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, ReadonlyArray<string>>>>>> = {
${perOperation.join(",\n")}
};
`;
}
