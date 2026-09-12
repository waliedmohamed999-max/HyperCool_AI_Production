# Tenant Custom Connectors — Status (Phase 6F)

**Not built.** Only the feature flag exists, and it currently gates nothing. This document
records the deferred design honestly, matching `scripts/production-check.mjs`'s own warning
when the flag is set to `true`.

## What exists today

`ENABLE_TENANT_CUSTOM_CONNECTORS` — an environment variable, default `false`/unset, validated
(presence and honest "gates nothing yet" warning) by `npm run production:check`. **No code path
anywhere in the application checks this flag**, because no tenant-facing custom-connector
creation endpoint exists. Today, only a Platform Admin can create a connector definition (the
Integration Builder, `#platform`) — a tenant owner has no path to create one, flag or no flag.

## The deferred design (for a future phase)

If/when this is built, the real governance workflow the original spec asked for:

1. **Tenant Draft** — a tenant owner (only if the flag is `true`) creates a `GENERIC_REST`
   connector definition scoped to their own tenant — never visible to other tenants, never
   auto-published.
2. **Security Validation** — the SAME real checks a Platform-Admin-created definition already
   gets (SSRF-validated base URL, known-capability-only, capability-declared-before-action) plus
   tenant-specific restrictions (see below).
3. **Platform Review** — every tenant-submitted draft appears in a Platform Admin "Pending
   Custom Connectors" queue; the admin can Approve, Reject, or Request Changes, each decision
   audited.
4. **Approved → Tenant Usage** — only after approval can the submitting tenant actually connect
   to and use it; it never becomes visible in the global marketplace for other tenants.

Tenant-specific restrictions this workflow would need to enforce (none of this exists in code
yet):

- **Per-tenant limits**: a configurable `MAX_CUSTOM_CONNECTORS_PER_TENANT`, conservative default.
- **URL policy**: HTTPS only, public IP only (the existing SSRF module already blocks private/
  reserved/metadata ranges — a tenant connector would need the SAME check, with no relaxation),
  no arbitrary redirect host, no internal domains.
- **Capability policy**: a tenant-submitted connector can never declare a security/admin/
  platform-level capability — only a safe subset of the canonical registry (which safe subset is
  itself an open design question this phase did not resolve).
- **Event policy**: a tenant custom webhook trigger can never target a privileged Event Bus type
  outside an explicit allowlist.
- **Write policy**: any write action requires Approval Engine gating (never auto-approved) and
  is blocked outright at agent autonomy L0.

## Why deferred

This is, in effect, a second authorization/workflow subsystem layered on top of the existing
Platform-Admin-only Builder — a real, substantial feature in its own right (review queue,
notification, audit trail, tenant-facing draft UI, and the additional SSRF/capability/event/
write policy layer above). Given everything else in this phase's scope, building this safely
would have meant either rushing it (real risk — this is the one area where an unvetted tenant
gets to define outbound network behavior) or dropping other, more foundational work. The
foundational architecture (Connector SDK, Builder backend, SSRF layer, capability registry) is
already real and reusable the moment a future phase takes this on.
