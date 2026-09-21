import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {fail} from '../auth.js';
import {createOAuthState, consumeOAuthState, peekOAuthState} from '../integrations/oauth-state.js';
import {getConnection, updateConnection, disconnectConnection} from '../integrations/connections.js';
import {removeCredential} from '../integrations/vault.js';
import {testConnectionHealth} from '../integrations/health.js';
import {OAUTH_PROVIDERS, PROVIDER_FOR_DEFINITION, getOAuthProvider, providerAvailability} from '../integrations/oauth-providers.js';
import {encryptionKey} from '../runtime/crypto.js';
import {ROLE_PERMISSIONS, audit, clean, now, tx} from './core.js';
import {assertWithinLimit, resolveAccess} from './plans.js';

// Merchant OAuth: the flow is bound to the workspace and to the person who started it, server side.
//   start     POST /api/client/integrations/:provider/connect   (session + CSRF + integrations.manage + plan + writable account)
//   callback  GET  /api/client/integrations/:provider/callback  (the provider's redirect; identity comes from the state, see below)
// The state is `token.signature`: `token` is 192 random bits whose hash is stored in oauth_states (tenant, user, provider,
// optional connection to reconnect, encrypted PKCE verifier, 10-minute expiry, single use); the signature is an HMAC over
// (token, tenant, user, provider) keyed from INTEGRATION_ENCRYPTION_KEY, checked BEFORE the state is consumed.
//
// The provider redirects the browser back cross-site, so the Strict session cookie is not sent: the callback therefore never
// depends on a session. It re-authorizes the person named by the state (still an active member holding integrations.manage,
// workspace still writable, plan still includes integrations) and, when a session cookie IS present, requires it to be theirs.

export const OAUTH_RETURN_PATH = '/client/integrations';
export const redirectUriFor = (baseUrl, slug) => `${baseUrl}/api/client/integrations/${slug}/callback`;

const stateKey = env => { const k = encryptionKey(env); return k ? createHmac('sha256', k).update('frost-client-oauth-state/v1').digest() : null; };
const signature = (env, {token, tenantId, userId, slug}) => createHmac('sha256', stateKey(env)).update([token, tenantId, userId, slug].join('|')).digest('base64url');
const signState = (env, parts) => `${parts.token}.${signature(env, parts)}`;

export function providerViewFor(env, slug, {baseUrl}) {
 const provider = getOAuthProvider(slug);
 return {provider, availability: providerAvailability(env, provider, {baseUrl})};
}

// ---- start ------------------------------------------------------------------------------------------------------------------
export function startOAuth(db, env, ctx, slug, {baseUrl, connectionId = null}) {
 const {provider, availability} = providerViewFor(env, slug, {baseUrl});
 if (!provider) fail(404, 'UNKNOWN_PROVIDER');
 if (availability.state !== 'available') fail(409, `OAUTH_UNAVAILABLE:${availability.reason}`);
 let reconnecting = false;
 if (connectionId !== null && connectionId !== undefined) {
  const existing = getConnection(db, String(connectionId), ctx.tenantId); // 404 for another tenant's id
  if (PROVIDER_FOR_DEFINITION[existing.integrationDefinitionId] !== slug) fail(400, 'CONNECTION_PROVIDER_MISMATCH');
  reconnecting = true;
 } else {
  const already = db.prepare("SELECT 1 FROM integration_connections WHERE tenant_id=? AND integration_definition_id=? AND status!='DISCONNECTED'").get(ctx.tenantId, provider.definitionSlug);
  reconnecting = !!already && !provider.multiple;
  if (!reconnecting) assertWithinLimit(db, ctx.tenantId, 'integrations', 1);
 }
 const verifier = provider.pkce ? randomBytes(32).toString('base64url') : null;
 const token = createOAuthState(db, {tenantId: ctx.tenantId, userId: ctx.user.id, integrationDefinitionId: slug, connectionId: connectionId ? String(connectionId) : null, pkceVerifier: verifier, returnUrl: OAUTH_RETURN_PATH}, env);
 const state = signState(env, {token, tenantId: ctx.tenantId, userId: ctx.user.id, slug});
 const authorizeUrl = provider.authorizeUrl({env, state, verifier, redirectUri: redirectUriFor(baseUrl, slug)});
 audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: 'CLIENT_INTEGRATION_OAUTH_STARTED', entityType: 'integration', entityId: slug, detail: {reconnect: reconnecting}});
 return {authorizeUrl, expiresInSeconds: 600};
}

