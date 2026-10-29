import { getAccount } from "@/lib/server/accounts"
import { testConnection } from "@/lib/server/connections"

export const dynamic = "force-dynamic"

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const account = await getAccount(id)
  if (!account) return Response.json({ error: "Account not found." }, { status: 404 })
  try {
    return Response.json({ ok: true, ...(await testConnection(account)) })
  } catch (e) {
    console.error(new Date().toISOString(), `[accounts] test failed for ${account.label}`, e)
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Connection failed" }, { status: 200 })
  }
}
