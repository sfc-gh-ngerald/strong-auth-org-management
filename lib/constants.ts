/** App title — displayed in the nav header and browser tab */
export const APP_TITLE = "Strong Auth Control Center"

/** Path to the logo in /public (used in the header and as favicon) */
export const LOGO_SRC = "/icon.svg"

/** Top-level pages: shown in the header nav and under "Go to" in the ⌘K palette. */
export const NAV_ITEMS: { label: string; href: string }[] = [
  { label: "Overview & fixes", href: "/" },
  { label: "Managed accounts", href: "/accounts" },
  { label: "Audit log", href: "/audit" },
]

/** Enforcement timeline from https://docs.snowflake.com/en/user-guide/security-mfa-rollout */
export const ENFORCEMENT_PHASES = [
  {
    phase: "Phase 1",
    window: "Sep 2025 – Jan 2026",
    title: "Mandatory MFA for Snowsight",
    detail: "Human password users must use MFA in Snowsight. BI tools and drivers unaffected.",
  },
  {
    phase: "Phase 2",
    window: "May 2026 – Jul 2026",
    title: "Strong auth for new users",
    detail: "New human users need MFA on every client. LEGACY_SERVICE can no longer be created or assigned.",
  },
  {
    phase: "Phase 3",
    window: "Aug 2026 – Oct 2026",
    title: "Strong auth for all users",
    detail: "All human password users need MFA. LEGACY_SERVICE is migrated to SERVICE; service passwords stop working.",
  },
]
