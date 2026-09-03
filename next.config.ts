import type { NextConfig } from "next";

import { normalizeBasePath } from "./src/server/config/base-path";
import { assertUiDemoConfiguration } from "./src/lib/ui-demo";

assertUiDemoConfiguration();
const basePath = normalizeBasePath(process.env.NEXT_BASE_PATH);

const nextConfig: NextConfig = {
  agentRules: false,
  basePath,
  env: { NEXT_PUBLIC_APP_BASE_PATH: basePath },
  output: "standalone",
};

export default nextConfig;
