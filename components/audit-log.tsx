"use client"

import { useQuery } from "@tanstack/react-query"
import { CheckCircle2, XCircle } from "lucide-react"
import type { AuditEntry } from "@/lib/types"
import { ISSUE_LABELS } from "@/lib/classify"
import { formatDateTime } from "@/lib/format"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export function AuditLog() {
  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: async () => {
      const res = await fetch("/api/audit")
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
      return body as AuditEntry[]
    },
  })
  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        eyebrow="History"
        title="Audit log"
        description="Every fix executed from this app, with the exact statements and results. Stored locally in config/audit-log.jsonl."
      />
      <Card>
        <CardContent className="p-0">
          {audit.isPending ? (
            <div className="space-y-2 p-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : audit.error ? (
            <div className="p-6">
              <EmptyState variant="error" title="Could not read the audit log" description={audit.error.message} />
            </div>
          ) : audit.data.length === 0 ? (
            <div className="p-6">
              <EmptyState title="No executions yet" description="Fixes you run from the overview appear here." />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Fix</TableHead>
                  <TableHead>Statements</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.data.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      <span className="flex items-center gap-1.5">
                        {e.ok ? <CheckCircle2 className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-destructive" />}
                        {formatDateTime(e.at)}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{e.accountLabel}</TableCell>
                    <TableCell className="font-mono text-xs">{e.userName ?? "(account)"}</TableCell>
                    <TableCell className="text-sm">{ISSUE_LABELS[e.issue] ?? e.issue}</TableCell>
                    <TableCell className="max-w-xl">
                      <ul className="space-y-1">
                        {e.statements.map((s, i) => (
                          <li key={i} className="font-mono text-xs break-all">
                            <span className={s.ok ? undefined : "text-destructive"}>{s.sql}</span>
                            {s.error && <span className="block break-words text-destructive">{s.error}</span>}
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
