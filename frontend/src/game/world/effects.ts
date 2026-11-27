import Phaser from "phaser";
import type { RenderProp } from "../config/worldRender";
import type {
  WorldLight,
  WorldMote,
  WorldSceneSurface,
  WorldState,
} from "./types";

const GLOW_TEXTURE = "glow-soft";

export function createLampGlow(
  scene: WorldSceneSurface,
  prop: RenderProp,
): WorldLight | null {
  if (!/\/lamps\/|\/torches\//.test(prop.textureUrl)) return null;
  if (!scene.textures.exists(GLOW_TEXTURE)) return null;
  const torch = prop.textureUrl.includes("/torches/");
  const image = scene.add
    .image(prop.x, prop.y - (torch ? 8 : 9), GLOW_TEXTURE)
    .setDisplaySize(torch ? 28 : 38, torch ? 28 : 38)
    .setTint(torch ? 0xffb45e : 0xffcf8a)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setAlpha(0)
    .setDepth(102);
  return {
    image,
    baseAlpha: torch ? 0.32 : 0.38,
    phase: (prop.x * 0.13 + prop.y * 0.07) % (Math.PI * 2),
    flicker: torch ? 0.16 : 0.07,
  };
}

function createMotes(scene: WorldSceneSurface, indoor: boolean): WorldMote[] {
  if (indoor || !scene.textures.exists(GLOW_TEXTURE)) return [];
  const motes: WorldMote[] = [];
  const width = scene.width * 16;
  const height = scene.height * 16;
  for (let index = 0; index < 24; index++) {
    const x = ((index * 137) % Math.max(1, width - 32)) + 16;
    const y = ((index * 83) % Math.max(1, height - 32)) + 16;
    const image = scene.add
      .image(x, y, GLOW_TEXTURE)
      .setDisplaySize(7, 7)
      .setDepth(103)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(0xfff0c9)
      .setAlpha(0);
    motes.push({
      image,
      baseX: x,
      baseY: y,
      phase: index * 0.7,
      drift: 4 + (index % 5),
    });
  }
  return motes;
}

export function createEffectObjects(scene: WorldSceneSurface, indoor: boolean): void {
  const player = scene.player;
  scene.playerShadow = scene.add
    .ellipse(player.x, player.y - 1, 11, 4, 0x0a1712, 0.22)
    .setDepth(player.depth - 1);
  scene.focusRing = scene.add
    .ellipse(0, 0, 22, 9, 0x000000, 0)
    .setStrokeStyle(2, 0xf0d38a, 0.9)
    .setVisible(false)
    .setDepth(0);
  scene.pathTrail = scene.add.graphics().setDepth(2);
  scene.motes = createMotes(scene, indoor);
  scene.focusTarget = null;
  scene.trailKey = "";
  scene.clickRipple = undefined;
}

function updateTrail(scene: WorldSceneSurface): void {
  const graphics = scene.pathTrail;
  if (!graphics) return;
  const path = scene.path;
  if (!path.length) {
    if (scene.trailKey) {
      graphics.clear();
      scene.trailKey = "";
    }
    return;
  }
  const first = path[0]!;
  const second = path[1] ?? first;
  const last = path[path.length - 1]!;
  const key = `${path.length}:${first.x},${first.y}:${second.x},${second.y}:${last.x},${last.y}`;
  if (key === scene.trailKey) return;
  scene.trailKey = key;
  graphics.clear();
  const step = Math.max(1, Math.ceil(path.length / 14));
  graphics.lineStyle(2, 0xf0d38a, 0.18);
  graphics.beginPath();
  graphics.moveTo(scene.player.x, scene.player.y - 2);
  for (const point of path) graphics.lineTo(point.x * 16 + 8, point.y * 16 + 12);
  graphics.strokePath();
  for (let index = 0; index < path.length; index += step) {
    const point = path[index]!;
    const destination = index === path.length - 1;
    graphics.fillStyle(0xf0d38a, destination ? 0.8 : 0.55);
    graphics.fillCircle(
      point.x * 16 + 8,
      point.y * 16 + 12,
      destination ? 2.6 : 2,
    );
  }
  graphics.lineStyle(2, 0xf0d38a, 0.85);
  graphics.strokeCircle(last.x * 16 + 8, last.y * 16 + 12, 4);
}

function updateFocus(scene: WorldSceneSurface, state: WorldState, time: number): void {
  const ring = scene.focusRing;
  if (!ring) return;
  const target = scene.focusTarget;
  if (!target || state.paused) {
    if (ring.visible) ring.setVisible(false);
    return;
  }
  ring.setVisible(true);
  ring.setPosition(target.x * 16 + 8, target.y * 16 + 12);
  ring.setDepth(target.y + 2);
  const pulse = state.reducedMotion ? 1 : 1 + Math.sin(time * 0.004) * 0.06;
  ring.setScale(pulse);
  ring.setAlpha(
    state.reducedMotion ? 0.9 : 0.75 + Math.sin(time * 0.004) * 0.15,
  );
}

function updateMotes(scene: WorldSceneSurface, state: WorldState, time: number): void {
  if (!scene.motes.length) return;
  const { dustAlpha, fireflyAlpha } = scene.atmosphere;
  const firefly = fireflyAlpha > 0.02;
  for (const mote of scene.motes) {
    if (state.reducedMotion) {
      mote.image
        .setPosition(mote.baseX, mote.baseY)
        .setAlpha(firefly ? fireflyAlpha * 0.8 : dustAlpha * 0.8)
        .setTint(firefly ? 0xffe07a : 0xfff0c9);
      continue;
    }
    const phase = time * (firefly ? 0.0011 : 0.00028) + mote.phase;
    mote.image
      .setPosition(
        mote.baseX + Math.sin(phase) * mote.drift,
        mote.baseY + Math.cos(phase * 0.8) * mote.drift * 0.6,
      )
      .setAlpha(
        firefly
          ? fireflyAlpha * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(phase * 2.2)))
          : dustAlpha * (0.5 + 0.5 * Math.sin(phase * 1.7)),
      )
      .setTint(firefly ? 0xffe07a : 0xfff0c9);
  }
}

