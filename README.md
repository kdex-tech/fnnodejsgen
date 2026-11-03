# kdex-fnnodejsgen

OpenAPI-driven scaffolding generator for Node.js / TypeScript KDex functions.
Sibling of [`kdex-fngogen`](../kdex-fngogen) — same scaffolding contract,
TypeScript dialect.

## What it does

Given an OpenAPI 3 document, the generator emits a Fastify-based TypeScript
project that wires routes, request validation, and auth (JWT/JWKS +
entitlements) automatically, leaving the user a single file to edit
(`src/custom.ts`) where they implement the auto-wired `Service` interface
— one method per OpenAPI `operationId`.

```sh
kdex-fnnodejsgen --spec openapi.json --target .
```

## Output layout

```
<target>/
├── openapi.json
├── api/
│   ├── types.gen.ts       TS types from OpenAPI schemas
│   ├── schemas.gen.ts     runtime JSON Schemas for Fastify validation
│   ├── service.gen.ts     Service interface (one method per operationId)
│   ├── security.gen.ts    per-operation security metadata
│   └── routes.gen.ts      Fastify plugin registering all routes
├── src/
│   ├── main.ts            bootstrap (regenerated)
│   ├── auth.ts            JWT/entitlements middleware (regenerated)
│   ├── default.ts         defaultService returning 501 (regenerated)
│   └── custom.ts          your Service implementation (PRESERVED)
├── package.json           (preserved after first run)
├── tsconfig.json          (preserved after first run)
└── project.toml           CNB metadata for kpack
```

## Security

A generated function accepts exactly one credential: the host-minted Function
Access Token (FAT), a JWT presented as `Authorization: Bearer <token>`. Its
only authority is the token's `entitlements` claim. That holds whatever scheme
the spec declares: bearer, oauth2, openIdConnect and apiKey alternatives are
all rewritten to bearer, each requiring the union of its declared scopes as
entitlements. PASETO tokens, apiKey headers, query parameters and cookies, and
the `scope` claim are never read. See kdex-tech/fngogen#18.

Per operation, the security alternatives are OR'd:

- A token that is present must verify (signature, `aud`, `iss`, an unexpired
  `exp`, and a `sub`), or the call is refused with 401, even when an empty
  alternative (`{}`) would admit a caller with no token at all.
- A valid token whose entitlements satisfy an alternative is admitted, and its
  claims reach the handler as `claims`.
- Otherwise an empty alternative admits the call as anonymous, with empty
  `claims`.
- Otherwise the call is refused: 401 without a token, 403 with a valid one.

A malformed `security` value (a scheme mapped to anything but an array of
strings, say) fails generation instead of weakening the requirement.

## Runtime env contract

| Var | Required? | Notes |
| --- | --- | --- |
| `PORT` | optional | Default `8080`. |
| `AUDIENCE` | required (security) | The FAT's `aud`. |
| `ISSUER` | required (security) | The FAT's `iss`. |
| `JWKS_URL` | required (security) | JWKS endpoint the FAT is verified against. |
| `ANONYMOUS_ENTITLEMENTS` | optional | Space-separated entitlements granted only to callers holding none (a FAT with an empty or missing `entitlements` claim). |
| `DEBUG` | optional | Set `true` for verbose logging. |

The security variables are required only when some operation declares
security; otherwise no auth plugin is emitted.

## Build / test

```sh
make test          # vitest
make build         # tsc → dist/
make docker-build  # build the generator image
```

## Container model

The image is meant to run inside a kpack build pipeline. `entry-point.sh`
reads `WORKDIR`, `TARGET_DIR`, `FUNCTION_API_SPEC` from `.env`, writes
`openapi.json`, invokes the generator, then runs `npm install` and `tsc`
to verify the result.
