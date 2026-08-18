import { SCALAR_SCRIPT_NONCE } from "./scalar-bundle";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  `script-src 'self' 'nonce-${SCALAR_SCRIPT_NONCE}'`,
  "style-src 'self' 'unsafe-inline'",
].join("; ");

export const DOCS_SECURITY_HEADERS = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export const OPENAPI_CACHE_CONTROL = "public, max-age=300, must-revalidate";
export const SCALAR_BUNDLE_CACHE_CONTROL =
  "public, max-age=31536000, immutable";
export const HTML_CACHE_CONTROL = "public, max-age=60";
