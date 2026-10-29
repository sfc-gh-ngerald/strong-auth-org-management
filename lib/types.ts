// Shared types used by both API routes and client components. Nothing in this
// file may reference credentials — the browser only ever sees credential paths.

/**
 * PAT / KEYPAIR read a credential file from disk.
 * OAUTH (Snowflake OAuth for local apps) and SSO (EXTERNALBROWSER) sign in interactively in the
 * browser; the session lives in this server process's memory only and nothing is written to disk.
 */
export type AuthType = "PAT" | "KEYPAIR" | "OAUTH" | "SSO"

export const INTERACTIVE_AUTH: AuthType[] = ["OAUTH", "SSO"]
export const isInteractive = (t: AuthType) => INTERACTIVE_AUTH.includes(t)

/** One managed Snowflake account, as stored in config/accounts.json. */
export interface ManagedAccount {
  id: string
  /** Friendly name shown in the UI (e.g. "EDW Prod"). */
  label: string
  /** Account URL, e.g. https://myorg-myaccount.snowflakecomputing.com */
  accountUrl: string
  /** Snowflake login name. Required for PAT/KEYPAIR; optional for OAUTH/SSO (checked after sign-in when set). */
  user: string
  authType: AuthType
  /** Local path to a PAT file (PAT) or a PEM private key (KEYPAIR). `~` is expanded. Empty for OAUTH/SSO. */
  credentialPath: string
  /** Name of an env var holding the private-key passphrase (KEYPAIR only). Never the passphrase itself. */
  passphraseEnvVar?: string
  /** Role used for reads and remediation. Needs IMPORTED PRIVILEGES on SNOWFLAKE; ALTER USER rights to run fixes. */
  role: string
  /** Warehouse for ACCOUNT_USAGE queries. Empty = the signed-in user's DEFAULT_WAREHOUSE. */
  warehouse: string
  /** Optional DB.SCHEMA where account-level authentication policies are created. */
  policySchema?: string
  /** In scope toggle. OAUTH/SSO accounts are only in scope while signed in. */
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type ManagedAccountInput = Omit<ManagedAccount, "id" | "createdAt" | "updatedAt">

/** Account plus local, non-secret file checks for display. */
export interface SessionInfo {
  user: string
  role: string
  /** Warehouse actually in use (configured, or the user's default); null if none. */
  warehouse: string | null
  signedInAt: string
}

export interface AccountView extends ManagedAccount {
  credentialFileFound: boolean
  passphraseEnvVarSet: boolean | null
  /** Live interactive session (OAUTH/SSO), null when signed out or not interactive. */
  session: SessionInfo | null
  signingIn: boolean
  /** enabled AND (file-based OR signed in). */
  inScope: boolean
}

export type UserKind = "PERSON" | "SERVICE" | "LEGACY_SERVICE" | "OTHER"

export type Severity = "critical" | "high" | "medium" | "low" | "info"

export type IssueCode =
  | "HUMAN_ACTIVE_PASSWORD_ONLY"
  | "HUMAN_SSO_UNPROTECTED_PASSWORD"
  | "HUMAN_DORMANT_PASSWORD"
  | "LIKELY_SERVICE_TYPED_AS_PERSON"
  | "LEGACY_SERVICE_ACTIVE_PASSWORD"
  | "LEGACY_SERVICE_IDLE_PASSWORD"
  | "LEGACY_SERVICE_CONVERT_TYPE"
  | "ACCOUNT_NO_AUTH_POLICY"
  | "ACCOUNT_NO_NETWORK_POLICY"

export interface UserRecord {
  name: string
  loginName: string | null
  email: string | null
  kind: UserKind
  rawType: string | null
  hasPassword: boolean
  hasMfa: boolean
  hasRsaKey: boolean
  hasPat: boolean
  hasWorkloadIdentity: boolean
  lastSuccessLogin: string | null
  createdOn: string | null
  owner: string | null
  adminRoles: string[]
  /** User-level authentication policy (DB.SCHEMA.NAME), if one is attached. Snowflake allows only one. */
  authPolicy?: string | null
  /** Login-history signals over the last 90 days. */
  logins90d: number
  passwordOnlyLogins90d: number
  lastPasswordOnlyLogin: string | null
  passwordOnlyClients: string[]
  ssoLogins90d: number
  keypairLogins90d: number
  patLogins90d: number
  mfaLogins90d: number
  failedLogins90d: number
  /** Derived readiness. */
  ready: boolean
  atRisk: boolean
  issues: IssueCode[]
}

export interface Fix {
  /** Stable key: accountId|issue|user|variant */
  key: string
  variant: string
  accountId: string
  accountLabel: string
  issue: IssueCode
  severity: Severity
  userName: string | null
  title: string
  rationale: string
  impact: string
  /** Manual steps that cannot be automated (e.g. user must enroll MFA, update a connector). */
  manualSteps: string[]
  /** Parameters the operator must supply before SQL can run. */
  params: FixParam[]
  /** True when the app can execute SQL for this fix. */
  executable: boolean
  /** Preview of SQL with parameters left as <placeholders>. Server rebuilds from params on execute. */
  sqlPreview: string[]
  tags: string[]
  /** Set when this exact fix was executed successfully recently (ACCOUNT_USAGE lags up to 2h). */
  appliedAt: string | null
}

export interface FixParam {
  key: string
  label: string
  placeholder: string
  help?: string
  multiline?: boolean
  defaultValue?: string
}

export interface ClientBreakdown {
  client: string
  users: number
  logins: number
}

export interface AccountPosture {
  accountLevelAuthPolicy: string | null
  accountAuthPolicyMfaEnrollment: string | null
  usersWithAuthPolicy: number
  accountNetworkPolicy: string | null
  ssoIntegrations: string[]
  oauthIntegrations: string[]
}

export interface AccountMetrics {
  totalUsers: number
  disabledUsers: number
  humans: number
  services: number
  legacyServices: number
  ready: number
  notReady: number
  atRisk: number
  passwordHumans: number
  mfaEnrolledPasswordHumans: number
  dormantPasswordUsers: number
  ssoWithPassword: number
  adminsTotal: number
  adminsNotReady: number
  patUsers: number
  keypairUsers: number
  workloadIdentityUsers: number
  failedLogins90d: number
  readinessPct: number | null
}

export interface SectionError {
  section: string
  message: string
}

/** Where user attributes come from. "live" = SHOW USERS (real time); "account_usage" = ACCOUNT_USAGE.USERS (lags up to ~2h). */
export type UserSource = "live" | "account_usage"

export interface AccountSnapshot {
  accountId: string
  /** Source requested for this snapshot, and the one actually used (live falls back to account_usage on error). */
  userSourceRequested: UserSource
  userSource: UserSource
  userSourceNote: string | null
  label: string
  accountUrl: string
  status: "ok" | "partial" | "error" | "signed_out"
  error: string | null
  sectionErrors: SectionError[]
  collectedAt: string
  durationMs: number
  metrics: AccountMetrics | null
  posture: AccountPosture | null
  passwordOnlyClients: ClientBreakdown[]
  users: UserRecord[]
  fixes: Fix[]
}

export interface OrgOverview {
  generatedAt: string
  accountsInScope: number
  /** Enabled OAUTH/SSO accounts waiting for a browser sign-in. */
  accountsAwaitingSignIn: number
  userSource: UserSource
  accounts: AccountSnapshot[]
  totals: AccountMetrics
  passwordOnlyClients: ClientBreakdown[]
}

export interface ExecutionStatement {
  sql: string
  ok: boolean
  error?: string
  rows?: number
}

export interface AuditEntry {
  id: string
  fixKey: string
  at: string
  accountId: string
  accountLabel: string
  issue: IssueCode
  userName: string | null
  dryRun: boolean
  ok: boolean
  statements: ExecutionStatement[]
}
