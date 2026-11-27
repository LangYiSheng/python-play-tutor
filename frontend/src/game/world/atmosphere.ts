/**
 * Pure day/night and weather math for the pixel town.
 *
 * Kept free of Phaser and Vue so the lighting stays testable and the scene only
 * reads a small value object once per second instead of recomputing per frame.
 */

export interface VillageLighting {
  /** Colour of the full-map MULTIPLY shade. */
  shadeColor: number;
  /** 0 means no tint; the night cap keeps the town readable. */
  shadeAlpha: number;
  /** Opacity multiplier for the lamp and torch glows. */
  glowAlpha: number;
  /** Opacity of the drifting dust motes during the day. */
  dustAlpha: number;
  /** Opacity of the fireflies at night. */
  fireflyAlpha: number;
}

interface LightingKey extends VillageLighting {
  /** Local hour, fractional. */
  hour: number;
}

const NIGHT: VillageLighting = {
  shadeColor: 0x17233d,
  shadeAlpha: 0.38,
  glowAlpha: 1,
  dustAlpha: 0,
  fireflyAlpha: 0.55,
};
const DAWN: VillageLighting = {
  shadeColor: 0x6a4630,
  shadeAlpha: 0.16,
  glowAlpha: 0.55,
  dustAlpha: 0.08,
  fireflyAlpha: 0.15,
};
const DAY: VillageLighting = {
  shadeColor: 0x17233d,
  shadeAlpha: 0,
  glowAlpha: 0,
  dustAlpha: 0.12,
  fireflyAlpha: 0,
};
const DUSK: VillageLighting = {
  shadeColor: 0x6b3c24,
  shadeAlpha: 0.16,
  glowAlpha: 0.5,
  dustAlpha: 0.05,
  fireflyAlpha: 0.25,
};
const INDOOR: VillageLighting = {
  shadeColor: 0x3a2b1f,
  shadeAlpha: 0.06,
  glowAlpha: 0,
  dustAlpha: 0.05,
  fireflyAlpha: 0,
};
const RAIN_TINT = 0x2f3d46;
const INDOOR_RAIN_TINT = 0x2e2a26;

/** Keyframes are local wall-clock hours; values between them are interpolated. */
const KEYS: LightingKey[] = [
  { hour: 0, ...NIGHT },
  { hour: 5, ...NIGHT },
  { hour: 6.5, ...DAWN },
  { hour: 8, ...DAY },
  { hour: 16.5, ...DAY },
  { hour: 18.5, ...DUSK },
  { hour: 20, ...NIGHT },
  { hour: 24, ...NIGHT },
];

function mixColor(from: number, to: number, amount: number): number {
  const red = Math.round(((from >> 16) & 0xff) + ((((to >> 16) & 0xff) - ((from >> 16) & 0xff)) * amount));
  const green = Math.round(((from >> 8) & 0xff) + ((((to >> 8) & 0xff) - ((from >> 8) & 0xff)) * amount));
  const blue = Math.round((from & 0xff) + (((to & 0xff) - (from & 0xff)) * amount));
  return (red << 16) | (green << 8) | blue;
}

function mix(from: VillageLighting, to: VillageLighting, amount: number): VillageLighting {
  return {
    shadeColor: mixColor(from.shadeColor, to.shadeColor, amount),
    shadeAlpha: from.shadeAlpha + (to.shadeAlpha - from.shadeAlpha) * amount,
    glowAlpha: from.glowAlpha + (to.glowAlpha - from.glowAlpha) * amount,
    dustAlpha: from.dustAlpha + (to.dustAlpha - from.dustAlpha) * amount,
    fireflyAlpha: from.fireflyAlpha + (to.fireflyAlpha - from.fireflyAlpha) * amount,
  };
}

function withRain(lighting: VillageLighting, indoor: boolean): VillageLighting {
  return {
    shadeColor: mixColor(lighting.shadeColor, indoor ? INDOOR_RAIN_TINT : RAIN_TINT, 0.35),
    shadeAlpha: Math.min(0.42, lighting.shadeAlpha + 0.04),
    glowAlpha: lighting.glowAlpha * 0.9,
    dustAlpha: lighting.dustAlpha * 0.4,
    fireflyAlpha: lighting.fireflyAlpha * 0.6,
  };
}

/**
 * Ambient lighting for the given local time. The function only runs a handful of
 * comparisons and mixes, so calling it once per second is effectively free.
 */
export function lightingAt(
  date: Date,
  options: { indoor?: boolean; rain?: boolean } = {},
): VillageLighting {
  let lighting: VillageLighting;
  if (options.indoor) {
    lighting = INDOOR;
  } else {
    const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
    let nextIndex = 1;
    while (nextIndex < KEYS.length - 1 && KEYS[nextIndex]!.hour <= hour) nextIndex++;
    const previous = KEYS[nextIndex - 1]!;
    const next = KEYS[nextIndex]!;
    const span = next.hour - previous.hour;
    const amount = span > 0 ? Math.min(1, Math.max(0, (hour - previous.hour) / span)) : 0;
    lighting = mix(previous, next, amount);
  }
  return options.rain ? withRain(lighting, options.indoor === true) : lighting;
}

/**
 * Stable per-day weather. Mixing year, month and day avoids the visible monthly
 * clustering of a bare `getDate() % 3` while keeping a 1-in-3 rain chance.
 */
export function rainyDay(date: Date): boolean {
  const seed = date.getFullYear() * 372 + date.getMonth() * 31 + date.getDate();
  return seed % 3 === 0;
}
