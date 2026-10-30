'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import styles from './valuation.module.css';
export interface HistoryPoint {date:string;value:string|null;ma250?:string|null;ma500?:string|null}
type Key='value'|'ma250'|'ma500';
export interface ChartLine {key:Key;label:string;color:string}
interface Reference {label:string;value:string|null;color:string}
function number(v:string|null|undefined){return v!==null&&v!==undefined&&Number.isFinite(Number(v))?Number(v):null;}
export function sampleForPlot(points:HistoryPoint[],lines:ChartLine[]):HistoryPoint[]{
 if(points.length<=1500)return points;
 const size=Math.ceil(points.length/(1400/(2+lines.length*2))),indices=new Set<number>([0,points.length-1]);
 for(let start=0;start<points.length;start+=size){
  const end=Math.min(start+size,points.length);indices.add(start);indices.add(end-1);
  for(const line of lines){let min=-1,max=-1;for(let i=start;i<end;i++){const v=number(points[i][line.key]);if(v===null){if(i===0||number(points[i-1][line.key])!==null||i===points.length-1||number(points[i+1][line.key])!==null)indices.add(i);continue;}
   if(min<0||v<Number(points[min][line.key]))min=i;if(max<0||v>Number(points[max][line.key]))max=i;
  }if(min>=0)indices.add(min);if(max>=0)indices.add(max);}
 }
 return [...indices].sort((a,b)=>a-b).map(i=>points[i]);
}
function format(v:string|null|undefined,unit?:'%'){return number(v)===null?'—':Number(v).toLocaleString('zh-CN',{minimumFractionDigits:unit?2:0,maximumFractionDigits:unit?2:4})+(unit??'');}
export function HistoryChart({label,points,lines,references=[],unit}:{label:string;points:HistoryPoint[];lines:ChartLine[];references?:Reference[];unit?:'%'}){
 const host=useRef<HTMLDivElement>(null),[width,setWidth]=useState(800),[selected,setSelected]=useState<number|null>(null);
 useEffect(()=>{if(!host.current||typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(entries=>setWidth(Math.max(280,Math.round(entries[0].contentRect.width))));observer.observe(host.current);return()=>observer.disconnect();},[]);
 const sampled=useMemo(()=>sampleForPlot(points,lines),[points,lines]);
 const values=useMemo(()=>[...points.flatMap(p=>lines.map(l=>number(p[l.key]))),...references.map(r=>number(r.value))].filter((v):v is number=>v!==null),[points,lines,references]);
 if(!points.length||!values.length)return <div className={styles.empty}>暂无可绘制的历史数据</div>;
 const height=250,left=58,right=width-16,top=18,bottom=217;
 let low=Infinity,high=-Infinity;for(const v of values){low=Math.min(low,v);high=Math.max(high,v);}
 const pad=(high-low)*.1||Math.max(Math.abs(high)*.05,.1);low-=pad;high+=pad;
 const first=Date.parse(points[0].date),last=Date.parse(points.at(-1)!.date);
 const x=(d:string)=>first===last?(left+right)/2:left+(Date.parse(d)-first)/(last-first)*(right-left);
 const y=(v:number)=>bottom-(v-low)/(high-low)*(bottom-top);
 const index=selected===null?null:Math.max(0,Math.min(selected,points.length-1)),active=index===null?null:points[index];
 const showAt=(clientX:number,rect:DOMRect)=>{
  const target=first+(((clientX-rect.left)/rect.width*width-left)/(right-left))*(last-first);
  let a=0,b=points.length-1;while(a<b){const m=Math.floor((a+b)/2);if(Date.parse(points[m].date)<target)a=m+1;else b=m;}
  if(a>0&&Math.abs(Date.parse(points[a-1].date)-target)<Math.abs(Date.parse(points[a].date)-target))a--;setSelected(a);
 };
 return <div ref={host} className={styles.chart} role="group" aria-label={`${label}，使用左右方向键查看日期`} tabIndex={0} onKeyDown={e=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const at=index??points.length-1;
  setSelected(e.key==='Home'?0:e.key==='End'?points.length-1:Math.max(0,Math.min(points.length-1,at+(e.key==='ArrowLeft'?-1:1))));
 }}>
  <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} onPointerDown={e=>showAt(e.clientX,e.currentTarget.getBoundingClientRect())} onPointerMove={e=>showAt(e.clientX,e.currentTarget.getBoundingClientRect())}>
   <title>{label}，{points[0].date}至{points.at(-1)!.date}</title>
   {[0,.25,.5,.75,1].map(t=><g key={t}><line x1={left} x2={right} y1={top+t*(bottom-top)} y2={top+t*(bottom-top)} stroke="var(--line)"/><text x={left-9} y={top+t*(bottom-top)+4} textAnchor="end">{format(String(high-t*(high-low)),unit)}</text></g>)}
   <text x={left} y={242}>{points[0].date}</text>{width>500?<text x={(left+right)/2} y={242} textAnchor="middle">{points[Math.floor(points.length/2)].date}</text>:null}<text x={right} y={242} textAnchor="end">{points.at(-1)!.date}</text>
   {references.filter(r=>number(r.value)!==null).map(r=><line key={r.label} aria-label={r.label} x1={left} x2={right} y1={y(Number(r.value))} y2={y(Number(r.value))} stroke={r.color} strokeDasharray="5 5" opacity=".7"/>)}
   {lines.map(line=>{let connected=false;const d=sampled.map(p=>{const value=number(p[line.key]);if(value===null){connected=false;return ''; }const command=connected?'L':'M';connected=true;return `${command}${x(p.date).toFixed(2)},${y(value).toFixed(2)}`;}).join(' ');
    const single=points.filter(p=>number(p[line.key])!==null);
    return <g key={line.key}><path data-series={line.key} d={d} fill="none" stroke={line.color} strokeWidth="1.8" vectorEffect="non-scaling-stroke"/>{single.length===1?<circle cx={x(single[0].date)} cy={y(Number(single[0][line.key]))} r="3" fill={line.color}/>:null}</g>;
   })}
   {active?<line x1={x(active.date)} x2={x(active.date)} y1={top} y2={bottom} stroke="var(--text-muted)" strokeDasharray="3 3"/>:null}
  </svg>
  <div className={styles.chartReadout} aria-live="polite">{active?`${active.date} · ${lines.map(l=>`${l.label} ${format(active[l.key],unit)}`).join(' · ')}`:'移动指针、触摸图表或使用左右方向键查看历史值'}</div>
  <div className={styles.legend}>{lines.map(l=><span key={l.key}><i style={{background:l.color}}/>{l.label}</span>)}{references.map(r=><span key={r.label}><i style={{background:r.color}}/>{r.label}</span>)}</div>
 </div>;
}
