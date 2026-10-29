import type {
  AccountMetrics,
  AccountPosture,
  ClientBreakdown,
  Fix,
  FixParam,
  IssueCode,
  ManagedAccount,
  Severity,
  UserKind,
  UserRecord,
} from "@/lib/types"

/**
 * Readiness rules, aligned with the Strong Authentication Hub categories
 * (https://docs.snowflake.com/en/user-guide/strong-authentication-hub):
 *   - Humans (TYPE=PERSON or NULL) who have a password must be enrolled in MFA.
 *   - Service users must not use passwords; LEGACY_SERVICE is being deprecated.
 *   - SSO users who still hold an unprotected password are a risk.
 *   - Dormant password users without MFA should be disabled or have the password removed.
 * "At risk" = not ready AND has logged in with a single-factor password in the last
 * 90 days, i.e. something will break when enforcement lands.
 */

export const ADMIN_ROLES = ["ACCOUNTADMIN", "SECURITYADMIN", "ORGADMIN", "GLOBALORGADMIN", "USERADMIN"]

const SERVICE_NAME_HINT =
  /(SVC|SERVICE|_SA$|^SA_|ETL|PIPELINE|INTEGRATION|BOT|_API|API_|FIVETRAN|DBT|AIRFLOW|POWERBI|POWER_BI|TABLEAU|LOOKER|SIGMA|COALESCE|COLLIBRA|MATILLION|INFORMATICA|DENODO|MIRROR|LOADER|INGEST|_APP$|_SYS$|AUTOMATION|DEPLOY)/i

const UI_CLIENTS = new Set(["SNOWFLAKE_UI", "SNOWSIGHT", "SNOWFLAKE_WEB"])

export function userKind(rawType: string | null): UserKind {
  const t = (rawType ?? "").toUpperCase()
  if (t === "" || t === "PERSON" || t === "NULL") return "PERSON"
  if (t === "LEGACY_SERVICE") return "LEGACY_SERVICE"
  if (t === "SERVICE" || t === "SERVICE_AGENT") return "SERVICE"
  return "OTHER"
}

export function looksLikeService(u: Pick<UserRecord, "name" | "email" | "passwordOnlyClients" | "logins90d">): boolean {
  if (SERVICE_NAME_HINT.test(u.name)) return true
  const nonUiOnly = u.passwordOnlyClients.length > 0 && u.passwordOnlyClients.every((c) => !UI_CLIENTS.has(c))
  return !u.email && nonUiOnly && u.logins90d > 0
}

type Signals = Omit<UserRecord, "ready" | "atRisk" | "issues">

/** Assigns issues, readiness and risk to a user. */
export function classifyUser(s: Signals): UserRecord {
  const issues: IssueCode[] = []
  const activePwOnly = s.passwordOnlyLogins90d > 0

  if (s.kind === "PERSON" && s.hasPassword && !s.hasMfa) {
    if (looksLikeService(s)) issues.push("LIKELY_SERVICE_TYPED_AS_PERSON")
    else if (activePwOnly) issues.push("HUMAN_ACTIVE_PASSWORD_ONLY")
    else if (s.ssoLogins90d > 0 || s.keypairLogins90d > 0 || s.patLogins90d > 0) issues.push("HUMAN_SSO_UNPROTECTED_PASSWORD")
    else issues.push("HUMAN_DORMANT_PASSWORD")
  } else if (s.kind === "LEGACY_SERVICE") {
    if (s.hasPassword && activePwOnly) issues.push("LEGACY_SERVICE_ACTIVE_PASSWORD")
    else if (s.hasPassword) issues.push("LEGACY_SERVICE_IDLE_PASSWORD")
    else issues.push("LEGACY_SERVICE_CONVERT_TYPE")
  }

  // LEGACY_SERVICE without a password is auto-migrated to SERVICE in Phase 3 and
  // won't break, so it counts as ready (with a low-priority cleanup fix).
  const blocking = issues.filter((i) => i !== "LEGACY_SERVICE_CONVERT_TYPE")
  const ready = blocking.length === 0
  const atRisk = !ready && activePwOnly
  return { ...s, issues, ready, atRisk }
}

