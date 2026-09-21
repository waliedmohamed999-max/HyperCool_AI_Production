// Frost Client Portal - database schema. Additive only (no existing table is altered).
// installClient() is idempotent; uninstallClient() is the tested down-migration and drops ONLY these
// tables (tenants, memberships, audit_logs, agent_* ... belong to the core platform and stay).

const TABLES = [
 'client_workflow_meta', 'client_support_events', 'client_support_sessions', 'client_admin_notes', 'client_audit_logs', 'client_notifications', 'client_usage_events',
 'client_tasks', 'client_invitation_roles', 'client_members', 'client_onboarding', 'client_agent_settings', 'client_agent_platform',
 'client_tenant_overrides', 'client_subscriptions', 'client_profiles', 'client_plans', 'client_settings'
];

export function installClient(db) {
 db.exec(`
 CREATE TABLE IF NOT EXISTS client_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);

 CREATE TABLE IF NOT EXISTS client_plans (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  plan_type TEXT NOT NULL DEFAULT 'merchant' CHECK(plan_type IN ('standard','partner','merchant')),
  name_ar TEXT NOT NULL, name_en TEXT NOT NULL,
  description_ar TEXT NOT NULL DEFAULT '', description_en TEXT NOT NULL DEFAULT '',
  price_minor INTEGER NOT NULL DEFAULT 0 CHECK(price_minor>=0),
  currency TEXT NOT NULL DEFAULT 'SAR',
  billing_period TEXT NOT NULL DEFAULT 'monthly' CHECK(billing_period IN ('free','monthly','yearly','one_time')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','archived')),
  sort_order INTEGER NOT NULL DEFAULT 0, highlighted INTEGER NOT NULL DEFAULT 0,
  trial_days INTEGER NOT NULL DEFAULT 14 CHECK(trial_days>=0),
  support_level TEXT NOT NULL DEFAULT 'standard',
  entitlements_json TEXT NOT NULL DEFAULT '[]',
  limits_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );

 CREATE TABLE IF NOT EXISTS client_profiles (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  phone TEXT, country TEXT, business_name TEXT NOT NULL,
  business_type TEXT, business_size TEXT, store_url TEXT, ecommerce_platform TEXT, team_size INTEGER,
  goals_json TEXT NOT NULL DEFAULT '[]',
  requested_plan_id TEXT REFERENCES client_plans(id),
  terms_version TEXT, terms_accepted_at TEXT,
  account_status TEXT NOT NULL DEFAULT 'trial' CHECK(account_status IN ('pending','trial','active','limited','past_due','suspended','cancelled','archived')),
  workspace_status TEXT NOT NULL DEFAULT 'onboarding' CHECK(workspace_status IN ('onboarding','ready','restricted','suspended','archived')),
  status_reason TEXT, grace_until TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_client_profiles_status ON client_profiles(account_status);
 CREATE INDEX IF NOT EXISTS idx_client_profiles_owner ON client_profiles(owner_user_id);

 CREATE TABLE IF NOT EXISTS client_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  plan_id TEXT NOT NULL REFERENCES client_plans(id),
  status TEXT NOT NULL CHECK(status IN ('trial','active','past_due','expired','cancelled')),
  started_at TEXT NOT NULL, trial_ends_at TEXT, ends_at TEXT, grace_until TEXT,
  source TEXT NOT NULL DEFAULT 'signup', created_by TEXT, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_client_subs_tenant ON client_subscriptions(tenant_id,started_at);

 CREATE TABLE IF NOT EXISTS client_tenant_overrides (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL CHECK(kind IN ('entitlement','limit')),
  key TEXT NOT NULL, value TEXT NOT NULL,
  updated_by TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, kind, key)
 );

 CREATE TABLE IF NOT EXISTS client_agent_platform (
  agent_id TEXT PRIMARY KEY, available INTEGER NOT NULL DEFAULT 1,
  allowed_plans_json TEXT, note TEXT, updated_by TEXT, updated_at TEXT NOT NULL
 );

 CREATE TABLE IF NOT EXISTS client_agent_settings (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL,
  admin_state TEXT NOT NULL DEFAULT 'default' CHECK(admin_state IN ('default','enabled','disabled')),
  client_paused INTEGER NOT NULL DEFAULT 0,
  approval_level TEXT CHECK(approval_level IS NULL OR approval_level IN ('manual','approval_required','limited_autonomy')),
  admin_approval_level TEXT CHECK(admin_approval_level IS NULL OR admin_approval_level IN ('manual','approval_required','limited_autonomy')),
  allowed_actions_json TEXT, blocked_actions_json TEXT,
  usage_limit_monthly INTEGER CHECK(usage_limit_monthly IS NULL OR usage_limit_monthly>=0),
  settings_json TEXT NOT NULL DEFAULT '{}', admin_note TEXT,
  updated_by TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, agent_id)
 );

 CREATE TABLE IF NOT EXISTS client_onboarding (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  current_step INTEGER NOT NULL DEFAULT 1,
  data_json TEXT NOT NULL DEFAULT '{}',
  default_autonomy TEXT NOT NULL DEFAULT 'approval_required' CHECK(default_autonomy IN ('manual','approval_required','limited_autonomy')),
  completed_at TEXT, updated_at TEXT NOT NULL
 );

 CREATE TABLE IF NOT EXISTS client_members (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_role TEXT NOT NULL CHECK(workspace_role IN ('workspace_owner','workspace_admin','manager','operator','analyst','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','removed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
 );
 CREATE INDEX IF NOT EXISTS idx_client_members_user ON client_members(user_id,status);

 CREATE TABLE IF NOT EXISTS client_invitation_roles (
  invitation_id TEXT PRIMARY KEY REFERENCES workspace_invitations(id),
  workspace_role TEXT NOT NULL CHECK(workspace_role IN ('workspace_admin','manager','operator','analyst','viewer'))
 );

 CREATE TABLE IF NOT EXISTS client_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id), assigned_to TEXT REFERENCES users(id),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', input_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK(status IN ('draft','queued','waiting_for_integration','waiting_for_approval','running','completed','failed','cancelled','paused')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK(risk_level IN ('low','medium','high')),
  approval_status TEXT NOT NULL DEFAULT 'not_required' CHECK(approval_status IN ('not_required','pending','approved','rejected')),
  approval_id TEXT,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT,
  result_json TEXT, error TEXT, run_id TEXT, usage_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_client_tasks_tenant ON client_tasks(tenant_id,status,created_at);
 CREATE INDEX IF NOT EXISTS idx_client_tasks_due ON client_tasks(status,scheduled_at);
 CREATE INDEX IF NOT EXISTS idx_client_tasks_run ON client_tasks(run_id);

 CREATE TABLE IF NOT EXISTS client_usage_events (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL, agent_id TEXT, quantity INTEGER NOT NULL DEFAULT 1, tokens INTEGER NOT NULL DEFAULT 0,
  ref_id TEXT, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_client_usage_tenant ON client_usage_events(tenant_id,kind,created_at);

 CREATE TABLE IF NOT EXISTS client_notifications (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT,
  kind TEXT NOT NULL, params_json TEXT NOT NULL DEFAULT '{}', read_at TEXT, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_client_notifications ON client_notifications(tenant_id,user_id,read_at,created_at);

 CREATE TABLE IF NOT EXISTS client_audit_logs (
  id TEXT PRIMARY KEY, tenant_id TEXT,
  action TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
  actor_id TEXT, actor_name TEXT, actor_kind TEXT NOT NULL DEFAULT 'system',
  performed_by_admin TEXT, on_behalf_of_user TEXT, support_session_id TEXT, reason TEXT,
  detail_json TEXT, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_client_audit_tenant ON client_audit_logs(tenant_id,created_at);
 CREATE INDEX IF NOT EXISTS idx_client_audit_support ON client_audit_logs(support_session_id);
 CREATE TRIGGER IF NOT EXISTS client_audit_no_update BEFORE UPDATE ON client_audit_logs BEGIN SELECT RAISE(ABORT,'client_audit_logs is append-only'); END;
 CREATE TRIGGER IF NOT EXISTS client_audit_no_delete BEFORE DELETE ON client_audit_logs BEGIN SELECT RAISE(ABORT,'client_audit_logs is append-only'); END;

 CREATE TABLE IF NOT EXISTS client_workflow_meta (
  workflow_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  template_key TEXT NOT NULL, params_json TEXT NOT NULL,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_client_wf_meta_tenant ON client_workflow_meta(tenant_id);

 CREATE TABLE IF NOT EXISTS client_admin_notes (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  author_id TEXT NOT NULL, author_name TEXT, note TEXT NOT NULL, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_client_notes_tenant ON client_admin_notes(tenant_id,created_at);

 CREATE TABLE IF NOT EXISTS client_support_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  admin_user_id TEXT NOT NULL REFERENCES users(id), admin_name TEXT,
  access_level TEXT NOT NULL CHECK(access_level IN ('view_only','limited','extended')),
  reason TEXT NOT NULL, ticket TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended','expired','revoked')),
  token_hash TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL, expires_at TEXT NOT NULL, ended_at TEXT, ended_by TEXT, end_reason TEXT
 );
 CREATE INDEX IF NOT EXISTS idx_support_tenant ON client_support_sessions(tenant_id,started_at);
 CREATE INDEX IF NOT EXISTS idx_support_admin ON client_support_sessions(admin_user_id,status);

 CREATE TABLE IF NOT EXISTS client_support_events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES client_support_sessions(id),
  tenant_id TEXT NOT NULL, kind TEXT NOT NULL, method TEXT, path TEXT, detail TEXT, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_support_events_session ON client_support_events(session_id,created_at);
 CREATE TRIGGER IF NOT EXISTS client_support_events_no_update BEFORE UPDATE ON client_support_events BEGIN SELECT RAISE(ABORT,'client_support_events is append-only'); END;
 CREATE TRIGGER IF NOT EXISTS client_support_events_no_delete BEFORE DELETE ON client_support_events BEGIN SELECT RAISE(ABORT,'client_support_events is append-only'); END;
 `);
}

// Deletion policy: the audit trail and the support-access records are compliance evidence (who did what, who entered a customer's
// workspace and why). A normal uninstall keeps them - with their append-only triggers - and drops everything else; a later
// installClient() simply reattaches. Only an explicit `{dropAudit: true}` removes them too.
export const RETAINED_ON_UNINSTALL = ['client_support_events', 'client_support_sessions', 'client_audit_logs'];

export function uninstallClient(db, {dropAudit = false} = {}) {
 if (dropAudit) db.exec('DROP TRIGGER IF EXISTS client_audit_no_update; DROP TRIGGER IF EXISTS client_audit_no_delete; DROP TRIGGER IF EXISTS client_support_events_no_update; DROP TRIGGER IF EXISTS client_support_events_no_delete;');
 for (const table of TABLES) if (dropAudit || !RETAINED_ON_UNINSTALL.includes(table)) db.exec(`DROP TABLE IF EXISTS ${table}`);
}
export const CLIENT_TABLES = TABLES;
