import {platformMailStatus, sendPlatformMail} from '../runtime/platform-mail.js';
import {getSettings} from './core.js';

// Partner e-mails reuse the platform mail service (Resend, or the capture transport in dev/tests).
// They are best-effort: an unconfigured/failed transport never blocks or rolls back the business
// action - the in-app notification is the durable channel, e-mail is the courtesy copy.

/** Existing databases created the outbox with a CHECK that does not know PARTNER_NOTICE: rebuild once. */
export function ensurePartnerMailKind(db) {
 const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='platform_mail_outbox'").get();
 if (!row || row.sql.includes('PARTNER_NOTICE')) return false;
 db.exec('BEGIN IMMEDIATE');
 try {
  db.exec(`ALTER TABLE platform_mail_outbox RENAME TO platform_mail_outbox_old;
   DROP INDEX IF EXISTS idx_platform_mail_outbox_to;
   CREATE TABLE platform_mail_outbox (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('VERIFY_EMAIL','PASSWORD_RESET','INVITATION','SECURITY_NOTICE','PARTNER_NOTICE')),
    to_email TEXT NOT NULL, subject TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('SENT','FAILED')),
    sent_at TEXT, last_send_error_code TEXT, captured_body TEXT, created_at TEXT NOT NULL
   );
   INSERT INTO platform_mail_outbox SELECT * FROM platform_mail_outbox_old;
   DROP TABLE platform_mail_outbox_old;
   CREATE INDEX IF NOT EXISTS idx_platform_mail_outbox_to ON platform_mail_outbox(to_email);`);
  db.exec('COMMIT');
 } catch (error) { db.exec('ROLLBACK'); throw error; }
 return true;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const money = (minor, currency) => `${(minor / 100).toFixed(2)} ${currency || ''}`.trim();

const TEMPLATES = {
 application_approved: (p, o) => ({ar: ['تمت الموافقة على طلب الشراكة', `مبروك! تمت الموافقة على طلب انضمامك لبرنامج شركاء Frost. رمز الإحالة الخاص بك: ${p.referralCode}\nلوحة الشريك: ${o}/partners/dashboard`], en: ['Your partner application was approved', `Congratulations! You have been approved for the Frost partner program. Your referral code: ${p.referralCode}\nPartner dashboard: ${o}/partners/dashboard`]}),
 application_rejected: (p, o) => ({ar: ['بخصوص طلب الشراكة', `نأسف، لم نتمكن من قبول طلب الشراكة حاليًا.\nالسبب: ${p.reason}`], en: ['About your partner application', `We are sorry, we could not approve your partner application at this time.\nReason: ${p.reason}`]}),
 application_needs_information: (p, o) => ({ar: ['نحتاج معلومات إضافية لطلب الشراكة', `يرجى الرد على ما يلي من لوحة الشريك:\n${p.message}\n${o}/partners/onboarding`], en: ['More information needed for your partner application', `Please reply from the partner portal:\n${p.message}\n${o}/partners/onboarding`]}),
 payout_paid: (p, o) => ({ar: ['تم صرف دفعتك', `تم صرف مبلغ ${money(p.amountMinor, p.currency)}. التفاصيل في ${o}/partners/payouts`], en: ['Your payout was sent', `A payout of ${money(p.amountMinor, p.currency)} was sent. Details: ${o}/partners/payouts`]}),
 payout_rejected: (p, o) => ({ar: ['تم رفض طلب السحب', `تم رفض طلب السحب وأُعيد المبلغ إلى رصيدك.\nالسبب: ${p.reason}`], en: ['Your payout request was rejected', `Your payout request was rejected and the funds returned to your balance.\nReason: ${p.reason}`]}),
 account_suspended: () => ({ar: ['تم إيقاف حساب الشريك', 'تم إيقاف حساب الشراكة الخاص بك. تواصل مع فريق Frost لمزيد من التفاصيل.'], en: ['Your partner account was suspended', 'Your partner account has been suspended. Contact the Frost team for details.']})
};
export const EMAIL_KINDS = Object.keys(TEMPLATES);

export async function sendPartnerMail(ctx, userId, kind, params = {}, origin = '') {
 try {
  const {db, env} = ctx;
  if (!TEMPLATES[kind] || !getSettings(db).notify_partner_email || platformMailStatus(env).status !== 'CONFIGURED') return {delivered: false, skipped: true};
  const user = db.prepare('SELECT email,email_verified_at,preferred_locale FROM users WHERE id=?').get(userId);
  if (!user?.email) return {delivered: false, skipped: true};
  const locale = user.preferred_locale === 'en' ? 'en' : 'ar';
  const [subject, text] = TEMPLATES[kind](params, origin)[locale];
  return await sendPlatformMail(ctx, {kind: 'PARTNER_NOTICE', to: user.email, subject: `${subject} — Frost`, text, html: `<p>${esc(text).replace(/\n/g, '<br>')}</p>`});
 } catch { return {delivered: false, error: true}; }
}
