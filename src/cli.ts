#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import prettier from "prettier";

import { emitAuth } from "./emit/auth.js";
import { emitCustom } from "./emit/custom.js";
import { emitDefault } from "./emit/default.js";
import { emitMain } from "./emit/main.js";
import { emitPackageJson } from "./emit/package-json.js";
import { emitProjectToml } from "./emit/project-toml.js";
import { emitRoutes } from "./emit/routes.js";
import { emitSchemas } from "./emit/schemas.js";
import { emitSecurity } from "./emit/security.js";
import { emitService } from "./emit/service.js";
import { emitTsConfig } from "./emit/tsconfig.js";
import { emitTypes } from "./emit/types.js";
import { parseSpec } from "./parse.js";

interface FileSpec {
  path: string;
  content: string;
  overwrite: boolean;
  /** Skip prettier (e.g., for JSON / TOML). */
  raw?: boolean;
}

async function writeFile(target: string, file: FileSpec): Promise<void> {
  const fullPath = resolve(target, file.path);
  if (!file.overwrite && existsSync(fullPath)) {
    return;
  }
  mkdirSync(dirname(fullPath), { recursive: true });

  let content = file.content;
  if (!file.raw && (file.path.endsWith(".ts") || file.path.endsWith(".js"))) {
    try {
      content = await prettier.format(content, { parser: "typescript" });
    } catch {
      // If prettier fails, write the unformatted content — better than failing
      // the generation, easier to debug.
    }
  }
  writeFileSync(fullPath, content, "utf8");
}

interface RunOptions {
  spec: string;
  target: string;
}

export async function run(opts: RunOptions): Promise<void> {
  const specPath = resolve(opts.spec);
  if (!existsSync(specPath)) {
    throw new Error(`spec file not found: ${specPath}`);
  }
  const specJson = JSON.parse(readFileSync(specPath, "utf8")) as unknown;
  const ir = await parseSpec(specPath);

  const files: FileSpec[] = [
    { path: "api/types.gen.ts", content: await emitTypes(specJson), overwrite: true },
    { path: "api/schemas.gen.ts", content: emitSchemas(ir), overwrite: true },
    { path: "api/service.gen.ts", content: emitService(ir), overwrite: true },
    { path: "api/security.gen.ts", content: emitSecurity(ir), overwrite: true },
    { path: "api/routes.gen.ts", content: emitRoutes(ir), overwrite: true },
    { path: "src/main.ts", content: emitMain(ir), overwrite: true },
    { path: "src/auth.ts", content: emitAuth(ir), overwrite: true },
    { path: "src/default.ts", content: emitDefault(ir), overwrite: true },
    { path: "src/custom.ts", content: emitCustom(), overwrite: false },
    { path: "package.json", content: emitPackageJson(ir), overwrite: false, raw: true },
    { path: "tsconfig.json", content: emitTsConfig(), overwrite: false, raw: true },
    { path: "project.toml", content: emitProjectToml(), overwrite: true, raw: true },
  ];

  mkdirSync(opts.target, { recursive: true });
  for (const f of files) {
    await writeFile(opts.target, f);
  }

  // Always copy the input spec next to the project root for reference.
  const inputSpec = JSON.stringify(specJson, null, 2) + "\n";
  writeFileSync(join(opts.target, "openapi.json"), inputSpec, "utf8");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: "string", default: "." },
      spec: { type: "string", default: "openapi.json" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`Usage: kdex-fnnodejsgen [--target DIR] [--spec FILE]

  --target DIR   Output directory (default: ".")
  --spec FILE    Path to the OpenAPI 3 spec (default: "openapi.json")

Generates a Fastify-based TypeScript scaffold from an OpenAPI document. Mirrors
the kdex-fngogen scaffolding contract. See README.md for the regeneration
policy (which files overwrite, which are preserved).
`);
    return;
  }

  await run({ spec: values.spec!, target: values.target! });
}

// Only run when invoked as a script (not when imported in tests).
const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("cli.js") === true ||
  process.argv[1]?.endsWith("cli.ts") === true;

if (invokedAsScript) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
