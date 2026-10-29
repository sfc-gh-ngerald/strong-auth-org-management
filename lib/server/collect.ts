import { promises as fs } from "fs"
import path from "path"
import { randomUUID } from "crypto"
import { redactForLog } from "@/lib/server/redact"
import type {
  AccountPosture,
  AccountSnapshot,
  AuditEntry,
  ClientBreakdown,
  ExecutionStatement,
  ManagedAccount,
  OrgOverview,
  SectionError,
  UserRecord,
  UserSource,
} from "@/lib/types"
import {
  ADMIN_ROLES,
  FixParamError,
  buildFixes,
  classifyUser,
  computeMetrics,
  fixSpec,
  mergeClients,
  sumMetrics,
  userKind,
} from "@/lib/classify"
import { configDir, getAccount, listAccounts } from "./accounts"
import { isInScope, runSql } from "./connections"
import { isInteractive } from "@/lib/types"

// ---------------------------------------------------------------------------
// Read queries. All are read-only and run with the account's configured role.
// ACCOUNT_USAGE views lag by up to ~2 hours.
// ---------------------------------------------------------------------------

const Q_USERS = `
SELECT NAME, LOGIN_NAME, EMAIL, TYPE, HAS_PASSWORD, HAS_MFA, EXT_AUTHN_DUO,
       HAS_RSA_PUBLIC_KEY, HAS_PAT, HAS_WORKLOAD_IDENTITY,
       COALESCE(TRY_TO_BOOLEAN(TO_VARCHAR(DISABLED)), FALSE) AS IS_DISABLED,
       LAST_SUCCESS_LOGIN, CREATED_ON, OWNER
FROM SNOWFLAKE.ACCOUNT_USAGE.USERS
WHERE DELETED_ON IS NULL
  AND NAME NOT IN ('SNOWFLAKE', 'WORKSHEETS_APP_USER')
  AND COALESCE(TYPE, 'PERSON') <> 'SNOWFLAKE_SERVICE'`

const PW_ONLY = "FIRST_AUTHENTICATION_FACTOR = 'PASSWORD' AND SECOND_AUTHENTICATION_FACTOR IS NULL"
const Q_LOGINS = `
SELECT USER_NAME,
       COALESCE(REPORTED_CLIENT_TYPE, 'UNKNOWN') AS CLIENT,
       COUNT_IF(IS_SUCCESS = 'YES') AS OK_LOGINS,
       COUNT_IF(IS_SUCCESS = 'YES' AND ${PW_ONLY}) AS PW_ONLY,
       MAX(IFF(IS_SUCCESS = 'YES' AND ${PW_ONLY}, EVENT_TIMESTAMP, NULL)) AS LAST_PW_ONLY,
       COUNT_IF(IS_SUCCESS = 'YES' AND FIRST_AUTHENTICATION_FACTOR = 'PASSWORD' AND SECOND_AUTHENTICATION_FACTOR IS NOT NULL) AS MFA,
       COUNT_IF(IS_SUCCESS = 'YES' AND FIRST_AUTHENTICATION_FACTOR IN ('SAML2_ASSERTION', 'OAUTH_ACCESS_TOKEN')) AS SSO,
       COUNT_IF(IS_SUCCESS = 'YES' AND FIRST_AUTHENTICATION_FACTOR = 'RSA_KEYPAIR') AS KEYPAIR,
       COUNT_IF(IS_SUCCESS = 'YES' AND FIRST_AUTHENTICATION_FACTOR = 'PROGRAMMATIC_ACCESS_TOKEN') AS PAT,
       COUNT_IF(IS_SUCCESS = 'NO') AS FAILED
FROM SNOWFLAKE.ACCOUNT_USAGE.LOGIN_HISTORY
WHERE EVENT_TIMESTAMP >= DATEADD('day', -90, CURRENT_TIMESTAMP())
GROUP BY 1, 2`

const Q_ADMINS = `
SELECT GRANTEE_NAME, ROLE
FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_USERS
WHERE DELETED_ON IS NULL
  AND ROLE IN (${ADMIN_ROLES.map((r) => `'${r}'`).join(", ")})`

const Q_AUTH_POLICY_REFS = `
SELECT POLICY_DB, POLICY_SCHEMA, POLICY_NAME, REF_ENTITY_DOMAIN, REF_ENTITY_NAME
FROM SNOWFLAKE.ACCOUNT_USAGE.POLICY_REFERENCES
WHERE POLICY_KIND = 'AUTHENTICATION_POLICY'`

