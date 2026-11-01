import { CHUNK, chunkKey, type GameMap, type LoadedChunk, type Vec } from "./sim/map";

export type StreamRange = {
  /** この距離（m）以内にかかる区画を読む */
  load: number;
  /** この距離より遠い区画を捨てる。load との差で、境目を行き来しても出し入れを繰り返さない */
  drop: number;
  /** 今の速さでこの秒数だけ進んだ先も、load の距離まで読む */
  lookahead: number;
};

export const STREAM_RANGE: StreamRange = { load: 640, drop: 900, lookahead: 8 };

/** 点から区画の四角までの距離 */
function chunkDist(p: Vec, i: number, j: number) {
  const dx = Math.max(i * CHUNK - p.x, 0, p.x - (i + 1) * CHUNK);
  const dy = Math.max(j * CHUNK - p.y, 0, p.y - (j + 1) * CHUNK);
  return Math.hypot(dx, dy);
}

/** プレイヤーの位置に合わせて、区画を読んで GameMap に置き、遠くなったら捨てる */
export class ChunkStreamer {
  private exists: Set<string>;
  private pending = new Set<string>();
  private arrived: LoadedChunk[] = [];
  loads = 0;
  drops = 0;

  constructor(
    private map: GameMap,
    private fetchChunk: (i: number, j: number) => Promise<LoadedChunk>,
    private range: StreamRange = STREAM_RANGE,
    /** 1回の update で GameMap に置く区画の数 */
    private perUpdate = 2,
  ) {
    this.exists = new Set(map.index.chunks.map(([i, j]) => chunkKey(i, j)));
  }

  private within(points: Vec[], r: number): [number, number][] {
    const out: [number, number][] = [];
    const seen = new Set<string>();
    for (const p of points) {
      for (let j = Math.floor((p.y - r) / CHUNK); j <= Math.floor((p.y + r) / CHUNK); j++) {
        for (let i = Math.floor((p.x - r) / CHUNK); i <= Math.floor((p.x + r) / CHUNK); i++) {
          const key = chunkKey(i, j);
          if (seen.has(key) || !this.exists.has(key) || chunkDist(p, i, j) > r) continue;
          seen.add(key);
          out.push([i, j]);
        }
      }
    }
    return out;
  }

  private request(i: number, j: number) {
    const key = chunkKey(i, j);
    if (this.map.hasChunk(i, j) || this.pending.has(key)) return;
    this.pending.add(key);
    this.fetchChunk(i, j).then(
      (c) => {
        this.pending.delete(key);
        this.arrived.push(c);
      },
      (e) => {
        this.pending.delete(key);
        console.error(e);
      },
    );
  }

  /** 欲しい区画を頼み、届いた区画を近い順に perUpdate 個まで置き、遠い区画を捨てる。dest は行き先が先に分かる移動の行き先 */
  update(pos: Vec, vel: Vec, dest: Vec | null = null) {
    const ahead = { x: pos.x + vel.x * this.range.lookahead, y: pos.y + vel.y * this.range.lookahead };
    const points = dest ? [pos, ahead, dest] : [pos, ahead];
    const near = (i: number, j: number) => Math.min(...points.map((p) => chunkDist(p, i, j)));
    const wanted = this.within(points, this.range.load).sort((a, b) => near(...a) - near(...b));
    for (const [i, j] of wanted) this.request(i, j);

    this.arrived = this.arrived.filter((c) => near(c.i, c.j) <= this.range.drop);
    this.arrived.sort((a, b) => near(a.i, a.j) - near(b.i, b.j));
    for (const c of this.arrived.splice(0, this.perUpdate)) this.place(c);

    for (const c of [...this.map.chunks.values()]) {
      if (near(c.i, c.j) <= this.range.drop) continue;
      this.map.removeChunk(c.i, c.j);
      this.drops++;
    }
  }

  private place(c: LoadedChunk) {
    if (this.map.hasChunk(c.i, c.j)) return;
    this.map.addChunk(c);
    this.loads++;
  }

  /** p から r 以内の区画を全部置き終えるまで待つ。出撃の前に使う。読めなかった区画は飛ばす */
  async loadAround(p: Vec, r = this.range.load) {
    const wanted = this.within([p], r).filter(([i, j]) => !this.map.hasChunk(i, j));
    const got = await Promise.allSettled(wanted.map(([i, j]) => this.fetchChunk(i, j)));
    for (const g of got) {
      if (g.status === "fulfilled") this.place(g.value);
      else console.error(g.reason);
    }
  }
}
