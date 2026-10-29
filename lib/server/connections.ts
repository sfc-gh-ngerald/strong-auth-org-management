import { promises as fs } from "fs"
import snowflake from "snowflake-sdk"
import { isInteractive, type AccountView, type ManagedAccount, type SessionInfo } from "@/lib/types"
import { credentialFileFound, expandHome } from "./accounts"

/**
 * Per-account Snowflake connections.
 *
 * - PAT / KEYPAIR: credentials are read from a local file and the app connects on demand.
 * - OAUTH / SSO: the operator clicks "Sign in"; the driver opens the browser to the account's
 *   login page (Snowflake OAuth for local applications via the built-in SNOWFLAKE$LOCAL_APPLICATION
 *   integration, or EXTERNALBROWSER SSO). The resulting session lives only in this process's
 *   memory — clientStoreTemporaryCredential stays false, so no token is cached on disk. These
 *   accounts are never signed in implicitly; queries fail with NotSignedInError until the
 *   operator signs in, and a server restart signs every account out.
 */

snowflake.configure({ logLevel: "ERROR" })

type Conn = snowflake.Connection
interface Entry {
  key: string
  conn: Promise<Conn>
  session: SessionInfo | null
  interactive: boolean
}
// Kept on globalThis so dev-mode hot reloads don't drop live sign-ins. A full process restart
// still signs everything out, by design.
const g = globalThis as typeof globalThis & { __saccConnections?: Map<string, Entry>; __saccSigningIn?: Set<string> }
const cache = (g.__saccConnections ??= new Map<string, Entry>())
const signingIn = (g.__saccSigningIn ??= new Set<string>())

export class NotSignedInError extends Error {
  constructor(label: string) {
    super(`Not signed in to ${label}. Click "Sign in" to authenticate in the browser.`)
  }
}

function accountIdentifier(accountUrl: string): string {
  return new URL(accountUrl).hostname.replace(/\.snowflakecomputing\.com$/i, "")
}

function cacheKey(a: ManagedAccount) {
  return `${a.updatedAt}|${a.accountUrl}|${a.user}|${a.role}|${a.warehouse}|${a.authType}`
}

async function buildOptions(a: ManagedAccount): Promise<snowflake.ConnectionOptions> {
  const base: snowflake.ConnectionOptions = {
    account: accountIdentifier(a.accountUrl),
    accessUrl: a.accountUrl,
    role: a.role,
    // Omitted when blank so the session uses the user's DEFAULT_WAREHOUSE.
    ...(a.warehouse ? { warehouse: a.warehouse } : {}),
    application: "StrongAuthControlCenter",
    clientSessionKeepAlive: true,
  }
  if (a.authType === "OAUTH") {
    // Client id defaults to LOCAL_APPLICATION; the driver requests scope session:role:<role> and
    // listens for the redirect on http://127.0.0.1:<random port>.
    return {
      ...base,
      ...(a.user ? { username: a.user } : {}),
      authenticator: "OAUTH_AUTHORIZATION_CODE",
      browserActionTimeout: 180_000,
      clientStoreTemporaryCredential: false,
    }
  }
  if (a.authType === "SSO") {
    return {
      ...base,
      ...(a.user ? { username: a.user } : {}),
      authenticator: "EXTERNALBROWSER",
      browserActionTimeout: 180_000,
      clientStoreTemporaryCredential: false,
    }
  }
  const credentialPath = expandHome(a.credentialPath)
  if (a.authType === "PAT") {
    let token: string
    try {
      token = (await fs.readFile(credentialPath, "utf8")).trim()
    } catch (e: any) {
      throw new Error(`Cannot read PAT file at ${a.credentialPath}: ${e?.code ?? e?.message ?? e}`)
    }
    if (!token) throw new Error(`PAT file at ${a.credentialPath} is empty.`)
    return { ...base, username: a.user, authenticator: "PROGRAMMATIC_ACCESS_TOKEN", token }
  }
  try {
    await fs.access(credentialPath)
  } catch {
    throw new Error(`Private key file not found at ${a.credentialPath}.`)
  }
  const opts: snowflake.ConnectionOptions = {
    ...base,
    username: a.user,
    authenticator: "SNOWFLAKE_JWT",
    privateKeyPath: credentialPath,
  }
  if (a.passphraseEnvVar) {
    const pass = process.env[a.passphraseEnvVar]
    if (!pass) throw new Error(`Env var ${a.passphraseEnvVar} (private key passphrase) is not set.`)
    opts.privateKeyPass = pass
  }
  return opts
}

const PRIVILEGED = ["ACCOUNTADMIN", "SECURITYADMIN", "ORGADMIN", "GLOBALORGADMIN"]

function cleanError(err: unknown, a?: ManagedAccount): string {
  let msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim()
  // The driver reports a closed, abandoned, or timed-out browser login this way.
  if (a && isInteractive(a.authType) && /connection was never established|browser action timed out|timed out/i.test(msg)) {
    return `The browser sign-in for ${a.label} didn't complete (the tab was closed or it timed out after 3 minutes). Click Sign in to try again. Driver message: ${msg}`
  }
  if (a?.authType === "OAUTH" && PRIVILEGED.includes(a.role.toUpperCase()) && /block|scope|role|consent|not allowed|invalid/i.test(msg)) {
    msg +=
      ` — if ${a.role} was refused, this account may block privileged roles for OAuth (OAUTH_ADD_PRIVILEGED_ROLES_TO_BLOCKED_LIST).` +
      " Try SSO sign-in or a custom admin role (e.g. STRONG_AUTH_ADMIN)."
  }
  return msg
}

