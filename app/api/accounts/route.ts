import { createAccount, listAccounts, ValidationError } from "@/lib/server/accounts"
import { toView } from "@/lib/server/connections"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json((await listAccounts()).map(toView))
  } catch (e) {
    console.error(new Date().toISOString(), "[accounts] list failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to list accounts" }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const account = await createAccount(await req.json())
    return Response.json(toView(account), { status: 201 })
  } catch (e) {
    const status = e instanceof ValidationError || e instanceof SyntaxError ? 400 : 500
    if (status === 500) console.error(new Date().toISOString(), "[accounts] create failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to create account" }, { status })
  }
}
