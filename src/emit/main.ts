import type { IR } from "../types.js";
import { GEN_BANNER } from "./helpers.js";

/** Emit `src/main.ts` — Fastify bootstrap, logger, optional auth plugin, routes
 * registration, graceful shutdown, and `listen()`. Always overwritten. */
export function emitMain(ir: IR): string {
  const useAuth = ir.securityFlags.hasSecurity;
  return `${GEN_BANNER}

import Fastify from "fastify";

import { routes } from "../api/routes.gen.js";
import { service } from "./custom.js";
${useAuth ? 'import { auth } from "./auth.js";' : ""}

async function main(): Promise<void> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? (process.env.DEBUG === "true" ? "debug" : "info"),
    },
    ajv: {
      customOptions: {
        coerceTypes: "array",
        useDefaults: true,
        removeAdditional: false,
        allErrors: false,
      },
    },
  });

  ${useAuth ? "await app.register(auth);" : ""}
  await app.register(routes, { service });

  const port = Number(process.env.PORT ?? "8080");
  const host = process.env.HOST ?? "0.0.0.0";

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, "Shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.error({ err }, "Failed to start server");
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
`;
}
