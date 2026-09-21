// Accounts created by the LOCAL dev preview seed (scripts/dev-preview.mjs) are recognisable by these markers, so a deployment can
// prove it holds none: `npm run production:check` fails when it finds one and the server logs an error at boot in production.
// The marker email domain is reserved for documentation/testing (RFC 2606), so it can never belong to a real person.
export const DEV_SEED_EMAIL_DOMAIN = 'preview.invalid';
export const DEV_SEED_USERNAME_PREFIX = 'devseed_';

export function isDevSeedAccount({username = '', email = ''} = {}) {
 return String(email).toLowerCase().endsWith(`@${DEV_SEED_EMAIL_DOMAIN}`) || String(username).toLowerCase().startsWith(DEV_SEED_USERNAME_PREFIX);
}

export function countDevSeedAccounts(db) {
 try {
  return db.prepare("SELECT COUNT(*) n FROM users WHERE lower(COALESCE(email,'')) LIKE ? OR lower(username) LIKE ? ESCAPE '\\'").get(`%@${DEV_SEED_EMAIL_DOMAIN}`, `${DEV_SEED_USERNAME_PREFIX.replace('_', '\\_')}%`).n;
 } catch {
  return 0; // a database without the users table has none
 }
}
