"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, CheckCircle2, Copy, Loader2, Play, XCircle } from "lucide-react"
import type { AuditEntry, Fix, UserRecord } from "@/lib/types"
import { ISSUE_LABELS } from "@/lib/classify"
import { copyText } from "@/lib/clipboard"
import { formatDateTime, formatNumber } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Checkbox, Field, Input, Textarea } from "@/components/ui/form"
import { postExecute, severityBadge } from "./fix-utils"

export function FixSheet({
  fix,
  user,
  onClose,
  onExecuted,
}: {
  fix: Fix
  user: UserRecord | null
  onClose: () => void
  onExecuted: () => void
}) {
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(fix.params.map((p) => [p.key, p.defaultValue ?? ""]))
  )
  const [preview, setPreview] = useState<string[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<AuditEntry | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const missing = fix.params.filter((p) => !params[p.key]?.trim())

  // Regenerate the exact SQL server-side (dry run) whenever inputs are complete.
  useEffect(() => {
    if (!fix.executable) return
    setConfirmed(false)
    if (missing.length) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    setPreviewing(true)
    const t = setTimeout(async () => {
      try {
        const r = await postExecute(fix, params, true)
        if (!cancelled) {
          setPreview(r.statements.map((s) => s.sql))
          setPreviewError(null)
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e)
          setPreview(null)
          setPreviewError(msg)
          if (/not signed in|no longer in the latest snapshot/i.test(msg)) onExecuted()
        }
      } finally {
        if (!cancelled) setPreviewing(false)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(params), fix.key])

  const run = async () => {
    setRunning(true)
    setRunError(null)
    try {
      const r = await postExecute(fix, params, false)
      setResult(r)
      onExecuted()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setRunError(msg)
      if (/not signed in|no longer in the latest snapshot/i.test(msg)) onExecuted()
    } finally {
      setRunning(false)
    }
  }

  const sqlShown = preview ?? fix.sqlPreview

  return (
    <Sheet open onOpenChange={(o) => !o && !running && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="space-y-2 pr-6 text-left">
          <div className="flex flex-wrap items-center gap-2">
            {severityBadge(fix.severity)}
            <Badge variant="outline">{ISSUE_LABELS[fix.issue]}</Badge>
            {fix.tags.includes("ADMIN") && <Badge variant="destructive">admin</Badge>}
            {fix.appliedAt && <Badge variant="success">applied {formatDateTime(fix.appliedAt)}</Badge>}
          </div>
          <SheetTitle>{fix.title}</SheetTitle>
          <SheetDescription>
            {fix.accountLabel}
            {fix.userName ? (
              <>
                {" · "}
                <span className="font-mono">{fix.userName}</span>
              </>
            ) : (
              " · account-level"
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-5 text-sm">
          <section className="space-y-1.5">
            <h3 className="font-medium">Why</h3>
            <p className="text-muted-foreground">{fix.rationale}</p>
          </section>

          <Alert variant={/BREAKING|HIGH IMPACT/.test(fix.impact) ? "destructive" : "default"}>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Impact</AlertTitle>
            <AlertDescription>{fix.impact}</AlertDescription>
          </Alert>

          {user && <UserFacts user={user} />}

          {fix.manualSteps.length > 0 && (
            <section className="space-y-1.5">
              <h3 className="font-medium">Manual steps</h3>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                {fix.manualSteps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </section>
          )}

          {fix.executable && (
            <>
              <Separator />
              {fix.params.map((p) => (
                <Field key={p.key} label={p.label} htmlFor={`param-${p.key}`} hint={p.help}>
                  {p.multiline ? (
                    <Textarea
                      id={`param-${p.key}`}
                      value={params[p.key] ?? ""}
                      placeholder={p.placeholder}
                      onChange={(e) => setParams((s) => ({ ...s, [p.key]: e.target.value }))}
                    />
                  ) : (
                    <Input
                      id={`param-${p.key}`}
                      className="font-mono"
                      value={params[p.key] ?? ""}
                      placeholder={p.placeholder}
                      onChange={(e) => setParams((s) => ({ ...s, [p.key]: e.target.value }))}
                    />
                  )}
                </Field>
              ))}

              <section className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <h3 className="flex items-center gap-2 font-medium">
                    SQL to execute {previewing && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      if (await copyText(sqlShown.join("\n"))) {
                        setCopied(true)
                        setTimeout(() => setCopied(false), 1500)
                      }
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
                  {sqlShown.join("\n")}
                </pre>
                {missing.length > 0 && (
                  <p className="text-xs text-muted-foreground">Fill in {missing.map((m) => m.label).join(", ")} to generate the exact SQL.</p>
                )}
                {previewError && <p className="text-xs text-destructive">{previewError}</p>}
              </section>

              {result ? (
                <ResultView result={result} />
              ) : (
                <section className="space-y-3">
                  <label className="flex items-start gap-2">
                    <Checkbox
                      className="mt-0.5"
                      checked={confirmed}
                      disabled={!preview || previewing}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    <span>
                      I reviewed this SQL and want to run it in <strong>{fix.accountLabel}</strong> with the account&apos;s configured
                      role.
                    </span>
                  </label>
                  {runError && (
                    <Alert variant="destructive">
                      <AlertDescription>{runError}</AlertDescription>
                    </Alert>
                  )}
                  <Button className="w-full" variant="destructive" disabled={!confirmed || running || !preview} onClick={run}>
                    {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Execute
                  </Button>
                </section>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function UserFacts({ user }: { user: UserRecord }) {
  const yes = (v: boolean) => (v ? "yes" : "no")
  const facts: [string, string][] = [
    ["Type", user.rawType ?? "PERSON (unset)"],
    ["Email", user.email ?? "—"],
    ["Password", yes(user.hasPassword)],
    ["MFA enrolled", yes(user.hasMfa)],
    ["Key pair / PAT / WIF", [user.hasRsaKey && "key pair", user.hasPat && "PAT", user.hasWorkloadIdentity && "WIF"].filter(Boolean).join(", ") || "none"],
    ["Admin roles", user.adminRoles.join(", ") || "—"],
    ["Last successful login", user.lastSuccessLogin ? formatDateTime(user.lastSuccessLogin) : "—"],
    ["Logins (90d)", formatNumber(user.logins90d)],
    ["Password-only logins (90d)", formatNumber(user.passwordOnlyLogins90d)],
    ["Last password-only login", user.lastPasswordOnlyLogin ? formatDateTime(user.lastPasswordOnlyLogin) : "—"],
    ["Password-only clients", user.passwordOnlyClients.join(", ") || "—"],
    ["SSO / key pair / PAT logins (90d)", `${user.ssoLogins90d} / ${user.keypairLogins90d} / ${user.patLogins90d}`],
    ["Failed logins (90d)", formatNumber(user.failedLogins90d)],
  ]
  return (
    <section className="space-y-1.5">
      <h3 className="font-medium">User</h3>
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-x-4 gap-y-1 rounded-md border p-3 text-xs">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="break-words font-mono">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function ResultView({ result }: { result: AuditEntry }) {
  return (
    <section className="space-y-2">
      <Alert variant={result.ok ? "default" : "destructive"}>
        {result.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
        <AlertTitle>{result.ok ? "Executed" : "Execution failed"}</AlertTitle>
        <AlertDescription>
          {result.ok
            ? "Logged to the audit log. ACCOUNT_USAGE can take up to 2 hours to reflect the change; the fix is marked applied until then."
            : "Stopped at the first failing statement. Nothing after it ran."}
        </AlertDescription>
      </Alert>
      <ul className="space-y-1.5">
        {result.statements.map((s, i) => (
          <li key={i} className="rounded-md border p-2 text-xs">
            <p className="flex items-start gap-1.5 font-mono">
              {s.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />}
              <span className="break-all">{s.sql}</span>
            </p>
            {s.error && <p className="mt-1 break-words text-destructive">{s.error}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}
