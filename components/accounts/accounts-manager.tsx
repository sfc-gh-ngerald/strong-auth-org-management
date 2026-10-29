"use client"

import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CheckCircle2,
  FileKey2,
  FileUp,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Pencil,
  Plug,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react"
import { isInteractive, type AccountView, type AuthType, type ManagedAccountInput } from "@/lib/types"
import { copyText } from "@/lib/clipboard"
import { formatRelative } from "@/lib/format"
import { PageHeader } from "@/components/page-header"
import { StatCard, StatCardSkeleton } from "@/components/stat-card"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, Input, Select, Switch, Textarea } from "@/components/ui/form"

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body as T
}

const EMPTY: ManagedAccountInput = {
  label: "",
  accountUrl: "",
  user: "",
  authType: "OAUTH",
  credentialPath: "",
  passphraseEnvVar: "",
  role: "ACCOUNTADMIN",
  warehouse: "",
  policySchema: "",
  enabled: true,
}

const AUTH_LABEL: Record<AuthType, string> = {
  OAUTH: "Snowflake OAuth",
  SSO: "SSO browser",
  PAT: "PAT file",
  KEYPAIR: "Key pair",
}

type SignInResult = { ok: true } | { ok: false; error: string }

type TestResult =
  | { ok: true; account: string; organization: string; user: string; role: string; warehouse: string | null; region: string; accountUsage: boolean; accountUsageError: string | null }
  | { ok: false; error: string }

