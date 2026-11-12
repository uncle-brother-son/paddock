// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".open-next/**",
    ".wrangler/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // W16: a frozen test-only copy of the removed order code and the two legacy routes it calls, linted where
    // it lived (the staff app; app/api). Deleted at step H.
    "server/rules/testing/legacy-order/**",
    // W17: the same for the old step D functions (legacy-booking/README.md), linted in the staff app. Step H.
    "server/rules/testing/legacy-booking/**",
  ]),
  ...storybook.configs["flat/recommended"],
  // Values go in as $1 parameters. A dynamic query (e.g. a variable number of search words) can
  // still build its placeholders: say why in an eslint-disable comment on that line.
  {
    files: ["server/**/*.ts", "app/api/v1/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name=/^(query|selectForUpdate)$/] > TemplateLiteral[expressions.length>0]:first-child",
          message: "Don't build SQL from values: pass them as params.",
        },
        {
          selector: "CallExpression[callee.property.name=/^(query|selectForUpdate)$/] > BinaryExpression:first-child",
          message: "Don't build SQL from values: pass them as params.",
        },
      ],
    },
  },
  // server/ holds secrets and database access: it must never reach the browser.
  {
    files: ["components/**/*.{ts,tsx}", "features/**/*.{ts,tsx}", "app/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@/server", "@/server/*"], message: "server/ is server-only." }] },
      ],
    },
  },
]);

export default eslintConfig;
