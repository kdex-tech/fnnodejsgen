/** Emit `tsconfig.json` for the generated function. Written only when not
 * present — preserved on regen. */
export function emitTsConfig(): string {
  const cfg = {
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2023"],
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      verbatimModuleSyntax: true,
      resolveJsonModule: true,
      isolatedModules: true,
      declaration: false,
      sourceMap: true,
      outDir: "dist",
      rootDir: ".",
    },
    include: ["api/**/*.ts", "src/**/*.ts"],
  };
  return JSON.stringify(cfg, null, 2) + "\n";
}
