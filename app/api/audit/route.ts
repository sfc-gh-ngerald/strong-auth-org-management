import { readAudit } from "@/lib/server/collect"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json(await readAudit())
  } catch (e) {
    console.error(new Date().toISOString(), "[audit] read failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to read audit log" }, { status: 500 })
  }
}
