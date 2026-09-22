# Canva Connector

## What is real

A working OAuth 2.0 + PKCE (S256) authorization-code connector, the same shape as X/LinkedIn:

- `src/runtime/canva-oauth.js` — authorize URL, state (CSRF + PKCE verifier, one-time,
  10-minute expiry, user-bound), token exchange, refresh, encrypted credential storage
  (reuses the existing `integration_credentials` vault — same discipline as every other
  provider in this codebase).
- `src/connectors/canva/manifest.js` + `adapter.js` — a real `healthCheck` that calls
  `GET /v1/users/me` to confirm the connected identity. Registered in
  `src/connectors/registry.js` and `src/integrations/definitions.js` (`isAvailable:1`,
  `authType:'OAUTH2'`, `connectionMode:'SINGLE'`).
- HTTP routes in `src/application.js` (owner-only, same authorization bar as every other
  OAuth provider):
  - `GET /api/integrations/canva/oauth/start`
  - `GET /api/integrations/canva/oauth/callback`
  - `GET /api/integrations/canva/oauth/status`
  - `POST /api/integrations/canva/disconnect`
- A real "Add connection" button in the Control Center's Integrations tab
  (`public/pages/control-center.js`, `DEDICATED_OAUTH_SLUGS`), which redirects to the start
  route above.

```dotenv
CANVA_CLIENT_ID=
CANVA_CLIENT_SECRET=
CANVA_REDIRECT_URI=
```

Get these from your own Canva Developer Portal app (developers.canva.com). Requested scope:
`profile:read` only — the minimum this connector's real health check needs.

## What is NOT real

**No live call has ever been made against these endpoints from this codebase.** No Canva
Developer Portal app exists to test against, and there is no internet access in this
environment to verify Canva's current published API contract. The authorize/token URLs and
the `GET /v1/users/me` response shape (`team_user.user_id`/`team_user.team_id`) are taken from
public documentation as recalled, not confirmed against a real request/response — **verify
this against your own Canva app before relying on it in production**, the same discipline
`docs/SALLA_INTEGRATION_SETUP.md` already asks for Salla's webhook conventions.

**The connector manifest declares zero content actions.** The `canva_generateAsset` agent
tool (`src/runtime/tools.js`) still always returns `{status:'INTEGRATION_REQUIRED'}` —
`ToolDefinition.isAvailable:false` — regardless of whether a Canva account is connected. This
is deliberate, not an oversight: Canva's public Connect API has no confirmed endpoint for
"generate a visual asset from a free-text brief." The closest real capability, the **Autofill
API** (`POST /v1/autofills`), fills named fields of a Canva Brand Template the merchant must
already own and design in Canva itself — a fundamentally different, narrower shape than a
free-text `brief` input promises. Wiring `canva_generateAsset` to a guessed call risked either
silently failing or silently doing the wrong thing for a real merchant; neither is acceptable,
so it stays honestly blocked.

## To finish this connector for real design generation

1. Get a real Canva Developer Portal app and confirm the OAuth flow above actually works
   end-to-end against it (authorize → callback → `GET /v1/users/me`).
2. Decide the real product shape: either (a) have merchants create Brand Templates in Canva
   and use the Autofill API with their real field names, or (b) find/confirm a different real
   Canva capability that matches "generate from a brief" more literally.
3. Add the chosen action to `src/connectors/canva/manifest.js` (with the real, verified
   `requiredCapability`) and its real HTTP call to `src/connectors/canva/adapter.js`'s
   `executeAction`, following the same pattern as `src/connectors/zid/adapter.js`.
4. Wire `canva_generateAsset`'s handler in `src/runtime/tools.js` to call it through
   `executeConnectorAction`, matching `salla_syncOrders`'s handler as a template.
5. Only then flip `isAvailable:false` → remove it (or `true`) for `canva_generateAsset`.
