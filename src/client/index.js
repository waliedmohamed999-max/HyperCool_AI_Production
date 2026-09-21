import {installClient} from './schema.js';
import {retireUnbackedKeys, seedPlans} from './plans.js';

export {uninstallClient, CLIENT_TABLES} from './schema.js';
export {makeRunGate} from './agents.js';
export {createClientRoutes} from './routes.js';
export {makeWorkflowGate} from './workflows.js';

/** Idempotent boot hook: schema + the editable starter merchant plans (only when none exist). */
export function installClientPortal(db) {
 installClient(db);
 seedPlans(db);
 retireUnbackedKeys(db);
}

/** True for accounts that belong to a merchant workspace (they use the portal, not the legacy dashboard API). */
export const isMerchantOnly = (db, userId) => !!db.prepare("SELECT 1 FROM client_members WHERE user_id=? AND status='active' LIMIT 1").get(userId);
