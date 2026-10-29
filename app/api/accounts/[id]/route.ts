import { deleteAccount, updateAccount, ValidationError } from "@/lib/server/accounts"
import { dropConnection, toView } from "@/lib/server/connections"
import { forgetSnapshot } from "@/lib/server/collect"

export const dynamic = "force-dynamic"

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const account = await updateAccount(id, await req.json())
    dropConnection(id)
    forgetSnapshot(id)
    return Response.json(toView(account))
  } catch (e) {
    const status = e instanceof ValidationError ? 400 : 500
    if (status === 500) console.error(new Date().toISOString(), "[accounts] update failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to update account" }, { status })
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    await deleteAccount(id)
    dropConnection(id)
    forgetSnapshot(id)
    return Response.json({ ok: true })
  } catch (e) {
    console.error(new Date().toISOString(), "[accounts] delete failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to delete account" }, { status: 500 })
  }
}
