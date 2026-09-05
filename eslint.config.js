import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist/", "node_modules/", ".screenshots/"]),

  // Shared TypeScript rules for the game source and the Vite config.
  {
    files: ["src/**/*.ts", "vite.config.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      // Animation code declares a pose variable up front and assigns it in
      // every branch of the state machine; that default is documentation,
      // not a bug.
      "no-useless-assignment": "off",
      // Type-only imports stay type-only so the bundler can drop them
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Game source runs in the browser.
  {
    files: ["src/**/*.ts"],
    languageOptions: { globals: { ...globals.browser } },
  },

  // Vite config and this file run under Node.
  {
    files: ["vite.config.ts", "eslint.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    files: ["eslint.config.js"],
    extends: [js.configs.recommended],
  },
]);
