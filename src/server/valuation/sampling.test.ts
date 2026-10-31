import {describe,expect,it} from 'vitest';
import {weeklyObservations} from './sampling';
describe('weekly observation sampling',()=>{
 it('shares a Monday-based period across calendar years and keeps the latest missing value',()=>{
  expect(weeklyObservations([{date:'2025-12-29',value:'2',quality:'valid'},{date:'2026-01-02',value:'3',quality:'valid'},{date:'2026-01-04',value:null,quality:'missing'},{date:'2026-01-05',value:'4',quality:'valid'}])).toEqual([{date:'2026-01-04',value:null,quality:'missing'},{date:'2026-01-05',value:'4',quality:'valid'}]);
 });
});
