// @vitest-environment jsdom
import {act,cleanup,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ValuationPage} from './valuation-page';
import {demoValuation} from './demo-valuation-data';
const api=vi.hoisted(()=>({getValuation:vi.fn(),refreshValuation:vi.fn()}));
vi.mock('./valuation-api',()=>api);
afterEach(()=>{cleanup();vi.useRealTimers();});
beforeEach(()=>{vi.clearAllMocks();api.getValuation.mockResolvedValue(demoValuation('grid'));api.refreshValuation.mockResolvedValue(demoValuation('grid'));});
describe('valuation page lifecycle',()=>{
 it('shares an explicit budget across independent panels and only shows a REIT yield scenario',async()=>{
  const user=userEvent.setup(),view=render(<ValuationPage id="grid"/>);await screen.findByRole('heading',{name:'PE走势'});
  expect(screen.getByLabelText('最大投资本金（CNY）')).toHaveValue('');
  expect(screen.getByRole('button',{name:'计算PE参考参数'})).toBeDisabled();
  await user.type(screen.getByLabelText('最大投资本金（CNY）'),'100000');await user.click(screen.getByRole('button',{name:'计算PE参考参数'}));await screen.findByText('实际首笔金额');
  expect(within(screen.getByRole('region',{name:'PB走势'})).queryByText('实际首笔金额')).not.toBeInTheDocument();
  await user.clear(screen.getByLabelText('最大投资本金（CNY）'));expect(screen.queryByText('实际首笔金额')).not.toBeInTheDocument();
  api.getValuation.mockResolvedValue(demoValuation('demo-reit-508000'));view.rerender(<ValuationPage id="demo-reit-508000"/>);
  await screen.findByRole('heading',{name:'股息率（近12个月现金分派率）'});expect(screen.queryByRole('button',{name:'计算PE参考参数'})).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'计算现金分派率参考参数'})).toBeDisabled();
 });
 it('disables manual refresh while another page is collecting and stops polling within 120 seconds',async()=>{
  vi.useFakeTimers();const cached=demoValuation('grid');cached.refresh={busy:true,hasMore:false,retryAfter:3};
  api.getValuation.mockResolvedValue(cached);render(<ValuationPage id="grid"/>);
  await act(async()=>{});
  expect(screen.getByRole('button',{name:'正在更新…'})).toBeDisabled();
  await act(async()=>{for(let i=0;i<40;i++)await vi.advanceTimersByTimeAsync(3000);});
  expect(screen.getByRole('alert')).toHaveTextContent('更新仍在进行');
  const calls=api.getValuation.mock.calls.length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});
  expect(api.getValuation).toHaveBeenCalledTimes(calls);expect(api.refreshValuation).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'刷新数据'})).toBeEnabled();
 });
 it('continues backfill sequentially and sends only one manual request per click',async()=>{
  api.refreshValuation.mockResolvedValueOnce({...demoValuation('grid'),refresh:{busy:false,hasMore:true,retryAfter:null}}).mockResolvedValueOnce(demoValuation('grid'));
  render(<ValuationPage id="grid"/>);await screen.findByRole('heading',{name:'价格走势'});
  await userEvent.click(screen.getByRole('button',{name:'刷新数据'}));
  await waitFor(()=>expect(api.refreshValuation).toHaveBeenCalledTimes(2));
  expect(api.refreshValuation.mock.calls.map(c=>c[1])).toEqual(['manual','due']);
 });
 it('does not automatically retry a failed backfill and retains cached cards',async()=>{
  const cached=demoValuation('grid');cached.refresh.hasMore=true;api.getValuation.mockResolvedValue(cached);
  api.refreshValuation.mockRejectedValue(new Error('来源请求失败'));
  render(<ValuationPage id="grid"/>);await screen.findByRole('alert');
  expect(api.refreshValuation).toHaveBeenCalledTimes(1);expect(screen.getByRole('heading',{name:'价格走势'})).toBeInTheDocument();
 });
 it('shows four independent charts and cached stats without refreshing fresh data',async()=>{
  render(<ValuationPage id="grid"/>);await screen.findByRole('heading',{name:'价格走势'});
  expect(screen.getByRole('heading',{name:'PE走势'})).toBeInTheDocument();expect(screen.getByRole('heading',{name:'PB走势'})).toBeInTheDocument();
  expect(screen.getAllByText('当前分位')).toHaveLength(3);expect(screen.getByText('MA250')).toBeInTheDocument();expect(api.refreshValuation).not.toHaveBeenCalled();
 });
 it('renders cached data before an expired-data refresh resolves',async()=>{
  const cached=demoValuation('grid');cached.pe.due=true;cached.pe.stale=true;cached.refresh.hasMore=true;api.getValuation.mockResolvedValue(cached);
  let done!:(x:ReturnType<typeof demoValuation>)=>void;api.refreshValuation.mockImplementation(()=>new Promise(r=>{done=r;}));
  render(<ValuationPage id="grid"/>);await screen.findByRole('heading',{name:'PE走势'});await waitFor(()=>expect(api.refreshValuation).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button',{name:'正在更新…'})).toBeDisabled();await act(async()=>done(demoValuation('grid')));
 });
 it('retains charts on manual refresh failure and displays request information',async()=>{
  api.refreshValuation.mockRejectedValue(new Error('来源暂不可用'));render(<ValuationPage id="grid"/>);await screen.findByRole('heading',{name:'价格走势'});
  await userEvent.click(screen.getByRole('button',{name:'刷新数据'}));await screen.findByText('来源暂不可用');expect(screen.getByRole('heading',{name:'价格走势'})).toBeInTheDocument();
 });
 it('keeps null data empty and handles unknown/REIT objects without fake zero values',async()=>{
  const data=demoValuation('grid');data.pe.availability='not_applicable';data.pe.points=[];data.pe.stats.currentValue=null;data.pe.stats.currentPercentile=null;data.pe.message='REIT的PE/PB不适用';
  api.getValuation.mockResolvedValue(data);render(<ValuationPage id="grid"/>);await screen.findByText('REIT的PE/PB不适用');expect(within(screen.getByRole('region',{name:'PE走势'})).queryByText('0%')).not.toBeInTheDocument();
 });
 it('aborts unfinished requests on navigation and does not update the unmounted page',async()=>{
  api.getValuation.mockImplementation((_id,signal)=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')))));
  const view=render(<ValuationPage id="grid"/>);const signal=api.getValuation.mock.calls[0][1] as AbortSignal;view.unmount();expect(signal.aborted).toBe(true);
 });
});