export function AccountsManager() {
  const qc = useQueryClient()
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<AccountView[]>("/api/accounts"),
    refetchInterval: (q) => (q.state.data?.some((a) => a.signingIn) ? 2000 : false),
  })
  const [editing, setEditing] = useState<AccountView | "new" | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [deleting, setDeleting] = useState<AccountView | null>(null)
  const [tests, setTests] = useState<Record<string, TestResult | "running">>({})
  const [signIns, setSignIns] = useState<Record<string, SignInResult | "running">>({})

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["accounts"] })
    qc.invalidateQueries({ queryKey: ["overview"] })
  }

  const toggle = useMutation({
    mutationFn: (a: AccountView) =>
      api(`/api/accounts/${a.id}`, { method: "PUT", body: JSON.stringify({ enabled: !a.enabled }) }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (a: AccountView) => api(`/api/accounts/${a.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeleting(null)
      invalidate()
    },
  })

  const runTest = async (a: AccountView) => {
    setTests((t) => ({ ...t, [a.id]: "running" }))
    try {
      const r = await api<TestResult>(`/api/accounts/${a.id}/test`, { method: "POST" })
      setTests((t) => ({ ...t, [a.id]: r }))
    } catch (e) {
      setTests((t) => ({ ...t, [a.id]: { ok: false, error: e instanceof Error ? e.message : String(e) } }))
    }
  }

  const signIn = async (a: { id: string }) => {
    setSignIns((t) => ({ ...t, [a.id]: "running" }))
    try {
      const r = await api<SignInResult>(`/api/accounts/${a.id}/signin`, { method: "POST", body: "{}" })
      setSignIns((t) => ({ ...t, [a.id]: r }))
    } catch (e) {
      setSignIns((t) => ({ ...t, [a.id]: { ok: false, error: e instanceof Error ? e.message : String(e) } }))
    }
    setTests((t) => ({ ...t, [a.id]: undefined as any }))
    invalidate()
  }
  const signOut = async (a: AccountView) => {
    await api(`/api/accounts/${a.id}/signout`, { method: "POST", body: "{}" }).catch(() => {})
    setSignIns((t) => ({ ...t, [a.id]: undefined as any }))
    setTests((t) => ({ ...t, [a.id]: undefined as any }))
    invalidate()
  }

  const list = accounts.data ?? []
  const inScope = list.filter((a) => a.inScope)
  const awaiting = list.filter((a) => a.enabled && !a.inScope && isInteractive(a.authType))
  const fileBased = list.filter((a) => !isInteractive(a.authType))

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        eyebrow="Scope"
        title="Managed accounts"
        description="Only accounts listed, enabled, and (for OAuth/SSO) signed in are queried on the overview and can have fixes executed. Browser sign-ins live in this app's memory only — nothing is written to disk, and restarting the app signs every account out."
        actions={
          <>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <FileUp className="h-4 w-4" /> Import JSON
            </Button>
            <Button onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" /> Add account
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {accounts.isPending ? (
          Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            <StatCard label="Accounts registered" value={list.length} icon={Server} />
            <StatCard label="In scope" value={inScope.length} hint="Enabled and authenticated" icon={ShieldCheck} />
            <StatCard label="Awaiting sign-in" value={awaiting.length} hint="Enabled OAuth / SSO accounts" icon={LogIn} />
            <StatCard
              label="Credential files missing"
              value={fileBased.filter((a) => !a.credentialFileFound).length}
              hint={`of ${fileBased.length} PAT / key-pair accounts`}
              icon={FileKey2}
            />
          </>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>
            Toggle an account off to take it out of scope without deleting it. OAuth and SSO accounts also need a browser sign-in
            each time the app starts.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {accounts.isPending ? (
            <div className="space-y-2 p-6">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : accounts.error ? (
            <div className="p-6">
              <EmptyState variant="error" title="Could not load accounts" description={accounts.error.message} />
            </div>
          ) : list.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No accounts yet"
                description="Add each Snowflake account you manage by URL, then sign in through the browser (Snowflake OAuth or SSO). PAT and key-pair files are also supported for unattended use."
                action={
                  <Button size="sm" onClick={() => setEditing("new")}>
                    <Plus className="h-4 w-4" /> Add account
                  </Button>
                }
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Scope</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Auth</TableHead>
                  <TableHead>Role / warehouse</TableHead>
                  <TableHead>Connection</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((a) => {
                  const t = tests[a.id]
                  return (
                    <TableRow key={a.id} className={a.enabled ? undefined : "opacity-60"}>
                      <TableCell>
                        <Switch
                          checked={a.enabled}
                          disabled={toggle.isPending}
                          onCheckedChange={() => toggle.mutate(a)}
                          label={`Include ${a.label} in scope`}
                        />
                      </TableCell>
                      <TableCell className="min-w-0 max-w-72">
                        <p className="truncate font-medium">{a.label}</p>
                        <p className="truncate text-xs text-muted-foreground">{a.accountUrl.replace("https://", "")}</p>
                        <p className="truncate text-xs text-muted-foreground">{a.user ? `user ${a.user}` : "any user (set at sign-in)"}</p>
                      </TableCell>
                      <TableCell className="max-w-64">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline">{AUTH_LABEL[a.authType]}</Badge>
                          {isInteractive(a.authType) ? (
                            a.session ? (
                              <Badge variant="success">signed in</Badge>
                            ) : (
                              <Badge variant={a.enabled ? "warning" : "outline"}>signed out</Badge>
                            )
                          ) : a.credentialFileFound ? (
                            <Badge variant="success">file found</Badge>
                          ) : (
                            <Badge variant="destructive">file missing</Badge>
                          )}
                          {a.passphraseEnvVarSet === false && <Badge variant="warning">passphrase env unset</Badge>}
                        </div>
                        {isInteractive(a.authType) ? (
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            {a.session ? `${a.session.user} · signed in ${formatRelative(a.session.signedInAt)}` : "No stored credential"}
                          </p>
                        ) : (
                          <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={a.credentialPath}>
                            {a.credentialPath}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        <p>{a.role}</p>
                        <p className="text-muted-foreground">
                          {a.warehouse ||
                            (a.session
                              ? a.session.warehouse
                                ? `${a.session.warehouse} (user default)`
                                : "no default warehouse"
                              : "user default")}
                        </p>
                      </TableCell>
                      <TableCell className="max-w-72 text-xs">
                        {signIns[a.id] === "running" || a.signingIn ? (
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for browser sign-in…
                          </span>
                        ) : signIns[a.id] && !(signIns[a.id] as SignInResult).ok && !a.session ? (
                          <span className="flex items-start gap-1.5 break-words text-destructive">
                            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {(signIns[a.id] as { error: string }).error}
                          </span>
                        ) : t === "running" ? (
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Testing…
                          </span>
                        ) : t?.ok ? (
                          <div className="space-y-0.5">
                            <span className="flex items-center gap-1.5 text-success">
                              <CheckCircle2 className="h-3.5 w-3.5" /> {t.organization}.{t.account} · {t.role}
                            </span>
                            {t.accountUsage ? (
                              <span className="text-muted-foreground">ACCOUNT_USAGE readable</span>
                            ) : (
                              <span className="block break-words text-warning">
                                No ACCOUNT_USAGE access: {t.accountUsageError}
                              </span>
                            )}
                          </div>
                        ) : t ? (
                          <span className="flex items-start gap-1.5 break-words text-destructive">
                            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t.error}
                          </span>
                        ) : a.session ? (
                          <span className="flex items-center gap-1.5 text-success">
                            <CheckCircle2 className="h-3.5 w-3.5" /> {a.session.role}
                          </span>
                        ) : isInteractive(a.authType) ? (
                          <span className="text-muted-foreground">
                            {a.enabled ? "Sign in to bring into scope" : "Out of scope"}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Updated {formatRelative(a.updatedAt)}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {isInteractive(a.authType) &&
                            (a.session ? (
                              <Button variant="ghost" size="sm" onClick={() => signOut(a)}>
                                <LogOut className="h-3.5 w-3.5" /> Sign out
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                onClick={() => signIn(a)}
                                disabled={signIns[a.id] === "running" || a.signingIn}
                              >
                                <LogIn className="h-3.5 w-3.5" /> Sign in
                              </Button>
                            ))}
                          {(!isInteractive(a.authType) || a.session) && (
                            <Button variant="outline" size="sm" onClick={() => runTest(a)} disabled={t === "running"}>
                              <Plug className="h-3.5 w-3.5" /> Test
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" onClick={() => setEditing(a)} aria-label={`Edit ${a.label}`}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => setDeleting(a)} aria-label={`Remove ${a.label}`}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <SetupHelp />

      {editing && (
        <AccountDialog
          account={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null)
            invalidate()
            if (isInteractive(saved.authType) && saved.enabled && !saved.session) signIn(saved)
          }}
        />
      )}
      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false)
            invalidate()
          }}
        />
      )}
      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {deleting?.label}?</DialogTitle>
            <DialogDescription>
              The account is removed from this app&apos;s scope. Nothing changes in Snowflake, and the credential file is not
              touched.
            </DialogDescription>
          </DialogHeader>
          {remove.error && (
            <Alert variant="destructive">
              <AlertDescription>{remove.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

function AccountDialog({
  account,
  onClose,
  onSaved,
}: {
  account: AccountView | null
  onClose: () => void
  onSaved: (saved: AccountView) => void
}) {
  const [form, setForm] = useState<ManagedAccountInput>(() =>
    account
      ? {
          label: account.label,
          accountUrl: account.accountUrl,
          user: account.user,
          authType: account.authType,
          credentialPath: account.credentialPath,
          passphraseEnvVar: account.passphraseEnvVar ?? "",
          role: account.role,
          warehouse: account.warehouse,
          policySchema: account.policySchema ?? "",
          enabled: account.enabled,
        }
      : EMPTY
  )
  const save = useMutation({
    mutationFn: () =>
      api<AccountView>(account ? `/api/accounts/${account.id}` : "/api/accounts", {
        method: account ? "PUT" : "POST",
        body: JSON.stringify(form),
      }),
    onSuccess: onSaved,
  })
  const interactive = isInteractive(form.authType)
  const set = (k: keyof ManagedAccountInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{account ? `Edit ${account.label}` : "Add account"}</DialogTitle>
          <DialogDescription>
            Browser sign-in (Snowflake OAuth or SSO) stores nothing on disk. Saving a new browser-auth account opens the
            sign-in page right away.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <Field label="Display name" htmlFor="label" hint="Defaults to the account locator.">
            <Input id="label" value={form.label} onChange={set("label")} placeholder="EDW Prod" />
          </Field>
          <Field label="Account URL" htmlFor="accountUrl">
            <Input
              id="accountUrl"
              required
              value={form.accountUrl}
              onChange={set("accountUrl")}
              placeholder="https://myorg-myaccount.snowflakecomputing.com"
            />
          </Field>
          <Field label="Auth method" htmlFor="authType">
            <Select id="authType" value={form.authType} onChange={set("authType")}>
              <option value="OAUTH">Snowflake OAuth — browser sign-in (password + MFA, or SSO)</option>
              <option value="SSO">SSO — browser sign-in through your identity provider</option>
              <option value="PAT">Programmatic access token (PAT file)</option>
              <option value="KEYPAIR">Key pair (PEM private key file)</option>
            </Select>
          </Field>
          <Field
            label={interactive ? "User (optional)" : "User"}
            htmlFor="user"
            hint={interactive ? "If set, sign-in is rejected unless you authenticate as this user." : undefined}
          >
            <Input
              id="user"
              required={!interactive}
              value={form.user}
              onChange={set("user")}
              placeholder={interactive ? "JDOE" : "STRONG_AUTH_ADMIN_SVC"}
            />
          </Field>
          {!interactive && (
          <Field
            label={form.authType === "PAT" ? "PAT file path" : "Private key path"}
            htmlFor="credentialPath"
            className="sm:col-span-2"
            hint={
              form.authType === "PAT"
                ? "A text file containing only the token. ~ is expanded. Keep it chmod 600."
                : "PKCS#8 PEM private key (e.g. ~/.ssh/snowflake/rsa_key.p8)."
            }
          >
            <Input
              id="credentialPath"
              required
              className="font-mono"
              value={form.credentialPath}
              onChange={set("credentialPath")}
              placeholder={form.authType === "PAT" ? "~/.snowflake/pats/edw_prod.token" : "~/.snowflake/keys/edw_prod.p8"}
            />
          </Field>
          )}
          {form.authType === "KEYPAIR" && (
            <Field
              label="Passphrase env var (optional)"
              htmlFor="passphraseEnvVar"
              className="sm:col-span-2"
              hint="Name of an environment variable holding the key passphrase. The passphrase itself is never stored."
            >
              <Input
                id="passphraseEnvVar"
                value={form.passphraseEnvVar ?? ""}
                onChange={set("passphraseEnvVar")}
                placeholder="EDW_PROD_KEY_PASSPHRASE"
              />
            </Field>
          )}
          <Field label="Role" htmlFor="role" hint="Reads ACCOUNT_USAGE; needs ALTER USER rights to run fixes.">
            <Input id="role" required value={form.role} onChange={set("role")} placeholder="SECURITYADMIN" />
          </Field>
          <Field
            label="Warehouse (optional)"
            htmlFor="warehouse"
            hint="Leave blank to use the signed-in user's default warehouse."
          >
            <Input id="warehouse" value={form.warehouse} onChange={set("warehouse")} placeholder="User default" />
          </Field>
          <Field
            label="Policy schema (optional)"
            htmlFor="policySchema"
            className="sm:col-span-2"
            hint="Existing DATABASE.SCHEMA where authentication policies are created by fixes. Can also be entered per fix."
          >
            <Input id="policySchema" value={form.policySchema ?? ""} onChange={set("policySchema")} placeholder="SECURITY_DB.POLICIES" />
          </Field>
          {save.error && (
            <Alert variant="destructive" className="sm:col-span-2">
              <AlertDescription>{save.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {account ? "Save changes" : "Add account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const IMPORT_EXAMPLE = `[
  {
    "label": "EDW Prod",
    "accountUrl": "https://myorg-edw_prod.snowflakecomputing.com",
    "authType": "OAUTH",
    "role": "STRONG_AUTH_ADMIN",
    "policySchema": "SECURITY_DB.POLICIES"
  },
  {
    "label": "EDW Dev",
    "accountUrl": "https://myorg-edw_dev.snowflakecomputing.com",
    "user": "STRONG_AUTH_ADMIN_SVC",
    "authType": "KEYPAIR",
    "credentialPath": "~/.snowflake/keys/strong_auth_admin.p8",
    "role": "STRONG_AUTH_ADMIN",
    "warehouse": "ADMIN_WH"
  }
]`

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("")
  const [result, setResult] = useState<{ added: number; skipped: number } | null>(null)
  const run = useMutation({
    mutationFn: async () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error("Not valid JSON.")
      }
      return api<{ added: number; skipped: number }>("/api/accounts/import", { method: "POST", body: JSON.stringify(parsed) })
    },
    onSuccess: setResult,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && (result ? onDone() : onClose())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import accounts</DialogTitle>
          <DialogDescription>
            Paste a JSON array. Every row is validated first; nothing is saved if any row is invalid. Duplicates (same URL +
            user) are skipped.
          </DialogDescription>
        </DialogHeader>
        <Textarea className="min-h-64" value={text} onChange={(e) => setText(e.target.value)} placeholder={IMPORT_EXAMPLE} />
        {run.error && (
          <Alert variant="destructive">
            <AlertDescription>{run.error.message}</AlertDescription>
          </Alert>
        )}
        {result && (
          <Alert>
            <AlertTitle>Imported</AlertTitle>
            <AlertDescription>
              {result.added} added, {result.skipped} skipped as duplicates.
            </AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          {result ? (
            <Button onClick={onDone}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={!text.trim() || run.isPending} onClick={() => run.mutate()}>
                Import
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const SETUP_SQL = `-- Run once per account as ACCOUNTADMIN / SECURITYADMIN.
CREATE ROLE IF NOT EXISTS STRONG_AUTH_ADMIN;
GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE STRONG_AUTH_ADMIN;   -- ACCOUNT_USAGE views
GRANT APPLICATION ROLE SNOWFLAKE.TRUST_CENTER_VIEWER TO ROLE STRONG_AUTH_ADMIN; -- Strong Auth Hub in Snowsight
GRANT USAGE ON WAREHOUSE ADMIN_WH TO ROLE STRONG_AUTH_ADMIN;

-- To execute fixes, the role also needs to manage users and policies.
-- Simplest: grant SECURITYADMIN (owns USERADMIN-created users, can apply auth policies).
GRANT ROLE SECURITYADMIN TO ROLE STRONG_AUTH_ADMIN;

-- Dedicated service user for this app (key pair shown; a PAT also works).
CREATE USER IF NOT EXISTS STRONG_AUTH_ADMIN_SVC
  TYPE = SERVICE
  DEFAULT_ROLE = STRONG_AUTH_ADMIN
  DEFAULT_WAREHOUSE = ADMIN_WH
  RSA_PUBLIC_KEY = '<paste public key body>';
GRANT ROLE STRONG_AUTH_ADMIN TO USER STRONG_AUTH_ADMIN_SVC;

-- PAT alternative (PATs require the user to be covered by a network policy by default):
-- ALTER USER STRONG_AUTH_ADMIN_SVC ADD PROGRAMMATIC ACCESS TOKEN SACC_TOKEN
--   ROLE_RESTRICTION = 'STRONG_AUTH_ADMIN' DAYS_TO_EXPIRY = 30;`

function SetupHelp() {
  const [copied, setCopied] = useState(false)
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Per-account setup</CardTitle>
          <CardDescription>
            Read-only metrics need IMPORTED PRIVILEGES on the SNOWFLAKE database and a warehouse (the account&apos;s configured
            one, or the user&apos;s default). Executing fixes needs a role
            that can ALTER the affected users and create/apply authentication policies.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            if (await copyText(SETUP_SQL)) {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }
          }}
        >
          {copied ? "Copied" : "Copy SQL"}
        </Button>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs leading-relaxed">{SETUP_SQL}</pre>
      </CardContent>
    </Card>
  )
}
