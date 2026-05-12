import type { IR } from "../types.js";
import { GEN_BANNER, jsString, toFastifyPath } from "./helpers.js";

/** Emit `api/routes.gen.ts` — a Fastify plugin that registers every operation
 * as a route, applies request validation via JSON Schema, attaches the per-
 * operation security requirement, and delegates to `service[methodName]`. */
export function emitRoutes(ir: IR): string {
  const routes = ir.operations.map((op) => {
    const fastifyPath = toFastifyPath(op.path);
    return `  app.${op.method}(${jsString(fastifyPath)}, {
    schema: operationSchemas[${jsString(op.methodName)}] as FastifySchema,
    config: { operationId: ${jsString(op.operationId)}, methodName: ${jsString(op.methodName)} },
  }, async (request, reply) => {
    const claims = (request as unknown as { claims?: Record<string, unknown> }).claims ?? {};
    const result = await service.${op.methodName}({
      params: (request.params ?? {}) as never,
      query: (request.query ?? {}) as never,
      headers: (request.headers ?? {}) as never,
      body: (request.body ?? undefined) as never,
      claims,
      request,
      reply,
    });
    if (!reply.sent) {
      return result;
    }
    return undefined;
  });`;
  });

  const componentRegistration =
    Object.keys(ir.schemas).length === 0
      ? "// No component schemas to register."
      : `for (const [name, schema] of Object.entries(componentSchemas)) {
    void name;
    if (!app.getSchema((schema as { $id: string }).$id)) {
      app.addSchema(schema as object);
    }
  }`;

  return `${GEN_BANNER}

import type { FastifyInstance, FastifyPluginAsync, FastifySchema } from "fastify";

import { componentSchemas, operationSchemas } from "./schemas.gen.js";
import type { Service } from "./service.gen.js";

declare module "fastify" {
  interface FastifyContextConfig {
    operationId?: string;
    methodName?: string;
  }
}

export interface RoutesOptions {
  service: Service;
}

export const routes: FastifyPluginAsync<RoutesOptions> = async (app, opts) => {
  const { service } = opts;
  ${componentRegistration}
${routes.join("\n")}
};

// Eliminate unused-import warnings when an operation has no body/response.
type _UsesFastifyInstance = FastifyInstance;
`;
}