export function emptyMetrics(): AccountMetrics {
  return {
    totalUsers: 0,
    disabledUsers: 0,
    humans: 0,
    services: 0,
    legacyServices: 0,
    ready: 0,
    notReady: 0,
    atRisk: 0,
    passwordHumans: 0,
    mfaEnrolledPasswordHumans: 0,
    dormantPasswordUsers: 0,
    ssoWithPassword: 0,
    adminsTotal: 0,
    adminsNotReady: 0,
    patUsers: 0,
    keypairUsers: 0,
    workloadIdentityUsers: 0,
    failedLogins90d: 0,
    readinessPct: null,
  }
}

export function computeMetrics(users: UserRecord[], disabledUsers: number): AccountMetrics {
  const m = emptyMetrics()
  m.disabledUsers = disabledUsers
  for (const u of users) {
    m.totalUsers++
    if (u.kind === "PERSON") m.humans++
    else if (u.kind === "LEGACY_SERVICE") m.legacyServices++
    else m.services++
    if (u.ready) m.ready++
    else m.notReady++
    if (u.atRisk) m.atRisk++
    if (u.kind === "PERSON" && u.hasPassword) {
      m.passwordHumans++
      if (u.hasMfa) m.mfaEnrolledPasswordHumans++
    }
    if (u.issues.includes("HUMAN_DORMANT_PASSWORD") || u.issues.includes("LEGACY_SERVICE_IDLE_PASSWORD")) m.dormantPasswordUsers++
    if (u.issues.includes("HUMAN_SSO_UNPROTECTED_PASSWORD")) m.ssoWithPassword++
    if (u.adminRoles.length) {
      m.adminsTotal++
      if (!u.ready) m.adminsNotReady++
    }
    if (u.hasPat) m.patUsers++
    if (u.hasRsaKey) m.keypairUsers++
    if (u.hasWorkloadIdentity) m.workloadIdentityUsers++
    m.failedLogins90d += u.failedLogins90d
  }
  m.readinessPct = m.totalUsers ? (m.ready / m.totalUsers) * 100 : null
  return m
}

export function sumMetrics(list: AccountMetrics[]): AccountMetrics {
  const t = emptyMetrics()
  for (const m of list) {
    for (const k of Object.keys(t) as (keyof AccountMetrics)[]) {
      if (k === "readinessPct") continue
      ;(t[k] as number) += (m[k] as number) ?? 0
    }
  }
  t.readinessPct = t.totalUsers ? (t.ready / t.totalUsers) * 100 : null
  return t
}

export function mergeClients(lists: ClientBreakdown[][]): ClientBreakdown[] {
  const map = new Map<string, ClientBreakdown>()
  for (const list of lists)
    for (const c of list) {
      const cur = map.get(c.client) ?? { client: c.client, users: 0, logins: 0 }
      cur.users += c.users
      cur.logins += c.logins
      map.set(c.client, cur)
    }
  return [...map.values()].sort((a, b) => b.users - a.users || b.logins - a.logins)
}

// ---------------------------------------------------------------------------
// SQL generation. Everything that reaches Snowflake is built here, server-side,
// from validated parameters — never from SQL text sent by the browser.
// ---------------------------------------------------------------------------

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
}

const QUALIFIED = /^("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\.("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)$/

export class FixParamError extends Error {}

export function normalizeSchema(v: string | undefined): string {
  const s = (v ?? "").trim()
  if (!QUALIFIED.test(s)) throw new FixParamError("Policy schema must be DATABASE.SCHEMA (the schema must already exist).")
  return s
}

/** Accepts a PEM public key or bare base64 body; returns the base64 body. */
export function normalizeRsaPublicKey(v: string | undefined): string {
  const body = (v ?? "")
    .replace(/-----BEGIN [A-Z ]*PUBLIC KEY-----/g, "")
    .replace(/-----END [A-Z ]*PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "")
  if (!body) throw new FixParamError("Paste the RSA public key (PEM or base64 body).")
  if (/PRIVATE/i.test(v ?? "")) throw new FixParamError("That looks like a PRIVATE key. Paste the public key only.")
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length < 200)
    throw new FixParamError("Public key is not valid base64 or is too short.")
  return body
}

export const ACCOUNT_POLICY_NAME = "SACC_ACCOUNT_STRONG_AUTH"
export const USER_MFA_POLICY_NAME = "SACC_REQUIRE_MFA"

