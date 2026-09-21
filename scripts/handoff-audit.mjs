// Read-only source inventory plus browser smoke in an isolated, disposable database.
import {createApp} from '../src/application.js';
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
const qaPassword=()=>`${randomBytes(12).toString('base64url')}-Aa1!`; // throwaway account in a temporary database, random per run
const QA_PASSWORD=qaPassword();
const output='artifacts/handoff';await mkdir(output,{recursive:true});
const inventory=[];
async function scan(path){for(const entry of await readdir(path,{withFileTypes:true})){const file=path+'/'+entry.name;if(entry.isDirectory())await scan(file);else if(/\.(js|mjs|css|html|json|md)$/.test(file)){const contents=await readFile(file);inventory.push({path:file,bytes:contents.length,lines:contents.toString('utf8').split('\n').length,sha256:createHash('sha256').update(contents).digest('hex')});}}}
for(const dir of ['src','public','tests','agents','schemas'])await scan(dir);
const dataDir=await mkdtemp(join(tmpdir(),'hypercool-handoff-')),app=await createApp({dataDir,env:{}});
const tables=app.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>({name,columns:app.store.db.prepare('SELECT name,type,pk FROM pragma_table_info(?)').all(name)}));
const result={capturedAt:new Date().toISOString(),node:process.version,inventory,tables,browserErrors:[],screens:[],scope:'Temporary database; empty-state smoke only. Does not prove live integrations or authenticated production data.'};
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',e=>result.browserErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')result.browserErrors.push(m.text());});
 const base=`http://127.0.0.1:${app.server.address().port}`;await page.goto(base);for(const [name,value] of Object.entries({name:'حساب فحص التسليم',username:'handoff_owner',password:QA_PASSWORD}))await page.locator(`#auth-form [name=${name}]`).fill(value);await page.locator('#auth-form button').click();await page.locator('#overview-dashboard').waitFor();
 const auditContext=await browser.newContext({storageState:await context.storageState(),bypassCSP:true}),auditPage=await auditContext.newPage();await auditPage.goto(base);await auditPage.locator('#overview-dashboard').waitFor();
 for(const width of [1440,1920,768,390])for(const route of ['overview','crm','planning','reports','content','agents','knowledge','integrations','audit','users']){
  await page.setViewportSize({width,height:1000});await page.evaluate(route=>document.querySelector(`nav a[href="#${route}"]`).click(),route);await page.evaluate(()=>document.querySelector('#message').replaceChildren());await page.screenshot({path:`${output}/${route}-${width}.png`,fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  await auditPage.setViewportSize({width,height:1000});await auditPage.evaluate(route=>document.querySelector(`nav a[href="#${route}"]`).click(),route);await auditPage.waitForTimeout(200);
  const axe=await new AxeBuilder({page:auditPage}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  result.screens.push({route,width,overflow,violations:axe.violations.map(v=>({id:v.id,impact:v.impact,targets:v.nodes.map(n=>n.target)}))});
 }
}catch(error){result.failure=error.stack;}
finally{await browser?.close();await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(dataDir,{recursive:true,force:true});await writeFile(output+'/evidence.json',JSON.stringify(result,null,2));console.log(JSON.stringify({files:inventory.length,tables:tables.length,screens:result.screens.length,errors:result.browserErrors,failure:result.failure,issues:result.screens.filter(s=>s.overflow||s.violations.length)},null,2));}
