import { BEARER_SCHEME, type IR } from "../types.js";
import { GEN_BANNER, jsString } from "./helpers.js";

/** Emit `src/auth.ts` — Fastify plugin that verifies the host-minted JWT (FAT,
 * via jose) from `Authorization: Bearer` and authorizes on its `entitlements`
 * claim via `@kdex-tech/entitlements`. Decorates the request with `claims`.
 * A token that is present must verify, even on an operation that also admits
 * anonymous callers.
 * The parser normalizes every security alternative to bearer, so no other
 * credential (PASETO, apiKey, cookie) or claim (`scope`) is ever read; see
 * kdex-tech/fngogen#18. Always overwritten. */
export function emitAuth(ir: IR): string {
  if (!ir.hasSecurity) {
    return `${GEN_BANNER}

// This OpenAPI spec has no security requirements; no auth plugin needed.
export const auth = async (): Promise<void> => {
  /* noop */
};
`;
  }

  return `${GEN_BANNER}

import { createRemoteJWKSet, jwtVerify } from "jose";
import { EntitlementsChecker } from "@kdex-tech/entitlements";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { operationSecurity } from "../api/security.gen.js";

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
const anonymousEntitlements = (process.env.ANONYMOUS_ENTITLEMENTS ?? "")
  .split(/\\s+/)
  .filter((s) => s.length > 0);

// The one scheme entitlements and requirements are keyed under: the generator
// rewrites every security alternative to bearer.
const SCHEME = ${jsString(BEARER_SCHEME)};

const jwks = createRemoteJWKSet(new URL(jwksUrl));
const checker = new EntitlementsChecker(anonymousEntitlements, SCHEME, false);

/** Verify the FAT's signature, \`aud\` and \`iss\`, and require \`exp\`: jose
 * treats it as optional, so a token without one would never expire. jose
 * already reads \`exp: 0\` as long expired. See kdex-tech/fngogen#13. */
async function verifyJwt(token: string): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, jwks, {
    audience,
    issuer,
    requiredClaims: ["exp"],
  });
  return payload;
}

function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return undefined;
  // The scheme is case-insensitive (RFC 9110), as ogen's EqualFold is in
  // kdex-fngogen.
  const match = /^bearer\\s+(.+)$/i.exec(header);
  return match ? match[1] : undefined;
}

/** Read the FAT's \`entitlements\` claim as the host gate's parseToStringArray
 * does (kdex-host-manager internal/auth/context.go), so the function admits
 * exactly what the host minted: absent or null is none; a string is ONE
 * entitlement, trimmed and never split (an empty one is none); an array must
 * hold only strings, each trimmed. Anything else makes the token invalid
 * (undefined). kdex-fngogen's counterpart is \`entitlementsClaim\` in
 * cmd/templates/main.go.tmpl. */
function entitlementsFromClaims(claims: Record<string, unknown>): string[] | undefined {
  const raw = claims.entitlements;
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    const value = raw.trim();
    return value === "" ? [] : [value];
  }
  if (Array.isArray(raw) && raw.every((v): v is string => typeof v === "string")) {
    return raw.map((v) => v.trim());
  }
  return undefined;
}

async function deny(reply: FastifyReply, status: 401 | 403, message: string): Promise<void> {
  await reply.code(status).send({
    statusCode: status,
    error: status === 401 ? "Unauthorized" : "Forbidden",
    message,
  });
}

/** Authorize a call against the operation's OR'd security clauses. A bearer
 * token that is present is verified once, before any clause is consulted: one
 * that fails verification, lacks \`sub\` or carries a malformed
 * \`entitlements\` claim is refused with 401 and never falls through to an
 * empty clause (\`{}\`). A valid token is admitted, with its claims, by the
 * first non-empty clause its entitlements satisfy. Failing that, an empty
 * clause admits the call as anonymous, with no claims, token or not. Otherwise
 * the call is refused: 401 without a token, 403 with one. */
async function verifyOperation(
  request: FastifyRequest,
  reply: FastifyReply,
  methodName: string,
): Promise<void> {
  // Every generated route has an entry. A missing one is a generator defect:
  // refuse rather than admit. Object.hasOwn keeps a methodName such as
  // "constructor" from reaching Object.prototype.
  if (!Object.hasOwn(operationSecurity, methodName)) {
    request.log.error({ methodName }, "[auth] no operationSecurity entry; refusing");
    return deny(reply, 401, "operation has no generated security entry");
  }
  const clauses = operationSecurity[methodName]!;
  if (clauses.length === 0) {
    request.claims = {};
    return;
  }

  const token = extractToken(request);
  let claims: Record<string, unknown> | undefined;
  if (token !== undefined) {
    try {
      claims = await verifyJwt(token);
    } catch (err) {
      return deny(reply, 401, err instanceof Error ? err.message : String(err));
    }
    if (typeof claims.sub !== "string") {
      return deny(reply, 401, "missing required claim: sub");
    }

    // The host gate authorizes on entitlements, never on scope (what the
    // client asked for).
    const entitlements = entitlementsFromClaims(claims);
    if (entitlements === undefined) {
      return deny(reply, 401, "invalid claim: entitlements");
    }
    const held = { [SCHEME]: entitlements };
    for (const clause of clauses) {
      if (Object.keys(clause).length === 0) continue;
      const required = Object.values(clause).flat();
      if (checker.verifyEntitlements(held, [{ [SCHEME]: required }])) {
        if (debug) {
          request.log.debug({ claims }, "[auth] claims accepted");
        }
        request.claims = claims;
        return;
      }
    }
  }

  if (clauses.some((clause) => Object.keys(clause).length === 0)) {
    request.claims = {};
    return;
  }
  if (claims === undefined) {
    return deny(reply, 401, "missing bearer token");
  }
  return deny(reply, 403, "entitlements do not match requirements");
}

/** Authorize at onRequest, before the body is parsed or validated, so an
 * unauthenticated caller never learns the body schema. Every generated route
 * carries a methodName; a route without one (the 404 handler, a route the
 * author added) is not the generator's and passes untouched. */
async function authPlugin(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    const methodName = request.routeOptions.config.methodName;
    if (!methodName) return;
    await verifyOperation(request, reply, methodName);
  });
}

// fastify-plugin marks the plugin as non-encapsulating so the onRequest hook
// applies to routes registered as siblings (e.g. by the generated routes plugin).
export const auth = fp(authPlugin, { name: "kdex-auth", fastify: "5.x" });
`;
}