const Q_USERS_LIVE = "SHOW USERS"
const Q_USER_COUNT_AU = "SELECT COUNT(*) AS N FROM SNOWFLAKE.ACCOUNT_USAGE.USERS WHERE DELETED_ON IS NULL AND NAME NOT IN ('SNOWFLAKE', 'WORKSHEETS_APP_USER') AND COALESCE(TYPE, 'PERSON') <> 'SNOWFLAKE_SERVICE'"
const EXCLUDED_USERS = new Set(["SNOWFLAKE", "WORKSHEETS_APP_USER"])

const Q_NETWORK_POLICY = "SHOW PARAMETERS LIKE 'NETWORK_POLICY' IN ACCOUNT"
const Q_INTEGRATIONS = "SHOW SECURITY INTEGRATIONS"

const bool = (v: unknown) => v === true || v === "true" || v === "TRUE"
const num = (v: unknown) => Number(v ?? 0) || 0
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null)
const pick = (row: Record<string, any>, key: string) => row[key] ?? row[key.toLowerCase()]

// ---------------------------------------------------------------------------
// Snapshot cache
// ---------------------------------------------------------------------------

// globalThis so dev-mode hot reloads keep snapshots (and in-flight collections) alive.
const g = globalThis as typeof globalThis & {
  __saccSnapshots?: Map<string, AccountSnapshot>
  __saccInflight?: Map<string, Promise<AccountSnapshot>>
}
const snapshots = (g.__saccSnapshots ??= new Map<string, AccountSnapshot>())
const inflight = (g.__saccInflight ??= new Map<string, Promise<AccountSnapshot>>())

export async function collectAccount(account: ManagedAccount, source: UserSource = "live"): Promise<AccountSnapshot> {
  const running = inflight.get(account.id)
  if (running) return running
  const p = doCollect(account, source).finally(() => inflight.delete(account.id))
  inflight.set(account.id, p)
  const snap = await p
  snapshots.set(account.id, snap)
  return snap
}

/**
 * User attributes. "live" uses SHOW USERS (real time, so new users and just-applied fixes show up
 * immediately) and falls back to ACCOUNT_USAGE.USERS if SHOW USERS fails. SHOW USERS only lists users
 * the role can see, so a much smaller count than ACCOUNT_USAGE is flagged.
 */
async function fetchUsers(
  account: ManagedAccount,
  source: UserSource
): Promise<{ rows: Record<string, any>[]; used: UserSource; note: string | null }> {
  if (source === "account_usage") {
    return { rows: await runSql(account, Q_USERS), used: "account_usage", note: "ACCOUNT_USAGE.USERS — can lag up to ~2 hours" }
  }
  let live: Record<string, any>[]
  try {
    live = await runSql(account, Q_USERS_LIVE)
  } catch (e: any) {
    const rows = await runSql(account, Q_USERS)
    return { rows, used: "account_usage", note: `SHOW USERS failed (${e?.message ?? e}); used ACCOUNT_USAGE.USERS instead` }
  }
  const rows = live
    .filter((r) => {
      const name = String(pick(r, "name") ?? "")
      const type = String(pick(r, "type") ?? "").toUpperCase()
      return name && !EXCLUDED_USERS.has(name) && type !== "SNOWFLAKE_SERVICE"
    })
    .map((r) => ({
      NAME: pick(r, "name"),
      LOGIN_NAME: pick(r, "login_name"),
      EMAIL: pick(r, "email"),
      TYPE: pick(r, "type") || null,
      HAS_PASSWORD: pick(r, "has_password"),
      HAS_MFA: pick(r, "has_mfa"),
      EXT_AUTHN_DUO: pick(r, "ext_authn_duo"),
      HAS_RSA_PUBLIC_KEY: pick(r, "has_rsa_public_key"),
      HAS_PAT: pick(r, "has_pat"),
      HAS_WORKLOAD_IDENTITY: pick(r, "has_workload_identity"),
      IS_DISABLED: pick(r, "disabled"),
      LAST_SUCCESS_LOGIN: pick(r, "last_success_login"),
      CREATED_ON: pick(r, "created_on"),
      OWNER: pick(r, "owner"),
    }))
  // SHOW USERS lists every user but leaves auth attributes empty for users the role can't fully see.
  // Classifying those rows would report hidden password users as ready, so don't use them.
  const hidden = rows.filter((r) => r.HAS_PASSWORD == null).length
  if (hidden) {
    const why = `SHOW USERS hides authentication details (password, MFA, type) for ${hidden} of ${rows.length} users from this role`
    let auRows: Record<string, any>[]
    try {
      auRows = await runSql(account, Q_USERS)
    } catch (e: any) {
      throw new Error(
        `${why}, and ACCOUNT_USAGE isn't readable (${e?.message ?? e}). Readiness can't be determined. Use a role with IMPORTED PRIVILEGES on database SNOWFLAKE that can see all users, such as ACCOUNTADMIN or SECURITYADMIN.`
      )
    }
    return { rows: auRows, used: "account_usage", note: `${why}; used ACCOUNT_USAGE.USERS instead (can lag up to ~2 hours)` }
  }
  let note = "Live (SHOW USERS)"
  try {
    const [c] = await runSql(account, Q_USER_COUNT_AU)
    const au = num(pick(c, "N"))
    if (au > 0 && rows.length < au * 0.9)
      note = `Live (SHOW USERS) lists ${rows.length} users but ACCOUNT_USAGE has ${au} — this role can't see every user. Use a role that can see all users (e.g. SECURITYADMIN or ACCOUNTADMIN), or switch to ACCOUNT_USAGE.`
  } catch {}
  return { rows, used: "live", note }
}

