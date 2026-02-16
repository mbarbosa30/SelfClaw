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

function rewriteImports(code) {
  code = code.replace(/from\s+["']\.\/([^"']+)\.js["']/g, 'from "./$1.mjs"');
  code = code.replace(/from\s+["']\.\.\/([^"']+)\.js["']/g, 'from "../$1.mjs"');
  code = code.replace(/from\s+["']\.\.\/\.\.\/([^"']+)\.js["']/g, 'from "../../$1.mjs"');
  code = code.replace(/import\(["']\.\/([^"']+)\.js["']\)/g, 'import("./$1.mjs")');
  code = code.replace(/import\(["']\.\.\/([^"']+)\.js["']\)/g, 'import("../$1.mjs")');
  code = code.replace(/import\(["']\.\.\/\.\.\/([^"']+)\.js["']\)/g, 'import("../../$1.mjs")');
  return code;
}

function walkDir(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

for (const dir of dirs) {
  const srcDir = path.join(__dirname, dir);
  const tsFiles = walkDir(srcDir);

  for (const srcPath of tsFiles) {
    const relPath = path.relative(srcDir, srcPath);
    const outPath = path.join(__dirname, outBase, dir, relPath.replace(/\.ts$/, ".mjs"));

    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    let code = fs.readFileSync(srcPath, "utf-8");
    code = rewriteImports(code);

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

    let outCode = rewriteImports(result.code);
    fs.writeFileSync(outPath, outCode);
    fileCount++;
  }
}

const elapsed = Date.now() - startTime;
console.log(`[build] Transpiled ${fileCount} files to dist/ in ${elapsed}ms`);
