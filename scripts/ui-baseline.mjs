import {chromium} from 'playwright';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const qaPassword=()=>`${randomBytes(12).toString('base64url')}-Aa1!`; // throwaway account in a temporary database, random per run
const QA_PASSWORD=qaPassword();
import {createApp} from '../src/application.js';
const dataDir=await mkdtemp(join(tmpdir(),'hypercool-ui-'));
const app=await createApp({dataDir,env:{}});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'light'});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 await page.goto(base);await page.locator('#auth-form [name=name]').fill('مالك اختبار الواجهة');await page.locator('#auth-form [name=username]').fill('ui_owner');await page.locator('#auth-form [name=password]').fill(QA_PASSWORD);await page.locator('#auth-form button').click();await page.locator('#protected').waitFor({state:'visible'});await page.waitForTimeout(1000);
 await mkdir('artifacts/ui/smoke',{recursive:true});
 for(const route of ['overview','crm','agents','integrations']){await page.locator(`nav a[href="#${route}"]`).click();await page.screenshot({path:`artifacts/ui/smoke/${route}.png`,fullPage:true});}
 console.log('Smoke screenshots captured using isolated test database');
}finally{await browser?.close();await new Promise(resolve=>app.server.close(resolve));app.scheduler?.stop?.();app.store.close();await rm(dataDir,{recursive:true,force:true});}
