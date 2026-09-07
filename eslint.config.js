import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "eslint.config.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/**/*.ts", "test/v2/**/*.ts"],
    languageOptions: {
      globals: { ...globals.worker, ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["packages/extension/src/**/*.js", "scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.browser, ...globals.node, chrome: "readonly" } },
  },
);
