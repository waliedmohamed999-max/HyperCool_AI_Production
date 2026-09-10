// Real, safe SQLite backup — uses VACUUM INTO (atomic, safe against a live WAL-mode writer,
// no risk of copying a torn/mid-transaction file) rather than a raw filesystem copy. Verifies
// the backup with PRAGMA integrity_check before keeping it, and applies simple retention.
// Usage: node scripts/backup.mjs [dataDir] [backupDir]
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const dataDir = resolve(process.argv[2] || process.env.DATA_DIR || './data');
const backupDir = resolve(process.argv[3] || process.env.BACKUP_DIR || join(dataDir, 'backups'));
const dbPath = join(dataDir, 'hypercool.sqlite');

const RETENTION = { daily: 7, weekly: 4, monthly: 3 };

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function backup() {
  await mkdir(backupDir, { recursive: true });
  const name = `hypercool-${stamp()}.sqlite`;
  const target = join(backupDir, name);

  const source = new DatabaseSync(dbPath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }

  const verify = new DatabaseSync(target, { readOnly: true });
  let result;
  try {
    result = verify.prepare('PRAGMA integrity_check').get().integrity_check;
    const userCount = verify.prepare('SELECT COUNT(*) c FROM users').get().c;
    console.log(`[backup] wrote ${name} — integrity_check: ${result}, users: ${userCount}`);
  } finally {
    verify.close();
  }
  if (result !== 'ok') {
    await unlink(target);
    throw new Error(`Backup failed integrity check (${result}) — removed ${name}`);
  }
  return target;
}

async function applyRetention() {
  const files = (await readdir(backupDir)).filter(f => f.startsWith('hypercool-') && f.endsWith('.sqlite'));
  const withDates = await Promise.all(files.map(async f => ({ f, mtime: (await stat(join(backupDir, f))).mtime })));
  withDates.sort((a, b) => b.mtime - a.mtime);
  const keep = new Set();
  withDates.slice(0, RETENTION.daily).forEach(x => keep.add(x.f));
  const byWeek = new Map();
  for (const x of withDates) {
    const week = `${x.mtime.getUTCFullYear()}-W${Math.ceil((x.mtime.getUTCDate()) / 7)}-${x.mtime.getUTCMonth()}`;
    if (!byWeek.has(week)) byWeek.set(week, x.f);
  }
  [...byWeek.values()].slice(0, RETENTION.weekly).forEach(f => keep.add(f));
  const byMonth = new Map();
  for (const x of withDates) {
    const month = `${x.mtime.getUTCFullYear()}-${x.mtime.getUTCMonth()}`;
    if (!byMonth.has(month)) byMonth.set(month, x.f);
  }
  [...byMonth.values()].slice(0, RETENTION.monthly).forEach(f => keep.add(f));
  const toDelete = withDates.map(x => x.f).filter(f => !keep.has(f));
  for (const f of toDelete) await unlink(join(backupDir, f));
  if (toDelete.length) console.log(`[backup] retention: removed ${toDelete.length} old backup(s), kept ${keep.size}`);
}

const target = await backup();
await applyRetention();
console.log(`[backup] done: ${target}`);
