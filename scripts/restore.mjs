// Restores a backup produced by scripts/backup.mjs. Verifies integrity BEFORE touching the
// live database, and moves (never deletes) the current live file aside so a bad restore is
// itself reversible. Usage: node scripts/restore.mjs <backup-file> [dataDir]
import { DatabaseSync } from 'node:sqlite';
import { copyFile, rename, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const backupFile = process.argv[2];
if (!backupFile) {
  console.error('Usage: node scripts/restore.mjs <backup-file> [dataDir]');
  process.exit(1);
}
const dataDir = resolve(process.argv[3] || process.env.DATA_DIR || './data');
const dbPath = join(dataDir, 'hypercool.sqlite');
const backupPath = resolve(backupFile);

const check = new DatabaseSync(backupPath, { readOnly: true });
let result, userCount;
try {
  result = check.prepare('PRAGMA integrity_check').get().integrity_check;
  userCount = check.prepare('SELECT COUNT(*) c FROM users').get().c;
} finally {
  check.close();
}
if (result !== 'ok') {
  console.error(`[restore] ABORTED — backup file failed integrity check: ${result}`);
  process.exit(1);
}
console.log(`[restore] backup verified: integrity_check=${result}, users=${userCount}`);

try {
  await access(dbPath);
  const sidecar = `${dbPath}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await rename(dbPath, sidecar);
  console.log(`[restore] moved current live DB aside: ${sidecar}`);
  for (const ext of ['-wal', '-shm']) {
    try { await rename(dbPath + ext, sidecar + ext); } catch {}
  }
} catch {
  console.log('[restore] no existing live DB at target path — first restore.');
}

await copyFile(backupPath, dbPath);
console.log(`[restore] restored ${backupPath} -> ${dbPath}`);

const verify = new DatabaseSync(dbPath, { readOnly: true });
try {
  const post = verify.prepare('PRAGMA integrity_check').get().integrity_check;
  console.log(`[restore] post-restore integrity_check: ${post}`);
} finally {
  verify.close();
}
console.log('[restore] done. Restart the app to pick up the restored database.');
