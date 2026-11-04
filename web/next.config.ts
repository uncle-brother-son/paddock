import type { NextConfig } from "next";

// Next 16 removed the `eslint` config key entirely — it no longer runs ESLint during
// `next build` at all, so there's nothing to ignore. Linting stays a separate `npm run lint` step.
const nextConfig: NextConfig = {
  // React Compiler: automatic memoisation (ubs-frontend-standards §7). Requires
  // babel-plugin-react-compiler in devDependencies.
  reactCompiler: true,
  // Left out of Next's bundle so OpenNext's Worker build picks the package's own `workerd` entry
  // (which uses Cloudflare sockets) instead of the Node one.
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
