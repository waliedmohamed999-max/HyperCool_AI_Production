# Full SaaS Entry Flow (Multi-Tenant Phase 4C-6)

The end-to-end journey this phase completes, real and verified by a real-browser Playwright
run (not committed as a permanent script — see `docs/CONTROL_CENTER_UI.md`'s existing note on
why some journeys are exercised via a temporary script rather than the long-running
`scripts/ui-qa.mjs`):

```
Create Account (docs/SELF_SERVICE_SIGNUP.md)
  → Verify Email (docs/EMAIL_VERIFICATION.md, unchanged)
    → Create Company (docs/WORKSPACE_CREATION.md)
      → Become Owner + Set Active Workspace (same atomic transaction + session update)
        → Guided Onboarding (docs/WORKSPACE_ONBOARDING.md, unchanged — no second wizard)
          → Connect AI / Configure Agents / System Check (all pre-existing, reused as-is)
            → Workspace Ready
```

No manual code, database, or console step anywhere in this chain.

## Real bugs this phase's own end-to-end testing found and fixed

Consistent with every prior phase in this project: the backend test suite alone did not catch
several of these — only driving the actual browser through the actual flow did.

1. **The legacy zero-membership auto-attach was a real security hole against self-service
   signup.** `resolveTenantForUser`'s pre-existing "attach to the sole tenant when exactly one
   exists" shortcut (safe when the only way to get a new user was `/api/setup` or an
   owner-created team member) would have silently attached — and, given signups default to
   `role:'owner'`, made an OWNER of — the real production tenant for any stranger who signed up
   publicly, since the real deployment has exactly one tenant today. Caught by an unrelated
   membership-count assertion in this phase's own atomic-bootstrap test before it ever reached
   a browser. Fixed with a new `users.self_registered` marker (see
   `docs/SELF_SERVICE_SIGNUP.md`). This is the most significant finding of this phase.
2. **Arabic company names could not create a workspace at all.** The slug generator stripped
   every non-ASCII character, producing an empty string — and a hard 400 — for any company
   named in Arabic, this product's own default locale. Fixed with a safe random fallback for
   the auto-generated case (`docs/WORKSPACE_CREATION.md`).
3. **The login `<input>`'s username-only `pattern` attribute already blocked email login**
   (a Phase 4C-5 finding, unchanged here) — re-verified still fixed and still working through
   this phase's own journey.
4. **A standalone form's `submit` event bubbling into `app.js`'s generic, document-level
   submit delegate** fired a stray, harmless `POST /api/content/undefined/undefined` for any
   form whose `id` that delegate doesn't recognize. Found via the new `#new-workspace-form`;
   the exact same latent pattern already existed (pre-dating this phase) in `pages/invite.js`'s
   and `pages/recovery.js`'s own standalone forms. Fixed with `event.stopPropagation()` in all
   of them, not only the new one.
5. **`#invite/accepted` (the post-acceptance URL sentinel `pages/invite.js` leaves in the
   visible URL) was itself still treated as a valid invitation route.** A page reload on that
   exact hash — reachable if the user did anything other than click the one "Go to workspace"
   button that itself resets the hash first — would call the invite page again with the literal
   string `"accepted"` as a token, get a real 404 from the preview endpoint, and strand the
   user on a permanent "invalid invitation" screen. Pre-existing since Phase 4C-3; surfaced by
   this phase's own invitation-regression journey. Fixed by excluding that one sentinel value
   from `isInviteRoute()`.
6. **The login/signup form toggle left BOTH forms hidden after a later logout.** The reset
   logic was gated behind `auth.needsSetup||auth.user`, which is false right after a logout —
   so neither branch ran, and whichever form was hidden by the toggle during the PREVIOUS
   session stayed hidden forever. Fixed by making the reset unconditional whenever `!auth.user`.

## What Phase 4C-6 explicitly does not build

Per the original instruction: no payment processor, no Stripe, no subscription billing, no
invoices, no seat billing, no paid-plan checkout, no reseller portal, no white-label, no
Super Admin billing panel. See `docs/TRIAL_WORKSPACES.md`'s own "what this phase does not
build" section for the complete list.

## Journeys verified (real browser, this phase's QA)

1. **Full SaaS journey**: existing platform owner exists → public signup → zero-workspace gate
   shows the real verify-email prompt (never a dead end) → verify → gate now shows the real
   create-workspace CTA → create a company (Arabic name) → lands directly in Guided Onboarding
   → configure a stubbed-at-the-network-boundary AI connection through the real form → apply
   the safe agent preset → skip optional steps → finish → Control Center and Account Settings
   both reachable, showing real, correct state. Zero console/page errors.
2. **Invitation regression**: an existing owner invites a colleague; the invitee's flow stays
   entirely membership-oriented — the invite page never mentions creating a company, and the
   invitee lands directly in the shared workspace, never the zero-workspace gate.
3. **Password/email regression**: an existing owner (with a real prior tenant, predating this
   phase) can still add + verify an email, log in with it, and complete a full forgot/reset
   password cycle — all unaffected by this phase's changes.

All three ran with the safe, non-network `PLATFORM_MAIL_TRANSPORT=capture` transport and (for
the AI step) a stubbed fetcher that only ever answers the exact Anthropic key-test endpoint —
never a real external call.