async function doCollect(account: ManagedAccount, source: UserSource): Promise<AccountSnapshot> {
  const started = Date.now()
  const sectionErrors: SectionError[] = []
  const base = {
    accountId: account.id,
    label: account.label,
    accountUrl: account.accountUrl,
    userSourceRequested: source,
  }

  const section = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn()
    } catch (e: any) {
      sectionErrors.push({ section: name, message: e?.message ?? String(e) })
      return fallback
    }
  }

  let userRows: Record<string, any>[]
  let userSource: UserSource = source
  let userSourceNote: string | null = null
  try {
    const u = await fetchUsers(account, source)
    userRows = u.rows
    userSource = u.used
    userSourceNote = u.note
  } catch (e: any) {
    return {
      ...base,
      userSource,
      userSourceNote,
      status: "error",
      error: e?.message ?? String(e),
      sectionErrors: [],
      collectedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      metrics: null,
      posture: null,
      passwordOnlyClients: [],
      users: [],
      fixes: [],
    }
  }

  const LOGIN_SECTION = "Login history (90 days)"
  const [loginRows, adminRows, policyRows, netRows, integrationRows] = await Promise.all([
    section(LOGIN_SECTION, () => runSql(account, Q_LOGINS), [] as Record<string, any>[]),
    section("Admin role grants", () => runSql(account, Q_ADMINS), [] as Record<string, any>[]),
    section("Authentication policy references", () => runSql(account, Q_AUTH_POLICY_REFS), null as Record<string, any>[] | null),
    section("Account network policy", () => runSql(account, Q_NETWORK_POLICY), null as Record<string, any>[] | null),
    section("Security integrations", () => runSql(account, Q_INTEGRATIONS), [] as Record<string, any>[]),
  ])

  // Without login history every password user would look dormant and get a "disable" fix,
  // including people who sign in daily. Refuse to classify instead.
  const loginError = sectionErrors.find((s) => s.section === LOGIN_SECTION)
  if (loginError) {
    return {
      ...base,
      userSource,
      userSourceNote,
      status: "error",
      error: `Can't read SNOWFLAKE.ACCOUNT_USAGE.LOGIN_HISTORY, so readiness can't be determined safely. Grant IMPORTED PRIVILEGES on database SNOWFLAKE to this role. (${loginError.message})`,
      sectionErrors,
      collectedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      metrics: null,
      posture: null,
      passwordOnlyClients: [],
      users: [],
      fixes: [],
    }
  }

  // Login signals per user, and password-only usage per client.
  type Agg = {
    ok: number; pw: number; lastPw: string | null; mfa: number; sso: number
    kp: number; pat: number; failed: number; pwClients: Set<string>
  }
  const logins = new Map<string, Agg>()
  // Per client: password-only login count per user.
  const clientUsers = new Map<string, Map<string, number>>()
  for (const r of loginRows) {
    const user = String(pick(r, "USER_NAME") ?? "")
    const client = String(pick(r, "CLIENT") ?? "UNKNOWN")
    const a = logins.get(user) ?? { ok: 0, pw: 0, lastPw: null, mfa: 0, sso: 0, kp: 0, pat: 0, failed: 0, pwClients: new Set() }
    a.ok += num(pick(r, "OK_LOGINS"))
    const pw = num(pick(r, "PW_ONLY"))
    a.pw += pw
    const last = iso(pick(r, "LAST_PW_ONLY"))
    if (last && (!a.lastPw || last > a.lastPw)) a.lastPw = last
    a.mfa += num(pick(r, "MFA"))
    a.sso += num(pick(r, "SSO"))
    a.kp += num(pick(r, "KEYPAIR"))
    a.pat += num(pick(r, "PAT"))
    a.failed += num(pick(r, "FAILED"))
    if (pw > 0) {
      a.pwClients.add(client)
      const c = clientUsers.get(client) ?? new Map<string, number>()
      c.set(user, (c.get(user) ?? 0) + pw)
      clientUsers.set(client, c)
    }
    logins.set(user, a)
  }

  const admins = new Map<string, string[]>()
  for (const r of adminRows) {
    const g = String(pick(r, "GRANTEE_NAME") ?? "")
    admins.set(g, [...(admins.get(g) ?? []), String(pick(r, "ROLE"))])
  }

  const userPolicies = new Map<string, string>()
  for (const r of policyRows ?? []) {
    if (String(pick(r, "REF_ENTITY_DOMAIN")).toUpperCase() !== "USER") continue
    userPolicies.set(String(pick(r, "REF_ENTITY_NAME")), `${pick(r, "POLICY_DB")}.${pick(r, "POLICY_SCHEMA")}.${pick(r, "POLICY_NAME")}`)
  }

  let disabled = 0
  const users: UserRecord[] = []
  for (const r of userRows) {
    if (bool(pick(r, "IS_DISABLED"))) {
      disabled++
      continue
    }
    const name = String(pick(r, "NAME"))
    const rawType = pick(r, "TYPE") ? String(pick(r, "TYPE")) : null
    const l = logins.get(name)
    users.push(
      classifyUser({
        name,
        loginName: pick(r, "LOGIN_NAME") ?? null,
        email: pick(r, "EMAIL") || null,
        kind: userKind(rawType),
        rawType,
        hasPassword: bool(pick(r, "HAS_PASSWORD")),
        hasMfa: bool(pick(r, "HAS_MFA")) || bool(pick(r, "EXT_AUTHN_DUO")),
        hasRsaKey: bool(pick(r, "HAS_RSA_PUBLIC_KEY")),
        hasPat: bool(pick(r, "HAS_PAT")),
        hasWorkloadIdentity: bool(pick(r, "HAS_WORKLOAD_IDENTITY")),
        lastSuccessLogin: iso(pick(r, "LAST_SUCCESS_LOGIN")),
        createdOn: iso(pick(r, "CREATED_ON")),
        owner: pick(r, "OWNER") ?? null,
        adminRoles: [...new Set(admins.get(name) ?? [])].sort(),
        authPolicy: userPolicies.get(name) ?? null,
        logins90d: l?.ok ?? 0,
        passwordOnlyLogins90d: l?.pw ?? 0,
        lastPasswordOnlyLogin: l?.lastPw ?? null,
        passwordOnlyClients: l ? [...l.pwClients].sort() : [],
        ssoLogins90d: l?.sso ?? 0,
        keypairLogins90d: l?.kp ?? 0,
        patLogins90d: l?.pat ?? 0,
        mfaLogins90d: l?.mfa ?? 0,
        failedLogins90d: l?.failed ?? 0,
      })
    )
  }

  // Account posture
  let posture: AccountPosture | null = null
  {
    const accountRef = policyRows?.find((r) => String(pick(r, "REF_ENTITY_DOMAIN")).toUpperCase() === "ACCOUNT")
    const accountPolicy = accountRef
      ? `${pick(accountRef, "POLICY_DB")}.${pick(accountRef, "POLICY_SCHEMA")}.${pick(accountRef, "POLICY_NAME")}`
      : null
    let mfaEnrollment: string | null = null
    if (accountPolicy) {
      mfaEnrollment = await section(
        "Account authentication policy details",
        async () => {
          const rows = await runSql(account, `DESCRIBE AUTHENTICATION POLICY ${accountPolicy}`)
          const row = rows.find((x) => String(pick(x, "property")).toUpperCase() === "MFA_ENROLLMENT")
          return row ? String(pick(row, "value")) : null
        },
        null
      )
    }
    const net = netRows?.find((r) => String(pick(r, "key")).toUpperCase() === "NETWORK_POLICY")
    const netValue = net ? String(pick(net, "value") ?? "").trim() : ""
    const integ = integrationRows.filter((r) => bool(pick(r, "enabled")) || pick(r, "enabled") === undefined)
    const typeOf = (r: Record<string, any>) => String(pick(r, "type") ?? "").toUpperCase()
    posture = {
      accountLevelAuthPolicy: policyRows === null ? "(unknown)" : accountPolicy,
      accountAuthPolicyMfaEnrollment: mfaEnrollment,
      usersWithAuthPolicy: (policyRows ?? []).filter((r) => String(pick(r, "REF_ENTITY_DOMAIN")).toUpperCase() === "USER").length,
      accountNetworkPolicy: netRows === null ? "(unknown)" : netValue || null,
      ssoIntegrations: integ.filter((r) => typeOf(r).includes("SAML")).map((r) => String(pick(r, "name"))),
      oauthIntegrations: integ.filter((r) => typeOf(r).includes("OAUTH")).map((r) => String(pick(r, "name"))),
    }
  }

  // Only users who aren't ready break at enforcement; MFA-enrolled users may still show old password-only logins.
  const notReady = new Set(users.filter((u) => !u.ready).map((u) => u.name))
  const passwordOnlyClients: ClientBreakdown[] = [...clientUsers.entries()]
    .map(([client, perUser]) => {
      const names = [...perUser.keys()].filter((n) => notReady.has(n))
      return { client, users: names.length, logins: names.reduce((s, n) => s + (perUser.get(n) ?? 0), 0) }
    })
    .filter((c) => c.users > 0)
    .sort((a, b) => b.users - a.users)

  const applied = await recentlyAppliedFixes()
  const fixes = buildFixes(account, users, posture).map((f) => ({ ...f, appliedAt: applied.get(f.key) ?? null }))

  return {
    ...base,
    userSource,
    userSourceNote,
    status: sectionErrors.length ? "partial" : "ok",
    error: null,
    sectionErrors,
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    metrics: computeMetrics(users, disabled),
    posture,
    passwordOnlyClients,
    users: users.sort((a, b) => Number(b.atRisk) - Number(a.atRisk) || Number(a.ready) - Number(b.ready) || a.name.localeCompare(b.name)),
    fixes,
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++
        out[idx] = await fn(items[idx])
      }
    })
  )
  return out
}

