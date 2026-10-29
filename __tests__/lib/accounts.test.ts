import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { createAccount, importAccounts, listAccounts, validateInput } from "../../lib/server/accounts"

const base = { accountUrl: "myorg-edw.snowflakecomputing.com", role: "accountadmin", warehouse: "admin_wh" }

describe("validateInput", () => {
  it("accepts OAuth accounts without a user or credential file", () => {
    const a = validateInput({ ...base, authType: "OAUTH" })
    expect(a.accountUrl).toBe("https://myorg-edw.snowflakecomputing.com")
    expect(a.user).toBe("")
    expect(a.credentialPath).toBe("")
    expect(a.role).toBe("ACCOUNTADMIN")
  })

  it("allows a blank warehouse (user default) but rejects invalid names", () => {
    expect(validateInput({ ...base, warehouse: "", authType: "OAUTH" }).warehouse).toBe("")
    expect(() => validateInput({ ...base, warehouse: "wh; drop", authType: "OAUTH" })).toThrow(/Warehouse/)
  })

  it("drops any credential path for browser-auth accounts", () => {
    expect(validateInput({ ...base, authType: "SSO", credentialPath: "~/x" }).credentialPath).toBe("")
  })

  it("still requires user and file for PAT / key pair", () => {
    expect(() => validateInput({ ...base, authType: "PAT" })).toThrow(/User is required.*Credential file path/)
  })

  it("rejects non-Snowflake hosts and unknown auth types", () => {
    expect(() => validateInput({ ...base, accountUrl: "https://evil.example.com", authType: "OAUTH" })).toThrow()
    expect(() => validateInput({ ...base, authType: "PASSWORD" as any })).toThrow(/Auth type/)
  })
})

describe("account registry", () => {
  let dir = ""
  const prev = process.env.SACC_CONFIG_DIR
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sacc-test-"))
    process.env.SACC_CONFIG_DIR = dir
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.SACC_CONFIG_DIR
    else process.env.SACC_CONFIG_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })

  const kp = { ...base, authType: "KEYPAIR" as const, credentialPath: "~/k.p8" }

  it("treats user names case-insensitively when checking duplicates", async () => {
    await createAccount({ ...kp, user: "svc" })
    await expect(createAccount({ ...kp, user: "SVC" })).rejects.toThrow(/already exists/)
    expect(await importAccounts([{ ...kp, user: "Svc" }, { ...kp, user: "other" }])).toEqual({ added: 1, skipped: 1 })
    expect((await listAccounts()).length).toBe(2)
  })
})
