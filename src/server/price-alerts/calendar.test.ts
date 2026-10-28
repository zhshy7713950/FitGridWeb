import { describe, expect, it } from "vitest";
import { calendarWarning, dueWindows, nextScanAt, segments } from "./calendar";

describe("exchange calendar scheduling", () => {
  it("skips CN holidays/weekends and refuses an uncovered year", () => {
    expect(segments("cn", "2026-10-01")).toEqual([]);
    expect(segments("cn", "2026-10-24")).toEqual([]);
    expect(() => segments("cn", "2027-01-04")).toThrow(/日历/);
    expect(calendarWarning("cn", new Date("2026-12-10T00:00:00Z"))).toContain("日历");
  });
  it("normalizes US daylight savings and published early closes", () => {
    expect(new Date(segments("us", "2026-03-06")[0].start).toISOString()).toBe("2026-03-06T14:30:00.000Z");
    expect(new Date(segments("us", "2026-03-09")[0].start).toISOString()).toBe("2026-03-09T13:30:00.000Z");
    expect(new Date(segments("us", "2026-11-27")[0].end).toISOString()).toBe("2026-11-27T18:00:00.000Z");
  });
  it("returns ten-minute windows after 15s and replaces the final poll with +30s cleanup", () => {
    expect(dueWindows("cn", Date.parse("2026-10-27T01:40:14Z"))).toEqual([]);
    const jobs = dueWindows("cn", Date.parse("2026-10-27T01:40:15Z"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ start: Date.parse("2026-10-27T01:30:00Z"), end: Date.parse("2026-10-27T01:40:00Z"), kind: "intraday" });
    expect(dueWindows("cn", Date.parse("2026-10-27T03:30:15Z"))).toEqual([]);
    expect(dueWindows("cn", Date.parse("2026-10-27T03:30:30Z"))[0].kind).toBe("closing");
    expect(dueWindows("cn", Date.parse("2026-10-27T03:31:00Z"))).toEqual([]);
    expect(dueWindows("cn", Date.parse("2026-10-27T04:00:00Z"))).toEqual([]);
  });
  it("reports the next cleanup or afternoon check instead of losing it near lunch", () => {
    expect(new Date(nextScanAt("cn", Date.parse("2026-10-27T03:25:00Z"))!).toISOString()).toBe("2026-10-27T03:30:30.000Z");
    expect(new Date(nextScanAt("cn", Date.parse("2026-10-27T03:31:00Z"))!).toISOString()).toBe("2026-10-27T05:10:15.000Z");
    expect(nextScanAt("cn", Date.parse("2027-01-04T00:00:00Z"))).toBeNull();
  });
});