/**
 * Org overview across every enabled (in-scope) account.
 * refresh: "all" re-collects everything; an account id re-collects just that one;
 * otherwise cached snapshots are reused and only missing ones are collected.
 */
export async function getOverview(refresh?: string | null, source: UserSource = "live"): Promise<OrgOverview> {
  const enabled = (await listAccounts()).filter((a) => a.enabled)
  const accounts = enabled.filter(isInScope)
  const awaiting = enabled.filter((a) => isInteractive(a.authType) && !isInScope(a))
  for (const a of awaiting) snapshots.delete(a.id)
  const snaps = await mapLimit(accounts, 4, async (a) => {
    const cached = snapshots.get(a.id)
    const stale =
      !cached || cached.label !== a.label || cached.userSourceRequested !== source || refresh === "all" || refresh === a.id
    return stale ? collectAccount(a, source) : cached
  })
  const signedOut: AccountSnapshot[] = awaiting.map((a) => ({
    accountId: a.id,
    userSourceRequested: source,
    userSource: source,
    userSourceNote: null,
    label: a.label,
    accountUrl: a.accountUrl,
    status: "signed_out",
    error: "Not signed in — sign in from Managed accounts to bring this account into scope.",
    sectionErrors: [],
    collectedAt: new Date().toISOString(),
    durationMs: 0,
    metrics: null,
    posture: null,
    passwordOnlyClients: [],
    users: [],
    fixes: [],
  }))
  const ok = snaps.filter((s) => s.metrics)
  return {
    generatedAt: new Date().toISOString(),
    accountsInScope: accounts.length,
    accountsAwaitingSignIn: awaiting.length,
    userSource: source,
    accounts: [...snaps, ...signedOut],
    totals: sumMetrics(ok.map((s) => s.metrics!)),
    passwordOnlyClients: mergeClients(ok.map((s) => s.passwordOnlyClients)),
  }
}

