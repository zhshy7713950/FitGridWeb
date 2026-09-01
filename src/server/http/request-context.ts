import { ulid } from "ulid";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function requestIdFromHeaders(headers: Headers): string {
  const supplied = headers.get("x-request-id");
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : ulid();
}
