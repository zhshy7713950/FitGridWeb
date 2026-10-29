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
  await mkdir('output/etf-valuation-observation-2026-10-29/screenshots',{recursive:true});
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
    expect(await page.getByRole('img',{name:/历史图$/}).count()).toBe(3);
    expect(await page.locator('html').getAttribute('data-theme')).toBe(theme);
    const chart=page.getByRole('group',{name:/价格走势历史图/});await chart.focus();await page.keyboard.press('End');
    expect(await chart.textContent()).toContain('2026-10-28');
    if(width===390){const svg=page.getByRole('img',{name:'价格走势历史图'});await svg.tap({position:{x:70,y:100}});expect(await chart.textContent()).not.toContain('移动指针');}
    await page.getByRole('button',{name:'刷新数据'}).click();await page.getByRole('button',{name:'刷新数据'}).waitFor();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.addStyleTag({content:'nextjs-portal { display: none !important; }'});
    await page.screenshot({path:`output/etf-valuation-observation-2026-10-29/screenshots/${theme}-${width}.png`,fullPage:true});
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
});
