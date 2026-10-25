import type { NextConfig } from "next";

// Next 16 removed the `eslint` config key entirely — it no longer runs ESLint during
// `next build` at all, so there's nothing to ignore. Linting stays a separate `npm run lint` step.
const nextConfig: NextConfig = {
  // React Compiler: automatic memoisation (ubs-frontend-standards §7). Requires
  // babel-plugin-react-compiler in devDependencies.
  reactCompiler: true,
};

export default nextConfig;