async function connect(a: ManagedAccount): Promise<Conn> {
  const conn = snowflake.createConnection(await buildOptions(a))
  try {
    // connectAsync is required for browser-based authenticators and works for all of them.
    await conn.connectAsync(() => {})
  } catch (e) {
    throw new Error(cleanError(e, a))
  }
  return conn
}

function destroy(entry: Entry | undefined) {
  entry?.conn.then((c) => c.destroy(() => {})).catch(() => {})
}

async function getConnection(a: ManagedAccount): Promise<Conn> {
  const key = cacheKey(a)
  const hit = cache.get(a.id)
  if (hit && hit.key === key) {
    const conn = await hit.conn.catch(() => null)
    if (conn && conn.isUp()) return conn
  }
  if (isInteractive(a.authType)) {
    // Never open a browser implicitly (e.g. from an overview refresh).
    if (hit) {
      destroy(hit)
      cache.delete(a.id)
    }
    throw new NotSignedInError(a.label)
  }
  if (hit) destroy(hit)
  const conn = connect(a)
  cache.set(a.id, { key, conn, session: null, interactive: false })
  conn.catch(() => cache.delete(a.id))
  return conn
}

export function dropConnection(accountId: string): void {
  const hit = cache.get(accountId)
  cache.delete(accountId)
  destroy(hit)
}

const NO_WAREHOUSE_HINT =
  " — no warehouse is active. Set a Warehouse on this account in Managed accounts, or give the user a DEFAULT_WAREHOUSE they can use (ALTER USER … SET DEFAULT_WAREHOUSE = …)."

function execute(conn: Conn, sqlText: string, binds: snowflake.Binds = []): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, _stmt, rows) => {
        if (!err) return resolve(rows ?? [])
        let msg = cleanError(err)
        if (/no active warehouse/i.test(msg)) msg += NO_WAREHOUSE_HINT
        reject(new Error(msg))
      },
    })
  })
}

export async function runSql(a: ManagedAccount, sqlText: string, binds: snowflake.Binds = []) {
  return execute(await getConnection(a), sqlText, binds)
}

// ---------------------------------------------------------------------------
// Interactive sign-in (OAUTH / SSO)
// ---------------------------------------------------------------------------

export function getSession(accountId: string): SessionInfo | null {
  return cache.get(accountId)?.session ?? null
}

export function isSigningIn(accountId: string) {
  return signingIn.has(accountId)
}

/** Opens the browser login for an OAUTH/SSO account and keeps the session in memory. */
export async function signIn(a: ManagedAccount): Promise<SessionInfo> {
  if (!isInteractive(a.authType)) throw new Error("Sign-in applies only to OAuth and SSO accounts.")
  if (signingIn.has(a.id)) throw new Error("A sign-in for this account is already in progress — finish it in the browser tab that opened.")
  signingIn.add(a.id)
  dropConnection(a.id)
  try {
    const conn = await connect(a)
    const [row] = await execute(conn, "SELECT CURRENT_USER() AS U, CURRENT_ROLE() AS R, CURRENT_WAREHOUSE() AS W")
    const user = String(row?.U ?? "")
    const role = String(row?.R ?? "")
    const warehouse = row?.W ? String(row.W) : null
    if (a.user && user.toUpperCase() !== a.user.toUpperCase()) {
      conn.destroy(() => {})
      throw new Error(`Signed in as ${user}, but this account is configured for ${a.user}. Sign in as ${a.user} or clear the User field.`)
    }
    const session: SessionInfo = { user, role, warehouse, signedInAt: new Date().toISOString() }
    cache.set(a.id, { key: cacheKey(a), conn: Promise.resolve(conn), session, interactive: true })
    return session
  } finally {
    signingIn.delete(a.id)
  }
}

export function signOut(accountId: string) {
  dropConnection(accountId)
}

export function isInScope(a: ManagedAccount): boolean {
  if (!a.enabled) return false
  if (!isInteractive(a.authType)) return true
  const hit = cache.get(a.id)
  return !!hit?.session && hit.key === cacheKey(a)
}

export function toView(a: ManagedAccount): AccountView {
  const hit = cache.get(a.id)
  const session = hit?.session && hit.key === cacheKey(a) ? hit.session : null
  return {
    ...a,
    credentialFileFound: credentialFileFound(a),
    passphraseEnvVarSet: a.passphraseEnvVar ? !!process.env[a.passphraseEnvVar] : null,
    session,
    signingIn: signingIn.has(a.id),
    inScope: isInScope(a),
  }
}

/** Connection test: returns the session context so the UI can confirm role/warehouse. */
export async function testConnection(a: ManagedAccount) {
  if (!isInteractive(a.authType)) dropConnection(a.id)
  const [row] = await runSql(
    a,
    "SELECT CURRENT_ACCOUNT() AS ACCOUNT, CURRENT_ORGANIZATION_NAME() AS ORG, CURRENT_USER() AS USER_NAME, CURRENT_ROLE() AS ROLE, CURRENT_WAREHOUSE() AS WAREHOUSE, CURRENT_REGION() AS REGION"
  )
  let accountUsage = false
  let accountUsageError: string | null = null
  try {
    await runSql(a, "SELECT 1 FROM SNOWFLAKE.ACCOUNT_USAGE.USERS LIMIT 1")
    accountUsage = true
  } catch (e) {
    accountUsageError = cleanError(e)
  }
  return {
    account: row?.ACCOUNT ?? null,
    organization: row?.ORG ?? null,
    user: row?.USER_NAME ?? null,
    role: row?.ROLE ?? null,
    warehouse: row?.WAREHOUSE ?? null,
    region: row?.REGION ?? null,
    accountUsage,
    accountUsageError,
  }
}
