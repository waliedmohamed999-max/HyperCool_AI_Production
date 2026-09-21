// Frost Partners - database schema (SQLite). Additive only: none of these tables touch or alter an
// existing table. installPartners() is idempotent; uninstallPartners() is the tested down-migration
// (drops ONLY the partner tables, in dependency order).

const TABLES = [
 'partner_notifications', 'partner_audit_logs', 'partner_admin_notes', 'partner_marketing_assets', 'payout_receipts', 'payout_commissions', 'payout_requests', 'payout_methods',
 'commission_ledger', 'commissions', 'billing_events', 'referrals', 'referral_visits', 'referral_links', 'partner_campaigns',
 'partner_subscriptions', 'partner_profiles', 'partner_applications', 'partner_invites', 'partner_staff', 'partner_plans', 'partner_settings'
];

export function installPartners(db) {
 db.exec(`
 CREATE TABLE IF NOT EXISTS partner_settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT
 );

 CREATE TABLE IF NOT EXISTS partner_plans (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  plan_type TEXT NOT NULL DEFAULT 'partner' CHECK(plan_type='partner'),
  name_ar TEXT NOT NULL, name_en TEXT NOT NULL,
  description_ar TEXT NOT NULL DEFAULT '', description_en TEXT NOT NULL DEFAULT '',
  price_minor INTEGER NOT NULL DEFAULT 0 CHECK(price_minor>=0),
  currency TEXT NOT NULL DEFAULT 'SAR',
  billing_period TEXT NOT NULL DEFAULT 'monthly' CHECK(billing_period IN ('free','monthly','yearly','one_time')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  highlighted INTEGER NOT NULL DEFAULT 0,
  default_commission_bps INTEGER NOT NULL CHECK(default_commission_bps BETWEEN 0 AND 10000),
  commission_duration_days INTEGER CHECK(commission_duration_days IS NULL OR commission_duration_days>0),
  commission_hold_days INTEGER CHECK(commission_hold_days IS NULL OR commission_hold_days>=0),
  min_payout_minor INTEGER CHECK(min_payout_minor IS NULL OR min_payout_minor>=0),
  max_team_members INTEGER CHECK(max_team_members IS NULL OR max_team_members>=0),
  max_referrals INTEGER CHECK(max_referrals IS NULL OR max_referrals>=0),
  entitlements_json TEXT NOT NULL DEFAULT '[]',
  trial_days INTEGER NOT NULL DEFAULT 0 CHECK(trial_days>=0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );

 CREATE TABLE IF NOT EXISTS partner_staff (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'partner_manager' CHECK(role='partner_manager'),
  permissions_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );

 CREATE TABLE IF NOT EXISTS partner_invites (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  email TEXT,
  plan_id TEXT REFERENCES partner_plans(id),
  note TEXT,
  created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT,
  used_by TEXT, used_at TEXT
 );

 CREATE TABLE IF NOT EXISTS partner_applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  full_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, country TEXT NOT NULL,
  company_name TEXT, website TEXT,
  partner_type TEXT NOT NULL, marketing_method TEXT NOT NULL, expected_customers INTEGER NOT NULL CHECK(expected_customers>=0),
  requested_plan_id TEXT REFERENCES partner_plans(id),
  terms_version TEXT NOT NULL, terms_accepted_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','under_review','approved','rejected','needs_information')),
  info_request TEXT, applicant_response TEXT, decision_reason TEXT,
  assigned_plan_id TEXT REFERENCES partner_plans(id), custom_commission_bps INTEGER,
  reviewed_by TEXT, reviewed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_partner_apps_status ON partner_applications(status,created_at);
 CREATE INDEX IF NOT EXISTS idx_partner_apps_user ON partner_applications(user_id);
 CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_apps_open_per_user ON partner_applications(user_id) WHERE status IN ('pending','under_review','needs_information');

 CREATE TABLE IF NOT EXISTS partner_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  application_id TEXT REFERENCES partner_applications(id),
  display_name TEXT NOT NULL, company_name TEXT, country TEXT, phone TEXT, website TEXT, partner_type TEXT,
  referral_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','limited','suspended','closed')),
  suspended_reason TEXT,
  plan_id TEXT REFERENCES partner_plans(id),
  custom_commission_bps INTEGER CHECK(custom_commission_bps IS NULL OR custom_commission_bps BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
 );
 CREATE INDEX IF NOT EXISTS idx_partner_profiles_status ON partner_profiles(status);

 CREATE TABLE IF NOT EXISTS partner_subscriptions (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partner_profiles(id),
  plan_id TEXT NOT NULL REFERENCES partner_plans(id),
  status TEXT NOT NULL CHECK(status IN ('trialing','active','past_due','expired','cancelled')),
  price_minor INTEGER NOT NULL, currency TEXT NOT NULL,
  started_at TEXT NOT NULL, trial_ends_at TEXT, ends_at TEXT, renews_at TEXT,
  source TEXT NOT NULL DEFAULT 'admin', created_by TEXT, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_partner_subs_partner ON partner_subscriptions(partner_id,started_at);

 CREATE TABLE IF NOT EXISTS partner_campaigns (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partner_profiles(id),
  name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_partner_campaigns_partner ON partner_campaigns(partner_id);

 CREATE TABLE IF NOT EXISTS referral_links (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partner_profiles(id),
  campaign_id TEXT REFERENCES partner_campaigns(id),
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL, landing_path TEXT NOT NULL DEFAULT '/',
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_referral_links_partner ON referral_links(partner_id);

 CREATE TABLE IF NOT EXISTS referral_visits (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES referral_links(id),
  partner_id TEXT NOT NULL REFERENCES partner_profiles(id),
  campaign_id TEXT,
  visitor_id TEXT NOT NULL,
  ip_hash TEXT, ua_hash TEXT, referrer TEXT, landing_page TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  click_count INTEGER NOT NULL DEFAULT 1,
  flagged INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
 );
 CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_visits_link_visitor ON referral_visits(link_id,visitor_id);
 CREATE INDEX IF NOT EXISTS idx_referral_visits_partner ON referral_visits(partner_id,first_seen_at);
 CREATE INDEX IF NOT EXISTS idx_referral_visits_ip ON referral_visits(ip_hash,last_seen_at);

 CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partner_profiles(id),
  link_id TEXT REFERENCES referral_links(id),
  campaign_id TEXT,
  visit_id TEXT REFERENCES referral_visits(id),
  visitor_id TEXT,
  referred_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  source TEXT, medium TEXT, campaign TEXT, landing_page TEXT,
  first_clicked_at TEXT, registered_at TEXT NOT NULL, qualified_at TEXT, converted_at TEXT,
  status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('clicked','registered','qualified','converted','rejected','cancelled')),
  reject_reason TEXT, ip_hash TEXT, metadata_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_referrals_partner ON referrals(partner_id,status,registered_at);

 CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('webhook','manual')),
  external_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('payment_succeeded','payment_failed','refund')),
  customer_user_id TEXT REFERENCES users(id),
  customer_email TEXT,
  plan_ref TEXT,
  amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),
  currency TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  refers_to_event_id TEXT,
  result TEXT NOT NULL DEFAULT 'applied',
  result_detail TEXT,
  raw_json TEXT, created_by TEXT, created_at TEXT NOT NULL
 );
 CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_events_source_external ON billing_events(source,external_id);
 CREATE INDEX IF NOT EXISTS idx_billing_events_customer ON billing_events(customer_user_id,occurred_at);

 CREATE TABLE IF NOT EXISTS commissions (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partner_profiles(id),
  referral_id TEXT NOT NULL REFERENCES referrals(id),
  customer_user_id TEXT NOT NULL REFERENCES users(id),
  billing_event_id TEXT NOT NULL UNIQUE REFERENCES billing_events(id),
  gross_minor INTEGER NOT NULL CHECK(gross_minor>=0),
  commission_rate_bps INTEGER NOT NULL CHECK(commission_rate_bps BETWEEN 0 AND 10000),
  commission_minor INTEGER NOT NULL CHECK(commission_minor>=0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','on_hold','approved','available','rejected','cancelled','paid')),
  hold_until TEXT, approved_at TEXT, available_at TEXT, paid_at TEXT, rejected_at TEXT,
  rejection_reason TEXT, held_previous_status TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_commissions_partner ON commissions(partner_id,status,created_at);
 CREATE INDEX IF NOT EXISTS idx_commissions_hold ON commissions(status,hold_until);

 CREATE TABLE IF NOT EXISTS commission_ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  partner_id TEXT NOT NULL REFERENCES partner_profiles(id),
  commission_id TEXT REFERENCES commissions(id),
  payout_id TEXT,
  entry_type TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK(bucket IN ('pending','available','reserved','paid')),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  memo TEXT, actor_id TEXT, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_ledger_partner ON commission_ledger(partner_id,bucket);
 CREATE TRIGGER IF NOT EXISTS commission_ledger_no_update BEFORE UPDATE ON commission_ledger BEGIN SELECT RAISE(ABORT,'commission_ledger is append-only'); END;
 CREATE TRIGGER IF NOT EXISTS commission_ledger_no_delete BEFORE DELETE ON commission_ledger BEGIN SELECT RAISE(ABORT,'commission_ledger is append-only'); END;

 CREATE TABLE IF NOT EXISTS payout_methods (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partner_profiles(id),
  type TEXT NOT NULL CHECK(type IN ('bank_transfer','paypal','other')),
  label TEXT NOT NULL, masked TEXT NOT NULL, details_encrypted TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_payout_methods_partner ON payout_methods(partner_id,status);

 CREATE TABLE IF NOT EXISTS payout_requests (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partner_profiles(id),
  method_id TEXT REFERENCES payout_methods(id),
  method_type TEXT NOT NULL, method_label TEXT NOT NULL, method_masked TEXT NOT NULL, method_details_encrypted TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor>0), currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','under_review','approved','processing','paid','rejected','cancelled')),
  reject_reason TEXT, payment_reference TEXT,
  reviewed_by TEXT, reviewed_at TEXT, processing_at TEXT, paid_at TEXT, paid_by TEXT,
  requested_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_payouts_partner ON payout_requests(partner_id,status,requested_at);
 CREATE INDEX IF NOT EXISTS idx_payouts_status ON payout_requests(status,requested_at);

 CREATE TABLE IF NOT EXISTS payout_commissions (
  payout_id TEXT NOT NULL REFERENCES payout_requests(id),
  commission_id TEXT NOT NULL REFERENCES commissions(id),
  amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
  PRIMARY KEY (payout_id, commission_id)
 );
 CREATE INDEX IF NOT EXISTS idx_payout_commissions_commission ON payout_commissions(commission_id);

 CREATE TABLE IF NOT EXISTS payout_receipts (
  payout_id TEXT PRIMARY KEY REFERENCES payout_requests(id),
  file_name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, data BLOB NOT NULL,
  uploaded_by TEXT, uploaded_at TEXT NOT NULL
 );

 CREATE TABLE IF NOT EXISTS partner_marketing_assets (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('file','text','link')),
  title_ar TEXT NOT NULL, title_en TEXT NOT NULL,
  description_ar TEXT NOT NULL DEFAULT '', description_en TEXT NOT NULL DEFAULT '',
  text_ar TEXT, text_en TEXT, url TEXT,
  file_name TEXT, mime_type TEXT, size_bytes INTEGER, file_data BLOB,
  plan_ids_json TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_partner_assets_category ON partner_marketing_assets(category,status);

 CREATE TABLE IF NOT EXISTS partner_admin_notes (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partner_profiles(id),
  author_id TEXT NOT NULL, author_name TEXT, note TEXT NOT NULL, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_partner_notes_partner ON partner_admin_notes(partner_id,created_at);

 CREATE TABLE IF NOT EXISTS partner_audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT, actor_name TEXT, actor_role TEXT,
  action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, partner_id TEXT,
  detail_json TEXT, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_partner_audit_partner ON partner_audit_logs(partner_id,created_at);
 CREATE INDEX IF NOT EXISTS idx_partner_audit_created ON partner_audit_logs(created_at);
 CREATE TRIGGER IF NOT EXISTS partner_audit_no_update BEFORE UPDATE ON partner_audit_logs BEGIN SELECT RAISE(ABORT,'partner_audit_logs is append-only'); END;
 CREATE TRIGGER IF NOT EXISTS partner_audit_no_delete BEFORE DELETE ON partner_audit_logs BEGIN SELECT RAISE(ABORT,'partner_audit_logs is append-only'); END;

 CREATE TABLE IF NOT EXISTS partner_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL, params_json TEXT NOT NULL DEFAULT '{}',
  read_at TEXT, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_partner_notifications_user ON partner_notifications(user_id,read_at,created_at);
 `);
}

/** Down-migration: removes every partner table (and its triggers/indexes). Data loss by design. */
export function uninstallPartners(db) {
 db.exec('DROP TRIGGER IF EXISTS commission_ledger_no_update; DROP TRIGGER IF EXISTS commission_ledger_no_delete; DROP TRIGGER IF EXISTS partner_audit_no_update; DROP TRIGGER IF EXISTS partner_audit_no_delete;');
 for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
}
export const PARTNER_TABLES = TABLES;
