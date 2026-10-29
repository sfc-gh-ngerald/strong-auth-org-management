import { getAccount } from "@/lib/server/accounts"
import { signIn, toView } from "@/lib/server/connections"
import { forgetSnapshot } from "@/lib/server/collect"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/** Opens the account's browser login (Snowflake OAuth or SSO) and waits for it to complete. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const account = await getAccount(id)
  if (!account) return Response.json({ error: "Account not found." }, { status: 404 })
  try {
    const session = await signIn(account)
    forgetSnapshot(id)
    return Response.json({ ok: true, session, account: toView(account) })
  } catch (e) {
    console.error(new Date().toISOString(), `[accounts] sign-in failed for ${account.label}`, e instanceof Error ? e.message : e)
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Sign-in failed" }, { status: 200 })
  }
}
