const PRODUCTION_BASE_PATH = "/fitgrid" as const;

export function normalizeBasePath(value?: string): "" | typeof PRODUCTION_BASE_PATH {
  if (!value) {
    return "";
  }

  if (value !== PRODUCTION_BASE_PATH) {
    throw new Error(`APP_BASE_PATH must be ${PRODUCTION_BASE_PATH}`);
  }

  return value;
}

export function cookiePath(value?: string): "/" | typeof PRODUCTION_BASE_PATH {
  return normalizeBasePath(value) || "/";
}

export function invitationUrl(requestUrl: string, token: string, value?: string): string {
  const basePath = normalizeBasePath(value);
  return new URL(`${basePath}/invite/${encodeURIComponent(token)}`, requestUrl).toString();
}
