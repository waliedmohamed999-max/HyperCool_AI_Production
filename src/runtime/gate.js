// The single kill-switch for every autonomous trigger (scheduler ticks AND event-routed
// runs). Human-initiated "test this agent" calls never check this — pausing stops the
// system from acting on its own, not a person from asking it something directly.
export function installGate(db) {
 db.exec("CREATE TABLE IF NOT EXISTS runtime_gate (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 0, paused_by TEXT, paused_by_name TEXT, paused_at TEXT, reason TEXT);");
 if(!db.prepare('SELECT id FROM runtime_gate WHERE id=1').get())db.prepare('INSERT INTO runtime_gate (id,paused) VALUES (1,0)').run();
}
export function isPaused(db) {
 return !!db.prepare('SELECT paused FROM runtime_gate WHERE id=1').get()?.paused;
}
export function getGateStatus(db) {
 const row=db.prepare('SELECT paused,paused_by,paused_by_name,paused_at,reason FROM runtime_gate WHERE id=1').get();
 return {paused:!!row.paused,pausedBy:row.paused_by_name,pausedAt:row.paused_at,reason:row.reason};
}
export function setPaused(db,paused,user,reason=null) {
 db.prepare('UPDATE runtime_gate SET paused=?,paused_by=?,paused_by_name=?,paused_at=?,reason=? WHERE id=1')
  .run(paused?1:0,user?.id||null,user?.name||null,new Date().toISOString(),reason);
 return getGateStatus(db);
}
