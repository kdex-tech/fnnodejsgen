# kdex-fnnodejsgen

OpenAPI-driven scaffolding generator for Node.js / TypeScript KDex functions.
Sibling of [`kdex-fngogen`](../kdex-fngogen) — same scaffolding contract,
TypeScript dialect.

## What it does

Given an OpenAPI 3 document, the generator emits a Fastify-based TypeScript
project that wires routes, request validation, and auth (JWT/JWKS + PASETO
+ entitlements) automatically, leaving the user a single file to edit
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
│   ├── auth.ts            JWT/PASETO/entitlements middleware (regenerated)
│   ├── default.ts         defaultService returning 501 (regenerated)
│   └── custom.ts          your Service implementation (PRESERVED)
├── package.json           (preserved after first run)
├── tsconfig.json          (preserved after first run)
└── project.toml           CNB metadata for kpack
```

## Runtime env contract

| Var | Required? | Notes |
| --- | --- | --- |
| `PORT` | optional | Default `8080`. |
| `AUDIENCE` | required (JWT) | JWT audience claim. |
| `ISSUER` | required (JWT) | JWT issuer claim. |
| `JWKS_URL` | required (JWT) | JWKS endpoint for bearer/oauth2/oidc. |
| `PKS_URL` | required (PASETO) | PASETO public-key set endpoint for apiKey schemes. |
| `ANONYMOUS_ENTITLEMENTS` | optional | Space-separated entitlements granted to all callers. |
| `DEFAULT_SECURITY_SCHEME` | optional | Default `bearer`. |
| `DEBUG` | optional | Set `true` for verbose logging. |

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
