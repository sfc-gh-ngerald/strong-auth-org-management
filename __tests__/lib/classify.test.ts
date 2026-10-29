import { describe, expect, it } from "vitest"
import {
  buildFixes,
  classifyUser,
  computeMetrics,
  fixSpec,
  normalizeRsaPublicKey,
  normalizeSchema,
  quoteIdent,
  userKind,
} from "../../lib/classify"
import type { ManagedAccount, UserRecord } from "../../lib/types"

const account: ManagedAccount = {
  id: "acct-1",
  label: "EDW",
  accountUrl: "https://org-edw.snowflakecomputing.com",
  user: "SVC",
  authType: "PAT",
  credentialPath: "~/pat",
  role: "SECURITYADMIN",
  warehouse: "WH",
  policySchema: "SEC.POLICIES",
  enabled: true,
  createdAt: "",
  updatedAt: "",
}

function signals(over: Partial<UserRecord> = {}) {
  return {
    name: "JANE",
    loginName: "JANE",
    email: "jane@example.com",
    kind: "PERSON" as const,
    rawType: null,
    hasPassword: true,
    hasMfa: false,
    hasRsaKey: false,
    hasPat: false,
    hasWorkloadIdentity: false,
    lastSuccessLogin: null,
    createdOn: null,
    owner: null,
    adminRoles: [],
    logins90d: 0,
    passwordOnlyLogins90d: 0,
    lastPasswordOnlyLogin: null,
    passwordOnlyClients: [],
    ssoLogins90d: 0,
    keypairLogins90d: 0,
    patLogins90d: 0,
    mfaLogins90d: 0,
    failedLogins90d: 0,
    ...over,
  }
}

describe("userKind", () => {
  it("treats null/empty as PERSON", () => {
    expect(userKind(null)).toBe("PERSON")
    expect(userKind("LEGACY_SERVICE")).toBe("LEGACY_SERVICE")
    expect(userKind("SERVICE")).toBe("SERVICE")
  })
})

describe("classifyUser", () => {
  it("human with password + MFA is ready", () => {
    const u = classifyUser(signals({ hasMfa: true, passwordOnlyLogins90d: 0, logins90d: 5 }))
    expect(u.ready).toBe(true)
    expect(u.issues).toEqual([])
  })

  it("active password-only human is not ready and at risk", () => {
    const u = classifyUser(signals({ logins90d: 3, passwordOnlyLogins90d: 3, passwordOnlyClients: ["SNOWFLAKE_UI"] }))
    expect(u.issues).toEqual(["HUMAN_ACTIVE_PASSWORD_ONLY"])
    expect(u.atRisk).toBe(true)
  })

  it("password-only human with an existing user policy gets guidance, not a second policy", () => {
    const at = { logins90d: 3, passwordOnlyLogins90d: 3, passwordOnlyClients: ["SNOWFLAKE_UI"] }
    const fresh = fixSpec("HUMAN_ACTIVE_PASSWORD_ONLY", classifyUser(signals(at)), account)
    expect(fresh.variant).toBe("require-mfa")
    expect(fresh.executable).toBe(true)

    const has = classifyUser(signals({ ...at, authPolicy: "SEC.POLICIES.EXISTING" }))
    const spec = fixSpec("HUMAN_ACTIVE_PASSWORD_ONLY", has, account)
    expect(spec.variant).toBe("require-mfa-existing-policy")
    expect(spec.executable).toBe(false)
    expect(spec.build({}, false)).toEqual([])
    expect(spec.impact).toContain("SEC.POLICIES.EXISTING")
  })

  it("SSO human with leftover password gets unset-password", () => {
    const u = classifyUser(signals({ logins90d: 4, ssoLogins90d: 4 }))
    expect(u.issues).toEqual(["HUMAN_SSO_UNPROTECTED_PASSWORD"])
    expect(u.atRisk).toBe(false)
  })

  it("dormant human password user", () => {
    expect(classifyUser(signals()).issues).toEqual(["HUMAN_DORMANT_PASSWORD"])
  })

  it("integration typed as PERSON is detected by name", () => {
    const u = classifyUser(signals({ name: "FIVETRAN_SERVICE_USER", email: null, logins90d: 9, passwordOnlyLogins90d: 9 }))
    expect(u.issues).toEqual(["LIKELY_SERVICE_TYPED_AS_PERSON"])
    expect(u.atRisk).toBe(true)
  })

  it("legacy service without password is ready but still gets a cleanup fix", () => {
    const u = classifyUser(signals({ kind: "LEGACY_SERVICE", rawType: "LEGACY_SERVICE", hasPassword: false, hasRsaKey: true }))
    expect(u.ready).toBe(true)
    expect(u.issues).toEqual(["LEGACY_SERVICE_CONVERT_TYPE"])
  })

  it("legacy service using a password is at risk", () => {
    const u = classifyUser(signals({ kind: "LEGACY_SERVICE", rawType: "LEGACY_SERVICE", logins90d: 10, passwordOnlyLogins90d: 10 }))
    expect(u.issues).toEqual(["LEGACY_SERVICE_ACTIVE_PASSWORD"])
    expect(u.atRisk).toBe(true)
  })

  it("SERVICE users are always ready", () => {
    expect(classifyUser(signals({ kind: "SERVICE", rawType: "SERVICE", hasPassword: false })).ready).toBe(true)
  })
})

