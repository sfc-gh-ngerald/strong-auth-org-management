"use client"

import Link from "next/link"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import {
  AlertOctagon,
  CalendarClock,
  ExternalLink,
  FileWarning,
  KeyRound,
  Loader2,
  Lock,
  LogIn,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UserCog,
  Users,
} from "lucide-react"
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import type { AccountSnapshot, OrgOverview, UserSource } from "@/lib/types"
import { ENFORCEMENT_PHASES } from "@/lib/constants"
import { formatNumber, formatPercent, formatRelative, formatDuration } from "@/lib/format"
import { PageHeader } from "@/components/page-header"
import { StatCard, StatCardSkeleton } from "@/components/stat-card"
import { EmptyState } from "@/components/empty-state"
import { CHART_COLORS, CHART_THEME, ChartTooltip } from "@/components/chart-utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { FixesPanel } from "./fixes-panel"

export async function fetchOverview(source: UserSource, refresh?: string): Promise<OrgOverview> {
  const q = new URLSearchParams({ source })
  if (refresh) q.set("refresh", refresh)
  const res = await fetch(`/api/overview?${q}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body as OrgOverview
}

const SOURCE_KEY = "sacc-user-source"

function useUserSource(): [UserSource, (s: UserSource) => void] {
  const [source, setSource] = useState<UserSource>("live")
  useEffect(() => {
    const saved = localStorage.getItem(SOURCE_KEY)
    if (saved === "live" || saved === "account_usage") setSource(saved)
  }, [])
  return [
    source,
    (s) => {
      localStorage.setItem(SOURCE_KEY, s)
      setSource(s)
    },
  ]
}

export function OverviewDashboard() {
  const qc = useQueryClient()
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [source, setSource] = useUserSource()
  // Refetch whenever the page opens: the server reuses cached snapshots and only collects accounts that
  // are newly in scope, so this is cheap. While accounts await a browser sign-in, poll so the page fills
  // in on its own once the login completes (possibly in another tab).
  const overview = useQuery({
    queryKey: ["overview", source],
    queryFn: () => fetchOverview(source),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.accountsAwaitingSignIn ? 5000 : false),
  })

  const refresh = async (target: string) => {
    setRefreshing(target)
    try {
      qc.setQueryData(["overview", source], await fetchOverview(source, target))
    } catch (e) {
      console.error(e)
    } finally {
      setRefreshing(null)
    }
  }

  const data = overview.data
  const t = data?.totals
  const okAccounts = data?.accounts.filter((a) => a.metrics) ?? []
  const noPolicy = okAccounts.filter((a) => a.posture && !a.posture.accountLevelAuthPolicy).length

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        eyebrow="Organization"
        title="Strong authentication overview"
        description="Readiness for MFA enforcement and the LEGACY_SERVICE deprecation across every managed account, with recommended fixes you can review and run."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SourceToggle value={source} onChange={setSource} disabled={!!refreshing} />
            <Button onClick={() => refresh("all")} disabled={!!refreshing || overview.isPending}>
              {refreshing === "all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh all
            </Button>
          </div>
        }
      />

      {overview.isPending ? (
        <LoadingState />
      ) : overview.error ? (
        <EmptyState variant="error" title="Could not build the overview" description={overview.error.message} />
      ) : data && data.accountsInScope === 0 && data.accountsAwaitingSignIn === 0 && overview.isFetching ? (
        <LoadingState />
      ) : data && data.accountsInScope === 0 ? (
        <EmptyState
          icon={data.accountsAwaitingSignIn ? LogIn : undefined}
          title={data.accountsAwaitingSignIn ? `Sign in to bring accounts into scope` : "No accounts in scope"}
          description={
            data.accountsAwaitingSignIn
              ? `${data.accountsAwaitingSignIn} enabled account${data.accountsAwaitingSignIn === 1 ? " is" : "s are"} waiting for a browser sign-in.`
              : "Add the Snowflake accounts you manage, then come back here for org-wide metrics and fixes."
          }
          action={
            <Button asChild size="sm">
              <Link href="/accounts">{data.accountsAwaitingSignIn ? "Sign in to accounts" : "Manage accounts"}</Link>
            </Button>
          }
        />
      ) : data && t ? (
        <>
          <p className="text-xs text-muted-foreground">
            {data.accountsInScope} account{data.accountsInScope === 1 ? "" : "s"} in scope · built{" "}
            {formatRelative(data.generatedAt)} ·{" "}
            {data.userSource === "live"
              ? "users live from SHOW USERS; login history from ACCOUNT_USAGE (can lag up to 2 hours)"
              : "all data from ACCOUNT_USAGE (can lag up to 2 hours)"}
            {overview.isFetching && !refreshing && (
              <span className="ml-2 inline-flex items-center gap-1 text-primary">
                <Loader2 className="h-3 w-3 animate-spin" /> Updating…
              </span>
            )}
          </p>
          {data.accountsAwaitingSignIn > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
              <span className="flex items-center gap-2">
                <LogIn className="h-4 w-4 text-warning" />
                {data.accountsAwaitingSignIn} enabled account{data.accountsAwaitingSignIn === 1 ? " is" : "s are"} signed out and
                excluded from these numbers.
              </span>
              <Button asChild size="sm" variant="outline">
                <Link href="/accounts">Sign in</Link>
              </Button>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Strong auth readiness"
              value={t.readinessPct == null ? "—" : formatPercent(t.readinessPct / 100)}
              hint={`${formatNumber(t.ready)} of ${formatNumber(t.totalUsers)} active users`}
              icon={ShieldCheck}
            />
            <StatCard label="Users not ready" value={formatNumber(t.notReady)} hint="Will need action before enforcement" icon={Users} />
            <StatCard
              label="At-risk users"
              value={formatNumber(t.atRisk)}
              hint="Single-factor password login in last 90 days"
              icon={AlertOctagon}
              className={t.atRisk ? "border-destructive/40" : undefined}
            />
            <StatCard label="Admins not ready" value={formatNumber(t.adminsNotReady)} hint={`of ${formatNumber(t.adminsTotal)} admin-role holders`} icon={UserCog} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="LEGACY_SERVICE users" value={formatNumber(t.legacyServices)} hint="Converted to SERVICE in Phase 3" icon={KeyRound} />
            <StatCard
              label="MFA among password humans"
              value={t.passwordHumans ? formatPercent(t.mfaEnrolledPasswordHumans / t.passwordHumans) : "—"}
              hint={`${formatNumber(t.mfaEnrolledPasswordHumans)} of ${formatNumber(t.passwordHumans)} enrolled`}
              icon={Lock}
            />
            <StatCard label="SSO users with a password" value={formatNumber(t.ssoWithPassword)} hint={`${formatNumber(t.dormantPasswordUsers)} dormant password users`} icon={ShieldAlert} />
            <StatCard label="Accounts without auth policy" value={`${noPolicy} / ${okAccounts.length}`} hint="No account-level authentication policy" icon={FileWarning} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ReadinessByAccount accounts={okAccounts} />
            <ClientChart data={data.passwordOnlyClients} />
          </div>

          <AccountPostureTable accounts={data.accounts} refreshing={refreshing} onRefresh={refresh} />

          <FixesPanel overview={data} />

          <EnforcementCard />
        </>
      ) : null}
    </main>
  )
}

function SourceToggle({ value, onChange, disabled }: { value: UserSource; onChange: (s: UserSource) => void; disabled?: boolean }) {
  const opts: { v: UserSource; label: string; title: string }[] = [
    { v: "live", label: "Live users", title: "SHOW USERS: new users and applied fixes appear immediately" },
    { v: "account_usage", label: "ACCOUNT_USAGE", title: "ACCOUNT_USAGE.USERS: can lag up to 2 hours" },
  ]
  return (
    <div role="radiogroup" aria-label="User data source" className="inline-flex h-9 items-center rounded-md border bg-background p-0.5 text-sm">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          title={o.title}
          disabled={disabled}
          onClick={() => onChange(o.v)}
          className={
            "h-8 rounded px-3 transition-colors disabled:opacity-50 " +
            (value === o.v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Collecting from each account (users, 90 days of login history, grants,
        policies)… this can take a minute for larger accounts.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  )
}

function ReadinessByAccount({ accounts }: { accounts: AccountSnapshot[] }) {
  const rows = accounts
    .map((a) => ({
      name: a.label,
      Ready: a.metrics!.ready,
      "Not ready": a.metrics!.notReady - a.metrics!.atRisk,
      "At risk": a.metrics!.atRisk,
    }))
    .sort((a, b) => b["At risk"] - a["At risk"] || b["Not ready"] - a["Not ready"])
  const height = Math.max(220, rows.length * 34 + 60)
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Readiness by account</CardTitle>
        <CardDescription>Active (non-disabled) users per account</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState title="No account data" description="Every in-scope account failed to collect. See the table below." />
        ) : (
          <div style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid stroke={CHART_THEME.grid} horizontal={false} />
                <XAxis type="number" tick={CHART_THEME.tick} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="name" width={130} tick={CHART_THEME.tick} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--muted)" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Ready" stackId="a" fill="var(--success)" />
                <Bar dataKey="Not ready" stackId="a" fill={CHART_COLORS[2]} />
                <Bar dataKey="At risk" stackId="a" fill="var(--destructive)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ClientChart({ data }: { data: OrgOverview["passwordOnlyClients"] }) {
  const rows = data.slice(0, 10).map((c) => ({ name: c.client, Users: c.users, Logins: c.logins }))
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Single-factor password logins by client</CardTitle>
        <CardDescription>Distinct users per reported client type, last 90 days — these break at enforcement</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState title="No password-only logins" description="No successful single-factor password logins in the last 90 days." />
        ) : (
          <div style={{ height: Math.max(220, rows.length * 34 + 40) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid stroke={CHART_THEME.grid} horizontal={false} />
                <XAxis type="number" tick={CHART_THEME.tick} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="name" width={150} tick={CHART_THEME.tick} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--muted)" }} />
                <Bar dataKey="Users" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function AccountPostureTable({
  accounts,
  refreshing,
  onRefresh,
}: {
  accounts: AccountSnapshot[]
  refreshing: string | null
  onRefresh: (id: string) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account posture</CardTitle>
        <CardDescription>Per-account readiness and account-level controls</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead numeric>Users</TableHead>
              <TableHead numeric>Ready</TableHead>
              <TableHead numeric>At risk</TableHead>
              <TableHead numeric>Legacy svc</TableHead>
              <TableHead numeric>Admins not ready</TableHead>
              <TableHead>Auth policy</TableHead>
              <TableHead>Network policy</TableHead>
              <TableHead>SSO</TableHead>
              <TableHead className="text-right">Collected</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((a) => (
              <TableRow key={a.accountId}>
                <TableCell className="max-w-56">
                  <p className="truncate font-medium">{a.label}</p>
                  {a.status === "signed_out" ? (
                    <Link href="/accounts" className="text-xs text-warning hover:underline">
                      Signed out — sign in
                    </Link>
                  ) : a.status === "error" ? (
                    <p className="break-words text-xs text-destructive">{a.error}</p>
                  ) : a.userSourceNote && (a.userSource !== a.userSourceRequested || /can't see every user/.test(a.userSourceNote)) ? (
                    <p className="break-words text-xs text-warning">{a.userSourceNote}</p>
                  ) : a.status === "partial" ? (
                    <p className="break-words text-xs text-warning" title={a.sectionErrors.map((e) => `${e.section}: ${e.message}`).join("\n")}>
                      Partial: {a.sectionErrors.map((e) => e.section).join(", ")}
                    </p>
                  ) : (
                    <p className="truncate text-xs text-muted-foreground">{a.accountUrl.replace("https://", "")}</p>
                  )}
                </TableCell>
                <TableCell numeric>{a.metrics ? formatNumber(a.metrics.totalUsers) : "—"}</TableCell>
                <TableCell numeric>
                  {a.metrics?.readinessPct != null ? formatPercent(a.metrics.readinessPct / 100) : "—"}
                </TableCell>
                <TableCell numeric className={a.metrics?.atRisk ? "text-destructive" : undefined}>
                  {a.metrics ? formatNumber(a.metrics.atRisk) : "—"}
                </TableCell>
                <TableCell numeric>{a.metrics ? formatNumber(a.metrics.legacyServices) : "—"}</TableCell>
                <TableCell numeric>{a.metrics ? formatNumber(a.metrics.adminsNotReady) : "—"}</TableCell>
                <TableCell className="max-w-48 text-xs">
                  {!a.posture ? (
                    "—"
                  ) : a.posture.accountLevelAuthPolicy ? (
                    <span className="block truncate" title={a.posture.accountLevelAuthPolicy}>
                      <Badge variant="success">set</Badge>{" "}
                      {a.posture.accountAuthPolicyMfaEnrollment && (
                        <span className="text-muted-foreground">MFA {a.posture.accountAuthPolicyMfaEnrollment}</span>
                      )}
                    </span>
                  ) : (
                    <Badge variant="warning">none</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {!a.posture ? "—" : a.posture.accountNetworkPolicy ? <Badge variant="success">set</Badge> : <Badge variant="outline">none</Badge>}
                </TableCell>
                <TableCell className="text-xs">
                  {!a.posture ? "—" : a.posture.ssoIntegrations.length ? (
                    <Badge variant="success" title={a.posture.ssoIntegrations.join(", ")}>
                      SAML ×{a.posture.ssoIntegrations.length}
                    </Badge>
                  ) : (
                    <Badge variant="outline">none</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">
                  <div className="flex items-center justify-end gap-1">
                    <span className="whitespace-nowrap" title={`took ${formatDuration(a.durationMs)}`}>
                      {a.status === "signed_out" ? "—" : formatRelative(a.collectedAt)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Refresh ${a.label}`}
                      disabled={!!refreshing || a.status === "signed_out"}
                      onClick={() => onRefresh(a.accountId)}
                    >
                      {refreshing === a.accountId ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function EnforcementCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-primary" /> Enforcement timeline
        </CardTitle>
        <CardDescription>
          Each account gets its own enforcement date within a phase window. Per-account dates and extension requests live in
          Snowsight → Governance &amp; security → Trust Center → Strong authentication hub (extensions need MODIFY on the
          account).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-3">
        {ENFORCEMENT_PHASES.map((p) => (
          <div key={p.phase} className="min-w-0 rounded-lg border p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-primary">
              {p.phase} · {p.window}
            </p>
            <p className="mt-1 text-sm font-medium">{p.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{p.detail}</p>
          </div>
        ))}
        <div className="flex flex-wrap gap-4 text-sm md:col-span-3">
          <a className="inline-flex items-center gap-1 text-primary hover:underline" href="https://docs.snowflake.com/en/user-guide/security-mfa-rollout" target="_blank" rel="noreferrer">
            Deprecation plan <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <a className="inline-flex items-center gap-1 text-primary hover:underline" href="https://docs.snowflake.com/en/user-guide/strong-authentication-hub" target="_blank" rel="noreferrer">
            Strong Authentication Hub <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </CardContent>
    </Card>
  )
}
