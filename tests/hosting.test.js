import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

test('CommonJS can load server module without top-level await or starting it',()=>{
  execFileSync(process.execPath,['-e',"require('./src/application.js')"],{timeout:15000});
});

for(const entry of ['./src/server.js','./app.cjs']) {
  test(`LiteSpeed require(${entry}) calls listen without a main-module guard`,async()=>{
    const dir=await mkdtemp(join(tmpdir(),'hc-entry-test-'));
    try {
      const output=execFileSync(process.execPath,['-e',
        `require('node:http').Server.prototype.listen=function(){console.log('LISTEN_CALLED');return this;};require(${JSON.stringify(entry)});`
      ],{timeout:3000,encoding:'utf8',env:{...process.env,DATA_DIR:dir,PUBLIC_ORIGIN:'https://app.example.com'}});
      assert.match(output,/LISTEN_CALLED/);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
}

test('hosted origin enforces host and origin and secures session cookies',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hc-hosting-'));
  const app=await createApp({env:{PUBLIC_ORIGIN:'https://app.example.com',DATA_DIR:dir}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const request=(host,origin,input)=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:app.server.address().port,path:input?'/api/setup':'/api/auth',method:input?'POST':'GET',headers:{Host:host,...(origin?{Origin:origin}:{}),...(input?{'Content-Type':'application/json'}:{})}},res=>{
      res.resume();res.on('end',()=>resolve({status:res.statusCode,cookies:res.headers['set-cookie']}));
    });req.on('error',reject);req.end(input?JSON.stringify(input):undefined);
  });
  try {
    assert.equal((await request('app.example.com')).status,200);
    assert.equal((await request('evil.example.com')).status,403);
    assert.equal((await request('app.example.com','https://evil.example.com')).status,403);
    assert.equal((await request('app.example.com','http://app.example.com')).status,403);
    const result=await request('app.example.com','https://app.example.com',{username:'owner',name:'Owner',password:'test-password-hosting'});
    assert.equal(result.status,200);
    assert.match(result.cookies[0],/; Secure/);
  } finally {
    await new Promise(resolve=>app.server.close(resolve));app.store.db.close();await rm(dir,{recursive:true,force:true});
  }
});
