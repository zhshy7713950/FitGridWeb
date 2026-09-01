import type { NextConfig } from "next";

import { normalizeBasePath } from "./src/server/config/base-path";

const basePath = normalizeBasePath(process.env.NEXT_BASE_PATH);

const nextConfig: NextConfig = {
  basePath,
  env: { NEXT_PUBLIC_APP_BASE_PATH: basePath },
  output: "standalone",
};

export default nextConfig;
