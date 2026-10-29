import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const light = css.match(/:root \{([^}]+)\}/)![1];
const dark = css.match(/:root\[data-theme="dark"\] \{([^}]+)\}/)![1];

function color(block: string, name: string): number[] {
  const value = block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, "i"))?.[1];
  if (!value) throw new Error(`Missing ${name} color`);
  return [1, 3, 5].map(index => Number.parseInt(value.slice(index, index + 2), 16) / 255);
}

function mix(a: number[], b: number[], fraction: number): number[] {
  return a.map((value, index) => value * fraction + b[index] * (1 - fraction));
}

function contrast(a: number[], b: number[]): number {
  function luminance(rgb: number[]): number {
    return rgb.reduce((sum, value, index) => sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index], 0);
  }
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1] + 0.05) / (values[0] + 0.05);
}

describe("small theme text contrast", () => {
  it("keeps dark action text readable on surfaces and navigation tint", () => {
    const text = color(dark, "action-text");
    for (const background of ["surface", "action-tint"]) {
      expect(contrast(text, color(dark, background)), background).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["grid-medium", "grid-large"])("keeps light %s labels readable in normal, hover and selected rows", (token) => {
    const text = color(light, token);
    const surface = color(light, "surface");
    for (const tint of [0.12, 0.18, 0.22]) {
      expect(contrast(text, mix(text, surface, tint)), `row tint ${tint}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(text, mix(color(light, "action"), surface, 0.26)), "selected blue row").toBeGreaterThanOrEqual(4.5);
  });
});
