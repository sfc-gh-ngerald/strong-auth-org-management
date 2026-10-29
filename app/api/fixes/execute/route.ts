import { executeFix, ExecutionError } from "@/lib/server/collect"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { accountId, fixKey, params, dryRun, confirm } = body ?? {}
    if (typeof accountId !== "string" || typeof fixKey !== "string")
      return Response.json({ error: "accountId and fixKey are required." }, { status: 400 })
    const safeParams: Record<string, string> = {}
    for (const [k, v] of Object.entries(params ?? {})) if (typeof v === "string") safeParams[k] = v
    const isDryRun = dryRun !== false
    if (!isDryRun && confirm !== true)
      return Response.json({ error: "Execution requires confirm: true." }, { status: 400 })
    return Response.json(await executeFix({ accountId, fixKey, params: safeParams, dryRun: isDryRun }))
  } catch (e) {
    const status = e instanceof ExecutionError ? e.status : 500
    if (status === 500) console.error(new Date().toISOString(), "[fixes] execute failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Execution failed" }, { status })
  }
}
