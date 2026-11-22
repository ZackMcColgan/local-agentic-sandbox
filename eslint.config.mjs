import path from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const nextCoreWebVitals = compat.extends("next/core-web-vitals").map((config) => ({
  ...config,
  files: config.files ?? ["web-ui/**/*.{js,jsx,mjs,cjs,ts,tsx}"],
}));

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/*.min.js",
      "**/*.min.css",
      "web-ui/next-env.d.ts",
      "deploy/helm/**/templates/**",
    ],
  },

  // Plain JS/MJS/CJS across root, scripts, eval, and workspaces
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...js.configs.recommended,
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      globals: {
        ...globals.node,
      },
    },
  },

  // Next.js Core Web Vitals (includes react, react-hooks, @next/next, import, jsx-a11y)
  ...nextCoreWebVitals,
  {
    files: ["web-ui/**/*.{js,jsx,mjs,cjs,ts,tsx}"],
    settings: {
      next: {
        rootDir: "web-ui/",
      },
    },
  },

  // TypeScript recommended across all TS/TSX files
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: config.files ?? ["**/*.{ts,tsx}"],
  })),
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // Node globals for Node services and root TS scripts
  {
    files: [
      "mcp-server/**/*.{ts,tsx,js,mjs,cjs}",
      "browser-mcp/**/*.{ts,tsx,js,mjs,cjs}",
      "host-bridge/**/*.{ts,tsx,js,mjs,cjs}",
      "scripts/**/*.{ts,tsx,js,mjs,cjs}",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Prettier compatibility must be last
  eslintConfigPrettier,
];
