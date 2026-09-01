import type { NextConfig } from "next";

import { normalizeBasePath } from "./src/server/config/base-path";

const nextConfig: NextConfig = {
  basePath: normalizeBasePath(process.env.NEXT_BASE_PATH),
  output: "standalone",
};

export default nextConfig;
