import js from "@eslint/js";
import tseslint from "typescript-eslint";

const NODE_GLOBALS = {
  process: "readonly",
  console: "readonly",
  fetch: "readonly",
  Response: "readonly",
  URL: "readonly",
  setTimeout: "readonly",
  Deno: "readonly",
  Bun: "readonly",
};

export default tseslint.config(
  {
    ignores: ["dist/", "coverage/", "_internal/", "examples/next-app/", "**/node_modules/"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    // The fake API in tests is typed loosely on purpose.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    files: ["**/*.mjs", "*.js"],
    languageOptions: { globals: NODE_GLOBALS },
  },
);
