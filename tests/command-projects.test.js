import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {openStore} from '../src/store.js';
import {installCommandChat} from '../src/runtime/command-chat.js';

// Command Center "Projects": named folders that group chats (ChatGPT-style). Real, tenant-scoped,
// soft-archived - archiving a project must never delete or hide its chats.
async function harness() {
 const directory = await mkdtemp(join(tmpdir(), 'hypercool-cmd-projects-'));
 const app = await createApp({dataDir: directory, env: {PLATFORM_MAIL_TRANSPORT: 'capture'}});
 await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
 const base = `http://127.0.0.1:${app.server.address().port}`;
 async function call(path, input, session, {method} = {}) {
  const res = await fetch(base + path, {method: method || (input ? 'POST' : 'GET'), headers: {...(input ? {'Content-Type': 'application/json'} : {}), ...(session ? {cookie: session.cookie, 'x-csrf-token': session.csrf} : {})}, ...(input ? {body: JSON.stringify(input)} : {})});
  const data = await res.json().catch(() => null);
  return {status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0], csrf: data?.csrf};
 }
 return {app, call, cleanup: async () => {await new Promise(resolve => app.server.close(resolve)); app.store.close(); await rm(directory, {recursive: true, force: true});}};
}
function latestMailTo(app, toEmail, kind) {
 const row = app.store.db.prepare('SELECT * FROM platform_mail_outbox WHERE to_email=? AND kind=? ORDER BY created_at DESC LIMIT 1').get(toEmail, kind);
 return row ? JSON.parse(row.captured_body) : null;
}
async function signupAndCreateWorkspace(call, app, {username, email, companyName}) {
 const signup = await call('/api/signup', {name: 'مستخدم اختبار', username, email, password: 'a-long-test-password'});
 const session = {cookie: signup.cookie, csrf: signup.csrf};
 const mail = latestMailTo(app, email, 'VERIFY_EMAIL');
 const token = (mail.html + mail.text).match(/verify-email\/([a-f0-9]+)/)?.[1];
 await call('/api/account/email/verify', {token}, null);
 await call('/api/workspaces', {companyName}, session);
 return session;
}

test('Command projects: create, group chats, move, rename and archive without losing any chat', async () => {
 const {app, call, cleanup} = await harness();
 try {
  const owner = await signupAndCreateWorkspace(call, app, {username: 'cp_owner1', email: 'cp1@example.com', companyName: 'CP One'});
  const project = await call('/api/command/projects', {name: '  مشروع   الإطلاق  '}, owner);
  assert.equal(project.status, 201);
  assert.equal(project.data.name, 'مشروع الإطلاق', 'the name is trimmed and whitespace collapsed');

  const inProject = await call('/api/command/conversations', {title: 'داخل المشروع', projectId: project.data.id}, owner);
  assert.equal(inProject.status, 201);
  assert.equal(inProject.data.projectId, project.data.id);
  const plain = await call('/api/command/conversations', {title: 'محادثة عادية'}, owner);
  assert.equal(plain.data.projectId, null);

  // Move a plain chat into the project, then back out.
  const moved = await call(`/api/command/conversations/${plain.data.id}`, {projectId: project.data.id}, owner, {method: 'PATCH'});
  assert.equal(moved.status, 200);
  assert.equal(moved.data.projectId, project.data.id);
  assert.equal(moved.data.title, 'محادثة عادية', 'moving does not touch the title');
  const removed = await call(`/api/command/conversations/${plain.data.id}`, {projectId: null}, owner, {method: 'PATCH'});
  assert.equal(removed.data.projectId, null);

  // Title-only rename still works exactly as before (backward compatible).
  const renamed = await call(`/api/command/conversations/${inProject.data.id}`, {title: 'اسم جديد'}, owner, {method: 'PATCH'});
  assert.equal(renamed.data.title, 'اسم جديد');
  assert.equal(renamed.data.projectId, project.data.id, 'renaming keeps the chat in its project');
  const blankTitle = await call(`/api/command/conversations/${inProject.data.id}`, {title: '  '}, owner, {method: 'PATCH'});
  assert.equal(blankTitle.status, 400);

  const renamedProject = await call(`/api/command/projects/${project.data.id}`, {name: 'مشروع أ'}, owner, {method: 'PATCH'});
  assert.equal(renamedProject.data.name, 'مشروع أ');
  const blank = await call('/api/command/projects', {name: '   '}, owner);
  assert.equal(blank.status, 400);

  // Archiving the project keeps every chat, as plain chats.
  const archived = await call(`/api/command/projects/${project.data.id}/archive`, {}, owner);
  assert.equal(archived.status, 200);
  assert.equal((await call('/api/command/projects', null, owner, {method: 'GET'})).data.length, 0);
  const chats = (await call('/api/command/conversations', null, owner, {method: 'GET'})).data;
  assert.equal(chats.length, 2, 'no chat is lost when its project is archived');
  assert.ok(chats.every(c => c.projectId === null));
  const intoArchived = await call('/api/command/conversations', {title: 'x', projectId: project.data.id}, owner);
  assert.equal(intoArchived.status, 404, 'cannot create a chat inside an archived project');
 } finally {await cleanup();}
});

