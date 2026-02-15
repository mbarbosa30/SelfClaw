import esbuild from "esbuild";
const { transform } = esbuild;
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const startTime = Date.now();

const dirs = ["server", "lib", "shared"];
const outBase = "dist";

let fileCount = 0;

for (const dir of dirs) {
  const srcDir = path.join(__dirname, dir);
  const outDir = path.join(__dirname, outBase, dir);

  if (!fs.existsSync(srcDir)) continue;
  fs.mkdirSync(outDir, { recursive: true });

  const files = fs.readdirSync(srcDir).filter(f => f.endsWith(".ts") && !f.endsWith(".d.ts"));

  for (const file of files) {
    const srcPath = path.join(srcDir, file);
    const outPath = path.join(outDir, file.replace(/\.ts$/, ".mjs"));

    let code = fs.readFileSync(srcPath, "utf-8");

    code = code.replace(/from\s+["']\.\/([^"']+)\.js["']/g, 'from "./$1.mjs"');
    code = code.replace(/from\s+["']\.\.\/([^"']+)\.js["']/g, 'from "../$1.mjs"');
    code = code.replace(/import\(["']\.\/([^"']+)\.js["']\)/g, 'import("./$1.mjs")');
    code = code.replace(/import\(["']\.\.\/([^"']+)\.js["']\)/g, 'import("../$1.mjs")');

    const result = await transform(code, {
      loader: "ts",
      format: "esm",
      target: "node22",
      platform: "node",
      keepNames: true,
      sourcefile: srcPath,
    }).catch(() => {
      return { code };
    });

    let outCode = result.code;
    outCode = outCode.replace(/from\s+["']\.\/([^"']+)\.js["']/g, 'from "./$1.mjs"');
    outCode = outCode.replace(/from\s+["']\.\.\/([^"']+)\.js["']/g, 'from "../$1.mjs"');
    outCode = outCode.replace(/import\(["']\.\/([^"']+)\.js["']\)/g, 'import("./$1.mjs")');
    outCode = outCode.replace(/import\(["']\.\.\/([^"']+)\.js["']\)/g, 'import("../$1.mjs")');

    fs.writeFileSync(outPath, outCode);
    fileCount++;
  }
}

const elapsed = Date.now() - startTime;
console.log(`[build] Transpiled ${fileCount} files to dist/ in ${elapsed}ms`);
