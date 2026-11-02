import assert from 'node:assert/strict';
import * as followup from './weekly_followup.js';
import {getRolloverCalendar,registerRolloverSchedule} from '../../src/engine/RolloverSpreadGate.js';
assert.equal(typeof (followup as any).calendarAllowsMissingM5,'function','followup must recognize verified broker closures, not stay pending each weekend');
const allow=(followup as any).calendarAllowsMissingM5;
// Explicit synthetic Monday-Friday 09:00-17:00 UTC broker schedule.
const calendar={scheduleTimeZone:'UTC',schedule:Array.from({length:5},(_,i)=>({startSecond:(i+1)*86400+9*3600,endSecond:(i+1)*86400+17*3600}))};
const ms=(s:string)=>Date.parse(s);
const probe=ms('2026-10-26T12:00:00Z'),special='__WEEKLY_FOLLOWUP_CALENDAR__';
assert.equal(getRolloverCalendar(special,probe).metadataAvailable,false);
allow(calendar,probe,probe+300000);
assert.equal(getRolloverCalendar(special,probe).metadataAvailable,false,'coverage probe must not leave a new global schedule behind');
registerRolloverSchedule(special,{scheduleTimeZone:'UTC',schedule:[{startSecond:0,endSecond:604800}]});
const prior=getRolloverCalendar(special,probe);
allow(calendar,probe,probe+300000);
assert.deepEqual(getRolloverCalendar(special,probe),prior,'coverage probe must not overwrite a prior calendar');
allow({...calendar,scheduleTimeZone:'invalid'},probe,probe+300000);
assert.deepEqual(getRolloverCalendar(special,probe),prior,'invalid metadata must not delete a prior calendar');
assert.equal(allow(calendar,ms('2026-10-23T17:00:00Z'),ms('2026-10-26T09:00:00Z')),true,'weekend closure is not missing market data');
assert.equal(allow(calendar,ms('2026-10-26T17:00:00Z'),ms('2026-10-27T09:00:00Z')),true,'overnight index closure is allowed');
assert.equal(allow(calendar,ms('2026-10-26T12:00:00Z'),ms('2026-10-26T12:10:00Z')),false,'missing prices during trading hours cannot be excused');
assert.equal(allow(undefined,ms('2026-10-23T17:00:00Z'),ms('2026-10-26T09:00:00Z')),false,'no invented fallback calendar');
assert.equal(allow({...calendar,scheduleTimeZone:'invalid'},1,1000000),false);
// Closure checks must agree with the real broker wall-time conversion even in
// ambiguous/repeated DST hours, not merely compare local seconds-of-week.
for(const schedule of [[{startSecond:5400,endSecond:10800}],[{startSecond:0,endSecond:5400}]]){
 const dst={scheduleTimeZone:'America/New_York',schedule};
 registerRolloverSchedule('FOLLOWUP-DST-ORACLE',dst);
 for(const stamp of ['2026-11-01T05:15:00Z','2026-11-01T05:45:00Z','2026-11-01T06:15:00Z','2026-11-01T06:45:00Z']){
  const t=ms(stamp);
  assert.equal(allow(dst,t,t+1),!getRolloverCalendar('FOLLOWUP-DST-ORACLE',t).marketOpen,`real calendar DST parity ${stamp} ${JSON.stringify(schedule)}`);
 }
}
console.log('PASS: pure calendar probes, preserved registrations, weekend/overnight/DST parity and strict missing-data rejection');
