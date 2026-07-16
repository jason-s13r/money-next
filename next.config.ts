import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `@gorules/zen-engine` is a native (napi-rs) addon: it must be loaded with
  // Node's own `require`, not bundled into the Server Components graph, or the
  // `.node` binary can't be resolved at runtime. Since better-sqlite3 was
  // dropped for Postgres, this is the only native module left in the app.
  serverExternalPackages: ["@gorules/zen-engine"],
};

export default nextConfig;
