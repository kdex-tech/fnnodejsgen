/** Emit `src/custom.ts` — the user seam. NEVER overwritten on regeneration. */
export function emitCustom(): string {
  return `import type { Service } from "../api/service.gen.js";
import { defaultService } from "./default.js";

/*
 * IMPLEMENTATION INSTRUCTIONS:
 *
 * Replace defaultService methods with your own. You can spread defaultService
 * to fall back to "not implemented" while iterating. To see claims, log
 * \`args.claims\` — populated by the generated auth middleware.
 *
 * NOTE: This file is NOT overwritten on regeneration.
 */

export const service: Service = {
  ...defaultService,
  // Override per-operation methods below, e.g.:
  // async getUserById({ params, claims }) {
  //   return { id: Number(params.id), name: "alice", email: "alice@example.com" };
  // },
};
`;
}
