# Agent notes

Local-only Next.js app (binds to 127.0.0.1). Not deployed to Snowflake.

- Readiness rules, fix catalog, and SQL builders: `lib/classify.ts` (pure, unit-tested). All executable SQL is built here from validated params; never accept SQL from the client.
- Per-account connections (OAuth / SSO / PAT / key pair), in-memory sessions: `lib/server/connections.ts`.
- Collection, snapshot cache, execution, audit log: `lib/server/collect.ts`.
- `proxy.ts` enforces loopback Host and same-origin JSON writes; keep it.
- Run `npm test` and `npx tsc --noEmit` after changes.
