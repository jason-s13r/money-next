import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `@gorules/zen-engine` is a native (napi-rs) addon: it must be loaded with
  // Node's own `require`, not bundled into the Server Components graph, or the
  // `.node` binary can't be resolved at runtime. `better-sqlite3` is already on
  // Next's built-in opt-out list; this extends it to the rules engine.
  serverExternalPackages: ["@gorules/zen-engine"],
};

export default nextConfig;
