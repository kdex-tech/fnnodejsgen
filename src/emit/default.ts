import type { IR } from "../types.js";
import { GEN_BANNER, cap } from "./helpers.js";

/** Emit `src/default.ts` — a Service stub where every method throws 501. */
export function emitDefault(ir: IR): string {
  if (ir.operations.length === 0) {
    return `${GEN_BANNER}

import type { Service } from "../api/service.gen.js";

export const defaultService: Service = {} as Service;
`;
  }

  const methods = ir.operations.map((op) => {
    return `  async ${op.methodName}(args) {
    args.reply.log.warn(
      { operationId: ${JSON.stringify(op.operationId)}, claims: args.claims },
      "default handler invoked — implement this method in src/custom.ts",
    );
    args.reply.code(501);
    throw new Error("not implemented: ${op.operationId}");
  }`;
  });

  void cap; // Reserved for future use; keep export contract stable.
  return `${GEN_BANNER}

import type { Service } from "../api/service.gen.js";

/** Default Service implementation — every method returns HTTP 501 "not implemented".
 * Useful as a fallback while iterating; spread it into your own implementation in
 * \`src/custom.ts\` to stub out operations you haven't built yet. */
export const defaultService: Service = {
${methods.join(",\n")}
};
`;
}
