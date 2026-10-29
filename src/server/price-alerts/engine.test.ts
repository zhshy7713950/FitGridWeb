import { describe, expect, it } from "vitest";
import { evaluateBars, ruleSchema, triggerThreshold } from "./engine";
import type { MinuteBar } from "./types";

const start = Date.parse("2026-10-27T02:00:00Z");
const bar = (offset: number, high: string, close: string, low = "90"): MinuteBar => ({
  start: start + offset * 60000, end: start + (offset + 1) * 60000,
  open: low, high, low, close,
});
const condition = { kind: "price" as const, direction: "up" as const, targetPrice: "100" };
const state = { armed: true, cursor: null, activeFrom: start };

describe("minute alert engine", () => {
  it("accepts 500-day rules and rejects 501 while preserving dynamic MA arithmetic", () => {
    expect(ruleSchema.safeParse({ kind: "ma_touch", direction: "up", days: 500 }).success).toBe(true);
    expect(ruleSchema.safeParse({ kind: "ma_touch", direction: "up", days: 501 }).success).toBe(false);
    expect(triggerThreshold({ kind: "ma_touch", direction: "up", days: 500 }, "49900").toString()).toBe("100");
  });

  it("records an equality touch even when close retreats and rearms only for next minute", () => {
    const result = evaluateBars(condition, state, [bar(0, "100", "99"), bar(1, "101", "100")]);
    expect(result.events.map((e) => e.minuteStart)).toEqual([start, start + 60000]);
    expect(result.state.armed).toBe(false);
  });
  it("does not repeat while satisfied and confirms leaving by close", () => {
    const result = evaluateBars(condition, state, [bar(0, "102", "101"), bar(1, "104", "100"), bar(2, "103", "99"), bar(3, "101", "100")]);
    expect(result.events).toHaveLength(2);
    expect(result.events[1].minuteStart).toBe(start + 180000);
  });
  it("rejects preactivation and already processed minutes without resetting a latch across gaps", () => {
    const result = evaluateBars(condition, { armed: false, cursor: start + 60000, activeFrom: start + 30000 }, [bar(0, "110", "105"), bar(4, "110", "105")]);
    expect(result.events).toEqual([]);
    expect(result.state.cursor).toBe(start + 300000);
    expect(result.state.armed).toBe(false);
  });
  it("calculates candidate-dependent MA thresholds rather than a close-only MA", () => {
    const rule = { kind: "ma_deviation" as const, direction: "up" as const, days: 3, percent: "10" };
    // S=200, threshold=220/1.9 = 115.78947..., not fixed-MA 110.
    expect(triggerThreshold(rule, "200").toFixed(5)).toBe("115.78947");
    expect(evaluateBars(rule, state, [bar(0, "115", "100")], "200").events).toHaveLength(0);
    expect(evaluateBars(rule, state, [bar(0, "116", "100")], "200").events).toHaveLength(1);
  });
  it("supports both MA touch directions and percentage below with equality", () => {
    const rule = { kind: "ma_touch" as const, direction: "down" as const, days: 3 };
    expect(evaluateBars(rule, state, [bar(0, "110", "105", "100")], "200").events).toHaveLength(1);
    expect(triggerThreshold({ kind: "ma_deviation", direction: "down", days: 3, percent: "10" }, "200").toFixed(5)).toBe("85.71429");
  });
  it("preserves ten fractional digits alongside the maximum supported integer precision", () => {
    const rule = { kind: "ma_touch" as const, direction: "up" as const, days: 3 };
    expect(triggerThreshold(rule, "199999999999999999998.0000000002").toFixed(10)).toBe("99999999999999999999.0000000001");
  });
  it("rejects inappropriate fields, invalid percentages and insufficient daily history", () => {
    expect(ruleSchema.safeParse({ ...condition, days: 20 }).success).toBe(false);
    expect(ruleSchema.safeParse({ kind: "ma_touch", direction: "up", days: 1 }).success).toBe(false);
    expect(ruleSchema.safeParse({ kind: "ma_deviation", direction: "down", days: 20, percent: "100" }).success).toBe(false);
    expect(() => evaluateBars({ kind: "ma_touch", direction: "up", days: 20 }, state, [bar(0, "100", "100")])).toThrow(/均线/);
  });
});