// ---- callback ---------------------------------------------------------------------------------------------------------------
const back = (slug, outcome, reason = null) => `${OAUTH_RETURN_PATH}?oauth=${outcome}&provider=${encodeURIComponent(slug)}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`;

function reauthorize(db, userId, tenantId) {
 const user = db.prepare('SELECT id,name,status FROM users WHERE id=?').get(userId);
 if (!user || user.status !== 'active') return {code: 'account_blocked'};
 const member = db.prepare("SELECT workspace_role FROM client_members WHERE tenant_id=? AND user_id=? AND status='active'").get(tenantId, userId);
 if (!member || !(ROLE_PERMISSIONS[member.workspace_role] || []).includes('integrations.manage')) return {code: 'not_permitted'};
 const access = resolveAccess(db, tenantId);
 if (!access || !['trial', 'active', 'past_due'].includes(access.state.status)) return {code: 'account_blocked'};
 if (!access.entitlements.includes('client.integrations')) return {code: 'not_permitted'};
 return {user, actor: {id: user.id, name: user.name, kind: 'user'}};
}

export async function handleOAuthCallback({db, env, fetcher, baseUrl, slug, query, session}) {
 const provider = getOAuthProvider(slug);
 if (!provider) return {redirect: back(slug, 'error', 'unknown_provider')};
 const rawState = String(query.get('state') || '');
 const [token, sig] = rawState.split('.');
 const peek = token ? peekOAuthState(db, token) : null;
 const failed = (reason, tenantId = null, actor = null, extra = {}) => {
  if (tenantId) audit(db, {tenantId, actor: actor || {kind: 'system'}, action: 'CLIENT_INTEGRATION_OAUTH_FAILED', entityType: 'integration', entityId: slug, detail: {reason, ...extra}});
  return {redirect: back(slug, 'error', reason)};
 };
 // 1. the state must exist, belong to this provider, carry a valid signature, be unexpired and unused
 if (!peek || peek.integrationDefinitionId !== slug || !stateKey(env) || !sig) return failed('state_invalid');
 const expected = Buffer.from(signature(env, {token, tenantId: peek.tenantId, userId: peek.userId, slug}));
 const given = Buffer.from(sig);
 if (expected.length !== given.length || !timingSafeEqual(expected, given)) return failed('state_invalid', peek.tenantId, null, {why: 'bad_signature'});
 if (peek.usedAt) return failed('state_used', peek.tenantId);
 if (Date.parse(peek.expiresAt) < Date.now()) return failed('state_expired', peek.tenantId);
 // a browser session, when the cookie made it through, must be the person who started the flow (checked BEFORE the state is
 // consumed, so somebody else's browser cannot burn it)
 if (session && session.user.id !== peek.userId) return failed('session_mismatch', peek.tenantId);
 let consumed;
 try { consumed = consumeOAuthState(db, token, {integrationDefinitionId: slug}, env); } // single use: a replay of the same callback finds it used
 catch { return failed('state_invalid', peek.tenantId); }
 // 3. the initiating person and workspace must still be allowed to connect things right now
 const who = reauthorize(db, consumed.userId, consumed.tenantId);
 if (who.code) return failed(who.code, consumed.tenantId);
 // 4. the provider's answer
 if (query.get('error')) return failed(query.get('error') === 'access_denied' ? 'denied' : 'provider_error', consumed.tenantId, who.actor, {providerError: clean(query.get('error'), 60)});
 const code = String(query.get('code') || '');
 if (!code) return failed('provider_error', consumed.tenantId, who.actor, {why: 'missing_code'});
 const reconnecting = !!consumed.connectionId || (!provider.multiple && !!db.prepare("SELECT 1 FROM integration_connections WHERE tenant_id=? AND integration_definition_id=? AND status='CONNECTED'").get(consumed.tenantId, provider.definitionSlug));
 if (!consumed.connectionId) { try { assertWithinLimit(db, consumed.tenantId, 'integrations', reconnecting ? 0 : 1); } catch { return failed('limit_reached', consumed.tenantId, who.actor); } }
 let done;
 try {
  done = await provider.complete({db, env, fetcher, code, verifier: consumed.pkceVerifier, redirectUri: redirectUriFor(baseUrl, slug), user: who.user, tenantId: consumed.tenantId, connectionId: consumed.connectionId});
 } catch (error) {
  // the provider modules only persist after a successful, verified exchange, so a failure leaves nothing half-connected
  return failed(/VERIFICATION_FAILED|META_NO_ASSETS/.test(String(error.code || error.message)) ? 'verification_failed' : 'provider_error', consumed.tenantId, who.actor, {code: clean(error.code || error.message, 80), detail: clean(error.detail, 80) || undefined});
 }
 // 5. verify the stored connection end to end, then record it
 let health = {status: 'ERROR', errors: ['NO_CONNECTION']};
 if (done.connectionId) {
  const connection = getConnection(db, done.connectionId, consumed.tenantId);
  health = await testConnectionHealth(connection, {store: {db}, env, fetcher});
  const t = now();
  updateConnection(db, connection.id, {status: health.status === 'CONNECTED' ? 'CONNECTED' : health.status, lastHealthCheck: t, lastSuccessAt: health.status === 'CONNECTED' ? t : connection.lastSuccessAt, lastErrorAt: health.status === 'CONNECTED' ? null : t, lastErrorCode: health.errors?.[0] || null, lastErrorMessageSafe: health.safeMessage || null}, consumed.tenantId);
 }
 if (health.status !== 'CONNECTED') {
  if (!reconnecting) await disconnectProvider(db, env, fetcher, consumed.tenantId, slug, done.connectionId).catch(() => {});
  return failed('verification_failed', consumed.tenantId, who.actor, {health: health.status, code: health.errors?.[0] || null});
 }
 audit(db, {tenantId: consumed.tenantId, actor: who.actor, action: reconnecting ? 'CLIENT_INTEGRATION_RECONNECTED' : 'CLIENT_INTEGRATION_CONNECTED', entityType: 'integration', entityId: done.connectionId || slug, detail: {provider: slug, account: done.accountName || null}});
 return {redirect: back(slug, 'success')};
}

