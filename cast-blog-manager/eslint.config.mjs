import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

/**
 * ESLint フラット設定（Next.js 16 以降は `next lint` が廃止され、
 * eslint を直接実行する形になった）。
 */
const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "screenshots/**",
      "assets/**",
      "src/generated/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
];

export default config;
