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
 it('shows three independent charts and cached stats without refreshing fresh data',async()=>{
  render(<ValuationPage id="grid"/>);await screen.findByRole('heading',{name:'价格走势'});
  expect(screen.getByRole('heading',{name:'PE走势'})).toBeInTheDocument();expect(screen.getByRole('heading',{name:'PB走势'})).toBeInTheDocument();
  expect(screen.getAllByText('当前分位')).toHaveLength(2);expect(screen.getByText('MA250')).toBeInTheDocument();expect(api.refreshValuation).not.toHaveBeenCalled();
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
  api.getValuation.mockResolvedValue(data);render(<ValuationPage id="grid"/>);await screen.findByText('REIT的PE/PB不适用');expect(screen.queryByText('0%')).not.toBeInTheDocument();
 });
 it('aborts unfinished requests on navigation and does not update the unmounted page',async()=>{
  api.getValuation.mockImplementation((_id,signal)=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')))));
  const view=render(<ValuationPage id="grid"/>);const signal=api.getValuation.mock.calls[0][1] as AbortSignal;view.unmount();expect(signal.aborted).toBe(true);
 });
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
