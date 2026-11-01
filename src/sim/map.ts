import type { BuildingType } from "../data/buildings";

export const Ground = { lot: 0, road: 1, sidewalk: 2, green: 3, viaduct: 4, dirt: 5, outside: 255 } as const;
export const Solid = { free: 0, building: 1, cover: 2 } as const;

/** 区画の一辺（m）。tools/osm_to_map.py の CHUNK と揃える */
export const CHUNK = 128;
/** 読み込んだ区画を置いておく格子の一辺（m）。端と端がつながっていて、座標の下位ビットだけでマスを引く */
const RING_BITS = 10;
const RING = 1 << RING_BITS;
const RING_MASK = RING - 1;
const SLOTS = RING / CHUNK;

/** 地面に描く表示。座標はマップのセル単位、angle は道の伸びる向き（ラジアン） */
export type Marking = { x: number; y: number; angle: number; len: number };

export type MapBuilding = {
  /** マップ全体で一意。見た目のばらつきの種にする */
  id: number;
  kind: string;
  type: BuildingType;
  h: number;
  /** 道に面した側。0:北 1:東 2:南 3:西 */
  front: 0 | 1 | 2 | 3;
  rects: [number, number, number, number][];
};

export type MapCover = { id: number; kind: string; x: number; y: number; w: number; h: number };

export type Markings = {
  crosswalks: Marking[];
  stops: Marking[];
  lines: { pts: [number, number][]; dash: boolean }[];
  manholes: [number, number][];
};

/** public/maps/<名前>/index.json */
export type MapIndex = {
  /** public/maps/ の下のディレクトリ名 */
  id: string;
  name: string;
  width: number;
  height: number;
  chunk: number;
  attribution: string;
  /** 位置はマップの幅・高さに対する割合（0〜1） */
  layout: {
    start: [number, number];
    extracts: [number, number][];
    /** 勢力の番号ごとの縄張り [左, 上, 右, 下] */
    factionAreas: Record<string, [number, number, number, number]>;
  };
  /** 町名と、その中心 */
  areas: { name: string; x: number; y: number }[];
  /** ファイルがある区画の番号 [i, j] */
  chunks: [number, number][];
  /** 全体マップの絵。overview/<ti>_<tj>.png が tile 四方を 1m 1ピクセルで描いている。マップの外は透明 */
  overview: { tile: number; tiles: [number, number][] };
};

