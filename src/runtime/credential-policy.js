import {isDefaultTenant} from '../tenancy.js';

// The static integration tokens an operator can put in the server environment (SALLA_ACCESS_TOKEN, META_ACCESS_TOKEN, ...)
// are the operator's OWN accounts. They are a single-tenant convenience for the operator's workspace and must never become
// the fallback credential of any other tenant: a merchant without a connection must see "not connected", not silently act
// through the platform owner's Meta page or mailbox.
export const STATIC_INTEGRATION_ENV_KEYS = [
 'SALLA_ACCESS_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'META_ACCESS_TOKEN', 'X_BEARER_TOKEN',
 'LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_ORGANIZATION_ID', 'MICROSOFT_ACCESS_TOKEN', 'CANVA_API_KEY', 'META_PAGE_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID'
];

export function platformCredentialsAllowed(db, tenantId) {
 if (!tenantId) return true;
 try { return isDefaultTenant(db, tenantId); } catch { return true; }
}

export function envForTenant(db, env, tenantId) {
 if (platformCredentialsAllowed(db, tenantId)) return env;
 const scoped = {...env};
 for (const key of STATIC_INTEGRATION_ENV_KEYS) delete scoped[key];
 return scoped;
}