test('Command projects: a workspace can never see, edit, archive or fill another workspace\'s project', async () => {
 const {app, call, cleanup} = await harness();
 try {
  const ownerA = await signupAndCreateWorkspace(call, app, {username: 'cp_owner2', email: 'cp2@example.com', companyName: 'CP A'});
  const ownerB = await signupAndCreateWorkspace(call, app, {username: 'cp_owner3', email: 'cp3@example.com', companyName: 'CP B'});
  const project = await call('/api/command/projects', {name: 'سري لـ A'}, ownerA);
  const chat = await call('/api/command/conversations', {title: 'محادثة A'}, ownerA);

  assert.equal((await call('/api/command/projects', null, ownerB, {method: 'GET'})).data.length, 0, 'B never lists A\'s projects');
  assert.equal((await call(`/api/command/projects/${project.data.id}`, {name: 'x'}, ownerB, {method: 'PATCH'})).status, 404);
  assert.equal((await call(`/api/command/projects/${project.data.id}/archive`, {}, ownerB)).status, 404);
  assert.equal((await call('/api/command/conversations', {title: 'اختراق', projectId: project.data.id}, ownerB)).status, 404, 'B cannot create a chat inside A\'s project');
  assert.equal((await call(`/api/command/conversations/${chat.data.id}`, {projectId: project.data.id}, ownerB, {method: 'PATCH'})).status, 404, 'B cannot move A\'s chat');

  const stillThere = (await call('/api/command/projects', null, ownerA, {method: 'GET'})).data;
  assert.equal(stillThere.length, 1);
  assert.equal(stillThere[0].name, 'سري لـ A', 'A\'s project is untouched by every rejected attempt');
 } finally {await cleanup();}
});

test('Command projects: installCommandChat adds project_id to a pre-existing conversations table without touching its rows', () => {
 const store = openStore(':memory:');
 try {
  store.db.exec(`CREATE TABLE command_conversations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT)`);
  store.db.prepare('INSERT INTO command_conversations (id,tenant_id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('old-1', 't1', 'u1', 'قديمة', 'x', 'x');
  installCommandChat(store.db);
  installCommandChat(store.db); // idempotent
  const columns = store.db.prepare('PRAGMA table_info(command_conversations)').all().map(c => c.name);
  assert.ok(columns.includes('project_id'));
  const row = store.db.prepare('SELECT * FROM command_conversations WHERE id=?').get('old-1');
  assert.equal(row.title, 'قديمة');
  assert.equal(row.project_id, null);
 } finally {store.close();}
});
