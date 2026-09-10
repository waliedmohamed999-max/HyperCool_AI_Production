import {createApp} from '../src/application.js';
import {chromium} from 'playwright';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'hc-mobile-'));
const app=await createApp({dataDir:dir,env:{}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'msedge',headless:true});
const errors=[],screens=[];
await mkdir('artifacts/mobile',{recursive:true});
try {
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${app.server.address().port}`);
 assert.equal(await page.locator('.mobile-tabbar').isVisible(),false);
 for(const [name,value] of Object.entries({name:'فحص الموبايل',username:'mobile_owner',password:'mobile-test-password'}))await page.locator(`#auth-form [name=${name}]`).fill(value);
 await page.locator('#auth-form button').click();await page.locator('#overview-dashboard').waitFor();
 await page.evaluate(()=>document.querySelector('#message').replaceChildren());
 assert.equal(await page.locator('[data-mobile-route="overview"] span').textContent(),'الرئيسية');
 for(const width of [360,390,430]){
  await page.setViewportSize({width,height:844});
  for(const route of ['overview','crm','content','agents','planning','reports','knowledge','integrations','audit','users']){
   await page.evaluate(route=>document.querySelector(`.app-sidebar nav a[href="#${route}"]`).click(),route);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${route} overflow at ${width}`);
   assert.equal(await page.locator('.mobile-tabbar').isVisible(),true);
   await page.screenshot({path:`artifacts/mobile/${route}-${width}.png`});screens.push({route,width});
  }
 }
 await page.locator('[data-mobile-route="content"]').click();
 assert.equal(await page.locator('[data-mobile-route="content"]').getAttribute('aria-current'),'page');
 await page.locator('.mobile-more').click();
 await page.locator('.app-sidebar.mobile-open').waitFor();
 await page.screenshot({path:'artifacts/mobile/more.png'});
 await page.locator('.mobile-menu-dismiss').click();
 assert.equal(await page.locator('.app-sidebar').isVisible(),false);
 await page.locator('#notifications').click();
 assert.equal(await page.locator('dialog[open]').isVisible(),true);
 await page.screenshot({path:'artifacts/mobile/decisions.png'});
 await page.keyboard.press('Escape');
 await page.setViewportSize({width:1440,height:1000});
 assert.equal(await page.locator('.mobile-tabbar').isVisible(),false);
 assert.equal(await page.locator('.app-sidebar').isVisible(),true);
 assert.deepEqual(errors,[]);
 await writeFile('artifacts/mobile/qa.json',JSON.stringify({screens,errors,checks:['signed-out dock hidden','30 route/viewports no overflow','bottom navigation','more menu opens/closes','decision dialog','desktop navigation preserved']},null,2));
 console.log('Mobile QA passed: 30 screens, navigation, menu, dialog and desktop checks.');
} finally {await browser.close();await new Promise(r=>app.server.close(r));app.store.close();await rm(dir,{recursive:true,force:true});}
