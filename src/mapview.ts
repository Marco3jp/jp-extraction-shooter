import { BEACON_RADIUS, DEVICE_ACTIVE_RANGE, DEVICES, EVAC, EXTRACT_RADIUS, HEAL_SENSE, factionDef } from "./sim/data";
import type { GameMap, Vec } from "./sim/map";
import type { Actor, Extract, World } from "./sim/world";
import { PARTNER_COLOR, TYPE_COLORS, extractColor } from "./render/renderer";
import { overviewTile } from "./maploader";

/** 銃声。k は届いたときの強さ（近いほど 1）、ours はタレットの銃声 */
export type Ping = { pos: Vec; t: number; k: number; ours: boolean };

/** 長距離移動の行き先を選んでいる間に描くもの。hover はカーソルが指している所、ok はそこへ飛べるか */
export type EvacPick = { hover: Vec | null; ok: boolean };

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
  private tiles: Set<string>;
  /** 最後に drawFull で描いたときの、マップの座標から canvas の座標への変換 */
  private full = { offX: 0, offY: 0, scale: 1, bx0: 0, by0: 0 };

  constructor(private map: GameMap) {
    this.tiles = new Set(map.index.overview.tiles.map(([i, j]) => `${i}_${j}`));
  }

  /** マップの (ox, oy) から meters 四方を、ctx の (0, 0) から size 四方へ描く。読み終わっていない絵は飛ばす */
  drawArea(ctx: CanvasRenderingContext2D, ox: number, oy: number, meters: number, size: number) {
    this.drawRect(ctx, ox, oy, meters, meters, 0, 0, size / meters);
  }

  /** 範囲の絵を読み終えたら解決する。読めなかった絵は飛ばす */
  loadArea(ox: number, oy: number, meters: number): Promise<void> {
    const T = this.map.index.overview.tile;
    const waits: Promise<void>[] = [];
    for (let tj = Math.floor(oy / T); tj * T < oy + meters; tj++) {
      for (let ti = Math.floor(ox / T); ti * T < ox + meters; ti++) {
        if (this.tiles.has(`${ti}_${tj}`)) waits.push(overviewTile(this.map.index.id, ti, tj).decode().catch(() => {}));
      }
    }
    return Promise.all(waits).then(() => {});
  }

  private drawRect(ctx: CanvasRenderingContext2D, ox: number, oy: number, mw: number, mh: number, dx: number, dy: number, scale: number) {
    const T = this.map.index.overview.tile;
    ctx.imageSmoothingEnabled = false;
    for (let tj = Math.floor(oy / T); tj * T < oy + mh; tj++) {
      for (let ti = Math.floor(ox / T); ti * T < ox + mw; ti++) {
        if (!this.tiles.has(`${ti}_${tj}`)) continue;
        const img = overviewTile(this.map.index.id, ti, tj);
        if (!img.complete || !img.naturalWidth) continue;
        // 絵の外を指すと描かないブラウザがあるので、重なる所だけを切り出す
        const x0 = Math.max(ox, ti * T), y0 = Math.max(oy, tj * T);
        const x1 = Math.min(ox + mw, (ti + 1) * T), y1 = Math.min(oy + mh, (tj + 1) * T);
        // 描く先をピクセルの境目に揃える。小数のままだと隣の絵との間に細いすき間が見える
        const sx0 = Math.round(dx + (x0 - ox) * scale), sy0 = Math.round(dy + (y0 - oy) * scale);
        const sx1 = Math.round(dx + (x1 - ox) * scale), sy1 = Math.round(dy + (y1 - oy) * scale);
        ctx.drawImage(img, x0 - ti * T, y0 - tj * T, x1 - x0, y1 - y0, sx0, sy0, sx1 - sx0, sy1 - sy0);
      }
    }
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
    this.drawArea(ctx, ox, oy, MINI_METERS, size);
    const toS = (v: Vec) => ({ x: (v.x - ox) * scale, y: (v.y - oy) * scale });
    this.drawMarkers(ctx, w, pings, toS, scale, size, true);
  }

  /** drawFull で描いた canvas の上の点を、マップの座標にする */
  fullToMap(x: number, y: number): Vec {
    const f = this.full;
    return { x: f.bx0 + (x - f.offX) / f.scale, y: f.by0 + (y - f.offY) / f.scale };
  }

  /** 地図全体 */
  drawFull(canvas: HTMLCanvasElement, w: World, pings: Ping[], pick: EvacPick | null = null) {
    const ctx = canvas.getContext("2d")!;
    const cw = canvas.width, ch = canvas.height;
    const [bx0, by0, bx1, by1] = this.map.bounds;
    const mw = bx1 - bx0, mh = by1 - by0;
    const scale = Math.min(cw / mw, ch / mh);
    const offX = (cw - mw * scale) / 2, offY = (ch - mh * scale) / 2;
    this.full = { offX, offY, scale, bx0, by0 };
    ctx.clearRect(0, 0, cw, ch);
    this.drawRect(ctx, bx0, by0, mw, mh, offX, offY, scale);
    const toS = (v: Vec) => ({ x: offX + (v.x - bx0) * scale, y: offY + (v.y - by0) * scale });
    this.drawMarkers(ctx, w, pings, toS, scale, Math.max(cw, ch), false);
    if (pick) this.drawPick(ctx, w, pick, toS, scale);
  }

  private drawPick(ctx: CanvasRenderingContext2D, w: World, pick: EvacPick, toS: (v: Vec) => { x: number; y: number }, scale: number) {
    const pc = toS(w.player.pos);
    ctx.fillStyle = "rgba(255, 192, 48, 0.08)";
    ctx.strokeStyle = "rgba(255, 192, 48, 0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pc.x, pc.y, EVAC.range * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (!pick.hover) return;
    const h = toS(pick.hover);
    const color = pick.ok ? "#ffc030" : "#ff5040";
    ctx.strokeStyle = color;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(pc.x, pc.y);
    ctx.lineTo(h.x, h.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(h.x, h.y, 7, 0, Math.PI * 2);
    ctx.moveTo(h.x - 11, h.y);
    ctx.lineTo(h.x + 11, h.y);
    ctx.moveTo(h.x, h.y - 11);
    ctx.lineTo(h.x, h.y + 11);
    ctx.stroke();
    const d = Math.round(Math.hypot(pick.hover.x - w.player.pos.x, pick.hover.y - w.player.pos.y));
    ctx.fillStyle = color;
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${d}m`, h.x + 13, h.y - 8);
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
      ctx.strokeStyle = ping.ours ? `rgba(90, 170, 255, ${1 - k})` : `rgba(255, 80, 60, ${1 - k})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(3, (3 + k * 10) * (mini ? 1 : 1.4)), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = "#9ab8d0";
    for (const b of w.barriers) {
      for (const c of b.cells) {
        const s = toS(c);
        ctx.fillRect(s.x, s.y, Math.max(2, scale), Math.max(2, scale));
      }
    }
    ctx.strokeStyle = "rgba(128, 232, 255, 0.8)";
    ctx.lineWidth = 2;
    // 固定レールは全体マップの絵に描いてある
    for (const r of w.rails) {
      if (r.owner === null) continue;
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

    // パートナーは味方なので常に出す。倒れていたら色を落とす
    for (const a of w.actors) {
      if (a.team !== "partner") continue;
      const s = toS(a.pos);
      ctx.fillStyle = a.alive ? hex(PARTNER_COLOR) : "#5a6a74";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, mini ? 3.5 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // 設置物。センサーは見える範囲の円も出す。止まっている物は色を落とす
    for (const dv of w.devices) {
      const s = toS(dv.pos);
      const on = Math.hypot(dv.pos.x - p.pos.x, dv.pos.y - p.pos.y) <= DEVICE_ACTIVE_RANGE;
      if (dv.kind === "sensor") {
        ctx.strokeStyle = on ? "rgba(120, 220, 255, 0.35)" : "rgba(120, 140, 150, 0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(s.x, s.y, DEVICES.sensor.radius * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = on ? "#78dcff" : "#5a6a74";
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - 4);
        ctx.lineTo(s.x + 4, s.y);
        ctx.lineTo(s.x, s.y + 4);
        ctx.lineTo(s.x - 4, s.y);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = on ? hex(TYPE_COLORS.turret) : "#5a6a74";
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.fillRect(s.x - 3.5, s.y - 3.5, 7, 7);
        ctx.strokeRect(s.x - 3.5, s.y - 3.5, 7, 7);
      }
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

    // 長距離移動で飛んでいる間は、降りる所に印を出す
    if (p.evac?.state === "fly") {
      const t = toS(p.evac.to);
      ctx.strokeStyle = "#ffc030";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(t.x - 6, t.y - 6);
      ctx.lineTo(t.x + 6, t.y + 6);
      ctx.moveTo(t.x + 6, t.y - 6);
      ctx.lineTo(t.x - 6, t.y + 6);
      ctx.stroke();
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
