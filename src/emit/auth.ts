import type { IR } from "../types.js";
import { GEN_BANNER } from "./helpers.js";

/** Emit `src/auth.ts` — Fastify plugin that validates JWT (via jose) and
 * PASETO (via the `paseto` npm package) tokens per the OpenAPI security
 * schemes, then verifies entitlements via `@kdex-tech/entitlements`. Decorates
 * the request with `claims`. Always overwritten. */
export function emitAuth(ir: IR): string {
  if (!ir.securityFlags.hasSecurity) {
    return `${GEN_BANNER}

// This OpenAPI spec declares no securitySchemes; no auth plugin needed.
export const auth = async (): Promise<void> => {
  /* noop */
};
`;
  }

  const flags = ir.securityFlags;
  const usesPaseto = flags.apiKeyHeader || flags.apiKeyQuery || flags.apiKeyCookie;

  return `${GEN_BANNER}

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
${usesPaseto ? 'import * as paseto from "paseto";\n' : ""}import { EntitlementsChecker, type Entitlements, type Requirements } from "@kdex-tech/entitlements";
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
${
  usesPaseto
    ? `
const pksUrl = envRequired("PKS_URL");
const pasetoKeys = new Map<string, string>();
let pasetoExpiry = 0;
const PASETO_TTL_MS = 15 * 60 * 1000;

async function refreshPasetoKeys(): Promise<void> {
  const resp = await fetch(pksUrl);
  if (!resp.ok) {
    throw new Error(\`failed to fetch PASETO public keys: \${resp.status}\`);
  }
  const body = (await resp.json()) as { keys?: Array<{ kid: string; key: string }> };
  pasetoKeys.clear();
  for (const k of body.keys ?? []) {
    pasetoKeys.set(k.kid, k.key);
  }
  pasetoExpiry = Date.now() + PASETO_TTL_MS;
}

async function pasetoKeyFor(kid: string): Promise<string> {
  if (Date.now() >= pasetoExpiry || !pasetoKeys.has(kid)) {
    await refreshPasetoKeys();
  }
  const key = pasetoKeys.get(kid);
  if (!key) throw new Error(\`unknown PASETO key id: \${kid}\`);
  return key;
}
`
    : ""
}

async function verifyJwt(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, jwks, { audience, issuer });
  return payload;
}
${
  usesPaseto
    ? `
function decodePasetoFooter(token: string): { kid: string } | undefined {
  const segments = token.split(".");
  if (segments.length < 3) return undefined;
  // PASETO V4 public layout: v4.public.<payload>[.<footer>]
  const footerB64 = segments[3];
  if (!footerB64) return undefined;
  const padded = footerB64 + "=".repeat((4 - (footerB64.length % 4)) % 4);
  const footer = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  try {
    const parsed = JSON.parse(footer) as { kid?: string };
    return parsed.kid ? { kid: parsed.kid } : undefined;
  } catch {
    return undefined;
  }
}

async function verifyPaseto(token: string): Promise<Record<string, unknown>> {
  // White-label: the host may have replaced the PASETO "v4.public." header with
  // its brand prefix (PASETO_TOKEN_PREFIX). Restore the header before parsing so
  // the signature verifies. A token already starting with "v4.public." is bare
  // and left untouched; otherwise, if it carries the configured prefix, swap it
  // back. Empty prefix => no transformation.
  const tokenPrefix = process.env.PASETO_TOKEN_PREFIX ?? "";
  const pasetoToken =
    tokenPrefix && !token.startsWith("v4.public.") && token.startsWith(tokenPrefix)
      ? "v4.public." + token.slice(tokenPrefix.length)
      : token;
  const footer = decodePasetoFooter(pasetoToken);
  if (!footer) throw new Error("PASETO token missing kid footer");
  const publicKey = await pasetoKeyFor(footer.kid);
  // The \`paseto\` package's V4.verify validates audience/issuer claims.
  const claims = (await paseto.V4.verify(pasetoToken, publicKey, {
    audience,
    issuer,
  })) as Record<string, unknown>;
  return claims;
}
`
    : ""
}

function extractToken(request: FastifyRequest, scheme: { kind: string; in?: string; name?: string }): string | undefined {
  if (scheme.kind === "bearer" || scheme.kind === "oauth2" || scheme.kind === "openIdConnect") {
    const header = request.headers["authorization"];
    if (typeof header !== "string") return undefined;
    const match = /^Bearer\\s+(.+)$/.exec(header);
    return match ? match[1] : undefined;
  }
  if (scheme.kind === "apiKey") {
    if (scheme.in === "header") {
      const v = request.headers[(scheme.name ?? "").toLowerCase()];
      return Array.isArray(v) ? v[0] : (v as string | undefined);
    }
    if (scheme.in === "query") {
      const q = request.query as Record<string, unknown> | undefined;
      const v = q?.[scheme.name ?? ""];
      return typeof v === "string" ? v : undefined;
    }
    if (scheme.in === "cookie") {
      // Requires @fastify/cookie to be registered upstream.
      const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies ?? {};
      return cookies[scheme.name ?? ""];
    }
  }
  return undefined;
}

function entitlementsFromClaims(claims: Record<string, unknown>, claimKey: string): string[] {
  const raw = claims[claimKey];
  if (typeof raw === "string") return raw.split(/\\s+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  return [];
}

function claimKeyForScheme(kind: string): string {
  // Bearer uses "entitlements" per the Go reference; oauth2/oidc use "scopes";
  // apiKey (PASETO) uses "scp".
  if (kind === "oauth2" || kind === "openIdConnect") return "scopes";
  if (kind === "apiKey") return "scp";
  return "entitlements";
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
      const token = extractToken(request, scheme);
      if (!token) {
        clauseOk = false;
        lastError = { kind: "unauthorized", message: \`missing token for scheme \${schemeName}\` };
        break;
      }
      try {
        const claims =
          scheme.kind === "apiKey"
            ${usesPaseto ? "? await verifyPaseto(token)" : '? (() => { throw new Error("apiKey schemes require PASETO support — not compiled in"); })()'}
            : (await verifyJwt(token)) as Record<string, unknown>;
        Object.assign(mergedClaims, claims);
        const claimKey = claimKeyForScheme(scheme.kind);
        userEntitlements[schemeName] = entitlementsFromClaims(claims, claimKey);
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
