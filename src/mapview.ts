import { BEACON_RADIUS, EXTRACT_RADIUS, HEAL_SENSE, factionDef } from "./sim/data";
import { Solid, type GameMap, type Vec } from "./sim/map";
import type { Actor, Extract, World } from "./sim/world";
import { TYPE_COLORS, extractColor } from "./render/renderer";
import { GROUND_COLORS } from "./render/cityscape";

export type Ping = { pos: Vec; t: number };

const PING_LIFE = 3;
const MINI_METERS = 140;

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

function enemyColor(a: Actor): string | null {
  if (a.seen) return hex(factionDef(a.faction).color);
  if (a.info >= 2 && a.kind !== "player") return hex(TYPE_COLORS[a.kind]);
  if (a.info >= 1) return "#d0d0d0";
  return null;
}

export class MapView {
  /** 1m を1ピクセルにしたマップ全体の絵 */
  readonly base: HTMLCanvasElement;

  constructor(private map: GameMap) {
    const c = document.createElement("canvas");
    c.width = map.w;
    c.height = map.h;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(map.w, map.h);
    for (let i = 0; i < map.w * map.h; i++) {
      let r: number, g: number, b: number;
      if (map.solid[i] === Solid.building) [r, g, b] = [150, 144, 132];
      else if (map.solid[i] === Solid.cover) [r, g, b] = [190, 170, 110];
      else {
        const gc = GROUND_COLORS[map.ground[i]] ?? GROUND_COLORS[0];
        [r, g, b] = [gc[0] * 0.4 + 10, gc[1] * 0.4 + 10, gc[2] * 0.4 + 14];
      }
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.base = c;
  }

  /** プレイヤーを中心にした小さい地図 */
  drawMini(canvas: HTMLCanvasElement, w: World, pings: Ping[]) {
    const ctx = canvas.getContext("2d")!;
    const size = canvas.width;
    const scale = size / MINI_METERS;
    const p = w.player.pos;
    const ox = p.x - MINI_METERS / 2, oy = p.y - MINI_METERS / 2;
    ctx.fillStyle = "#15171b";
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, ox, oy, MINI_METERS, MINI_METERS, 0, 0, size, size);
    const toS = (v: Vec) => ({ x: (v.x - ox) * scale, y: (v.y - oy) * scale });
    this.drawMarkers(ctx, w, pings, toS, scale, size, true);
  }

  /** 地図全体 */
  drawFull(canvas: HTMLCanvasElement, w: World, pings: Ping[]) {
    const ctx = canvas.getContext("2d")!;
    const cw = canvas.width, ch = canvas.height;
    const scale = Math.min(cw / this.map.w, ch / this.map.h);
    const offX = (cw - this.map.w * scale) / 2, offY = (ch - this.map.h * scale) / 2;
    ctx.clearRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, offX, offY, this.map.w * scale, this.map.h * scale);
    const toS = (v: Vec) => ({ x: offX + v.x * scale, y: offY + v.y * scale });
    this.drawMarkers(ctx, w, pings, toS, scale, Math.max(cw, ch), false);
  }

  private drawMarkers(
    ctx: CanvasRenderingContext2D, w: World, pings: Ping[],
    toS: (v: Vec) => { x: number; y: number }, scale: number, size: number, mini: boolean,
  ) {
    const p = w.player;
    const pc = toS(p.pos);

    if (w.debug.beaconLevel > 0) {
      ctx.strokeStyle = "rgba(96, 224, 255, 0.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(pc.x, pc.y, BEACON_RADIUS * scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (const ping of pings) {
      const age = w.time - ping.t;
      if (age < 0 || age > PING_LIFE) continue;
      const s = toS(ping.pos);
      const k = age / PING_LIFE;
      ctx.strokeStyle = `rgba(255, 80, 60, ${1 - k})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(3, (3 + k * 10) * (mini ? 1 : 1.4)), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = "#9ab8d0";
    for (const b of w.barriers) {
      for (const c of b.cells) {
        const s = toS({ x: c % this.map.w, y: Math.floor(c / this.map.w) });
        ctx.fillRect(s.x, s.y, Math.max(2, scale), Math.max(2, scale));
      }
    }
    ctx.strokeStyle = "rgba(128, 232, 255, 0.8)";
    ctx.lineWidth = 2;
    for (const r of w.rails) {
      const a = toS(r.a), b = toS(r.b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(80, 224, 112, 0.85)";
    ctx.lineWidth = 1.5;
    for (const m of w.healMarks) {
      const s = toS(m.pos);
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(4, HEAL_SENSE.radius * scale), 0, Math.PI * 2);
      ctx.stroke();
    }

    for (const l of w.loot) {
      if (l.kind !== "deathbox" || l.items.length === 0) continue;
      const s = toS(l.pos);
      ctx.fillStyle = l.opened ? "rgba(160, 90, 90, 0.7)" : "#e05050";
      ctx.fillRect(s.x - 2.5, s.y - 2.5, 5, 5);
    }

    for (const a of w.actors) {
      if (a.team !== "enemy" || !a.alive) continue;
      const c = enemyColor(a);
      if (!c) continue;
      const s = toS(a.pos);
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(s.x, s.y, mini ? 3.5 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ミニマップには近い3か所だけ出し、外れていれば縁に寄せる。呼んでいる所は遠くても出す
    const d = (e: Extract) => Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y);
    const shown = mini
      ? [...w.extracts].sort((a, b) => d(a) - d(b)).filter((e, i) => i < 3 || e.readyAt !== null)
      : w.extracts;
    const er = Math.max(5, EXTRACT_RADIUS * scale);
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 2;
    for (const e of shown) {
      let ex = toS(e.pos);
      if (mini) {
        const m = 8;
        ex = { x: Math.max(m, Math.min(size - m, ex.x)), y: Math.max(m, Math.min(size - m, ex.y)) };
      }
      const color = hex(extractColor(e));
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(ex.x, ex.y, er, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText("脱出", ex.x, ex.y - er - 3);
    }

    ctx.save();
    ctx.translate(pc.x, pc.y);
    ctx.rotate(p.facing);
    ctx.fillStyle = "#4fb0ff";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-5, 5);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-5, -5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
