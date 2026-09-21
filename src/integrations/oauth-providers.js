import {fail} from '../auth.js';
import {testSallaConnection} from '../connectors.js';
import {credentialsConfigured, getCredentialsMeta} from '../runtime/credentials.js';
import {createAuthorizeUrl as sallaAuthorizeUrl, exchangeCodeForTokens as sallaExchange, oauthConfigured as sallaConfigured} from '../runtime/salla-oauth.js';
import {createZidAuthorizeUrl, exchangeZidCodeForTokens, resolveZidIdentity, zidOAuthConfigured} from '../runtime/zid-oauth.js';
import {createMetaAuthorizeUrl, exchangeCodeAndResolveAssets, saveMetaConnection, metaOAuthStatus, disconnectMeta, metaOAuthConfigured} from '../runtime/meta-oauth.js';
import {createMicrosoftAuthorizeUrl, exchangeCodeForTokens as microsoftExchange, resolveConnectedProfile as microsoftProfile, saveMicrosoftConnection, microsoftOAuthStatus, disconnectMicrosoft, microsoftOAuthConfigured} from '../runtime/microsoft-oauth.js';
import {createXAuthorizeUrl, exchangeCodeForTokens as xExchange, resolveConnectedProfile as xProfile, saveXConnection, xOAuthStatus, disconnectX, xOAuthConfigured} from '../runtime/x-oauth.js';
import {createLinkedInAuthorizeUrl, exchangeCodeForTokens as linkedInExchange, resolveConnectedProfile as linkedInProfile, resolveAdministeredOrganizations, saveLinkedInConnection, linkedInOAuthStatus, disconnectLinkedIn, linkedInOAuthConfigured} from '../runtime/linkedin-oauth.js';
import {deleteMailSubscription} from '../runtime/microsoft-graph.js';
import {createConnection, getConnection, getDefaultConnection, updateConnection, disconnectConnection} from './connections.js';
import {storeCredential, removeCredential} from './vault.js';
import {tx} from '../partners/core.js';

// One place that knows how each provider's OAuth flow starts, completes, reports status and disconnects. It ADAPTS the existing
// per-provider modules (src/runtime/*-oauth.js) and the existing credential stores — nothing about the exchange, the token
// storage or the encryption is reimplemented here.
//
// Two storage models exist in the platform and both are tenant-scoped:
//   'connection'   Salla, Zid  — one integration_connections row per store (many per tenant) + vault credential
//   'credentials'  Meta, Microsoft 365, X, LinkedIn — one (tenant, provider) row in integration_credentials, mirrored into
//                  integration_connections by the platform's compatibility bridge
// The redirect URI of a flow is given by the caller (the merchant portal registers its own callback URL with each provider) and
// overrides the deployment-wide *_REDIRECT_URI used by the operator's dashboard flow.

const withEnv = (env, key, value) => ({...env, [key]: value});
const providerError = (code, detail = null) => Object.assign(new Error(code), {code, detail, status: 502});

function persistConnectionTokens(db, env, args) {
 return tx(db, () => persistConnectionTokensTx(db, env, args)); // connection row + vault credential + status change land together
}
function persistConnectionTokensTx(db, env, {slug, tokens, identity = {}, user, tenantId, connectionId, defaultName}) {
 const t = new Date().toISOString();
 const connection = connectionId
  ? getConnection(db, connectionId, tenantId)
  : createConnection(db, {integrationDefinitionId: slug, name: identity.externalAccountName || defaultName, connectedBy: user.id}, tenantId);
 storeCredential(db, env, {connectionId: connection.id, credentialType: 'oauth_tokens', payload: {accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || null, expiresAt: tokens.expiresAt || null}}, tenantId);
 return updateConnection(db, connection.id, {
  status: 'CONNECTED', externalAccountType: slug, scopes: tokens.scopes,
  ...(identity.externalAccountId ? {externalAccountId: identity.externalAccountId} : {}),
  ...(identity.externalAccountName ? {externalAccountName: identity.externalAccountName} : {}),
  connectedBy: user.id, connectedAt: connection.connectedAt || t, lastHealthCheck: t, lastSuccessAt: t, lastErrorAt: null, lastErrorCode: null, lastErrorMessageSafe: null
 }, tenantId);
}

function connectionStatus(db, slug, tenantId) {
 const rows = db.prepare("SELECT id,name,status,external_account_name,connected_at,last_success_at,last_error_code FROM integration_connections WHERE tenant_id=? AND integration_definition_id=? AND status!='DISCONNECTED' ORDER BY created_at").all(tenantId, slug);
 return {connected: rows.some(r => r.status === 'CONNECTED'), connections: rows.map(r => ({id: r.id, name: r.name, status: r.status, accountName: r.external_account_name, connectedAt: r.connected_at, lastSuccessAt: r.last_success_at, lastError: r.last_error_code}))};
}
function disconnectStoredConnection(db, tenantId, connectionId, slug) {
 const target = connectionId ? getConnection(db, connectionId, tenantId) : getDefaultConnection(db, slug, tenantId);
 if (!target || target.integrationDefinitionId !== slug) fail(404, 'الاتصال غير موجود');
 disconnectConnection(db, target.id, tenantId);
 removeCredential(db, target.id, tenantId);
 return target.id;
}

