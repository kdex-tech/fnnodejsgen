import type { IR } from "../types.js";
import { GEN_BANNER } from "./helpers.js";

/** Emit `src/auth.ts` — Fastify plugin that verifies the host-minted JWT (FAT,
 * via jose) from `Authorization: Bearer` and authorizes on its `entitlements`
 * claim via `@kdex-tech/entitlements`. Decorates the request with `claims`.
 * The parser normalizes every security alternative to bearer, so no other
 * credential (PASETO, apiKey, cookie) or claim (`scope`) is ever read; see
 * kdex-tech/fngogen#18. Always overwritten. */
export function emitAuth(ir: IR): string {
  if (!ir.securityFlags.hasSecurity) {
    return `${GEN_BANNER}

// This OpenAPI spec declares no securitySchemes; no auth plugin needed.
export const auth = async (): Promise<void> => {
  /* noop */
};
`;
  }

  return `${GEN_BANNER}

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { EntitlementsChecker, type Entitlements, type Requirements } from "@kdex-tech/entitlements";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { operationSecurity, securitySchemes } from "../api/security.gen.js";

declare module "fastify" {
  interface FastifyRequest {
    claims?: Record<string, unknown>;
  }
}

function envRequired(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(\`\${name} environment variable is required for security\`);
  }
  return value;
}

const audience = envRequired("AUDIENCE");
const issuer = envRequired("ISSUER");
const jwksUrl = envRequired("JWKS_URL");
const debug = process.env.DEBUG === "true";
const defaultSecurityScheme = process.env.DEFAULT_SECURITY_SCHEME ?? "bearer";
const anonymousEntitlements = (process.env.ANONYMOUS_ENTITLEMENTS ?? "")
  .split(/\\s+/)
  .filter((s) => s.length > 0);

const jwks = createRemoteJWKSet(new URL(jwksUrl));
const checker = new EntitlementsChecker(anonymousEntitlements, defaultSecurityScheme, false);

async function verifyJwt(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, jwks, { audience, issuer });
  return payload;
}

function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\\s+(.+)$/.exec(header);
  return match ? match[1] : undefined;
}

function entitlementsFromClaims(claims: Record<string, unknown>, claimKey: string): string[] {
  const raw = claims[claimKey];
  if (typeof raw === "string") return raw.split(/\\s+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  return [];
}

async function verifyOperation(
  request: FastifyRequest,
  reply: FastifyReply,
  methodName: string,
): Promise<void> {
  const clauses = operationSecurity[methodName] ?? [];
  if (clauses.length === 0) {
    request.claims = {};
    return;
  }

  type FailKind = "unauthorized" | "forbidden";
  let lastError: { kind: FailKind; message: string } | undefined;

  for (const clause of clauses) {
    const userEntitlements: Entitlements = {};
    const requirements: Requirements = [{}];
    const mergedClaims: Record<string, unknown> = {};
    let clauseOk = true;

    for (const [schemeName, requiredScopes] of Object.entries(clause)) {
      const scheme = securitySchemes[schemeName];
      if (!scheme) {
        clauseOk = false;
        lastError = { kind: "unauthorized", message: \`unknown security scheme: \${schemeName}\` };
        break;
      }
      const token = extractToken(request);
      if (!token) {
        clauseOk = false;
        lastError = { kind: "unauthorized", message: \`missing token for scheme \${schemeName}\` };
        break;
      }
      try {
        const claims = (await verifyJwt(token)) as Record<string, unknown>;
        Object.assign(mergedClaims, claims);
        // The host gate authorizes on entitlements, never on scope (what the
        // client asked for). A missing or null claim is an empty list.
        userEntitlements[schemeName] = entitlementsFromClaims(claims, "entitlements");
        requirements[0]![schemeName] = [...requiredScopes];
        if (typeof claims.sub !== "string") {
          clauseOk = false;
          lastError = { kind: "unauthorized", message: "missing required claim: sub" };
          break;
        }
      } catch (err) {
        clauseOk = false;
        lastError = {
          kind: "unauthorized",
          message: err instanceof Error ? err.message : String(err),
        };
        break;
      }
    }

    if (!clauseOk) continue;
    if (!checker.verifyEntitlements(userEntitlements, requirements)) {
      lastError = { kind: "forbidden", message: "entitlements do not match requirements" };
      continue;
    }

    if (debug) {
      request.log.debug({ claims: mergedClaims }, "[auth] claims accepted");
    }
    request.claims = mergedClaims;
    return;
  }

  const status = lastError?.kind === "forbidden" ? 403 : 401;
  await reply.code(status).send({
    statusCode: status,
    error: status === 401 ? "Unauthorized" : "Forbidden",
    message: lastError?.message ?? "unauthorized",
  });
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    const methodName = request.routeOptions.config.methodName;
    if (!methodName) return;
    await verifyOperation(request, reply, methodName);
  });
}

// fastify-plugin marks the plugin as non-encapsulating so the preHandler hook
// applies to routes registered as siblings (e.g. by the generated routes plugin).
export const auth = fp(authPlugin, { name: "kdex-auth", fastify: "5.x" });
`;
}