// ---- status / disconnect ---------------------------------------------------------------------------------------------------
export function providerStatus(db, env, ctx, slug, {baseUrl}) {
 const {provider, availability} = providerViewFor(env, slug, {baseUrl});
 if (!provider) fail(404, 'UNKNOWN_PROVIDER');
 return {provider: slug, availability, multiple: provider.multiple, ...provider.status(db, env, ctx.tenantId)};
}

/** Full disconnect: provider-side records cleared, the vault/credential rows deleted, the connection marked DISCONNECTED. */
export async function disconnectProvider(db, env, fetcher, tenantId, slug, connectionId = null) {
 const provider = getOAuthProvider(slug);
 if (!provider) fail(404, 'UNKNOWN_PROVIDER');
 await provider.disconnect({db, env, fetcher, tenantId, connectionId});
 return {ok: true};
}

/** Disconnect by connection id (any provider, including the API-key ones). Nothing usable is left behind. */
export async function disconnectByConnectionId(db, env, fetcher, ctx, connectionId) {
 const connection = getConnection(db, connectionId, ctx.tenantId);
 const slug = PROVIDER_FOR_DEFINITION[connection.integrationDefinitionId];
 if (slug && OAUTH_PROVIDERS[slug].store === 'credentials') await disconnectProvider(db, env, fetcher, ctx.tenantId, slug);
 else tx(db, () => { disconnectConnection(db, connection.id, ctx.tenantId); removeCredential(db, connection.id, ctx.tenantId); });
 audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: 'CLIENT_INTEGRATION_DISCONNECTED', entityType: 'integration', entityId: connectionId, detail: {provider: connection.integrationDefinitionId}});
 return {ok: true};
}
export async function disconnectBySlug(db, env, fetcher, ctx, slug, connectionId = null) {
 const provider = getOAuthProvider(slug);
 if (!provider) fail(404, 'UNKNOWN_PROVIDER');
 if (provider.multiple && !connectionId && db.prepare("SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=? AND integration_definition_id=? AND status!='DISCONNECTED'").get(ctx.tenantId, provider.definitionSlug).n > 1) fail(400, 'CONNECTION_ID_REQUIRED');
 await disconnectProvider(db, env, fetcher, ctx.tenantId, slug, connectionId ? String(connectionId) : null);
 audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: 'CLIENT_INTEGRATION_DISCONNECTED', entityType: 'integration', entityId: connectionId ? String(connectionId) : slug, detail: {provider: slug}});
 return {ok: true};
}
