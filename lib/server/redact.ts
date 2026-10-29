import { createHash } from "crypto"

const RSA_KEY_SQL = /(RSA_PUBLIC_KEY(?:_2)?\s*=\s*)'([A-Za-z0-9+/=\s]+)'/gi

/** Snowflake's RSA_PUBLIC_KEY_FP format: SHA256 of the DER key bytes, base64. */
export function rsaFingerprint(base64Body: string): string {
  const der = Buffer.from(base64Body.replace(/\s+/g, ""), "base64")
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`
}

/**
 * Text for the audit log. Public keys aren't secret, but logging the whole key is noise;
 * the fingerprint still matches DESCRIBE USER's RSA_PUBLIC_KEY_FP.
 */
export function redactForLog(text: string): string {
  return text.replace(RSA_KEY_SQL, (_m, prefix: string, body: string) => `${prefix}'<public key ${rsaFingerprint(body)}>'`)
}
