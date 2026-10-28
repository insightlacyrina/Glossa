import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
const out = new URL('./', import.meta.url).pathname;
const server = await createServer({server:{host:'127.0.0.1',port:0,hmr:false,watch:null}});
await server.listen();
const base=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const records=[];
async function shot(page,label){
  await page.waitForTimeout(180);
  const metrics=await page.evaluate(()=>({width:innerWidth,height:innerHeight,bodyWidth:document.body.scrollWidth,rootWidth:document.documentElement.scrollWidth,view:document.querySelector('.app-shell')?.getAttribute('data-view'),dialog:document.querySelector('section[role=dialog]')?.getAttribute('aria-label'),overflow:[...document.querySelectorAll('section[role=dialog],.settings-panel,.topbar,.reading-toolbar,.paper-toolbar')].map(el=>({class:el.className,client:el.clientWidth,scroll:el.scrollWidth,rect:el.getBoundingClientRect().toJSON()}))}));
  await page.screenshot({path:out+'after-'+label+'.png',fullPage:true}); records.push({label,...metrics});console.log(label);
}
async function nav(page,name){let target=page.locator('.sidebar').getByRole('button',{name,exact:true});if(!await target.isVisible())await page.getByRole('button',{name:'导航',exact:true}).click();await target.click();}
try{
 for(const [label,role,width,height] of [['tablet-landscape','tablet',1280,900],['tablet-portrait','tablet',800,1100],['tablet-1100','tablet',1100,900],['tablet-1101','tablet',1101,900],['phone','phone',390,844],['phone-narrow','phone',360,640]]){
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,isMobile:role==='phone',hasTouch:true});
  await context.addInitScript(({role})=>{
   window.QuietPaperNative={getRole:()=>role,getDeviceId:()=>`visual-${role}`,getPlatform:()=> 'android',getRecognitionStatus:(id,language)=>setTimeout(()=>dispatchEvent(new CustomEvent('quietpaper-native',{detail:{requestId:id,type:'recognition',ok:true,downloaded:false,language}})),10)};
  },{role});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto(base);await page.locator('.app-shell').waitFor();await shot(page,label+'-01-empty');
  await nav(page,/温故/);await shot(page,label+'-02-review-empty');
  await nav(page,/校对/);await shot(page,label+'-03-proof-empty');
  await nav(page,'运行状态');await shot(page,label+'-04-activity-empty');
  await page.goto(base+'/tests/fixtures/workspace-harness.html');await page.waitForFunction(()=>window.workspaceHarness?.ready);
  await page.evaluate(async()=>{const{seedWorkspace}=await import('/src/bootstrap.ts');const e=seedWorkspace('visual-fixture');e.setSetting('stages',{recognition:false,mapping:false,structure:false,formatting:false,relations:false});const n=e.state.notes[0];e.manageNote(n.id,{title:'变化，与积累｜从瞬间到整体的数学笔记与长期思考'});const s=n.blocks[0].segments[0];e.editRange(n.id,s.id,0,0,'修订：');await window.workspaceHarness.importProject(e.exportProject());await window.workspaceHarness.waitForSave();});
  await page.goto(base);await page.locator('.app-shell').waitFor();await nav(page,/所有笔记/);await shot(page,label+'-05-library');
  await page.locator('.note-card').first().click();await shot(page,label+'-06-note');
  for(let i=0;i<3;i++){await page.locator('.representation-switch button').nth(i).click();await shot(page,label+'-07-mode-'+i);}
  await page.getByRole('button',{name:'修订与历史',exact:true}).click();await shot(page,label+'-08-history');await page.getByRole('button',{name:'关闭',exact:true}).click();
  await nav(page,/温故/);await shot(page,label+'-09-review');
  await nav(page,/校对/);await shot(page,label+'-10-proof');
  await nav(page,'运行状态');await shot(page,label+'-11-activity');
  await nav(page,'设置');
  for(const name of ['书写与整理','识别与仿手写','Mac 同步','外部识别']){await page.locator('.settings-tabs').getByRole('button',{name,exact:true}).click();await shot(page,label+'-12-settings-'+name);}
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await nav(page,'导出与恢复');await shot(page,label+'-13-export');
  records.push({label,errors});await context.close();
 }
}finally{await writeFile(out+'after-metrics.json',JSON.stringify(records,null,2));await browser.close();await server.close();}
