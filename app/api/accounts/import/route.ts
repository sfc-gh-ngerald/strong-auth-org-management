import { importAccounts, ValidationError } from "@/lib/server/accounts"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const rows = Array.isArray(body) ? body : Array.isArray(body?.accounts) ? body.accounts : null
    if (!rows) return Response.json({ error: "Expected a JSON array of accounts or { accounts: [...] }." }, { status: 400 })
    return Response.json(await importAccounts(rows))
  } catch (e) {
    const status = e instanceof ValidationError || e instanceof SyntaxError ? 400 : 500
    if (status === 500) console.error(new Date().toISOString(), "[accounts] import failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Import failed" }, { status })
  }
}
