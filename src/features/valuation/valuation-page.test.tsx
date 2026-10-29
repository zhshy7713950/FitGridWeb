// @vitest-environment jsdom
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
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
