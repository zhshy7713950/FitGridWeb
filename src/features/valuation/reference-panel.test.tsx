// @vitest-environment jsdom
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,describe,expect,it} from 'vitest';
import {demoValuation} from './demo-valuation-data';
import {ReferencePanel} from './reference-panel';

afterEach(cleanup);
const options={budget:'100000',feeRate:'0.03',minimumFee:'5',increase:5};
function props(){const data=demoValuation('grid');return {basis:data.reference!.pe,grid:data.reference!.gridInput,options,currency:'CNY',snapshot:data};}
describe('independent read-only reference panels',()=>{
 it('calculates a fee-aware plan and shows its parameters and stress assumptions without saving',async()=>{
  render(<ReferencePanel {...props()}/>);await userEvent.click(screen.getByRole('button',{name:'计算PE参考参数'}));
  await screen.findByText('实际首笔金额');
  expect(screen.getByText('候选加码')).toBeInTheDocument();expect(screen.getByText('买入费用')).toBeInTheDocument();
  expect(screen.getByText(/未完成3～5年/)).toBeInTheDocument();expect(screen.getByText(/不计未来分红/)).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:/保存|应用|下单/})).not.toBeInTheDocument();
 });
 it('hides old results when budget or fetched data changes',async()=>{
  const p=props(),view=render(<ReferencePanel {...p}/>);await userEvent.click(screen.getByRole('button',{name:'计算PE参考参数'}));await screen.findByText('实际首笔金额');
  view.rerender(<ReferencePanel {...p} options={{...options,budget:'50000'}}/>);expect(screen.queryByText('实际首笔金额')).not.toBeInTheDocument();
  view.rerender(<ReferencePanel {...p} options={{...options}}/>);expect(screen.queryByText('实际首笔金额')).not.toBeInTheDocument();
  view.rerender(<ReferencePanel {...p} options={{...options,budget:'50000'}}/>);
  await userEvent.click(screen.getByRole('button',{name:'计算PE参考参数'}));await screen.findByText('实际首笔金额');
  view.rerender(<ReferencePanel {...p} options={{...options,budget:'50000'}} snapshot={structuredClone(p.snapshot)}/>);expect(screen.queryByText('实际首笔金额')).not.toBeInTheDocument();
 });
 it('reports insufficient budgets without showing an old successful calculation',async()=>{
  const p=props(),view=render(<ReferencePanel {...p}/>);await userEvent.click(screen.getByRole('button',{name:'计算PE参考参数'}));await screen.findByText('实际首笔金额');
  view.rerender(<ReferencePanel {...p} options={{...options,budget:'1'}}/>);await userEvent.click(screen.getByRole('button',{name:'计算PE参考参数'}));
  await screen.findByRole('alert');expect(screen.queryByText('实际首笔金额')).not.toBeInTheDocument();
 });
 it('keeps an explicit missing state and supports old responses without saved inputs',async()=>{
  const p=props();p.basis={...p.basis,status:'unavailable',reason:'最近历史不足',startPrice:null};
  const view=render(<ReferencePanel {...p}/>);expect(screen.getByText('最近历史不足')).toBeInTheDocument();expect(screen.queryByRole('button')).not.toBeInTheDocument();
  view.rerender(<ReferencePanel {...props()} grid={null}/>);expect(screen.getByText(/缺少原网格/)).toBeInTheDocument();
 });
 it('disables calculation until a budget is supplied and preserves USD labelling',async()=>{
  render(<ReferencePanel {...props()} currency="USD" options={{...options,budget:''}}/>);
  await waitFor(()=>expect(screen.getByRole('button',{name:'计算PE参考参数'})).toBeDisabled());expect(screen.getAllByText(/USD/).length).toBeGreaterThan(0);
 });
});
