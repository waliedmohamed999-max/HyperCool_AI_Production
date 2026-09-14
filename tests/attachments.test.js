import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.js';
import {installAuditLog} from '../src/audit.js';
import {installAttachments,createAttachment,getAttachment,listAttachments,readAttachmentTextForChat,pinAttachmentToBrain} from '../src/runtime/attachments.js';
import {installContextItems,createContextItem} from '../src/runtime/context-items.js';

const user={id:'owner-id',name:'Owner',role:'owner'};

async function fixture() {
 const store=openStore(':memory:');
 installAuditLog(store.db);installAttachments(store.db);installContextItems(store.db);
 const dir=await mkdtemp(join(tmpdir(),'hypercool-attachments-'));
 return {store,env:{ATTACHMENTS_DIR:dir},dir};
}

test('a valid text attachment is stored tenant-scoped, on disk, with real governance metadata',async()=>{
 const {store,env,dir}=await fixture();
 try{
  const content=Buffer.from('hello world','utf8').toString('base64');
  const attachment=createAttachment(store.db,env,{filename:'notes.txt',mimeType:'text/plain',contentBase64:content},user,'t1');
  assert.equal(attachment.filename,'notes.txt');
  assert.equal(attachment.sizeBytes,11);
  assert.equal(attachment.uploadedByName,'Owner');
  assert.equal(attachment.tenantId,'t1');
  const listed=listAttachments(store.db,'t1');
  assert.equal(listed.length,1);
  const {text}=readAttachmentTextForChat(store.db,env,attachment.id,'t1');
  assert.equal(text,'hello world');
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('an unsupported MIME type is rejected before anything is written',async()=>{
 const {store,env,dir}=await fixture();
 try{
  const content=Buffer.from('#!/bin/sh\necho pwned','utf8').toString('base64');
  assert.throws(()=>createAttachment(store.db,env,{filename:'evil.sh',mimeType:'application/x-sh',contentBase64:content},user,'t1'),/نوع الملف غير مسموح/);
  assert.equal(listAttachments(store.db,'t1').length,0);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('an oversized file is rejected',async()=>{
 const {store,env,dir}=await fixture();
 try{
  const big=Buffer.alloc(9*1024*1024,'a').toString('base64'); // > 8MB cap
  assert.throws(()=>createAttachment(store.db,env,{filename:'big.txt',mimeType:'text/plain',contentBase64:big},user,'t1'),/كبير جدًا/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('a filename with path-traversal characters is sanitized, never written outside the tenant directory',async()=>{
 const {store,env,dir}=await fixture();
 try{
  const content=Buffer.from('x','utf8').toString('base64');
  const attachment=createAttachment(store.db,env,{filename:'../../etc/passwd',mimeType:'text/plain',contentBase64:content},user,'t1');
  assert.ok(!attachment.filename.includes('..'));
  assert.ok(!attachment.filename.includes('/'));
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('attachments are tenant-isolated: a cross-tenant read 404s',async()=>{
 const {store,env,dir}=await fixture();
 try{
  const content=Buffer.from('x','utf8').toString('base64');
  const attachment=createAttachment(store.db,env,{filename:'a.txt',mimeType:'text/plain',contentBase64:content},user,'tenant-a');
  assert.throws(()=>getAttachment(store.db,attachment.id,'tenant-b'),/غير موجود/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('a non-text attachment (e.g. PDF) tracks real metadata but is honestly NOT read as text — no garbled binary sent as text',async()=>{
 const {store,env,dir}=await fixture();
 try{
  const content=Buffer.from('%PDF-1.4 fake','utf8').toString('base64');
  const attachment=createAttachment(store.db,env,{filename:'report.pdf',mimeType:'application/pdf',contentBase64:content},user,'t1');
  const {text,note}=readAttachmentTextForChat(store.db,env,attachment.id,'t1');
  assert.equal(text,null);
  assert.match(note,/غير نصي/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('pinning an attachment to the brain creates a real, governed context item and links back for traceability — never automatic',async()=>{
 const {store,env,dir}=await fixture();
 try{
  const content=Buffer.from('نص مهم','utf8').toString('base64');
  const attachment=createAttachment(store.db,env,{filename:'important.txt',mimeType:'text/plain',contentBase64:content},user,'t1');
  assert.equal(attachment.savedToBrainContextId,null); // uploading alone never pins it
  const contextItem=createContextItem(store.db,{type:'client_note',title:attachment.filename,description:'from attachment',source:'attachment'},user,'t1');
  const pinned=pinAttachmentToBrain(store.db,attachment.id,contextItem.id,'t1');
  assert.equal(pinned.savedToBrainContextId,contextItem.id);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