export function updateEffects(
  scene: WorldSceneSurface,
  state: WorldState,
  time: number,
): void {
  if (scene.playerShadow && scene.player) {
    scene.playerShadow
      .setPosition(scene.player.x, scene.player.y - 1)
      .setDepth(scene.player.depth - 1);
  }
  updateFocus(scene, state, time);
  updateTrail(scene);
  updateMotes(scene, state, time);
}

export function puffDust(
  scene: WorldSceneSurface,
  tileX: number,
  tileY: number,
  reducedMotion: boolean,
): void {
  if (reducedMotion) return;
  for (const offset of [-3, 3]) {
    const puff = scene.add
      .ellipse(tileX * 16 + 8 + offset, tileY * 16 + 14, 4, 2, 0xd9c9a8, 0.28)
      .setDepth(tileY + 2);
    scene.tweens.add({
      targets: puff,
      y: puff.y - 3,
      alpha: 0,
      scaleX: 1.8,
      duration: 300,
      ease: Phaser.Math.Easing.Quadratic.Out,
      onComplete: () => puff.destroy(),
    });
  }
}

export function showClickRipple(
  scene: WorldSceneSurface,
  tileX: number,
  tileY: number,
  blocked: boolean,
  reducedMotion: boolean,
): void {
  if (reducedMotion) return;
  if (scene.clickRipple) {
    scene.tweens.killTweensOf(scene.clickRipple);
    scene.clickRipple.destroy();
  }
  const ripple = scene.add
    .ellipse(tileX * 16 + 8, tileY * 16 + 12, 10, 4, 0x000000, 0)
    .setStrokeStyle(1, blocked ? 0x9a8a75 : 0xf0d38a, blocked ? 0.5 : 0.8)
    .setDepth(tileY + 2);
  scene.clickRipple = ripple;
  scene.tweens.add({
    targets: ripple,
    scaleX: 2.2,
    scaleY: 2.2,
    alpha: 0,
    duration: 380,
    ease: Phaser.Math.Easing.Quadratic.Out,
    onComplete: () => {
      ripple.destroy();
      if (scene.clickRipple === ripple) scene.clickRipple = undefined;
    },
  });
}
