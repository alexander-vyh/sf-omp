/* SPDX-License-Identifier: Apache-2.0 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const [outfile] = process.argv.slice(2);
const language = fileURLToPath(import.meta.resolve("@sf-agentscript/language"));
await build({
  stdin: {
    contents:
      'export {processDocument, provideCodeActions, provideRename} from "@sf-agentscript/lsp";',
    resolveDir: import.meta.dirname,
  },
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  plugins: [
    {
      name: "shared-agentforce-language",
      setup(builder) {
        // The SDK and LSP share the language package's AST classes and pass keys.
        builder.onResolve({ filter: /^@sf-agentscript\/language$/ }, () => ({
          path: language,
          external: true,
        }));
      },
    },
  ],
});
