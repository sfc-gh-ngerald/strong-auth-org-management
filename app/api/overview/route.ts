import { getOverview } from "@/lib/server/collect"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams
    const source = params.get("source") === "account_usage" ? "account_usage" : "live"
    return Response.json(await getOverview(params.get("refresh"), source))
  } catch (e) {
    console.error(new Date().toISOString(), "[overview] failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to build overview" }, { status: 500 })
  }
}
