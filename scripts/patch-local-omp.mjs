/* SPDX-License-Identifier: Apache-2.0 */
/** OMP 18.22's object loader must preserve callable CommonJS require() exports. */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "node_modules", "@oh-my-pi", "pi-coding-agent");
const relative = path.relative(path.join(root, "node_modules"), realpathSync(packageRoot));
if (relative.startsWith("..") || path.isAbsolute(relative)) {
  throw new Error("Refusing to patch OMP outside this checkout's node_modules.");
}
const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
if (manifest.version !== "18.22.0")
  throw new Error("Review the local CJS interoperability patch before changing OMP 18.22.0.");

const patches = [
  {
    file: "dist/cli.js",
    before: 'm[h]=Reflect.get(f,h)}return{exports:m,loader:"object"}',
    after: 'm[h]=Reflect.get(f,h)}m["module.exports"]=f;return{exports:m,loader:"object"}',
  },
  {
    file: "src/extensibility/plugins/legacy-pi-compat.ts",
    before: '\t\t\t\t\treturn { exports: moduleNamespace, loader: "object" };',
    after:
      '\t\t\t\t\tmoduleNamespace["module.exports"] = moduleExports;\n\t\t\t\t\treturn { exports: moduleNamespace, loader: "object" };',
  },
];
// Validate both artifacts before modifying either; repeated installation is a no-op.
const changes = patches.map(({ file, before, after }) => {
  const target = path.join(packageRoot, file);
  const source = readFileSync(target, "utf8");
  if (source.split(after).length === 2) return { target, source, changed: false };
  if (source.split(before).length !== 2) throw new Error(`Unexpected OMP loader contents: ${file}`);
  return { target, source: source.replace(before, after), changed: true };
});
for (const change of changes) if (change.changed) writeFileSync(change.target, change.source);
console.log("Repository-local OMP 18.22.0 CommonJS interoperability patch applied.");
