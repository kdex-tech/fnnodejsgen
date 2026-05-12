/** Emit `project.toml` — CNB metadata that tells the Paketo Node.js buildpack
 * how to run the function. Always overwritten. */
export function emitProjectToml(): string {
  return `[_]
schema-version = "0.2"

[[io.buildpacks.build.env]]
name = "BP_NODE_RUN_SCRIPT"
value = "build,start"
`;
}
