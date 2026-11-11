// @vitest-environment jsdom
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const api=vi.hoisted(()=>({search:vi.fn(),resolve:vi.fn()}));
vi.mock('@/features/price-alerts/price-alert-api',()=>({alertApi:api}));
import {ProductPicker} from './product-picker';
const candidate={code:'QQQ.US',name:'Invesco QQQ Trust',market:'us',currency:'USD',kind:'etf',exchange:'NASDAQ'};
const instrument={...candidate,id:'00000000-0000-4000-8000-000000000001',yahoo:'QQQ',tencent:null,eastmoney:null};
beforeEach(()=>{vi.resetAllMocks();api.search.mockResolvedValue({items:[candidate]});api.resolve.mockResolvedValue(instrument);});
afterEach(cleanup);
describe('grid product selection',()=>{
 it('searches by market and name and returns only a verified instrument',async()=>{
  const select=vi.fn();render(<ProductPicker onSelect={select}/>);
  await userEvent.selectOptions(screen.getByLabelText('交易市场'),'us');
  await userEvent.type(screen.getByLabelText('搜索产品代码或名称'),'QQQ');
  await userEvent.click(screen.getByRole('button',{name:'搜索产品'}));
  await userEvent.click(await screen.findByRole('button',{name:'确认选择 Invesco QQQ Trust QQQ.US'}));
  await waitFor(()=>expect(select).toHaveBeenLastCalledWith(instrument));
  expect(screen.getByText(/已确认/)).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText('交易市场'),'cn');
  expect(select).toHaveBeenLastCalledWith(null);expect(screen.queryByText(/已确认/)).not.toBeInTheDocument();
 });
 it('discards stale results when a query or market changes',async()=>{
  let finish!:(value:unknown)=>void;api.search.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  render(<ProductPicker onSelect={()=>{}}/>);
  await userEvent.type(screen.getByLabelText('搜索产品代码或名称'),'QQQ');
  await userEvent.click(screen.getByRole('button',{name:'搜索产品'}));
  await userEvent.selectOptions(screen.getByLabelText('交易市场'),'us');
  finish({items:[candidate]});
  await waitFor(()=>expect(screen.getByRole('button',{name:'搜索产品'})).not.toBeDisabled());
  expect(screen.queryByRole('button',{name:/确认选择/})).not.toBeInTheDocument();
 });
 it('retains selection errors without treating a search candidate as verified',async()=>{
  api.resolve.mockRejectedValue(new Error('unavailable'));const select=vi.fn();render(<ProductPicker onSelect={select}/>);
  await userEvent.type(screen.getByLabelText('搜索产品代码或名称'),'QQQ');await userEvent.click(screen.getByRole('button',{name:'搜索产品'}));
  await userEvent.click(await screen.findByRole('button',{name:/确认选择/}));
  expect(await screen.findByRole('alert')).toBeInTheDocument();expect(select.mock.calls.every(c=>c[0]===null)).toBe(true);
 });
 it('discards a pending verification after the market changes',async()=>{
  let finish!:(value:unknown)=>void;api.resolve.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const select=vi.fn();render(<ProductPicker onSelect={select}/>);
  await userEvent.selectOptions(screen.getByLabelText('交易市场'),'us');
  await userEvent.type(screen.getByLabelText('搜索产品代码或名称'),'QQQ');
  await userEvent.click(screen.getByRole('button',{name:'搜索产品'}));
  await userEvent.click(await screen.findByRole('button',{name:/确认选择/}));
  await userEvent.selectOptions(screen.getByLabelText('交易市场'),'cn');
  finish(instrument);
  await waitFor(()=>expect(screen.getByRole('button',{name:'搜索产品'})).not.toBeDisabled());
  expect(select).toHaveBeenLastCalledWith(null);expect(screen.queryByText(/已确认/)).not.toBeInTheDocument();
 });
});
