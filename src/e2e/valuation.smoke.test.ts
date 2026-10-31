import {existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {chromium,type Browser} from 'playwright-core';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';

// Run against a local dev:ui server to keep this suite independent of the
// server lifecycle used by ui-demo.smoke.test.ts (and its Next.js build lock).
const baseUrl=process.env.FITGRID_VALUATION_E2E_URL;
describe.skipIf(!baseUrl)('valuation browser acceptance',()=>{
 let browser:Browser;
 beforeAll(async()=>{
  const executablePath=[process.env.FITGRID_CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
  if(!executablePath)throw new Error('Set FITGRID_CHROME_PATH to run valuation browser acceptance');
  browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  await mkdir('output/dividend-yield-2026-10-31/screenshots',{recursive:true});
 });
 afterAll(async()=>{await browser?.close();});
 it.each(['light','dark'] as const)('renders desktop and mobile charts in the %s theme',async theme=>{
  for(const width of [1440,390]){
   const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390});
   try{
    await context.addInitScript(t=>localStorage.setItem('fitgrid-theme',t),theme);
    const page=await context.newPage();const errors:string[]=[],requests:string[]=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(!new URL(r.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))requests.push(r.url());});
    await page.goto(`${baseUrl}/grids/demo-grid-05/valuation`);
    await page.getByRole('heading',{name:'PE走势',exact:true}).waitFor();
    expect(await page.getByRole('img',{name:/历史图$/}).count()).toBe(4);
    expect(await page.getByText('50分位值（中位数）',{exact:true}).count()).toBe(3);
    expect(await page.locator('line[aria-label="P50（中位数）"]').count()).toBe(3);
    const yieldCard=page.getByRole('region',{name:'股息率走势（对应指数）'});
    expect(await yieldCard.getByText('当前股息率',{exact:true}).locator('..').textContent()).toMatch(/\d+\.\d{2}%/);
    for(const label of ['30分位值','50分位值（中位数）','70分位值'])expect(await yieldCard.getByText(label,{exact:true}).locator('..').textContent()).toMatch(/\d+\.\d{2}%/);
    const yieldChart=page.getByRole('group',{name:/股息率走势.*方向键/});await yieldChart.focus();await page.keyboard.press('End');expect(await yieldChart.textContent()).toMatch(/2026-10-28.*%/);
    expect(await page.locator('html').getAttribute('data-theme')).toBe(theme);
    const chart=page.getByRole('group',{name:/价格走势历史图/});await chart.focus();await page.keyboard.press('End');
    expect(await chart.textContent()).toContain('2026-10-28');
    if(width===390){const svg=page.getByRole('img',{name:'价格走势历史图'});await svg.tap({position:{x:70,y:100}});expect(await chart.textContent()).not.toContain('移动指针');}
    await page.getByRole('button',{name:'刷新数据'}).click();await page.getByRole('button',{name:'刷新数据'}).waitFor();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.addStyleTag({content:'nextjs-portal { display: none !important; }'});
    await page.screenshot({path:`output/dividend-yield-2026-10-31/screenshots/valuation-${theme}-${width}.png`,fullPage:true});
    await page.getByRole('link',{name:'← 返回产品详情'}).click();
    await page.getByRole('heading',{name:'红利 ETF',exact:true}).waitFor();
    if(width===390)await page.getByRole('button',{name:'更多操作',exact:true}).click();
    await page.getByRole('link',{name:'查看估值',exact:true}).filter({visible:true}).click();
    await page.getByRole('heading',{name:'PE走势',exact:true}).waitFor();
    expect(new URL(page.url()).pathname).toBe(`${new URL(baseUrl!).pathname.replace(/\/$/,'')}/grids/demo-grid-05/valuation`);
    expect(errors).toEqual([]);expect(requests).toEqual([]);
   }finally{await context.close();}
  }
 },60000);
 it.each(['light','dark'] as const)('shows REIT yield and alert boundaries on desktop/mobile in %s',async theme=>{
  for(const width of [1440,390]){
   const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390});
   try{
    await context.addInitScript(t=>localStorage.setItem('fitgrid-theme',t),theme);
    const page=await context.newPage(),errors:string[]=[],external:string[]=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!/^(127\.0\.0\.1|localhost)$/.test(new URL(r.url()).hostname))external.push(r.url());});
    await page.goto(`${baseUrl}/grids/demo-reit-508000/valuation`);
    const card=page.getByRole('region',{name:'股息率（近12个月现金分派率）'});await card.waitFor();
    expect(await page.getByRole('img',{name:/历史图$/}).count()).toBe(2);expect(await page.getByRole('heading',{name:'PE走势',exact:true}).count()).toBe(0);expect(await page.getByRole('heading',{name:'PB走势',exact:true}).count()).toBe(0);
    expect(await card.getByText('当前分派率',{exact:true}).locator('..').textContent()).toMatch(/\d+\.\d{2}%/);
    const chart=page.getByRole('group',{name:/股息率.*方向键/});await chart.focus();await page.keyboard.press('End');expect(await chart.textContent()).toMatch(/2026-10-28.*%/);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.addStyleTag({content:'nextjs-portal { display: none !important; }'});await page.screenshot({path:`output/dividend-yield-2026-10-31/screenshots/reit-${theme}-${width}.png`,fullPage:true});
    await page.goto(`${baseUrl}/price-alerts/demo-alert-3`);const condition=page.getByRole('group',{name:'提醒条件'});await condition.waitFor();expect(await condition.textContent()).toContain('触发价 ¥4.211');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.addStyleTag({content:'nextjs-portal { display: none !important; }'});await page.screenshot({path:`output/dividend-yield-2026-10-31/screenshots/alert-${theme}-${width}.png`,fullPage:true});
    expect(errors).toEqual([]);expect(external).toEqual([]);
   }finally{await context.close();}
  }
 },60000);

});
