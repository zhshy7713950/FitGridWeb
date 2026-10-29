// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {HistoryChart,sampleForPlot} from './history-chart';
afterEach(cleanup);
const lines=[{key:'value' as const,label:'PE',color:'var(--action-text)'}];
describe('dated history charts',()=>{
 it('inspects the nearest date on a touch pointer press without requiring a drag',()=>{
  vi.stubGlobal('PointerEvent',MouseEvent);
  render(<HistoryChart label="PE历史" points={[{date:'2026-09-30',value:'12'},{date:'2026-10-28',value:'15'}]} lines={lines}/>);
  const svg=screen.getByRole('img',{name:'PE历史'});
  vi.spyOn(svg,'getBoundingClientRect').mockReturnValue({left:0,width:800} as DOMRect);
  fireEvent.pointerDown(svg,{clientX:70,pointerType:'touch'});
  expect(screen.getByText('2026-09-30 · PE 12')).toBeInTheDocument();vi.unstubAllGlobals();
 });
 it('supports a single real point and keyboard inspection',()=>{
  render(<HistoryChart label="PE历史" points={[{date:'2026-09-30',value:'12'}]} lines={lines}/>);
  expect(screen.getByRole('img',{name:'PE历史'}).querySelector('circle')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('group',{name:/PE历史.*方向键/}),{key:'ArrowLeft'});expect(screen.getByText(/2026-09-30.*PE/)).toBeInTheDocument();
 });
 it('breaks lines at missing points and never emits NaN coordinates',()=>{
  const {container}=render(<HistoryChart label="PB历史" points={[{date:'2026-01-31',value:'1'},{date:'2026-02-28',value:null},{date:'2026-03-31',value:'2'}]} lines={lines}/>);
  const path=container.querySelector('path[data-series="value"]')?.getAttribute('d');expect(path?.match(/M/g)).toHaveLength(2);expect(path).not.toContain('NaN');
 });
 it('preserves extremes and source endpoints when sampling only the rendered curve',()=>{
  const points=Array.from({length:5000},(_,i)=>({date:new Date(Date.UTC(2000,0,1+i)).toISOString().slice(0,10),value:String(i===2222?99999:i%10)}));
  const sampled=sampleForPlot(points,lines);expect(sampled.length).toBeLessThan(1500);expect(sampled[0]).toBe(points[0]);expect(sampled.at(-1)).toBe(points.at(-1));expect(sampled).toContain(points[2222]);expect(points).toHaveLength(5000);
 });
});
