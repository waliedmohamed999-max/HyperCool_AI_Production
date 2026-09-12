# Connector SDK Reference (Phase 6A)

> **Phase 6B update**: `src/connectors/generic-rest/manifest.js`'s `validateRestManifest()`
> extends `validateManifest()` below with REST-specific fields (`rest.baseUrl`, per-action
> `rest.httpMethod`/`rest.pathTemplate`/mappings) — see `docs/GENERIC_REST_CONNECTOR.md`. No
> change was made to `validateManifest`/`validateAdapter` themselves.

> **Phase 6C update**: `src/connectors/generic-webhook/manifest.js`'s `validateWebhookManifest()`
> extends whichever base validation already applies (`validateManifest` or `validateRestManifest`)
> with webhook-specific trigger fields (`authentication`, `normalizedEventType`, `eventIdPolicy`,
> discriminator fields) — see `docs/GENERIC_WEBHOOK_FRAMEWORK.md`. Same "re-attach by index"
> extension technique as 6B; still no change to `core/manifest.js` itself.



## Manifest schema (`src/connectors/core/manifest.js`)

Required fields: `id, slug, nameAr, nameEn, category, version, availability, connectionMode,
auth`. `slug` must be lowercase alphanumeric/dash/underscore. `category` ∈
`CONNECTOR_CATEGORY`, `availability` ∈ `CONNECTOR_AVAILABILITY` (`AVAILABLE, BETA, PARTIAL,
DEFINITION_ONLY, NOT_IMPLEMENTED, DISABLED` — Part 5, never a fake connected state),
`connectionMode` ∈ `CONNECTION_MODE` (`MULTI, SINGLE, PARTIAL, UNAVAILABLE` — matches the exact
real values already live in `src/integrations/definitions.js`).

`auth.type` ∈ `AUTH_TYPE`. An `OAUTH2` auth block MUST declare a real `https://` `authorizeUrl`
and `tokenUrl` — `validateManifest` throws otherwise (Part 7's "never trust a database-defined
arbitrary OAuth URL without policy" starts at the schema level).

`capabilities: string[]` — every raw string is canonicalized (`capability-registry.js`) and
de-duplicated. Every `actions[].requiredCapability` must appear in this list, or validation
fails loudly (a real config error, never a silent gap discovered at runtime).

`actions[]`: `id, slug, method, requiredCapability, riskLevel, actionType` are required.
`riskLevel` ∈ `RISK_LEVEL`, `actionType` ∈ `ACTION_TYPE`. **A write-shaped actionType
(`EXTERNAL_WRITE`/`EXTERNAL_SEND`/`EXTERNAL_PUBLISH`/`DESTRUCTIVE`) can never declare
`riskLevel: LOW`** (Part 94) — this is enforced at validation time, not left to a reviewer to
notice later. `requiresApprovalDefault` defaults to `true` for every write-shaped action and
`false` for `READ` (Part 95), unless the manifest explicitly overrides it.

`triggers[]`: `id, slug, eventType` required (Phase 6C consumes these; declaring them now is
free documentation of a real existing webhook, see the Salla manifest's `triggers:[]` — none
declared this phase since Salla's real webhook is order-events, not yet normalized into a
Trigger's `eventIdPath`/`mappingDefinition` shape).

`webhooks`/`health`/`identity`/`metadataSchema` are free-form, optional, descriptive objects —
validated structurally by later phases as their consumers (Phase 6C's Webhook Framework, the
Builder's health-check runner) are built.

## Adapter contract (`src/connectors/core/adapter.js`)

An adapter is a plain object of functions — no class, no `extends`, matching this codebase's
existing style. `healthCheck` is always required. `executeAction` is required the moment the
manifest declares any `actions`. Every OTHER key on the object must be one of
`getIdentity, executeAction, refreshCredential, revoke, processWebhook` — an adapter cannot
silently expose an extra method nothing in the framework will ever call (`validateAdapter`
throws on an unrecognized key, catching a typo or a leftover debug method before it ships).

**An adapter never receives a decrypted credential except inside its own `healthCheck`/
`executeAction` call** (Part 16) — `ConnectorRuntime.execute()` is the only caller that ever
resolves one from the Vault, and it is passed as a plain `{payload}` object scoped to that one
call, never stored, logged, or handed to anything else.

## Writing a new adapter that wraps existing code (the pattern used for Salla/Anthropic/OpenAI)

```js
// src/connectors/<slug>/adapter.js
import {existingTestFunction, existingRealAction} from '../../<existing-file>.js';
export const myAdapter = {
  async healthCheck({env, fetcher, credential}) {
    const result = await existingTestFunction({env, fetcher, /* map credential in */});
    return result.result === 'OK' ? {status:'OK'} : {status: result.result, errorCode: /* map */};
  },
  async executeAction({action, env, fetcher, credential}) {
    if (action.slug !== 'the_one_action') return {status:'ERROR', errorCode:'CAPABILITY_MISSING'};
    const output = await existingRealAction({env, fetcher, /* map credential in */});
    return {status:'OK', output};
  }
};
```

The adapter's job is entirely translation: map the generic `{env, fetcher, credential}` shape
into whatever the EXISTING function's real parameters are, and map its real return value into
the generic `{status, output|errorCode}` shape. It never reimplements the network call itself.
