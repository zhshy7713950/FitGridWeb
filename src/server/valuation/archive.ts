import histories from './archive-data.json';
import yieldHistories from './yield-archive-data.json';
import type {Observation} from './types';
/** Verified public research captures; per-source cutoffs are recorded in manifests, never described as live data. */
export function archivedObservations(key:string):Observation[] {
  return ((histories as Record<string,Observation[]>)[key]??(yieldHistories as Record<string,Observation[]>)[key]??[]).map(row=>({...row}));
}