export function forgetSnapshot(accountId: string) {
  snapshots.delete(accountId)
}

// ---------------------------------------------------------------------------
// Execution + audit log
// ---------------------------------------------------------------------------

function auditFile() {
  return path.join(configDir(), "audit-log.jsonl")
}

export async function readAudit(limit = 500): Promise<AuditEntry[]> {
  try {
    const raw = await fs.readFile(auditFile(), "utf8")
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => redactEntry(JSON.parse(l) as AuditEntry))
      .reverse()
      .slice(0, limit)
  } catch (e: any) {
    if (e?.code === "ENOENT") return []
    throw e
  }
}

function redactEntry(e: AuditEntry): AuditEntry {
  return {
    ...e,
    statements: e.statements.map((s) => ({ ...s, sql: redactForLog(s.sql), ...(s.error ? { error: redactForLog(s.error) } : {}) })),
  }
}

async function appendAudit(entry: AuditEntry) {
  await fs.mkdir(configDir(), { recursive: true })
  await fs.appendFile(auditFile(), JSON.stringify(entry) + "\n", { mode: 0o600 })
}

/** Successful executions in the last 3h, so the UI can show "applied — pending ACCOUNT_USAGE refresh". */
async function recentlyAppliedFixes(): Promise<Map<string, string>> {
  const cutoff = new Date(Date.now() - 3 * 3600_000).toISOString()
  const map = new Map<string, string>()
  for (const e of await readAudit(2000)) if (!e.dryRun && e.ok && e.at >= cutoff && !map.has(e.fixKey)) map.set(e.fixKey, e.at)
  return map
}

