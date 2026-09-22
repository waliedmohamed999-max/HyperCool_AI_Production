# AI Image Generation (`generate_visual_asset`)

## What is real

The agent tool `generate_visual_asset` (`src/runtime/tools.js`) is provider-neutral: it
resolves to whichever of the tenant's connected providers grants the `design.generate`
capability (the same generic-capability pattern `get_invoices`/`get_orders`/`get_customers`
already use — see `docs/CAPABILITY_REGISTRY.md`). Today the only real provider for it is
**OpenAI**.

- `src/connectors/openai/manifest.js` declares `design.generate` and a `generate_image`
  action, `POST /v1/images/generations`.
- `src/connectors/openai/adapter.js`'s `generateImage()` sends `{model, prompt, size, n:1}`
  with the tenant's own stored OpenAI API key (`Authorization: Bearer ...`) and returns one
  image as a `data:image/png;base64,...` URI (or a temporary provider URL, if the response
  has no `b64_json`).
- Reuses the **same OpenAI connection** a tenant may already have for the agent runtime
  itself (Control Center → Integrations → OpenAI → "Add connection") — connecting OpenAI once
  covers both AI chat/tool-use and image generation, no separate setup.
- The action is `EXTERNAL_SEND`/`MEDIUM` risk, so it **requires approval before running** —
  whether triggered by an agent or by an operator manually running it from the Control
  Center's "Run Action" button (`src/connectors/core/runtime.js`'s own
  `requiresApprovalDefault` gate). Nothing is ever generated (and no OpenAI spend incurred)
  without a human approving it first.

```dotenv
OPENAI_IMAGE_MODEL=gpt-image-1   # optional; this is the default if unset
```

## What is NOT real

**This exact call has never been made from this codebase against a live OpenAI account.**
There is no internet access in this environment and no account to test against. The request
shape (`model`/`prompt`/`size`/`n`) and response shape (`data[0].b64_json` or `data[0].url`)
are this model's best recollection of OpenAI's own published Images API docs, not a confirmed
live request/response — **verify this against your own OpenAI account before relying on it in
production**, the same discipline `docs/SALLA_INTEGRATION_SETUP.md` already asks for Salla's
webhook conventions and `docs/CANVA_CONNECTOR.md` asks for Canva's OAuth flow.

**No persistent asset storage exists.** A generated image is returned directly in the tool's
result (a data URI or provider URL) — it is never saved into any content/media library table.
If an agent needs to attach it to a piece of marketing content, that still has to be done by
hand today; building a real asset-storage pipeline is a separate, larger feature.

**Canva is not used by this tool at all**, despite Canva having its own real OAuth2 connector
(`docs/CANVA_CONNECTOR.md`) — see that doc for why, and for what it would take to make Canva
itself eligible for `generate_visual_asset` too.
