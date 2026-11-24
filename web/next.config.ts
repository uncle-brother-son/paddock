import type { NextConfig } from "next";

import { LIVE_HOST_RULE, NOINDEX_HEADER } from "./lib/site";

// Next 16 removed the `eslint` config key entirely — it no longer runs ESLint during
// `next build` at all, so there's nothing to ignore. Linting stays a separate `npm run lint` step.
const nextConfig: NextConfig = {
  // React Compiler: automatic memoisation (docs/build-standards.md, section 6: Performance). Requires
  // babel-plugin-react-compiler in devDependencies.
  reactCompiler: true,
  // Left out of Next's bundle so OpenNext's Worker build picks the package's own `workerd` entry
  // (which uses Cloudflare sockets) instead of the Node one.
  serverExternalPackages: ["postgres"],
  // Test copies stay out of search (docs/build-standards.md, section 2): every path answered on a host that isn't
  // the live domain carries `X-Robots-Tag: noindex, nofollow`. app/robots.ts says the same to crawlers, and
  // lib/seo/noindex.test.ts holds both.
  async headers() {
    return [{ source: "/:path*", missing: [LIVE_HOST_RULE], headers: [NOINDEX_HEADER] }];
  },
};

export default nextConfig;
