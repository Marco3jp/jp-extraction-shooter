import type { BuildingType } from "../data/buildings";

export const Ground = { lot: 0, road: 1, sidewalk: 2, green: 3, viaduct: 4, dirt: 5 } as const;
export const Solid = { free: 0, building: 1, cover: 2 } as const;

/** 地面に描く表示。座標はマップのセル単位、angle は道の伸びる向き（ラジアン） */
export type Marking = { x: number; y: number; angle: number; len: number };

export type MapJson = {
  name: string;
  width: number;
  height: number;
  cell: number;
  attribution: string;
  /** 位置はマップの幅・高さに対する割合（0〜1） */
  layout: {
    start: [number, number];
    extracts: [number, number][];
    /** 勢力の番号ごとの縄張り [左, 上, 右, 下] */
    factionAreas: Record<string, [number, number, number, number]>;
  };
  ground: string;
  solid: string;
  buildings: {
    kind: string;
    type: BuildingType;
    h: number;
    /** 道に面した側。0:北 1:東 2:南 3:西 */
    front: 0 | 1 | 2 | 3;
    rects: [number, number, number, number][];
  }[];
  covers: { kind: string; x: number; y: number; w: number; h: number }[];
  markings: {
    crosswalks: Marking[];
    stops: Marking[];
    lines: { pts: [number, number][]; dash: boolean }[];
    manholes: [number, number][];
  };
  /** street は通りの名前、station は駅名 */
  signs: { kind: "street" | "station"; x: number; y: number; text: string[] }[];
  /** 町名と、その中心 */
  areas: { name: string; x: number; y: number }[];
};

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  clear() {
    this.keys.length = 0;
    this.vals.length = 0;
  }
  push(v: number, k: number) {
    const ks = this.keys, vs = this.vals;
    let i = ks.length;
    ks.push(k);
    vs.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (ks[p] <= k) break;
      ks[i] = ks[p];
      vs[i] = vs[p];
      i = p;
    }
    ks[i] = k;
    vs[i] = v;
  }
  pop(): number {
    const ks = this.keys, vs = this.vals;
    const top = vs[0];
    const lk = ks.pop()!, lv = vs.pop()!;
    const n = ks.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && ks[c + 1] < ks[c]) c++;
        if (ks[c] >= lk) break;
        ks[i] = ks[c];
        vs[i] = vs[c];
        i = c;
      }
      ks[i] = lk;
      vs[i] = lv;
    }
    return top;
  }
}

export type Vec = { x: number; y: number };

/** 通れるが避けたい場所。cellCost はそのセルに入るときに1歩あたりへ足す重み、lineOk はまっすぐ歩いてよい線分か */
export type PathAvoid = { cellCost: (cx: number, cy: number) => number; lineOk: (a: Vec, b: Vec) => boolean };

export class GameMap {
  readonly name: string;
  readonly w: number;
  readonly h: number;
  readonly ground: Uint8Array;
  readonly solid: Uint8Array;
  readonly json: MapJson;
  /** セルごとの建物の番号（json.buildings の添字）。建物でなければ -1 */
  readonly buildingIndex: Int32Array;

  /** 歩いて行けるセル（一番広くつながった範囲）。setReachMain するまでは null */
  reach: Uint8Array | null = null;
  private gScore: Float32Array;
  private came: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private gen = 1;
  private heap = new MinHeap();

  constructor(json: MapJson) {
    this.json = json;
    this.name = json.name;
    this.w = json.width;
    this.h = json.height;
    this.ground = decode(json.ground);
    this.solid = decode(json.solid);
    const n = this.w * this.h;
    this.buildingIndex = new Int32Array(n).fill(-1);
    json.buildings.forEach((b, bi) => {
      for (const [x, y, w, h] of b.rects) {
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.buildingIndex[xx + yy * this.w] = bi;
      }
    });
    this.gScore = new Float32Array(n);
    this.came = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  /** 一番近い町名。町名のデータが無ければ null */
  areaAt(x: number, y: number): string | null {
    let best: string | null = null;
    let bd = Infinity;
    for (const a of this.json.areas) {
      const d = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = a.name;
      }
    }
    return best;
  }

  blocked(cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return true;
    return this.solid[cx + cy * this.w] !== Solid.free;
  }

  blockedAt(x: number, y: number): boolean {
    return this.blocked(Math.floor(x), Math.floor(y));
  }

  /** a→b の線分が最初に塞がったセルに入る位置の割合（0〜1）。当たらなければ 1 より大きい値 */
  raycast(ax: number, ay: number, bx: number, by: number): number {
    let cx = Math.floor(ax), cy = Math.floor(ay);
    if (this.blocked(cx, cy)) return 0;
    const dx = bx - ax, dy = by - ay;
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = dx !== 0 ? (dx > 0 ? cx + 1 - ax : ax - cx) * tdx : Infinity;
    let tmy = dy !== 0 ? (dy > 0 ? cy + 1 - ay : ay - cy) * tdy : Infinity;
    for (;;) {
      let t: number;
      if (tmx < tmy) {
        t = tmx;
        tmx += tdx;
        cx += stepX;
      } else {
        t = tmy;
        tmy += tdy;
        cy += stepY;
      }
      if (t > 1) return 2;
      if (this.blocked(cx, cy)) return t;
    }
  }

  los(a: Vec, b: Vec): boolean {
    return this.raycast(a.x, a.y, b.x, b.y) > 1;
  }

