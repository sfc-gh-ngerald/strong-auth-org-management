import { promises as fs, existsSync } from "fs"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { isInteractive, type AuthType, type ManagedAccount, type ManagedAccountInput } from "@/lib/types"

/**
 * Local, file-backed registry of managed accounts. The file holds only paths and
 * connection metadata — never token or key contents. Override the location with
 * SACC_CONFIG_DIR (defaults to ./config, which is git-ignored).
 */
export function configDir(): string {
  return expandHome(process.env.SACC_CONFIG_DIR ?? path.join(process.cwd(), "config"))
}

function accountsFile(): string {
  return path.join(configDir(), "accounts.json")
}

export function expandHome(p: string): string {
  if (!p) return p
  if (p === "~") return os.homedir()
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2))
  return p
}

export async function listAccounts(): Promise<ManagedAccount[]> {
  try {
    const raw = await fs.readFile(accountsFile(), "utf8")
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.accounts) ? (parsed.accounts as ManagedAccount[]) : []
  } catch (e: any) {
    if (e?.code === "ENOENT") return []
    throw new Error(`Could not read ${accountsFile()}: ${e?.message ?? e}`)
  }
}

async function saveAccounts(accounts: ManagedAccount[]): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true })
  const tmp = `${accountsFile()}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ version: 1, accounts }, null, 2), { mode: 0o600 })
  await fs.rename(tmp, accountsFile())
}

export async function getAccount(id: string): Promise<ManagedAccount | null> {
  return (await listAccounts()).find((a) => a.id === id) ?? null
}

export function credentialFileFound(a: ManagedAccount): boolean {
  return !isInteractive(a.authType) && !!a.credentialPath && existsSync(expandHome(a.credentialPath))
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/
const QUALIFIED = /^("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\.("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)$/

/** Validates and normalizes user input. Throws with a readable message on bad input. */
export function validateInput(input: Partial<ManagedAccountInput>): ManagedAccountInput {
  const errors: string[] = []
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

  let accountUrl = str(input.accountUrl)
  if (accountUrl && !/^https?:\/\//i.test(accountUrl)) accountUrl = `https://${accountUrl}`
  accountUrl = accountUrl.replace(/\/+$/, "")
  try {
    const u = new URL(accountUrl)
    if (u.protocol !== "https:") errors.push("Account URL must use https.")
    if (!u.hostname.toLowerCase().endsWith(".snowflakecomputing.com"))
      errors.push("Account URL must be a *.snowflakecomputing.com host.")
  } catch {
    errors.push("Account URL is not a valid URL.")
  }

  const authType = str(input.authType).toUpperCase() as AuthType
  const validType = ["PAT", "KEYPAIR", "OAUTH", "SSO"].includes(authType)
  if (!validType) errors.push("Auth type must be OAUTH, SSO, PAT, or KEYPAIR.")
  const interactive = validType && isInteractive(authType)

  const user = str(input.user)
  if (!user && !interactive) errors.push("User is required for PAT and key-pair auth.")

  const credentialPath = interactive ? "" : str(input.credentialPath)
  if (!credentialPath && !interactive) errors.push("Credential file path is required.")

  const passphraseEnvVar = str(input.passphraseEnvVar)
  if (passphraseEnvVar && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(passphraseEnvVar))
    errors.push("Passphrase env var must be a valid environment variable name.")

  const role = str(input.role).toUpperCase()
  if (!role || !IDENT.test(role)) errors.push("Role must be a valid unquoted identifier.")

  const warehouse = str(input.warehouse).toUpperCase()
  if (warehouse && !IDENT.test(warehouse)) errors.push("Warehouse must be a valid unquoted identifier (or leave it blank to use the user's default).")

  const policySchema = str(input.policySchema)
  if (policySchema && !QUALIFIED.test(policySchema)) errors.push("Policy schema must look like DATABASE.SCHEMA.")

  if (errors.length) throw new ValidationError(errors.join(" "))

  const host = new URL(accountUrl).hostname
  return {
    label: str(input.label) || host.split(".")[0],
    accountUrl,
    user,
    authType,
    credentialPath,
    passphraseEnvVar: authType === "KEYPAIR" && passphraseEnvVar ? passphraseEnvVar : undefined,
    role,
    warehouse,
    policySchema: policySchema || undefined,
    enabled: input.enabled !== false,
  }
}

export class ValidationError extends Error {}

/** Same account URL and user. Snowflake user names are case-insensitive. */
function sameAccount(a: Pick<ManagedAccountInput, "accountUrl" | "user">, b: Pick<ManagedAccountInput, "accountUrl" | "user">) {
  return a.accountUrl.toLowerCase() === b.accountUrl.toLowerCase() && a.user.toUpperCase() === b.user.toUpperCase()
}

export async function createAccount(input: Partial<ManagedAccountInput>): Promise<ManagedAccount> {
  const clean = validateInput(input)
  const accounts = await listAccounts()
  if (accounts.some((a) => sameAccount(a, clean)))
    throw new ValidationError("An account with this URL and user already exists.")
  const now = new Date().toISOString()
  const account: ManagedAccount = { ...clean, id: randomUUID(), createdAt: now, updatedAt: now }
  await saveAccounts([...accounts, account])
  return account
}

export async function updateAccount(id: string, input: Partial<ManagedAccountInput>): Promise<ManagedAccount> {
  const accounts = await listAccounts()
  const idx = accounts.findIndex((a) => a.id === id)
  if (idx < 0) throw new ValidationError("Account not found.")
  const merged = validateInput({ ...accounts[idx], ...input })
  const updated: ManagedAccount = { ...accounts[idx], ...merged, updatedAt: new Date().toISOString() }
  accounts[idx] = updated
  await saveAccounts(accounts)
  return updated
}

export async function deleteAccount(id: string): Promise<void> {
  const accounts = await listAccounts()
  await saveAccounts(accounts.filter((a) => a.id !== id))
}

/** Bulk import. Validates every row first; writes nothing if any row is invalid. */
export async function importAccounts(rows: unknown[]): Promise<{ added: number; skipped: number }> {
  const existing = await listAccounts()
  const now = new Date().toISOString()
  const toAdd: ManagedAccount[] = []
  let skipped = 0
  rows.forEach((row, i) => {
    let clean: ManagedAccountInput
    try {
      clean = validateInput(row as Partial<ManagedAccountInput>)
    } catch (e: any) {
      throw new ValidationError(`Row ${i + 1}: ${e.message}`)
    }
    const dup = [...existing, ...toAdd].some((a) => sameAccount(a, clean))
    if (dup) skipped++
    else toAdd.push({ ...clean, id: randomUUID(), createdAt: now, updatedAt: now })
  })
  await saveAccounts([...existing, ...toAdd])
  return { added: toAdd.length, skipped }
}
