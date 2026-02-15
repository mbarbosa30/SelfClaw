import { build } from "esbuild";
import fs from "node:fs";

const startTime = Date.now();

try {
  fs.mkdirSync("dist", { recursive: true });

  await build({
    entryPoints: ["server/index.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: "dist/server.mjs",
    packages: "external",
    external: ["pg-native", "bufferutil", "utf-8-validate"],
    sourcemap: false,
    minify: false,
    keepNames: true,
    banner: {
      js: '// SelfClaw production build\nimport { createRequire } from "module";\nconst require = createRequire(import.meta.url);\n',
    },
  });

  const stats = fs.statSync("dist/server.mjs");
  const sizeKB = (stats.size / 1024).toFixed(1);
  const elapsed = Date.now() - startTime;
  console.log(`[build] dist/server.mjs (${sizeKB} KB) built in ${elapsed}ms`);
} catch (err) {
  console.error("[build] Build failed:", err.message);
  process.exit(1);
}
