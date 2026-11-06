import { build } from "esbuild"

/** Bundles the React dashboard into one ES module, in memory. */
export async function bundleDashboard(entry: string, production: boolean): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2023",
    jsx: "automatic",
    minify: production,
    sourcemap: production ? false : "inline",
    define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
    logLevel: "silent",
  })
  const output = result.outputFiles[0]
  if (output === undefined) throw new Error("esbuild produced no output")
  return output.text
}