type SqlBuilder = (params: Record<string, string>, preview: boolean) => string[]

interface FixSpec {
  variant: string
  title: string
  severity: Severity
  rationale: string
  impact: string
  manualSteps: string[]
  params: FixParam[]
  executable: boolean
  build: SqlBuilder
}

const RSA_PARAM: FixParam = {
  key: "rsaPublicKey",
  label: "RSA public key",
  placeholder: "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq...\n-----END PUBLIC KEY-----",
  help: "Generate with: openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out rsa_key.p8 && openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub",
  multiline: true,
}

function schemaParam(defaultValue?: string): FixParam {
  return {
    key: "policySchema",
    label: "Policy schema",
    placeholder: "SECURITY_DB.POLICIES",
    help: "Existing DATABASE.SCHEMA where the authentication policy object is created.",
    defaultValue,
  }
}

function p(params: Record<string, string>, key: string, preview: boolean, normalize: (v: string) => string): string {
  if (preview && !params[key]) return `<${key}>`
  return normalize(params[key])
}

/** Builds the fix (title, guidance, SQL) for one issue in one account. */
export function fixSpec(issue: IssueCode, user: UserRecord | null, account: ManagedAccount): FixSpec {
  const u = user ? quoteIdent(user.name) : ""
  const strongAlt = !!user && (user.hasRsaKey || user.hasPat || user.hasWorkloadIdentity)
  const clients = user?.passwordOnlyClients.length ? user.passwordOnlyClients.join(", ") : "unknown client"
  const isAdmin = !!user?.adminRoles.length
  const bump = (s: Severity): Severity => (isAdmin && s !== "info" ? "critical" : s)

  const serviceMigration = (activePw: boolean, legacy: boolean): FixSpec => {
    if (!strongAlt)
      return {
        variant: "register-key",
        title: "Register a key pair for this service user",
        severity: bump(activePw ? "critical" : "high"),
        rationale: `${legacy ? "LEGACY_SERVICE users" : "Service-style users"} lose password access when Phase 3 is enforced. ${user?.name} has no key pair, PAT, or workload identity configured.`,
        impact: "Non-breaking. Adds a public key; the password keeps working until you remove it in the next step.",
        manualSteps: [
          "Generate an RSA key pair for the integration and store the private key in the tool's secret store.",
          `Update the connector (${clients}) to authenticate with the key pair.`,
          "Once logins show RSA_KEYPAIR in login history, refresh and run the 'remove password & convert to SERVICE' fix.",
        ],
        params: [RSA_PARAM],
        executable: true,
        build: (pr, preview) => [
          `ALTER USER ${u} SET RSA_PUBLIC_KEY = ${preview && !pr.rsaPublicKey ? "'<rsaPublicKey>'" : quoteLiteral(normalizeRsaPublicKey(pr.rsaPublicKey))};`,
        ],
      }
    return {
      variant: "unset-password-convert",
        title: "Remove password and convert to TYPE = SERVICE",
      severity: bump(activePw ? "critical" : "high"),
      rationale: `${user?.name} already has a strong credential (${[
        user?.hasRsaKey && "key pair",
        user?.hasPat && "PAT",
        user?.hasWorkloadIdentity && "workload identity",
      ]
        .filter(Boolean)
        .join(", ")}). Removing the password and converting the type completes the migration.`,
      impact: activePw
        ? `BREAKING if the integration still sends a password — it logged in with a password-only factor recently via ${clients}. Confirm the connector uses the key pair first.`
        : "Low risk: no password-only logins in the last 90 days.",
      manualSteps: activePw ? [`Confirm ${clients} has been switched to key-pair / PAT authentication.`] : [],
      params: [],
      executable: true,
      build: () => [`ALTER USER ${u} UNSET PASSWORD;`, `ALTER USER ${u} SET TYPE = SERVICE;`],
    }
  }

  switch (issue) {
    case "HUMAN_ACTIVE_PASSWORD_ONLY":
      return {
        variant: "require-mfa",
        title: "Enroll in MFA (password-only human user)",
        severity: bump("critical"),
        rationale: `${user?.name} signed in with a single-factor password in the last 90 days via ${clients} and is not enrolled in MFA. Phase 3 blocks this login.`,
        impact:
          "Attaching the policy forces MFA enrollment for this user's password logins on every client. BI tools that store this password will prompt for or require MFA; move them to SSO/OAuth if possible.",
        manualSteps: [
          `Ask ${user?.email ?? user?.name} to enroll in MFA in Snowsight (profile → Multi-factor authentication).`,
          "If this user only signs in through a BI tool, switch that tool to SSO or OAuth instead of a stored password.",
          "Optionally run the SQL below to require MFA enrollment for this user.",
        ],
        params: [schemaParam(account.policySchema)],
        executable: true,
        build: (pr, preview) => {
          const schema = p(pr, "policySchema", preview, normalizeSchema)
          return [
            `CREATE AUTHENTICATION POLICY IF NOT EXISTS ${schema}.${USER_MFA_POLICY_NAME} MFA_ENROLLMENT = 'REQUIRED_PASSWORD_ONLY' COMMENT = 'Strong Auth Control Center: require MFA for password users';`,
            `ALTER USER ${u} SET AUTHENTICATION POLICY ${schema}.${USER_MFA_POLICY_NAME};`,
          ]
        },
      }
    case "HUMAN_SSO_UNPROTECTED_PASSWORD":
      return {
        variant: "unset-password",
        title: "Remove unused password from SSO user",
        severity: bump("high"),
        rationale: `${user?.name} signs in with SSO / key pair / PAT but still has a password without MFA. A stolen password could be used to sign in and enroll MFA as the attacker.`,
        impact: "Password login stops working for this user. SSO and other configured methods continue to work.",
        manualSteps: [],
        params: [],
        executable: true,
        build: () => [`ALTER USER ${u} UNSET PASSWORD;`],
      }
    case "HUMAN_DORMANT_PASSWORD":
      return {
        variant: "disable",
        title: "Disable dormant password user",
        severity: bump("medium"),
        rationale: `${user?.name} has a password, no MFA, and no successful login in the last 90 days.`,
        impact: "User can no longer sign in until re-enabled (ALTER USER … SET DISABLED = FALSE). Owned objects are untouched.",
        manualSteps: ["If the user is still needed, have them enroll in MFA instead, or UNSET PASSWORD if they use SSO."],
        params: [],
        executable: true,
        build: () => [`ALTER USER ${u} SET DISABLED = TRUE;`],
      }
    case "LIKELY_SERVICE_TYPED_AS_PERSON": {
      const base = serviceMigration(user!.passwordOnlyLogins90d > 0, false)
      return {
        ...base,
        title: `Service-style user typed as PERSON — ${base.title.charAt(0).toLowerCase()}${base.title.slice(1)}`,
        rationale: `${user?.name} looks like an integration (name/clients: ${clients}) but is TYPE=PERSON with a password and no MFA. Integrations can't do MFA, so it should become a SERVICE user. ${base.rationale}`,
      }
    }
    case "LEGACY_SERVICE_ACTIVE_PASSWORD":
      return serviceMigration(true, true)
    case "LEGACY_SERVICE_IDLE_PASSWORD":
      if (user && user.logins90d === 0)
        return {
          variant: "disable",
        title: "Disable unused LEGACY_SERVICE user",
          severity: bump("medium"),
          rationale: `${user.name} is LEGACY_SERVICE with a password and no successful login in 90 days.`,
          impact: "Any job still configured with this user will fail. Re-enable with SET DISABLED = FALSE.",
          manualSteps: ["Confirm with the owning team that this integration is retired."],
          params: [],
          executable: true,
          build: () => [`ALTER USER ${u} SET DISABLED = TRUE;`],
        }
      return serviceMigration(false, true)
    case "LEGACY_SERVICE_CONVERT_TYPE":
      return {
        variant: "convert-type",
        title: "Convert to TYPE = SERVICE",
        severity: bump("low"),
        rationale: `${user?.name} is LEGACY_SERVICE but has no password. Converting now removes the deprecated type ahead of Phase 3.`,
        impact: "Non-breaking: the user already authenticates without a password.",
        manualSteps: [],
        params: [],
        executable: true,
        build: () => [`ALTER USER ${u} SET TYPE = SERVICE;`],
      }
    case "ACCOUNT_NO_AUTH_POLICY":
      return {
        variant: "account-auth-policy",
        title: "Set an account-level authentication policy requiring MFA for password users",
        severity: "medium",
        rationale:
          "No account-level authentication policy is set. An account policy with MFA_ENROLLMENT = 'REQUIRED_PASSWORD_ONLY' makes every password user enroll in MFA now, on your schedule, instead of at enforcement.",
        impact:
          "HIGH IMPACT: applies to every user without a user-level policy. Human password users must enroll in MFA at next sign-in on any client. Fix at-risk users first. Unset with ALTER ACCOUNT UNSET AUTHENTICATION POLICY.",
        manualSteps: ["Communicate the change to users before enabling.", "Remediate at-risk human and legacy service users first."],
        params: [schemaParam(account.policySchema)],
        executable: true,
        build: (pr, preview) => {
          const schema = p(pr, "policySchema", preview, normalizeSchema)
          return [
            `CREATE AUTHENTICATION POLICY IF NOT EXISTS ${schema}.${ACCOUNT_POLICY_NAME} MFA_ENROLLMENT = 'REQUIRED_PASSWORD_ONLY' COMMENT = 'Strong Auth Control Center: account-level strong auth';`,
            `ALTER ACCOUNT SET AUTHENTICATION POLICY ${schema}.${ACCOUNT_POLICY_NAME};`,
          ]
        },
      }
    case "ACCOUNT_NO_NETWORK_POLICY":
      return {
        variant: "network-guidance",
        title: "No account-level network policy",
        severity: "info",
        rationale:
          "No network policy is set at the account level. Network policies are a recommended second control, and by default users need one to use programmatic access tokens.",
        impact: "Guidance only — a network policy that omits a needed IP range locks users out, so this app does not apply one.",
        manualSteps: [
          "Collect egress IPs for users, BI tools, and integrations (or use Snowflake-managed SaaS network rules).",
          "Create network rules and a network policy, test on a single user, then apply at the account level.",
        ],
        params: [],
        executable: false,
        build: () => [],
      }
  }
}

