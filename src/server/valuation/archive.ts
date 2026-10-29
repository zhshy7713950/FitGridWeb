import histories from './archive-data.json';
import type {Observation} from './types';
/** Verified public research captures, cutoff 2026-10-27; these are never described as live data. */
export function archivedObservations(key:string):Observation[] {
  return ((histories as Record<string,Observation[]>)[key]??[]).map(row=>({...row}));
}
