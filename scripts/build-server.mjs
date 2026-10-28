// Bundles the TypeScript API server to dist/server.mjs (native/optional deps stay external).
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/server.mjs",
  sourcemap: false,
  packages: "external",
  banner: {
    js: [
      "import { createRequire as __cr } from 'module';",
      "const require = __cr(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
