import { NextResponse, type NextRequest } from "next/server"

/**
 * This app holds live admin sessions for every signed-in account, so it must only be reachable
 * from this machine's own browser:
 *  - Host must be a loopback name (blocks LAN access and DNS-rebinding attacks).
 *  - State-changing API calls must come from this origin with a JSON body (blocks cross-site
 *    form posts and fetches from other web pages; no CORS headers are ever sent).
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function hostname(hostHeader: string | null): string {
  if (!hostHeader) return ""
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1)
  return hostHeader.split(":")[0].toLowerCase()
}

export function proxy(req: NextRequest) {
  const host = req.headers.get("host")
  if (!LOOPBACK.has(hostname(host))) {
    return new NextResponse("Strong Auth Control Center only accepts requests to localhost.", { status: 403 })
  }

  if (req.nextUrl.pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.get("origin")
    if (origin) {
      let originHost = ""
      try {
        originHost = new URL(origin).host
      } catch {}
      if (originHost !== host) return NextResponse.json({ error: "Cross-origin request blocked." }, { status: 403 })
    }
    if (req.headers.get("sec-fetch-site") === "cross-site")
      return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 })
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
      return NextResponse.json({ error: "Expected application/json." }, { status: 415 })
  }
  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon.svg).*)"],
}
