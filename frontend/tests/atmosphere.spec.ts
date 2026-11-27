import { describe, expect, it } from "vitest";
import { lightingAt, rainyDay, type VillageLighting } from "../src/game/world/atmosphere";

const at = (hour: number, minute = 0, day = 2) =>
  new Date(2026, 3, day, hour, minute, 0);

function expectAlphaInRange(lighting: VillageLighting) {
  for (const value of [
    lighting.shadeAlpha,
    lighting.glowAlpha,
    lighting.dustAlpha,
    lighting.fireflyAlpha,
  ]) {
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  }
}

describe("town lighting", () => {
  it("keeps noon clear, bright and free of night lights", () => {
    const lighting = lightingAt(at(12));
    expect(lighting.shadeAlpha).toBe(0);
    expect(lighting.glowAlpha).toBe(0);
    expect(lighting.fireflyAlpha).toBe(0);
    expect(lighting.dustAlpha).toBeGreaterThan(0);
    expectAlphaInRange(lighting);
  });

  it("turns on the night grade, lamps and fireflies after 20:00", () => {
    const lighting = lightingAt(at(22));
    expect(lighting.shadeAlpha).toBeGreaterThan(0.25);
    expect(lighting.glowAlpha).toBeGreaterThan(0.7);
    expect(lighting.fireflyAlpha).toBeGreaterThan(0.4);
    expect(lighting.dustAlpha).toBe(0);
    expectAlphaInRange(lighting);
  });

  it("interpolates dawn and dusk instead of jumping between states", () => {
    const dawn = lightingAt(at(6, 30));
    expect(dawn.shadeAlpha).toBeGreaterThan(0);
    expect(dawn.shadeAlpha).toBeLessThan(0.25);
    expect(dawn.glowAlpha).toBeGreaterThan(0);
    expect(dawn.glowAlpha).toBeLessThan(1);

    const beforeDusk = lightingAt(at(19, 59));
    const afterDusk = lightingAt(at(20, 1));
    expect(Math.abs(beforeDusk.shadeAlpha - afterDusk.shadeAlpha)).toBeLessThan(0.02);
    expectAlphaInRange(dawn);
    expectAlphaInRange(beforeDusk);
    expectAlphaInRange(afterDusk);
  });

  it("uses a warm indoor grade at night and hides outdoor lights", () => {
    const lighting = lightingAt(at(22), { indoor: true });
    expect(lighting.shadeAlpha).toBeLessThan(0.1);
    expect(lighting.glowAlpha).toBe(0);
    expect(lighting.fireflyAlpha).toBe(0);
    expectAlphaInRange(lighting);
  });

  it("darkens the grade on rainy days without flooding the town", () => {
    const clear = lightingAt(at(12));
    const rainy = lightingAt(at(12), { rain: true });
    expect(rainy.shadeAlpha).toBeGreaterThan(clear.shadeAlpha);
    expect(rainy.shadeAlpha).toBeLessThan(0.1);
    expect(rainy.shadeColor).not.toBe(clear.shadeColor);
    expect(rainy.glowAlpha).toBeLessThanOrEqual(clear.glowAlpha);
    expectAlphaInRange(rainy);

    const indoorRain = lightingAt(at(22), { indoor: true, rain: true });
    expect(indoorRain.glowAlpha).toBe(0);
    expectAlphaInRange(indoorRain);
  });

  it("stays within bounds for every hour of the day and is stable across calls", () => {
    for (let hour = 0; hour < 24; hour++) {
      const lighting = lightingAt(at(hour));
      expectAlphaInRange(lighting);
      expect(lightingAt(at(hour))).toEqual(lighting);
    }
  });
});

describe("town weather", () => {
  it("keeps one stable 1-in-3 rain calendar without repeating within the day", () => {
    const rainy = new Date(2026, 3, 3, 9, 0, 0);
    expect(rainyDay(rainy)).toBe(true);
    expect(rainyDay(new Date(2026, 3, 3, 21, 0, 0))).toBe(true);
    expect(rainyDay(new Date(2026, 3, 2, 12, 0, 0))).toBe(false);
    expect(rainyDay(new Date(2026, 3, 4, 12, 0, 0))).toBe(false);
  });
});
