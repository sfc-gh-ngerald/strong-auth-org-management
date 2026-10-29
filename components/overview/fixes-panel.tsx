"use client"

import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, Loader2, Play, Search, Wand2, XCircle } from "lucide-react"
import type { Fix, OrgOverview, Severity } from "@/lib/types"
import { ISSUE_LABELS, SEVERITY_RANK } from "@/lib/classify"
import { formatNumber, formatRelative } from "@/lib/format"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Checkbox, Input, Select } from "@/components/ui/form"
import { FixSheet } from "./fix-sheet"
import { postExecute, severityBadge } from "./fix-utils"

const PAGE = 50

/** Fixes runnable in bulk: executable and every param has a default. */
function bulkReady(f: Fix) {
  return f.executable && !f.appliedAt && f.params.every((p) => !!p.defaultValue)
}

export function FixesPanel({ overview }: { overview: OrgOverview }) {
  const qc = useQueryClient()
  const all = useMemo(
    () =>
      overview.accounts
        .flatMap((a) => a.fixes)
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.accountLabel.localeCompare(b.accountLabel)),
    [overview]
  )
  const users = useMemo(() => {
    const m = new Map<string, OrgOverview["accounts"][number]["users"][number]>()
    for (const a of overview.accounts) for (const u of a.users) m.set(`${a.accountId}|${u.name}`, u)
    return m
  }, [overview])

  const [account, setAccount] = useState("")
  const [severity, setSeverity] = useState("")
  const [issue, setIssue] = useState("")
  const [q, setQ] = useState("")
  const [hideApplied, setHideApplied] = useState(true)
  const [limit, setLimit] = useState(PAGE)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Fix | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)

  const filtered = all.filter(
    (f) =>
      (!account || f.accountId === account) &&
      (!severity || f.severity === severity) &&
      (!issue || f.issue === issue) &&
      (!hideApplied || !f.appliedAt) &&
      (!q || `${f.userName ?? ""} ${f.title} ${f.accountLabel}`.toLowerCase().includes(q.toLowerCase()))
  )
  const visible = filtered.slice(0, limit)
  const selectedFixes = all.filter((f) => selected.has(f.key))
  const issuesPresent = [...new Set(all.map((f) => f.issue))]
  const counts = all.reduce<Record<string, number>>((acc, f) => ((acc[f.severity] = (acc[f.severity] ?? 0) + 1), acc), {})

  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const selectableVisible = visible.filter(bulkReady)
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((f) => selected.has(f.key))

  const onExecuted = () => qc.invalidateQueries({ queryKey: ["overview"] })

  return (
    <Card>
      <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" /> Recommended fixes
          </CardTitle>
          <CardDescription>
            {formatNumber(all.length)} recommendations ·{" "}
            {(["critical", "high", "medium", "low", "info"] as Severity[])
              .filter((s) => counts[s])
              .map((s) => `${counts[s]} ${s}`)
              .join(" · ")}
            . SQL is generated on the server from the latest snapshot; nothing runs without your confirmation.
          </CardDescription>
        </div>
        <Button disabled={selectedFixes.length === 0} onClick={() => setBulkOpen(true)}>
          <Play className="h-4 w-4" /> Run selected ({selectedFixes.length})
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative min-w-0 lg:col-span-2">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search user or fix…" value={q} onChange={(e) => (setQ(e.target.value), setLimit(PAGE))} />
          </div>
          <Select aria-label="Account" value={account} onChange={(e) => (setAccount(e.target.value), setLimit(PAGE))}>
            <option value="">All accounts</option>
            {overview.accounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.label}
              </option>
            ))}
          </Select>
          <Select aria-label="Severity" value={severity} onChange={(e) => (setSeverity(e.target.value), setLimit(PAGE))}>
            <option value="">All severities</option>
            {(["critical", "high", "medium", "low", "info"] as Severity[]).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select aria-label="Issue" value={issue} onChange={(e) => (setIssue(e.target.value), setLimit(PAGE))}>
            <option value="">All issue types</option>
            {issuesPresent.map((i) => (
              <option key={i} value={i}>
                {ISSUE_LABELS[i]}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={hideApplied} onChange={(e) => setHideApplied(e.target.checked)} /> Hide fixes applied in the last 3
          hours (ACCOUNT_USAGE refresh pending)
        </label>

        {filtered.length === 0 ? (
          <EmptyState
            title={all.length === 0 ? "Nothing to fix" : "No fixes match these filters"}
            description={all.length === 0 ? "Every in-scope user meets strong authentication requirements." : undefined}
          />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="Select all visible bulk-runnable fixes"
                      checked={allVisibleSelected}
                      disabled={selectableVisible.length === 0}
                      onChange={() =>
                        setSelected((s) => {
                          const n = new Set(s)
                          selectableVisible.forEach((f) => (allVisibleSelected ? n.delete(f.key) : n.add(f.key)))
                          return n
                        })
                      }
                    />
                  </TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Recommendation</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((f) => {
                  const u = f.userName ? users.get(`${f.accountId}|${f.userName}`) : null
                  return (
                    <TableRow key={f.key}>
                      <TableCell>
                        <Checkbox
                          aria-label={`Select ${f.title}`}
                          checked={selected.has(f.key)}
                          disabled={!bulkReady(f)}
                          title={bulkReady(f) ? undefined : "Needs input or review — open it to run"}
                          onChange={() => toggle(f.key)}
                        />
                      </TableCell>
                      <TableCell>{severityBadge(f.severity)}</TableCell>
                      <TableCell className="max-w-40 truncate text-sm">{f.accountLabel}</TableCell>
                      <TableCell className="max-w-56">
                        <p className="truncate font-mono text-xs">{f.userName ?? "(account)"}</p>
                        {u && (
                          <p className="truncate text-xs text-muted-foreground">
                            {u.rawType ?? "PERSON"}
                            {u.adminRoles.length ? ` · ${u.adminRoles.join(", ")}` : ""}
                            {u.passwordOnlyClients.length ? ` · ${u.passwordOnlyClients.join(", ")}` : ""}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="max-w-md">
                        <p className="truncate text-sm">{f.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{ISSUE_LABELS[f.issue]}</p>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {f.appliedAt && <Badge variant="success">applied {formatRelative(f.appliedAt)}</Badge>}
                          <Button size="sm" variant={f.executable ? "outline" : "ghost"} onClick={() => setOpen(f)}>
                            {f.executable ? "Review & run" : "View guidance"}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
        {filtered.length > limit && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => setLimit((l) => l + PAGE)}>
              Show more ({formatNumber(filtered.length - limit)} remaining)
            </Button>
          </div>
        )}
      </CardContent>

      {open && (
        <FixSheet
          fix={open}
          user={open.userName ? users.get(`${open.accountId}|${open.userName}`) ?? null : null}
          onClose={() => setOpen(null)}
          onExecuted={onExecuted}
        />
      )}
      {bulkOpen && (
        <BulkRunDialog
          fixes={selectedFixes}
          onClose={(ran) => {
            setBulkOpen(false)
            if (ran) {
              setSelected(new Set())
              onExecuted()
            }
          }}
        />
      )}
    </Card>
  )
}

function BulkRunDialog({ fixes, onClose }: { fixes: Fix[]; onClose: (ran: boolean) => void }) {
  const [confirmText, setConfirmText] = useState("")
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({})
  const done = Object.keys(results).length
  const accounts = [...new Set(fixes.map((f) => f.accountLabel))]

  const run = async () => {
    setRunning(true)
    for (const f of fixes) {
      const params = Object.fromEntries(f.params.map((p) => [p.key, p.defaultValue ?? ""]))
      try {
        const r = await postExecute(f, params, false)
        setResults((s) => ({
          ...s,
          [f.key]: { ok: r.ok, message: r.ok ? `${r.statements.length} statement(s) succeeded` : r.statements.find((x) => !x.ok)?.error ?? "Failed" },
        }))
      } catch (e) {
        setResults((s) => ({ ...s, [f.key]: { ok: false, message: e instanceof Error ? e.message : String(e) } }))
      }
    }
    setRunning(false)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !running && onClose(done > 0)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run {fixes.length} fixes</DialogTitle>
          <DialogDescription>
            Across {accounts.length} account{accounts.length === 1 ? "" : "s"}: {accounts.join(", ")}. Fixes run one at a time; each
            stops at its first failed statement. Every execution is written to the audit log.
          </DialogDescription>
        </DialogHeader>
        <Alert variant="destructive">
          <AlertTitle>These change live users</AlertTitle>
          <AlertDescription>
            Disabling users, removing passwords, and converting to SERVICE can break integrations still using a password. Review
            each fix&apos;s impact first if you are unsure.
          </AlertDescription>
        </Alert>
        <ul className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2 text-sm">
          {fixes.map((f) => {
            const r = results[f.key]
            return (
              <li key={f.key} className="flex min-w-0 items-start gap-2">
                <span className="flex w-20 shrink-0 justify-start pt-0.5">
                  {r ? (
                    r.ok ? (
                      <CheckCircle2 className="h-4 w-4 text-success" />
                    ) : (
                      <XCircle className="h-4 w-4 text-destructive" />
                    )
                  ) : running ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    severityBadge(f.severity)
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate">
                    <span className="font-mono text-xs">{f.userName ?? "(account)"}</span> · {f.title}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {f.accountLabel}
                    {r ? ` — ${r.message}` : ""}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
        {done < fixes.length && (
          <div className="space-y-1.5">
            <label htmlFor="bulk-confirm" className="text-sm">
              Type <span className="font-mono font-semibold">EXECUTE</span> to confirm
            </label>
            <Input id="bulk-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} disabled={running} autoComplete="off" />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={running} onClick={() => onClose(done > 0)}>
            {done ? "Close" : "Cancel"}
          </Button>
          {done < fixes.length && (
            <Button variant="destructive" disabled={confirmText !== "EXECUTE" || running} onClick={run}>
              {running && <Loader2 className="h-4 w-4 animate-spin" />} Run {fixes.length} fixes
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