export function buildFixes(account: ManagedAccount, users: UserRecord[], posture: AccountPosture | null): Fix[] {
  const fixes: Fix[] = []
  const make = (issue: IssueCode, user: UserRecord | null): Fix => {
    const spec = fixSpec(issue, user, account)
    const tags: string[] = []
    if (user) {
      tags.push(user.kind)
      if (user.adminRoles.length) tags.push("ADMIN")
      if (user.atRisk) tags.push("AT_RISK")
    }
    return {
      key: `${account.id}|${issue}|${user?.name ?? "*"}|${spec.variant}`,
      variant: spec.variant,
      accountId: account.id,
      accountLabel: account.label,
      issue,
      severity: spec.severity,
      userName: user?.name ?? null,
      title: spec.title,
      rationale: spec.rationale,
      impact: spec.impact,
      manualSteps: spec.manualSteps,
      params: spec.params,
      executable: spec.executable,
      sqlPreview: spec.build({}, true),
      tags,
      appliedAt: null,
    }
  }
  for (const u of users) for (const issue of u.issues) fixes.push(make(issue, u))
  if (posture && !posture.accountLevelAuthPolicy) fixes.push(make("ACCOUNT_NO_AUTH_POLICY", null))
  if (posture && !posture.accountNetworkPolicy) fixes.push(make("ACCOUNT_NO_NETWORK_POLICY", null))
  return fixes.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

export const ISSUE_LABELS: Record<IssueCode, string> = {
  HUMAN_ACTIVE_PASSWORD_ONLY: "Human, password-only logins",
  HUMAN_SSO_UNPROTECTED_PASSWORD: "SSO user with unprotected password",
  HUMAN_DORMANT_PASSWORD: "Dormant password user, no MFA",
  LIKELY_SERVICE_TYPED_AS_PERSON: "Integration typed as PERSON",
  LEGACY_SERVICE_ACTIVE_PASSWORD: "Legacy service using password",
  LEGACY_SERVICE_IDLE_PASSWORD: "Legacy service with idle password",
  LEGACY_SERVICE_CONVERT_TYPE: "Legacy service type cleanup",
  ACCOUNT_NO_AUTH_POLICY: "No account authentication policy",
  ACCOUNT_NO_NETWORK_POLICY: "No account network policy",
}
