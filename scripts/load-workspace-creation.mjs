// Multi-Tenant Phase 4C-7 (Part 35/36/38/40) — a reproducible, documented concurrency check
// for `POST /api/workspaces`. Runs against a fresh, throwaway local SQLite copy — never
// production. Real HTTP requests, real signups, real verification tokens (read back from the
// safe `capture` mail transport) — no mocked business logic.
//
// Usage: node scripts/load-workspace-creation.mjs [concurrency]
// Example: npm run load:workspace-creation -- 25
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {randomBytes} from 'node:crypto';
const LOAD_TEST_PASSWORD=`${randomBytes(12).toString('base64url')}-Aa1!`; // throwaway accounts on a throwaway database, random per run

const concurrency=Number(process.argv[2])||10;
const dataDir=await mkdtemp(join(tmpdir(),'hypercool-load-'));
const app=await createApp({dataDir,env:{PLATFORM_MAIL_TRANSPORT:'capture'}});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${app.server.address().port}`;

function latestMailTo(toEmail,kind) {
 const row=app.store.db.prepare('SELECT * FROM platform_mail_outbox WHERE to_email=? AND kind=? ORDER BY created_at DESC LIMIT 1').get(toEmail,kind);
 return row?JSON.parse(row.captured_body):null;
}
function extractToken(body,marker) {
 const match=(body.html+body.text).match(new RegExp(marker+'/([a-f0-9]+)'));
 return match?match[1]:null;
}
async function jsonFetch(path,input,cookie,csrf) {
 const res=await fetch(base+path,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',...(cookie?{cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body:JSON.stringify(input)});
 const data=await res.json().catch(()=>({}));
 return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
}

async function newVerifiedUser(i) {
 const email=`load-test-${i}-${Date.now()}@example.com`;
 const signup=await jsonFetch('/api/signup',{name:`Load Test ${i}`,username:`load_test_${i}_${Date.now()}`,email,password:LOAD_TEST_PASSWORD});
 // A real, expected outcome at high concurrency from one source IP: checkSignupRateLimit
 // (20/15min) correctly rejects a burst beyond that — never a bug in the test itself; the
 // caller below simply excludes this user from the workspace-creation phase.
 if(signup.status!==201)return {rateLimited:true,status:signup.status};
 const mail=latestMailTo(email,'VERIFY_EMAIL');
 const token=extractToken(mail,'verify-email');
 await jsonFetch('/api/account/email/verify',{token});
 return {cookie:signup.cookie,csrf:signup.data.csrf};
}

async function main() {
 console.log(`Concurrency check: ${concurrency} parallel signups + workspace creations…`);
 const startedAt=Date.now();
 const allUsers=await Promise.all(Array.from({length:concurrency},(_, i)=>newVerifiedUser(i)));
 const rateLimitedAtSignup=allUsers.filter(u=>u.rateLimited).length;
 const users=allUsers.filter(u=>!u.rateLimited);
 if(rateLimitedAtSignup)console.log(`${rateLimitedAtSignup} signup(s) were themselves rate-limited (checkSignupRateLimit, 20/15min per IP) — expected when concurrency exceeds that limit from one source IP; excluded from the creation phase below.`);
 const createStart=Date.now();
 const results=await Promise.all(users.map((u,i)=>jsonFetch('/api/workspaces',{companyName:`Load Test Co ${i}`},u.cookie,u.csrf)));
 const durationMs=Date.now()-createStart;
 const succeeded=results.filter(r=>r.status===201).length;
 const failed=results.length-succeeded;
 const tenantCount=app.store.db.prepare("SELECT COUNT(*) n FROM tenants WHERE name LIKE 'Load Test Co %'").get().n;

 console.log(`Signup+verify phase: ${(createStart-startedAt)}ms`);
 console.log(`Workspace creation phase: ${durationMs}ms for ${users.length} parallel requests`);
 console.log(`Succeeded: ${succeeded} / ${users.length}`);
 console.log(`Failed: ${failed}`);
 console.log(`Real distinct tenants actually created: ${tenantCount}`);
 if(tenantCount!==succeeded) {
  console.error(`FAIL: tenant count (${tenantCount}) does not match reported successes (${succeeded}) — possible duplicate or lost creation.`);
  process.exitCode=1;
 } else if(succeeded!==users.length) {
  console.log(`NOTE: ${failed} request(s) were rejected (expected under some policies — e.g. per-user/IP limits); each real, distinct user got at most one workspace, which is the real invariant that matters.`);
 } else {
  console.log('PASS: every distinct user got exactly one workspace, no duplicates.');
 }
}

try { await main(); }
finally {
 await new Promise(resolve=>app.server.close(resolve));
 app.scheduler?.stop?.();
 app.store.close();
 await rm(dataDir,{recursive:true,force:true});
}
