import {existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {chromium,type Browser} from 'playwright-core';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';

const baseUrl=process.env.FITGRID_VALUATION_E2E_URL;
describe.skipIf(!baseUrl)('independent valuation reference browser acceptance',()=>{
 let browser:Browser;
 beforeAll(async()=>{
  const executablePath=[process.env.FITGRID_CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
  if(!executablePath)throw new Error('Chrome is required');
  browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  await mkdir('output/valuation-reference-ui-2026-10-31/screenshots',{recursive:true});
 });
 afterAll(async()=>{await browser?.close();});
 it.each(['light','dark'] as const)('keeps independent results and budget states readable on desktop/mobile in %s',async theme=>{
  for(const width of [1440,390]){
   const context=await browser.newContext({viewport:{width,height:1000}});
   try{
    await context.addInitScript(t=>localStorage.setItem('fitgrid-theme',t),theme);
    const page=await context.newPage(),errors:string[]=[],writes:string[]=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(['POST','PUT','PATCH','DELETE'].includes(r.method()))writes.push(r.url());});
    await page.goto(`${baseUrl}/grids/demo-grid-05/valuation`);
    const budget=page.getByLabel('最大投资本金（CNY）',{exact:true});await budget.waitFor();
    expect(await page.getByRole('button',{name:'计算PE参考参数',exact:true}).isDisabled()).toBe(true);
    await budget.fill('100000');
    for(const metric of ['PE','PB','股息率']){
     const panel=page.getByRole('complementary',{name:metric+'参考方案',exact:true});
     await panel.getByRole('button',{name:`计算${metric}参考参数`,exact:true}).click();await panel.getByText('实际首笔金额',{exact:true}).waitFor();
    }
    const pe=page.getByRole('complementary',{name:'PE参考方案',exact:true});await pe.getByText('查看完整参数与下跌情景',{exact:true}).click();
    expect(await pe.getByText('实际最低买价',{exact:true}).count()).toBe(1);
    expect(await pe.getByText(/下跌 80%/).count()).toBe(1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.addStyleTag({content:'nextjs-portal { display: none !important; }'});
    await page.screenshot({path:`output/valuation-reference-ui-2026-10-31/screenshots/reference-${theme}-${width}.png`,fullPage:true});
    await budget.fill('50000');expect(await page.getByText('实际首笔金额',{exact:true}).count()).toBe(0);
    await pe.getByRole('button',{name:'计算PE参考参数',exact:true}).click();await pe.getByText('实际首笔金额',{exact:true}).waitFor();
    await page.getByRole('button',{name:'刷新数据',exact:true}).click();await page.getByRole('button',{name:'刷新数据',exact:true}).waitFor();
    expect(await page.getByText('实际首笔金额',{exact:true}).count()).toBe(0);
    await budget.fill('1');await pe.getByRole('button',{name:'计算PE参考参数',exact:true}).click();await pe.getByRole('alert').waitFor();
    await page.goto(`${baseUrl}/grids/demo-reit-508000/valuation`);
    await page.getByRole('complementary',{name:'现金分派率参考方案',exact:true}).waitFor();
    expect(await page.getByRole('complementary',{name:'PE参考方案',exact:true}).count()).toBe(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);expect(writes).toEqual([]);
   }finally{await context.close();}
  }
 },60000);
});
