import type {Observation} from './types';
/** UTC Monday identifies a natural week even across calendar-year boundaries. */
export function weeklyObservations(rows:Observation[]):Observation[]{
 const weeks=new Map<string,Observation>();
 for(const row of rows){
  const day=new Date(`${row.date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate()-(day.getUTCDay()+6)%7);
  const key=day.toISOString().slice(0,10),prior=weeks.get(key);
  if(!prior||row.date>prior.date)weeks.set(key,row);
 }
 return [...weeks.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
