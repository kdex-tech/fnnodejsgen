import openapiTS, { astToString } from "openapi-typescript";

import { GEN_BANNER } from "./helpers.js";

/** Emit `api/types.gen.ts` — full OpenAPI → TypeScript types via openapi-typescript. */
export async function emitTypes(spec: unknown): Promise<string> {
  const ast = await openapiTS(spec as Parameters<typeof openapiTS>[0]);
  const body = astToString(ast);
  return `${GEN_BANNER}\n/* eslint-disable */\n\n${body}`;
}
