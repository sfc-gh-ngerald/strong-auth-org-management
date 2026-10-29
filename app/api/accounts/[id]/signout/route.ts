import { signOut } from "@/lib/server/connections"
import { forgetSnapshot } from "@/lib/server/collect"

export const dynamic = "force-dynamic"

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  signOut(id)
  forgetSnapshot(id)
  return Response.json({ ok: true })
}