export class ExecutionError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

/**
 * Executes (or dry-runs) one fix. The fix must exist in the latest snapshot for the
 * account; SQL is regenerated server-side from the snapshot + validated params.
 */
export async function executeFix(opts: {
  accountId: string
  fixKey: string
  params: Record<string, string>
  dryRun: boolean
}): Promise<AuditEntry> {
  const account = await getAccount(opts.accountId)
  if (!account) throw new ExecutionError("Account not found.", 404)
  if (!isInScope(account))
    throw new ExecutionError(
      account.enabled ? "Account is not signed in. Sign in from Managed accounts, refresh, and try again." : "Account is not in scope (disabled).",
      400
    )
  const snap = snapshots.get(account.id)
  const fix = snap?.fixes.find((f) => f.key === opts.fixKey)
  if (!snap || !fix) throw new ExecutionError("This fix is no longer in the latest snapshot. Refresh the overview and try again.", 409)
  if (!fix.executable) throw new ExecutionError("This recommendation is guidance only and cannot be executed.", 400)
  const user = fix.userName ? snap.users.find((u) => u.name === fix.userName) ?? null : null

  let sql: string[]
  try {
    sql = fixSpec(fix.issue, user, account).build(opts.params ?? {}, false)
  } catch (e) {
    if (e instanceof FixParamError) throw new ExecutionError(e.message, 400)
    throw e
  }

  const statements: ExecutionStatement[] = []
  let ok = true
  if (opts.dryRun) {
    statements.push(...sql.map((s) => ({ sql: s, ok: true })))
  } else {
    for (const s of sql) {
      if (!ok) {
        statements.push({ sql: s, ok: false, error: "Skipped: a previous statement failed." })
        continue
      }
      try {
        const rows = await runSql(account, s)
        statements.push({ sql: s, ok: true, rows: rows.length })
      } catch (e: any) {
        ok = false
        statements.push({ sql: s, ok: false, error: e?.message ?? String(e) })
      }
    }
  }

  const entry: AuditEntry = {
    id: randomUUID(),
    fixKey: fix.key,
    at: new Date().toISOString(),
    accountId: account.id,
    accountLabel: account.label,
    issue: fix.issue,
    userName: fix.userName,
    dryRun: opts.dryRun,
    ok,
    statements,
  }
  if (!opts.dryRun) {
    const logged = redactEntry(entry)
    await appendAudit(logged)
    if (ok) fix.appliedAt = entry.at
    return logged
  }
  // Dry runs return the full SQL so it can be reviewed before execution.
  return entry
}
