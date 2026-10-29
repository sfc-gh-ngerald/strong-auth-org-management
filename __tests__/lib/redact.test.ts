import { describe, expect, it } from "vitest"
import { redactForLog, rsaFingerprint } from "../../lib/server/redact"

// A real key and the RSA_PUBLIC_KEY_FP Snowflake reported for it (DESCRIBE USER).
const KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxdvcQuW8MkU0jWI3KVB3SjK26YrT/BY7qSGoJp3Lh0+jp3AqxoiH1XsFi8e2AA2O1S88y95lgHo2TdRKzWHKcsr2zjQnzj8RMG0oVrPYrm2oM4rWuIDIfQAL92slDQvG5qE3SFFdG0rumEO5cJB5G1jLNOlVIHLY7I0ObKsd7e5Ot9zTWTxqOvZT2tMxVpsljNxAoXaDsNgX24urNY2Tj/HBAPdE5h/EPMVc2Lo/QOLPf79I8JrT0pXRU3MrleLihxNtiUytT2QH2zPWLLQ9JNwtE94+7ynsIOPn51v2tzbDkpoBQ6wXglNUvVA8ajcB6Aj+Swyl16FVfyLR/62FowIDAQAB"
const FP = "SHA256:2AexY27fHodXM/TrlX9q5JCc1QWdzi0Yfdi/wy3SmC8="

describe("audit redaction", () => {
  it("matches Snowflake's RSA_PUBLIC_KEY_FP", () => {
    expect(rsaFingerprint(KEY)).toBe(FP)
  })

  it("replaces the key in SQL with its fingerprint and leaves other SQL alone", () => {
    const out = redactForLog(`ALTER USER "SVC" SET RSA_PUBLIC_KEY = '${KEY}';`)
    expect(out).toBe(`ALTER USER "SVC" SET RSA_PUBLIC_KEY = '<public key ${FP}>';`)
    expect(out).not.toContain(KEY)
    expect(redactForLog('ALTER USER "SVC" SET DISABLED = TRUE;')).toBe('ALTER USER "SVC" SET DISABLED = TRUE;')
  })
})
