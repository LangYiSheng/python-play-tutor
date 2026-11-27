import { rainyDay, lightingAt } from "./atmosphere";
import type { WorldSceneSurface, WorldState } from "./types";

const RAIN_STREAKS = 48;

/**
 * Per-frame environment work is deliberately cheap: camera drift and position
 * saving stay as before, lighting is recomputed once per second, lamp opacity at
 * 10Hz, and rain only draws while the current day is rainy.
 */
export function updateEnvironment(
  scene: WorldSceneSurface,
  state: WorldState,
  time: number,
) {
  const offset = scene.cameras.main.followOffset;
  if (scene.indoor) {
    offset.set(0, 10);
  } else if (state.drifting) {
    if (!state.driftStart) state.driftStart = time;
    const t = (time - state.driftStart) / 1000;
    const easeIn = Math.min(1, t / 1.2);
    offset.x = Math.sin(t * 0.38) * 18 * easeIn;
    offset.y = 10 + Math.sin(t * 0.27) * 10 * easeIn;
  } else {
    offset.x *= 0.88;
    offset.y = 10 + (offset.y - 10) * 0.88;
    if (Math.abs(offset.x) < 0.01) offset.x = 0;
    if (Math.abs(offset.y - 10) < 0.01) offset.y = 10;
  }
  if (time - scene.saveTimer > 1500) {
    scene.saveTimer = time;
    scene.save();
  }
  if (time - scene.lightingClock >= 1000) {
    scene.lightingClock = time;
    const now = new Date();
    const raining = rainyDay(now);
    scene.raining = raining;
    scene.atmosphere = lightingAt(now, { indoor: scene.indoor, rain: raining });
    scene.shade.setFillStyle(
      scene.atmosphere.shadeColor,
      scene.atmosphere.shadeAlpha,
    );
  }
  if (time - scene.lightStep >= 100) {
    scene.lightStep = time;
    updateLights(scene, state, time);
  }
  updateWeather(scene, time);
}

function updateLights(
  scene: WorldSceneSurface,
  state: WorldState,
  time: number,
) {
  if (!scene.lampLights.length) return;
  const glow = scene.atmosphere.glowAlpha;
  for (const light of scene.lampLights) {
    const flicker = state.reducedMotion
      ? 1
      : 1 -
        light.flicker +
        light.flicker * (0.5 + 0.5 * Math.sin(time * 0.004 + light.phase));
    light.image.setAlpha(light.baseAlpha * glow * flicker);
  }
}

function updateWeather(scene: WorldSceneSurface, time: number) {
  if (scene.indoor || !scene.raining) {
    if (scene.weatherDrawn) {
      scene.weather.clear();
      scene.weatherDrawn = false;
    }
    return;
  }
  const view = scene.cameras.main.worldView;
  const width = view.width;
  const height = view.height;
  if (width < 2 || height < 2) return;
  scene.weatherDrawn = true;
  scene.weather.clear();
  const night = scene.atmosphere.fireflyAlpha > 0.3;
  scene.weather.lineStyle(
    1,
    night ? 0x9bbfce : 0xb8dbe2,
    night ? 0.13 : 0.16,
  );
  const wind = (time * 0.012) % width;
  const fall = time * 0.42;
  for (let index = 0; index < RAIN_STREAKS; index++) {
    const x = view.x + ((index * 97 + wind) % width);
    const y = view.y + ((index * 61 + fall) % height);
    scene.weather.lineBetween(x, y, x - 2, y + 8);
  }
}
