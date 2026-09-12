// Universal Integration Platform (Phase 6A) — shared enums for the Connector SDK. Plain
// frozen objects, not TypeScript enums (this codebase has none) — every value here is a
// literal string so it round-trips through JSON/SQLite exactly, matching the existing
// `agent_runs.status`/`integration_connections.status` CHECK-constraint idiom.

export const CONNECTOR_CATEGORY=Object.freeze({
 COMMERCE:'COMMERCE',MESSAGING:'MESSAGING',SOCIAL:'SOCIAL',PRODUCTIVITY:'PRODUCTIVITY',
 ACCOUNTING:'ACCOUNTING',CRM:'CRM',AI:'AI',ANALYTICS:'ANALYTICS',STORAGE:'STORAGE',CUSTOM:'CUSTOM'
});

// Part 5 — the honest lifecycle of a connector DEFINITION (never a fake CONNECTED-like state).
export const CONNECTOR_AVAILABILITY=Object.freeze({
 AVAILABLE:'AVAILABLE',BETA:'BETA',PARTIAL:'PARTIAL',
 DEFINITION_ONLY:'DEFINITION_ONLY',NOT_IMPLEMENTED:'NOT_IMPLEMENTED',DISABLED:'DISABLED'
});

// Part 8 — matches the exact real, already-live values in src/integrations/definitions.js's
// CONNECTION_MODE map (Salla/Anthropic/OpenAI=MULTI, the rest=SINGLE, Canva=UNAVAILABLE) — this
// enum does not invent a new vocabulary, it names the one that already exists.
export const CONNECTION_MODE=Object.freeze({MULTI:'MULTI',SINGLE:'SINGLE',PARTIAL:'PARTIAL',UNAVAILABLE:'UNAVAILABLE'});

export const AUTH_TYPE=Object.freeze({NONE:'NONE',API_KEY:'API_KEY',BEARER_TOKEN:'BEARER_TOKEN',BASIC:'BASIC',OAUTH2:'OAUTH2',CUSTOM:'CUSTOM'});

// Part 12 — reuses the exact vocabulary already enforced by src/runtime/permissions.js's
// existing action-type policy (READ/INTERNAL_WRITE/EXTERNAL_WRITE/EXTERNAL_SEND/
// EXTERNAL_PUBLISH/DESTRUCTIVE) plus SECURITY for the framework's own admin-level actions —
// never a second, parallel safety vocabulary.
export const ACTION_TYPE=Object.freeze({
 READ:'READ',INTERNAL_WRITE:'INTERNAL_WRITE',EXTERNAL_WRITE:'EXTERNAL_WRITE',
 EXTERNAL_SEND:'EXTERNAL_SEND',EXTERNAL_PUBLISH:'EXTERNAL_PUBLISH',DESTRUCTIVE:'DESTRUCTIVE',SECURITY:'SECURITY'
});

export const RISK_LEVEL=Object.freeze({LOW:'LOW',MEDIUM:'MEDIUM',HIGH:'HIGH',CRITICAL:'CRITICAL'});

// Part 106 — an action never silently assumes retry safety.
export const IDEMPOTENCY_POLICY=Object.freeze({NONE:'NONE',SAFE_RETRY:'SAFE_RETRY',IDEMPOTENCY_KEY:'IDEMPOTENCY_KEY'});

// Part 45 — webhook auth declarations (Phase 6C uses these; declared here so one enum module
// covers the whole SDK).
export const WEBHOOK_AUTH_TYPE=Object.freeze({NONE:'NONE',SHARED_SECRET:'SHARED_SECRET',HMAC:'HMAC',HEADER_TOKEN:'HEADER_TOKEN',CUSTOM:'CUSTOM'});

// Part 107 — the ONE safe, normalized error-code vocabulary every adapter must translate its
// own provider's real errors into before they ever reach a route response or the frontend.
export const CONNECTOR_ERROR_CODE=Object.freeze({
 AUTH_FAILED:'AUTH_FAILED',TOKEN_EXPIRED:'TOKEN_EXPIRED',RATE_LIMITED:'RATE_LIMITED',
 CONNECTION_UNHEALTHY:'CONNECTION_UNHEALTHY',CAPABILITY_MISSING:'CAPABILITY_MISSING',
 REMOTE_NOT_FOUND:'REMOTE_NOT_FOUND',REMOTE_VALIDATION_ERROR:'REMOTE_VALIDATION_ERROR',
 REMOTE_SERVER_ERROR:'REMOTE_SERVER_ERROR',TIMEOUT:'TIMEOUT',NETWORK_ERROR:'NETWORK_ERROR'
});