  /** 半径 r の円が通れるか。中心線と左右にずらした線で見る */
  walkLine(a: Vec, b: Vec, r: number): boolean {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * r, ny = (dx / len) * r;
    return (
      this.raycast(a.x, a.y, b.x, b.y) > 1 &&
      this.raycast(a.x + nx, a.y + ny, b.x + nx, b.y + ny) > 1 &&
      this.raycast(a.x - nx, a.y - ny, b.x - nx, b.y - ny) > 1
    );
  }

  /** 円を塞がったセルの外へ押し出す */
  collide(p: Vec, r: number) {
    for (let iter = 0; iter < 2; iter++) {
      const x0 = Math.floor(p.x - r), x1 = Math.floor(p.x + r);
      const y0 = Math.floor(p.y - r), y1 = Math.floor(p.y + r);
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          if (!this.blocked(cx, cy)) continue;
          const qx = Math.max(cx, Math.min(p.x, cx + 1));
          const qy = Math.max(cy, Math.min(p.y, cy + 1));
          let dx = p.x - qx, dy = p.y - qy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r * r) continue;
          if (d2 < 1e-8) {
            // 中心がセルの中に入ってしまったときは一番近い辺から出す
            const l = p.x - cx, rr = cx + 1 - p.x, t = p.y - cy, b = cy + 1 - p.y;
            const m = Math.min(l, rr, t, b);
            if (m === l) p.x = cx - r;
            else if (m === rr) p.x = cx + 1 + r;
            else if (m === t) p.y = cy - r;
            else p.y = cy + 1 + r;
            continue;
          }
          const d = Math.sqrt(d2);
          dx /= d;
          dy /= d;
          p.x = qx + dx * r;
          p.y = qy + dy * r;
        }
      }
    }
  }

  /** 歩いて行けるセルを、一番広くつながった範囲にする。出発地点がどこでも同じ結果になる */
  setReachMain() {
    if (this.reach) return;
    const n = this.w * this.h;
    const label = new Int32Array(n).fill(-1);
    let best = -1, bestSize = 0, id = 0;
    for (let s = 0; s < n; s++) {
      if (label[s] >= 0 || this.solid[s] !== Solid.free) continue;
      const q = [s];
      label[s] = id;
      let size = 0;
      while (q.length) {
        const i = q.pop()!;
        size++;
        const x = i % this.w, y = (i / this.w) | 0;
        const ns = [x > 0 ? i - 1 : -1, x < this.w - 1 ? i + 1 : -1, y > 0 ? i - this.w : -1, y < this.h - 1 ? i + this.w : -1];
        for (const m of ns) {
          if (m >= 0 && label[m] < 0 && this.solid[m] === Solid.free) {
            label[m] = id;
            q.push(m);
          }
        }
      }
      if (size > bestSize) {
        bestSize = size;
        best = id;
      }
      id++;
    }
    const mark = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (label[i] === best) mark[i] = 1;
    this.reach = mark;
  }

  /** 歩いて行ける場所か */
  walkable(x: number, y: number): boolean {
    const cx = Math.floor(x), cy = Math.floor(y);
    if (this.blocked(cx, cy)) return false;
    return !this.reach || this.reach[cx + cy * this.w] === 1;
  }

  findPath(a: Vec, b: Vec, maxNodes = 30000, avoid?: PathAvoid): Vec[] | null {
    const w = this.w;
    const sx = Math.floor(a.x), sy = Math.floor(a.y);
    const tx = Math.floor(b.x), ty = Math.floor(b.y);
    if (this.blocked(tx, ty)) return null;
    const start = sx + sy * w, goal = tx + ty * w;
    if (this.reach && !this.reach[goal]) return null;
    const gen = ++this.gen;
    const heap = this.heap;
    heap.clear();
    this.stamp[start] = gen;
    this.gScore[start] = 0;
    this.came[start] = -1;
    heap.push(start, 0);
    const dirs = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ];
    let found = false;
    let expanded = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      if (cur === goal) {
        found = true;
        break;
      }
      if (++expanded > maxNodes) break;
      const cx = cur % w, cy = (cur / w) | 0;
      const g = this.gScore[cur];
      for (const [dx, dy, cost] of dirs) {
        const nx = cx + dx, ny = cy + dy;
        if (this.blocked(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (this.blocked(cx + dx, cy) || this.blocked(cx, cy + dy))) continue;
        const n = nx + ny * w;
        if (this.closed[n] === gen) continue;
        const ng = g + cost * (1 + (avoid ? avoid.cellCost(nx, ny) : 0));
        if (this.stamp[n] === gen && this.gScore[n] <= ng) continue;
        this.stamp[n] = gen;
        this.gScore[n] = ng;
        this.came[n] = cur;
        const hx = Math.abs(nx - tx), hy = Math.abs(ny - ty);
        const h = Math.max(hx, hy) + (Math.SQRT2 - 1) * Math.min(hx, hy);
        heap.push(n, ng + h);
      }
    }
    if (!found) return null;
    const cells: Vec[] = [];
    for (let c = goal; c !== -1; c = this.came[c]) cells.push({ x: (c % w) + 0.5, y: ((c / w) | 0) + 0.5 });
    cells.reverse();
    cells[cells.length - 1] = { x: b.x, y: b.y };
    // 見通せるところは飛ばして、まっすぐ歩けるようにする
    const out: Vec[] = [];
    let anchor: Vec = { x: a.x, y: a.y };
    let i = 0;
    while (i < cells.length) {
      let j = i;
      while (j + 1 < cells.length && this.walkLine(anchor, cells[j + 1], 0.45) && (!avoid || avoid.lineOk(anchor, cells[j + 1]))) j++;
      out.push(cells[j]);
      anchor = cells[j];
      i = j + 1;
    }
    return out;
  }
}
