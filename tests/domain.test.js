import test from 'node:test';
import assert from 'node:assert/strict';
import {createContent,reviewContent,approveContent} from '../src/domain.js';
const draft=()=>createContent({title:'منتج',body:'محتوى للمراجعة',platform:'Instagram',date:'2026-09-10',url:'https://hyper-cool.com/offers'});
test('approval cannot bypass compliance',()=>{assert.throws(()=>approveContent(draft(),{owner:'Owner'}),/مراجعة/);});
test('unverified review is rejected',()=>{assert.throws(()=>reviewContent(draft(),{reviewer:'Reviewer',evidence:'source',facts:true,claims:false,link:true}),/تأكيد/);});
test('review and approval preserve evidence and do not publish',()=>{const reviewed=reviewContent(draft(),{reviewer:'Reviewer',evidence:'Product page checked',facts:true,claims:true,link:true});const approved=approveContent(reviewed,{owner:'Owner'});assert.equal(approved.status,'APPROVED');assert.equal(approved.review.evidence,'Product page checked');assert.throws(()=>reviewContent(approved,{}));});
test('external and deceptive store URLs are rejected',()=>{for(const url of ['https://hyper-cool.com.evil.test/x','http://hyper-cool.com/x','https://user@hyper-cool.com/x','javascript:alert(1)'])assert.throws(()=>createContent({...draft(),url}));});