export const OAUTH_PROVIDERS = {
 salla: {
  slug: 'salla', definitionSlug: 'salla', store: 'connection', pkce: false, multiple: true, redirectEnvKey: 'SALLA_REDIRECT_URI', defaultName: 'متجر سلة',
  configured: env => !!(env.SALLA_CLIENT_ID && env.SALLA_CLIENT_SECRET),
  authorizeUrl: ({env, state, redirectUri}) => sallaAuthorizeUrl(withEnv(env, 'SALLA_REDIRECT_URI', redirectUri), null, state),
  async complete({db, env, fetcher, code, redirectUri, user, tenantId, connectionId}) {
   const e = withEnv(env, 'SALLA_REDIRECT_URI', redirectUri);
   const tokens = await sallaExchange({env: e, fetcher, code});
   // verified against Salla with THIS token before anything is stored (the platform's own static token is never a fallback)
   const check = await testSallaConnection({env: {...e, SALLA_ACCESS_TOKEN: undefined}, fetcher, accessToken: tokens.accessToken});
   if (check.result !== 'OK') throw providerError('VERIFICATION_FAILED', check.code || check.result);
   const connection = persistConnectionTokens(db, env, {slug: 'salla', tokens, user, tenantId, connectionId, defaultName: 'متجر سلة'});
   return {connectionId: connection.id, accountName: connection.externalAccountName};
  },
  status: (db, env, tenantId) => connectionStatus(db, 'salla', tenantId),
  async disconnect({db, tenantId, connectionId}) { return disconnectStoredConnection(db, tenantId, connectionId, 'salla'); }
 },
 zid: {
  slug: 'zid', definitionSlug: 'zid', store: 'connection', pkce: false, multiple: true, redirectEnvKey: 'ZID_REDIRECT_URI', defaultName: 'متجر زد',
  configured: env => !!(env.ZID_CLIENT_ID && env.ZID_CLIENT_SECRET),
  authorizeUrl: ({env, state, redirectUri}) => createZidAuthorizeUrl(withEnv(env, 'ZID_REDIRECT_URI', redirectUri), null, state),
  async complete({db, env, fetcher, code, redirectUri, user, tenantId, connectionId}) {
   const e = withEnv(env, 'ZID_REDIRECT_URI', redirectUri);
   const tokens = await exchangeZidCodeForTokens({env: e, fetcher, code});
   // the store profile is the real verification: no resolvable store => nothing is stored
   const identity = await resolveZidIdentity({env: e, fetcher, accessToken: tokens.accessToken}).catch(() => null);
   if (!identity?.externalAccountId) throw providerError('VERIFICATION_FAILED');
   const connection = persistConnectionTokens(db, env, {slug: 'zid', tokens, identity, user, tenantId, connectionId, defaultName: 'متجر زد'});
   return {connectionId: connection.id, accountName: connection.externalAccountName};
  },
  status: (db, env, tenantId) => connectionStatus(db, 'zid', tenantId),
  async disconnect({db, tenantId, connectionId}) { return disconnectStoredConnection(db, tenantId, connectionId, 'zid'); }
 },
 meta: {
  slug: 'meta', definitionSlug: 'meta', store: 'credentials', pkce: false, multiple: false, redirectEnvKey: 'META_REDIRECT_URI', defaultName: 'ميتا',
  configured: env => !!(env.META_APP_ID && env.META_APP_SECRET),
  authorizeUrl: ({env, state, redirectUri}) => createMetaAuthorizeUrl(withEnv(env, 'META_REDIRECT_URI', redirectUri), null, state),
  async complete({db, env, fetcher, code, redirectUri, user, tenantId}) {
   const assets = await exchangeCodeAndResolveAssets({env: withEnv(env, 'META_REDIRECT_URI', redirectUri), fetcher, code});
   if (!assets.page && !assets.whatsapp) throw providerError('META_NO_ASSETS'); // a login that exposes no Page and no WhatsApp account connects nothing usable
   saveMetaConnection(db, env, assets, user, tenantId);
   const connection = getDefaultConnection(db, 'meta', tenantId);
   return {connectionId: connection?.id || null, accountName: assets.page?.name || null};
  },
  status: (db, env, tenantId) => metaOAuthStatus(db, tenantId),
  async disconnect({db, tenantId}) { disconnectMeta(db, tenantId); }
 },
 microsoft365: {
  slug: 'microsoft365', definitionSlug: 'microsoft365', store: 'credentials', pkce: false, multiple: false, redirectEnvKey: 'MICROSOFT_REDIRECT_URI', defaultName: 'مايكروسوفت 365',
  configured: env => !!(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
  authorizeUrl: ({env, state, redirectUri}) => createMicrosoftAuthorizeUrl(withEnv(env, 'MICROSOFT_REDIRECT_URI', redirectUri), null, state),
  async complete({db, env, fetcher, code, redirectUri, user, tenantId}) {
   const e = withEnv(env, 'MICROSOFT_REDIRECT_URI', redirectUri);
   const tokens = await microsoftExchange({env: e, fetcher, code});
   const profile = await microsoftProfile({env: e, fetcher, accessToken: tokens.accessToken});
   saveMicrosoftConnection(db, env, tokens, profile, user, tenantId);
   const connection = getDefaultConnection(db, 'microsoft365', tenantId);
   return {connectionId: connection?.id || null, accountName: profile.displayName || profile.email || null};
  },
  status: (db, env, tenantId) => microsoftOAuthStatus(db, tenantId),
  async disconnect({db, env, fetcher, tenantId}) {
   const meta = getCredentialsMeta(db, 'microsoft365', tenantId);
   if (meta?.metadata?.mailSubscription?.id) await deleteMailSubscription({store: {db}, env, fetcher}, meta.metadata.mailSubscription.id, tenantId).catch(() => {});
   disconnectMicrosoft(db, tenantId);
  }
 },
 x: {
  slug: 'x', definitionSlug: 'x', store: 'credentials', pkce: true, multiple: false, redirectEnvKey: 'X_REDIRECT_URI', defaultName: 'إكس',
  configured: env => !!(env.X_CLIENT_ID && env.X_CLIENT_SECRET),
  authorizeUrl: ({env, state, verifier, redirectUri}) => createXAuthorizeUrl(withEnv(env, 'X_REDIRECT_URI', redirectUri), null, state, verifier),
  async complete({db, env, fetcher, code, verifier, redirectUri, user, tenantId}) {
   const e = withEnv(env, 'X_REDIRECT_URI', redirectUri);
   const tokens = await xExchange({env: e, fetcher, code, codeVerifier: verifier});
   const profile = await xProfile({fetcher, accessToken: tokens.accessToken});
   saveXConnection(db, env, tokens, profile, user, tenantId);
   const connection = getDefaultConnection(db, 'x', tenantId);
   return {connectionId: connection?.id || null, accountName: profile?.username || profile?.name || null};
  },
  status: (db, env, tenantId) => xOAuthStatus(db, tenantId),
  async disconnect({db, tenantId}) { disconnectX(db, tenantId); }
 },
 linkedin: {
  slug: 'linkedin', definitionSlug: 'linkedin', store: 'credentials', pkce: false, multiple: false, redirectEnvKey: 'LINKEDIN_REDIRECT_URI', defaultName: 'لينكدإن',
  configured: env => !!(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET),
  authorizeUrl: ({env, state, redirectUri}) => createLinkedInAuthorizeUrl(withEnv(env, 'LINKEDIN_REDIRECT_URI', redirectUri), null, state),
  async complete({db, env, fetcher, code, redirectUri, user, tenantId}) {
   const e = withEnv(env, 'LINKEDIN_REDIRECT_URI', redirectUri);
   const tokens = await linkedInExchange({env: e, fetcher, code});
   const profile = await linkedInProfile({fetcher, accessToken: tokens.accessToken});
   let organization = null;
   try { organization = (await resolveAdministeredOrganizations({fetcher, accessToken: tokens.accessToken}))[0] || null; }
   catch { organization = null; } // rw_organization_admin not granted: the connection is identity-only and says so in its status
   saveLinkedInConnection(db, env, tokens, profile, organization, user, tenantId);
   const connection = getDefaultConnection(db, 'linkedin', tenantId);
   return {connectionId: connection?.id || null, accountName: organization?.name || profile?.name || null};
  },
  status: (db, env, tenantId) => linkedInOAuthStatus(db, tenantId),
  async disconnect({db, tenantId}) { disconnectLinkedIn(db, tenantId); }
 }
};
export const OAUTH_PROVIDER_SLUGS = Object.keys(OAUTH_PROVIDERS);
export const getOAuthProvider = slug => (Object.hasOwn(OAUTH_PROVIDERS, slug) ? OAUTH_PROVIDERS[slug] : null);
// The WhatsApp definition is the Meta login (one grant resolves Page + Instagram + WhatsApp assets).
export const PROVIDER_FOR_DEFINITION = {salla: 'salla', zid: 'zid', meta: 'meta', whatsapp: 'meta', microsoft365: 'microsoft365', x: 'x', linkedin: 'linkedin'};

/** 'available' | 'unavailable' with the concrete reason. Never true unless a start would really work on this server. */
export function providerAvailability(env, provider, {baseUrl}) {
 if (!provider) return {state: 'coming_soon', reason: 'not_implemented'};
 if (!credentialsConfigured(env)) return {state: 'unavailable', reason: 'encryption_key_missing'};
 if (!provider.configured(env)) return {state: 'unavailable', reason: 'provider_not_configured'};
 if (env.PUBLIC_ORIGIN ? !/^https:\/\//.test(baseUrl || '') : false) return {state: 'unavailable', reason: 'https_required'};
 return {state: 'available', reason: null};
}
export {metaOAuthConfigured, microsoftOAuthConfigured, xOAuthConfigured, linkedInOAuthConfigured, zidOAuthConfigured, sallaConfigured};
