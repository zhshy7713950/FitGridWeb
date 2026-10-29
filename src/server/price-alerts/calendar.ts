import type { Market, ScanWindow } from "./types";

export const ZONES = { cn: "Asia/Shanghai", us: "America/New_York" } as const;
export const CALENDAR_SOURCES = ["https://www.sse.com.cn/disclosure/dealinstruc/closed/", "https://www.szse.cn/disclosure/notice/general/t20251222_618087.html", "https://www.nyse.com/trade/hours-calendars"];
const cnClosed = new Set("01-01 01-02 02-16 02-17 02-18 02-19 02-20 02-23 04-06 05-01 05-04 05-05 06-19 09-25 10-01 10-02 10-05 10-06 10-07".split(" "));
const usClosed: Record<string, Set<string>> = {
  "2026": new Set("01-01 01-19 02-16 04-03 05-25 06-19 07-03 09-07 11-26 12-25".split(" ")),
  "2027": new Set("01-01 01-18 02-15 03-26 05-31 06-18 07-05 09-06 11-25 12-24".split(" ")),
  "2028": new Set("01-17 02-21 04-14 05-29 06-19 07-04 09-04 11-23 12-25".split(" ")),
};
const usEarly = new Set(["2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"]);
const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(time: number, zone: string) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }));
  return Object.fromEntries(formatters.get(zone)!.formatToParts(time).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
}
export function dateInZone(time: number, zone: string) { const p = parts(time, zone); return `${p.year}-${p.month}-${p.day}`; }
export function localTimeUtc(date: string, clock: string, zone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(clock)) throw new Error("行情时间格式异常");
  const wall = Date.parse(`${date}T${clock}:00Z`);
  if (!Number.isFinite(wall)) throw new Error("行情时间格式异常");
  let value = wall;
  for (let i = 0; i < 3; i++) {
    const p = parts(value, zone);
    value += wall - Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  }
  const p = parts(value, zone);
  if (`${p.year}-${p.month}-${p.day}` !== date || `${p.hour}:${p.minute}` !== clock) throw new Error("行情时间异常");
  return value;
}
export function segments(market: Market, date: string) {
  if (market === "cn" ? !/^2026-\d\d-\d\d$/.test(date) : !usClosed[date.slice(0, 4)]) throw new Error("交易日历尚未覆盖该年份");
  const day = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) throw new Error("交易日期异常");
  if ([0, 6].includes(day.getUTCDay()) || (market === "cn" ? cnClosed : usClosed[date.slice(0, 4)]).has(date.slice(5))) return [];
  const times = market === "cn" ? [["09:30", "11:30"], ["13:00", "15:00"]] : [["09:30", usEarly.has(date) ? "13:00" : "16:00"]];
  return times.map(([from, to]) => ({ start: localTimeUtc(date, from, ZONES[market]), end: localTimeUtc(date, to, ZONES[market]) }));
}
export function calendarWarning(market: Market, now: Date): string | null {
  const last = Date.parse(`${market === "cn" ? "2026" : "2028"}-12-31T23:59:59Z`);
  return last - now.getTime() <= 30 * 86400000 ? "交易日历即将到期或已到期，请更新后继续监控" : null;
}
export function nextScanAt(market: Market, now: number): number | null {
  const date = dateInZone(now, ZONES[market]);
  for (let offset = 0; offset < 23; offset++) {
    const day = new Date(Date.parse(`${date}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
    let sessions: ReturnType<typeof segments>;
    try { sessions = segments(market, day); } catch { return null; }
    for (const session of sessions) {
      for (let end = session.start + 600000; end <= session.end; end += 600000) {
        const runAt = end + (end === session.end ? 30000 : 15000);
        if (runAt > now) return runAt;
      }
    }
  }
  return null;
}
export function dueWindows(market: Market, now: number): ScanWindow[] {
  const sessionDate = dateInZone(now, ZONES[market]);
  return segments(market, sessionDate).flatMap((s): ScanWindow[] => {
    if (now < s.start || now >= s.end + 60000) return [];
    const closing = now >= s.end;
    if (closing && now < s.end + 30000) return [];
    const end = closing ? s.end : s.start + Math.floor((now - s.start - 15000) / 600000) * 600000;
    if (end <= s.start || end >= s.end && !closing) return [];
    const runAt = end + (closing ? 30000 : 15000);
    return [{ market, sessionDate, segmentStart: s.start, segmentEnd: s.end, start: end - 600000, end, runAt,
      deadline: closing ? s.end + 60000 : Math.min(s.end, now + 120000), kind: closing ? "closing" : "intraday" }];
  });
}
