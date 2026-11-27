import Phaser from "phaser";
import type { Npc, Player } from "../../shared/types";
import { findPath, isTextFocus } from "../pathfinding";
import { startedOnWorldCanvas } from "../pointerBoundary";
import {
  getWorldMap,
  mapCameraBounds,
  portalAvailable,
  withinWalkBounds,
  type WorldTarget,
} from "../config/worldConfig";
import type { RenderMap } from "../config/worldRender";
import type { VillageLighting } from "./atmosphere";
import { preloadWorld, queueCharacterSprites } from "./assets";
import {
  puffDust,
  showClickRipple,
  updateEffects,
} from "./effects";
import { updateEnvironment } from "./environment";
import { buildWorld } from "./render";
import { WorldInteractions } from "./interactions";
import type {
  PortalMarker,
  WorldCallbacks,
  WorldLight,
  WorldMote,
  WorldSceneSurface,
  WorldState,
} from "./types";

const DIRECTION_ROWS: Record<string, number> = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3,
};
const EMPTY_LIGHTING: VillageLighting = {
  shadeColor: 0x17233d,
  shadeAlpha: 0,
  glowAlpha: 0,
  dustAlpha: 0,
  fireflyAlpha: 0,
};

export function createTownScene(
  initial: Player,
  state: WorldState,
  callbacks: WorldCallbacks,
  ready: (scene: TownScene) => void,
) {
  class TownScene extends Phaser.Scene implements WorldSceneSurface {
    interactions: WorldInteractions = new WorldInteractions(
      this,
      state,
      callbacks,
    );
    player!: Phaser.GameObjects.Sprite;
    mapKey = initial.map_key;
    tileX = initial.tile_x;
    tileY = initial.tile_y;
    direction = (initial.direction ?? "down").toUpperCase();
    busy = false;
    path: { x: number; y: number }[] = [];
    collision: number[] = [];
    width = getWorldMap(initial.map_key).width;
    height = getWorldMap(initial.map_key).height;
    indoor = false;
    activeNpcs: {
      npc: Npc;
      sprite: Phaser.GameObjects.Sprite;
      label: Phaser.GameObjects.Text;
      homeX: number;
      homeY: number;
      baseRow: number;
      lastRow: number;
      shadow?: Phaser.GameObjects.Ellipse;
    }[] = [];
    shade!: Phaser.GameObjects.Rectangle;
    saveTimer = 0;
    pendingTarget: string | null = null;
    travelTarget: string | null = null;
    objects: WorldTarget[] = [];
    transitioning = false;
    weather!: Phaser.GameObjects.Graphics;
    renderMaps = new Map<string, RenderMap>();
    queuedTextures = new Set<string>();
    lastHint = "";
    atmosphere: VillageLighting = { ...EMPTY_LIGHTING };
    lightingClock = Number.NEGATIVE_INFINITY;
    lightStep = 0;
    weatherDrawn = false;
    raining = false;
    focusTarget: WorldTarget | null = null;
    hintAt = 0;
    trailKey = "";
    lastGlanceKey = "";
    lampLights: WorldLight[] = [];
    motes: WorldMote[] = [];
    portalMarkers: PortalMarker[] = [];
    playerShadow?: Phaser.GameObjects.Ellipse;
    focusRing?: Phaser.GameObjects.Ellipse;
    pathTrail?: Phaser.GameObjects.Graphics;
    clickRipple?: Phaser.GameObjects.Ellipse;
    constructor() {
      super("town");
    }
    preload() {
      preloadWorld(this, state, callbacks);
    }
    queueCharacterSprites() {
      return queueCharacterSprites(this, state);
    }
    create() {
      ready(this);
      this.build();
      this.input.on(
        "pointerdown",
        (p: Phaser.Input.Pointer, objects: Phaser.GameObjects.GameObject[]) => {
          if (
            !startedOnWorldCanvas(p, this.game.canvas) ||
            state.paused ||
            objects.length
          )
            return;
          const world = p.positionToCamera(
            this.cameras.main,
          ) as Phaser.Math.Vector2;
          const tileX = Math.floor(world.x / 16);
          const tileY = Math.floor(world.y / 16);
          showClickRipple(
            this,
            tileX,
            tileY,
            this.blocked(tileX, tileY),
            state.reducedMotion,
          );
          this.pendingTarget = null;
          this.travelTarget = null;
          this.walkTo(tileX, tileY);
        },
      );
      this.scale.on("resize", () => this.resize());
      callbacks.progress(1);
      this.game.events.once("postrender", () => {
        const camera = this.cameras.main;
        callbacks.cameraReady?.({
          x: camera.worldView.x,
          y: camera.worldView.y,
          zoom: camera.zoom,
          map: this.mapKey,
        });
      });
    }
    build() {
      buildWorld(this, state, callbacks);
    }
    resize() {
      this.cameras.main.setZoom(
        Math.min(
          3,
          Math.max(
            1.5,
            Math.min(this.scale.width / 380, this.scale.height / 240),
          ),
        ),
      );
      const bounds = mapCameraBounds(getWorldMap(this.mapKey));
      const camera = this.cameras.main;
      if (bounds)
        camera.setBounds(
          bounds.x * 16,
          bounds.y * 16,
          bounds.width * 16,
          bounds.height * 16,
        );
      else camera.removeBounds();
      if (this.player)
        camera.centerOn(
          this.player.x - camera.followOffset.x,
          this.player.y - camera.followOffset.y,
        );
    }
    blocked(x: number, y: number) {
      return (
        !withinWalkBounds(getWorldMap(this.mapKey), x, y) ||
        Boolean(this.collision[y * this.width + x]) ||
        this.activeNpcs.some((n) => n.homeX === x && n.homeY === y)
      );
    }
    walkTo(x: number, y: number) {
      if (state.paused || this.busy || this.transitioning || this.blocked(x, y))
        return;
      this.path = findPath(
        { x: this.tileX, y: this.tileY },
        { x, y },
        this.width,
        this.height,
        (a, b) => this.blocked(a, b),
      );
    }
    approach(key: string, preferredPoint?: { x: number; y: number }) {
      this.interactions.approach(key, preferredPoint);
    }
    nearbyTarget(preferredTarget?: string) {
      return this.interactions.nearbyTarget(preferredTarget);
    }
    refreshHint() {
      this.interactions.refreshHint();
    }
    interact(preferredTarget?: string) {
      return this.interactions.interact(preferredTarget);
    }
    changeMap(player: Player, fade = false) {
      this.mapKey = player.map_key;
      this.tileX = player.tile_x;
      this.tileY = player.tile_y;
      this.direction = player.direction.toUpperCase();
      this.path = [];
      this.pendingTarget = null;
      this.build();
      if (fade && !state.reducedMotion && !state.destroyed) {
        this.cameras.main.fadeIn(220, 6, 12, 10);
      }
      if (this.travelTarget) {
        const finalTarget = this.travelTarget;
        this.time.delayedCall(200, () => {
          if (this.travelTarget === finalTarget) this.approach(finalTarget);
        });
      }
    }
    beginMapTransition() {
      if (state.reducedMotion || state.destroyed) return;
      this.cameras.main.fadeOut(140, 6, 12, 10);
    }
    abortMapTransition() {
      if (state.reducedMotion || state.destroyed) return;
      this.cameras.main.fadeIn(160, 6, 12, 10);
    }
    refreshPortalMarkers() {
      for (const marker of this.portalMarkers) {
        marker.image.setAlpha(
          portalAvailable(marker.portal, state.flags, state.runtime)
            ? 0.92
            : 0.55,
        );
      }
      this.lastHint = "";
      this.refreshHint();
    }
    position(): Player {
      return {
        map_key: this.mapKey,
        tile_x: this.tileX,
        tile_y: this.tileY,
        direction: this.direction.toLowerCase(),
      };
    }
    mapPosition(): Player {
      return {
        map_key: this.mapKey,
        tile_x: this.player.x / 16 - 0.5,
        tile_y: this.player.y / 16 - 0.75,
        direction: this.direction.toLowerCase(),
      };
    }
    save() {
      if (!this.transitioning) callbacks.position(this.position());
    }
    glanceAtPlayer() {
      const key = `${this.tileX},${this.tileY}`;
      if (key === this.lastGlanceKey) return;
      this.lastGlanceKey = key;
      for (const item of this.activeNpcs) {
        const dx = this.tileX - item.homeX;
        const dy = this.tileY - item.homeY;
        const near = Math.abs(dx) + Math.abs(dy) <= 4;
        const row = near
          ? Math.abs(dx) >= Math.abs(dy)
            ? dx > 0
              ? 2
              : 1
            : dy > 0
              ? 0
              : 3
          : item.baseRow;
        if (row !== item.lastRow) {
          item.lastRow = row;
          item.sprite.setFrame(row * 3 + 1);
        }
      }
    }
    update(time: number) {
      if (!this.player) return;
      updateEnvironment(this, state, time);
      updateEffects(this, state, time);
      if (!state.paused && time - this.hintAt >= 100) {
        this.hintAt = time;
        this.refreshHint();
      }
      if (state.paused || isTextFocus(document.activeElement)) {
        this.path = [];
        this.player.anims.stop();
        return;
      }
      if (this.busy || this.transitioning) return;
      this.glanceAtPlayer();
      let dx = 0,
        dy = 0;
      if (state.pressed.has("arrowup") || state.pressed.has("w")) dy = -1;
      else if (state.pressed.has("arrowdown") || state.pressed.has("s")) dy = 1;
      else if (state.pressed.has("arrowleft") || state.pressed.has("a"))
        dx = -1;
      else if (state.pressed.has("arrowright") || state.pressed.has("d"))
        dx = 1;
      if (dx || dy) {
        this.path = [];
        this.pendingTarget = null;
        this.travelTarget = null;
      } else {
        const next = this.path.shift();
        if (next) {
          dx = next.x - this.tileX;
          dy = next.y - this.tileY;
        }
      }
      if (!dx && !dy) {
        this.player.anims.stop();
        const row = DIRECTION_ROWS[this.direction] ?? 0;
        this.player.setFrame(row * 3 + 1);
        if (this.pendingTarget) {
          const target = this.pendingTarget;
          this.pendingTarget = null;
          this.interact(target);
        }
        return;
      }
      this.direction =
        dy < 0 ? "UP" : dy > 0 ? "DOWN" : dx < 0 ? "LEFT" : "RIGHT";
      const row = DIRECTION_ROWS[this.direction]!;
      this.player.setFrame(row * 3 + 1);
      if (this.blocked(this.tileX + dx, this.tileY + dy)) return;
      this.tileX += dx;
      this.tileY += dy;
      this.busy = true;
      puffDust(this, this.tileX, this.tileY, state.reducedMotion);
      this.player.play(`chara_0-${row}`, true);
      this.player.setDepth(this.tileY + 3);
      this.tweens.add({
        targets: this.player,
        x: this.tileX * 16 + 8,
        y: this.tileY * 16 + 12,
        duration: 130,
        onComplete: () => {
          callbacks.mapPosition?.(this.mapPosition());
          this.busy = false;
        },
      });
    }
  }

  return TownScene;
}
export type TownScene = InstanceType<ReturnType<typeof createTownScene>>;