it('displays index yield percentages, all three reference lines and values without REIT-specific provenance',async()=>{
 const data=demoValuation('grid');api.getValuation.mockResolvedValue(data);render(<ValuationPage id="grid"/>);
 const card=await screen.findByRole('region',{name:'股息率走势（对应指数）'});
 expect(within(card).getByText('当前股息率').parentElement).toHaveTextContent('%');
 for(const [label,key] of [['30分位值','p30'],['50分位值（中位数）','p50'],['70分位值','p70']] as const)expect(within(card).getByText(label).parentElement).toHaveTextContent(Number(data.dividendYield!.stats[key]).toFixed(2)+'%');
 expect(within(card).getByRole('img').querySelectorAll('line[aria-label]')).toHaveLength(3);
 expect(within(card).queryByText(/近12个月每份分派合计/)).not.toBeInTheDocument();
 expect(within(card).getByText('对应指数股息率 · 非基金分派率')).toBeInTheDocument();
});
it('keeps an unavailable yield chart as an explicit empty state rather than showing zero or hiding PE/PB',async()=>{
 const data=demoValuation('grid');data.dividendYield={...data.pe,availability:'unsupported',points:[],stats:{...data.pe.stats,currentValue:null,p30:null,p50:null,p70:null,min:null,max:null,currentPercentile:null,validCount:0},message:'暂无已核验的股息率历史',trailingDistribution:null,distributionAsOf:null};
 api.getValuation.mockResolvedValue(data);render(<ValuationPage id="grid"/>);const card=await screen.findByRole('region',{name:'股息率走势（对应指数）'});
 expect(within(card).getByText('暂无已核验的股息率历史')).toBeInTheDocument();expect(within(card).queryByText('0.00%')).not.toBeInTheDocument();expect(screen.getByRole('heading',{name:'PE走势'})).toBeInTheDocument();
});

it('displays P50 separately from current percentile on both PE/PB charts',async()=>{
 const data=demoValuation('grid');data.pe.stats.p50='20';data.pb.stats.p50='1.25';api.getValuation.mockResolvedValue(data);
 render(<ValuationPage id="grid"/>);const pe=await screen.findByRole('region',{name:'PE走势'}),pb=screen.getByRole('region',{name:'PB走势'});
 expect(within(pe).getByText('50分位值（中位数）').parentElement).toHaveTextContent('20');expect(within(pb).getByText('50分位值（中位数）').parentElement).toHaveTextContent('1.25');
 expect(within(pe).getByRole('img').querySelector('line[aria-label="P50（中位数）"]')).toBeTruthy();expect(within(pe).getByText('当前分位')).toBeInTheDocument();
});
it('shows REIT price and percentage yield with provenance instead of PE/PB cards',async()=>{
 const data=demoValuation('grid');data.product.kind='reit';data.product.code='508000.SH';data.benchmark=null;
 data.dividendYield={...data.pe,stats:{...data.pe.stats,currentValue:'5',p50:'4.5'},trailingDistribution:'0.1',distributionAsOf:'2026-10-28'};
 api.getValuation.mockResolvedValue(data);render(<ValuationPage id="grid"/>);
 const yieldCard=await screen.findByRole('region',{name:'股息率（近12个月现金分派率）'});
 expect(screen.queryByRole('heading',{name:'PE走势'})).not.toBeInTheDocument();expect(screen.queryByRole('heading',{name:'PB走势'})).not.toBeInTheDocument();
 expect(screen.getByRole('heading',{name:'价格走势'})).toBeInTheDocument();expect(within(yieldCard).getByText('当前分派率').parentElement).toHaveTextContent('5.00%');
 expect(within(yieldCard).getByText(/近12个月每份分派合计/)).toHaveTextContent('0.1 CNY');expect(within(yieldCard).getByText(/分派数据截至/)).toHaveTextContent('2026-10-28');
});