/** public/maps/<名前>/<i>_<j>.json.gz。区画は x が i * CHUNK から、y が j * CHUNK から CHUNK 四方 */
export type ChunkJson = {
  i: number;
  j: number;
  /** CHUNK * CHUNK バイト。マップの外は Ground.outside */
  ground: string;
  solid: string;
  /** btype の 1 以上の値が指す建物の種類（値 - 1 が添字）。0 は建物でない */
  types: BuildingType[];
  btype: string;
  /** 左上の角がこの区画にある建物。ほかの区画にはみ出すこともある */
  buildings: MapBuilding[];
  covers: MapCover[];
  /** 区画の外の少し先までのものも入っている。地面のテクスチャに描くため */
  markings: Markings;
  /** street は通りの名前、station は駅名 */
  signs: { kind: "street" | "station"; x: number; y: number; text: string[] }[];
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

export const chunkKey = (i: number, j: number) => `${i}_${j}`;

/** マス (cx, cy) がある区画の番号 */
export const chunkOf = (c: number) => Math.floor(c / CHUNK);

export class GameMap {
  readonly name: string;
  /** マップの範囲（m）。区画ごとに敵や箱を置くようになったら使わなくなる */
  readonly w: number;
  readonly h: number;
  readonly index: MapIndex;
  /** 読み込んである区画 */
  readonly chunks = new Map<string, ChunkJson>();
  /** 区画が変わるたびに増える。描画が作り直すかを決める */
  version = 0;

  private ground = new Uint8Array(RING * RING);
  private solid = new Uint8Array(RING * RING);
  /** 読み込んだときの solid。遮蔽物のスキルで書き換えた分を、ランの始めに戻す */
  private baseSolid = new Uint8Array(RING * RING);
  private btype = new Uint8Array(RING * RING);
  /** 格子の区画の置き場所ごとに、置いてある区画の番号。空きは NaN */
  private slotI = new Float64Array(SLOTS * SLOTS).fill(NaN);
  private slotJ = new Float64Array(SLOTS * SLOTS).fill(NaN);
  private slotTypes: BuildingType[][] = [];

  private gScore = new Float32Array(RING * RING);
  private came = new Int32Array(RING * RING);
  private stamp = new Uint32Array(RING * RING);
  private closed = new Uint32Array(RING * RING);
  private gen = 1;
  private heap = new MinHeap();

  constructor(index: MapIndex) {
    if (index.chunk !== CHUNK) throw new Error(`区画の大きさが合わない: ${index.chunk}`);
    this.index = index;
    this.name = index.name;
    this.w = index.width;
    this.h = index.height;
  }

  private slot(i: number, j: number) {
    return (i & (SLOTS - 1)) | ((j & (SLOTS - 1)) * SLOTS);
  }

  private loaded(cx: number, cy: number) {
    const i = chunkOf(cx), j = chunkOf(cy);
    const s = this.slot(i, j);
    return this.slotI[s] === i && this.slotJ[s] === j;
  }

  hasChunk(i: number, j: number) {
    return this.chunks.has(chunkKey(i, j));
  }

  /** 区画を格子に書き込む。同じ置き場所に別の区画があれば、それを捨てる */
  addChunk(c: ChunkJson) {
    const s = this.slot(c.i, c.j);
    if (!Number.isNaN(this.slotI[s])) this.removeChunk(this.slotI[s], this.slotJ[s]);
    const ground = decode(c.ground), solid = decode(c.solid), btype = decode(c.btype);
    const x0 = c.i * CHUNK, y0 = c.j * CHUNK;
    for (let y = 0; y < CHUNK; y++) {
      const row = ((y0 + y) & RING_MASK) * RING + (x0 & RING_MASK);
      const src = y * CHUNK;
      this.ground.set(ground.subarray(src, src + CHUNK), row);
      this.solid.set(solid.subarray(src, src + CHUNK), row);
      this.baseSolid.set(solid.subarray(src, src + CHUNK), row);
      this.btype.set(btype.subarray(src, src + CHUNK), row);
    }
    this.slotI[s] = c.i;
    this.slotJ[s] = c.j;
    this.slotTypes[s] = c.types;
    this.chunks.set(chunkKey(c.i, c.j), c);
    this.version++;
  }

  removeChunk(i: number, j: number) {
    const s = this.slot(i, j);
    if (this.slotI[s] !== i || this.slotJ[s] !== j) return;
    this.slotI[s] = NaN;
    this.slotJ[s] = NaN;
    this.chunks.delete(chunkKey(i, j));
    this.version++;
  }

  resetSolid() {
    this.solid.set(this.baseSolid);
  }

  /** 一番近い町名。町名のデータが無ければ null */
  areaAt(x: number, y: number): string | null {
    let best: string | null = null;
    let bd = Infinity;
    for (const a of this.index.areas) {
      const d = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = a.name;
      }
    }
    return best;
  }

  /** 読み込んでいない所は塞がっている扱いにする */
  blocked(cx: number, cy: number): boolean {
    if (!this.loaded(cx, cy)) return true;
    return this.solid[(cx & RING_MASK) | ((cy & RING_MASK) << RING_BITS)] !== Solid.free;
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

  /** 歩いて行ける場所か。変換で閉じた空き地を埋めてあるので、空いているマスはどれもつながっている */
  walkable(x: number, y: number): boolean {
    return !this.blocked(Math.floor(x), Math.floor(y));
  }

  solidAt(cx: number, cy: number): number {
    if (!this.loaded(cx, cy)) return Solid.building;
    return this.solid[(cx & RING_MASK) | ((cy & RING_MASK) << RING_BITS)];
  }

  groundAt(cx: number, cy: number): number {
    if (!this.loaded(cx, cy)) return Ground.outside;
    return this.ground[(cx & RING_MASK) | ((cy & RING_MASK) << RING_BITS)];
  }

  /** 遮蔽物のスキルで立てた壁を書き込む。resetSolid で元に戻る */
  setSolid(cx: number, cy: number, v: number) {
    if (!this.loaded(cx, cy)) return;
    this.solid[(cx & RING_MASK) | ((cy & RING_MASK) << RING_BITS)] = v;
  }

  /** そのマスの建物の種類。建物でなければ null */
  buildingAt(cx: number, cy: number): BuildingType | null {
    if (!this.loaded(cx, cy)) return null;
    const t = this.btype[(cx & RING_MASK) | ((cy & RING_MASK) << RING_BITS)];
    return t ? this.slotTypes[this.slot(chunkOf(cx), chunkOf(cy))][t - 1] : null;
  }

  findPath(a: Vec, b: Vec, maxNodes = 30000, avoid?: PathAvoid): Vec[] | null {
    const sx = Math.floor(a.x), sy = Math.floor(a.y);
    const tx = Math.floor(b.x), ty = Math.floor(b.y);
    if (this.blocked(tx, ty)) return null;
    // 出発点を真ん中にした RING 四方の中だけを探す。読み込んである範囲はこれより狭い
    const ox = sx - RING / 2, oy = sy - RING / 2;
    const idx = (x: number, y: number) => {
      const lx = x - ox, ly = y - oy;
      return lx < 0 || ly < 0 || lx >= RING || ly >= RING ? -1 : lx + ly * RING;
    };
    const start = idx(sx, sy), goal = idx(tx, ty);
    if (goal < 0) return null;
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
      const cx = (cur & RING_MASK) + ox, cy = (cur >> RING_BITS) + oy;
      const g = this.gScore[cur];
      for (const [dx, dy, cost] of dirs) {
        const nx = cx + dx, ny = cy + dy;
        if (this.blocked(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (this.blocked(cx + dx, cy) || this.blocked(cx, cy + dy))) continue;
        const n = idx(nx, ny);
        if (n < 0 || this.closed[n] === gen) continue;
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
    for (let c = goal; c !== -1; c = this.came[c]) cells.push({ x: (c & RING_MASK) + ox + 0.5, y: (c >> RING_BITS) + oy + 0.5 });
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