describe("fixes", () => {
  it("legacy service without a key gets register-key, with a key gets convert", () => {
    const noKey = classifyUser(signals({ name: "ETL", kind: "LEGACY_SERVICE", rawType: "LEGACY_SERVICE", logins90d: 1, passwordOnlyLogins90d: 1 }))
    expect(fixSpec("LEGACY_SERVICE_ACTIVE_PASSWORD", noKey, account).variant).toBe("register-key")
    const withKey = { ...noKey, hasRsaKey: true }
    const spec = fixSpec("LEGACY_SERVICE_ACTIVE_PASSWORD", withKey, account)
    expect(spec.variant).toBe("unset-password-convert")
    expect(spec.build({}, false)).toEqual(['ALTER USER "ETL" UNSET PASSWORD;', 'ALTER USER "ETL" SET TYPE = SERVICE;'])
  })

  it("admin users are escalated to critical", () => {
    const u = classifyUser(signals({ adminRoles: ["ACCOUNTADMIN"] }))
    expect(fixSpec("HUMAN_DORMANT_PASSWORD", u, account).severity).toBe("critical")
  })

  it("adds account-level fixes when policies are missing", () => {
    const fixes = buildFixes(account, [], {
      accountLevelAuthPolicy: null,
      accountAuthPolicyMfaEnrollment: null,
      usersWithAuthPolicy: 0,
      accountNetworkPolicy: null,
      ssoIntegrations: [],
      oauthIntegrations: [],
    })
    expect(fixes.map((f) => f.issue).sort()).toEqual(["ACCOUNT_NO_AUTH_POLICY", "ACCOUNT_NO_NETWORK_POLICY"])
    const net = fixes.find((f) => f.issue === "ACCOUNT_NO_NETWORK_POLICY")!
    expect(net.executable).toBe(false)
  })

  it("previews placeholders, executes with validated params", () => {
    const spec = fixSpec("ACCOUNT_NO_AUTH_POLICY", null, account)
    expect(spec.build({}, true)[1]).toContain("<policySchema>")
    expect(spec.build({ policySchema: "SEC.POLICIES" }, false)[1]).toBe(
      "ALTER ACCOUNT SET AUTHENTICATION POLICY SEC.POLICIES.SACC_ACCOUNT_STRONG_AUTH;"
    )
  })
})

describe("SQL safety", () => {
  it("quotes identifiers", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"')
  })

  it("rejects schema injection", () => {
    expect(() => normalizeSchema("SEC.POLICIES; DROP DATABASE X")).toThrow()
    expect(() => normalizeSchema("SEC")).toThrow()
    expect(normalizeSchema("SEC.POLICIES")).toBe("SEC.POLICIES")
  })

  it("rejects private keys and non-base64 public keys", () => {
    expect(() => normalizeRsaPublicKey("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toThrow()
    expect(() => normalizeRsaPublicKey("abc'; DROP USER X; --")).toThrow()
    const body = "A".repeat(300)
    expect(normalizeRsaPublicKey(`-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`)).toBe(body)
  })

  it("user names with quotes cannot break out of the identifier", () => {
    const u = classifyUser(signals({ name: 'X"; DROP USER Y; --', logins90d: 1, ssoLogins90d: 1 }))
    expect(fixSpec("HUMAN_SSO_UNPROTECTED_PASSWORD", u, account).build({}, false)).toEqual([
      'ALTER USER "X""; DROP USER Y; --" UNSET PASSWORD;',
    ])
  })
})

describe("computeMetrics", () => {
  it("computes readiness", () => {
    const users = [
      classifyUser(signals({ hasMfa: true })),
      classifyUser(signals({ name: "B", logins90d: 1, passwordOnlyLogins90d: 1 })),
      classifyUser(signals({ name: "C", kind: "SERVICE", rawType: "SERVICE", hasPassword: false })),
    ]
    const m = computeMetrics(users, 2)
    expect(m.totalUsers).toBe(3)
    expect(m.ready).toBe(2)
    expect(m.atRisk).toBe(1)
    expect(m.disabledUsers).toBe(2)
    expect(Math.round(m.readinessPct!)).toBe(67)
  })
})
