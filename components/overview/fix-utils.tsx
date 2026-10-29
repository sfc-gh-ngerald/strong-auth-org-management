import type { AuditEntry, Fix, Severity } from "@/lib/types"
import { Badge } from "@/components/ui/badge"

export function severityBadge(s: Severity) {
  const variant = s === "critical" ? "destructive" : s === "high" ? "warning" : s === "medium" ? "secondary" : "outline"
  return <Badge variant={variant}>{s}</Badge>
}

/** Dry run returns the exact server-generated SQL; a real run requires confirm and is audited. */
export async function postExecute(fix: Fix, params: Record<string, string>, dryRun: boolean): Promise<AuditEntry> {
  const res = await fetch("/api/fixes/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: fix.accountId, fixKey: fix.key, params, dryRun, confirm: !dryRun }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body as AuditEntry
}
