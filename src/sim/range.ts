// 射撃場。拠点から入り、出撃準備の組み立てのまま的を撃って数値を確かめる。弾薬・回復・投げ物は減らず、プレイヤーは倒れない
import type { BuildingType } from "../data/buildings";
import { ENEMY_SHIELD, HEALTH_MAX, ITEMS, SOLO_FACTION_BASE, START_AMMO_MAGS, type ItemId } from "./data";
import { weapon } from "./combat";
import { bagAdd, bagCount } from "./inventory";
import { CHUNK, Ground, Solid, chunkOf, type GameMap, type LoadedChunk, type MapBuilding, type MapCover, type Markings, type Vec } from "./map";
import type { RunLoadout } from "../meta/profile";
import { createWorld, enemyWeapon, makeActor, type Actor, type World } from "./world";

/** 射撃場の線から的までの距離（m） */
const DISTANCES = [10, 20, 35, 50, 70];
/** 区画の中での位置（m）。プレイヤーは下の端の真ん中に立ち、上へ向かって撃つ */
const LINE_Y = 118;
const STATIC_X = 52;
const MOVING_X = 78;
/** 動く的が往復する幅の半分（m）と速さ（m/秒）。敵が撃ち合いながら横へ動く速さに近づけてある（仮） */
const MOVING = { amp: 5, speed: 4.5 };
/** 倒した的が元に戻るまでの秒数と、当てるのをやめてから体力が戻るまでの秒数（仮） */
const RESPAWN_T = 2;
const RESET_T = 3;
/** DPS は直近この秒数に当てたダメージから出す */
const DPS_SPAN = 3;
/** 倒すまでの時間を覚えておく数 */
const KILL_LOG = 6;
/** 回復と投げ物は、減らない分としてこの数を持たせる */
const STOCK: [ItemId, number][] = [
  ["cell", 4],
  ["medSmall", 2],
  ["medLarge", 1],
  ["ultCharge", 1],
  ["frag", 3],
  ["thermite", 3],
];
/** 区画の建物の番号。見た目のばらつきの種にしか使わないので、地図の建物と重ならない大きな数にする */
const WALL_ID_BASE = 900_000_000;

export type RangeTarget = {
  actor: number;
  /** 倒れた後に戻る場所。動く的は、ここを真ん中に往復する */
  home: Vec;
  distance: number;
  moving: boolean;
  dir: 1 | -1;
  /** 体力が満タンのときに最初に当てた時刻。体力が戻ったら null */
  firstHitT: number | null;
  lastHitT: number;
  deadT: number | null;
};

export type RangeKill = { weapon: string; distance: number; moving: boolean; time: number };

export type RangeState = {
  chunk: [number, number];
  targets: RangeTarget[];
  /** 減らないように毎ティック戻す持ち物と、その数 */
  stock: [ItemId, number][];
  pelletsFired: number;
  pelletsHit: number;
  /** 直近 DPS_SPAN 秒に当てたダメージ */
  recent: { t: number; amount: number }[];
  kills: RangeKill[];
};

/** 射撃場の区画の番号。地図の範囲から十分離して、地図の区画を読み込む距離に入らないようにする */
export function rangeChunk(map: GameMap): [number, number] {
  return [chunkOf(Math.floor(map.bounds[0])) - 40, chunkOf(Math.floor(map.bounds[1]))];
}

export function rangeStart(map: GameMap): Vec {
  const [i, j] = rangeChunk(map);
  return { x: i * CHUNK + CHUNK / 2, y: j * CHUNK + LINE_Y };
}

export function buildRangeChunk(i: number, j: number): LoadedChunk {
  const x0 = i * CHUNK, y0 = j * CHUNK;
  const ground = new Uint8Array(CHUNK * CHUNK).fill(Ground.lot);
  const solid = new Uint8Array(CHUNK * CHUNK);
  const btype = new Uint8Array(CHUNK * CHUNK);
  const types: BuildingType[] = ["industrial"];
  const buildings: MapBuilding[] = [];
  const covers: MapCover[] = [];

  const fill = (lx: number, ly: number, w: number, h: number, f: (k: number) => void) => {
    for (let y = ly; y < ly + h; y++) for (let x = lx; x < lx + w; x++) f(x + y * CHUNK);
  };
  // 区画の外は読み込んでいないので塞がっている扱いになるが、見た目で端が分かるように外周に建物を置く
  const WALL = 3;
  const walls: [number, number, number, number][] = [
    [0, 0, CHUNK, WALL], [0, CHUNK - WALL, CHUNK, WALL], [0, WALL, WALL, CHUNK - WALL * 2], [CHUNK - WALL, WALL, WALL, CHUNK - WALL * 2],
  ];
  walls.forEach(([lx, ly, w, h], k) => {
    fill(lx, ly, w, h, (n) => {
      solid[n] = Solid.building;
      btype[n] = 1;
    });
    buildings.push({ id: WALL_ID_BASE + k, kind: "wall", type: "industrial", h: 10, front: 2, rects: [[x0 + lx, y0 + ly, w, h]] });
  });
  // 撃つ位置の床と、左右に置いた低い遮蔽
  fill(WALL, LINE_Y - 2, CHUNK - WALL * 2, CHUNK - WALL - LINE_Y + 2, (n) => (ground[n] = Ground.sidewalk));
  for (const [lx, ly] of [[40, 113], [84, 113]] as const) {
    fill(lx, ly, 4, 1, (n) => (solid[n] = Solid.cover));
    covers.push({ id: covers.length + 1, kind: "barrier", x: x0 + lx, y: y0 + ly, w: 4, h: 1 });
  }

  const markings: Markings = { crosswalks: [], stops: [], lines: [], manholes: [] };
  markings.lines.push({ pts: [[x0 + WALL, y0 + LINE_Y - 2], [x0 + CHUNK - WALL, y0 + LINE_Y - 2]], dash: false });
  const signs: LoadedChunk["signs"] = [];
  for (const d of DISTANCES) {
    const y = y0 + LINE_Y - d;
    markings.lines.push({ pts: [[x0 + 30, y], [x0 + 100, y]], dash: true });
    signs.push({ kind: "street", x: x0 + 34, y, text: [`${d}m`] });
  }

  return { i, j, ground, solid, btype, types, buildings, covers, markings, signs, rails: [], pads: [] };
}

/** 出撃準備の組み立てから、射撃場へ持ち込む分。パートナー・設置物・蘇生アイテム・長距離移動は持ち込まない */
function rangeLoadout(run: RunLoadout): { loadout: RunLoadout; stock: [ItemId, number][] } {
  const stock: [ItemId, number][] = [...run.weapons.map((w): [ItemId, number] => [w.ammo, w.mag * START_AMMO_MAGS]), ...STOCK];
  const slots = stock.reduce((n, [item, c]) => n + Math.ceil(c / ITEMS[item].stack), 0);
  return {
    loadout: {
      ...run,
      bagSlots: slots,
      secureSlots: 0,
      revive: 0,
      startItems: stock,
      partners: [],
      devices: { carried: { sensor: 0, turret: 0 }, placed: [] },
    },
    stock,
  };
}

export function createRangeWorld(map: GameMap, run: RunLoadout): World {
  const { loadout, stock } = rangeLoadout(run);
  const chunk = rangeChunk(map);
  const range: RangeState = { chunk, targets: [], stock, pelletsFired: 0, pelletsHit: 0, recent: [], kills: [] };
  const w = createWorld(map, 1, loadout, rangeStart(map), range);
  w.extracts = [];
  const x0 = chunk[0] * CHUNK, y0 = chunk[1] * CHUNK;
  for (const d of DISTANCES) {
    for (const moving of [false, true]) {
      const home = { x: x0 + (moving ? MOVING_X : STATIC_X) + 0.5, y: y0 + LINE_Y - d + 0.5 };
      // 敵と同じシールドとヘルス。理論 TTK の相手の体力と揃う。ai を持たないので武器は撃たない
      const a = makeActor(w.nextId++, "enemy", "mid", SOLO_FACTION_BASE, home, [enemyWeapon("mid")], ENEMY_SHIELD);
      a.facing = Math.PI / 2;
      w.actors.push(a);
      range.targets.push({ actor: a.id, home, distance: d, moving, dir: 1, firstHitT: null, lastHitT: -Infinity, deadT: null });
    }
  }
  return w;
}

function restore(a: Actor) {
  a.shield = a.shieldMax;
  a.health = HEALTH_MAX;
}

/** step の最後に呼ぶ。このティックの出来事を数え、的を動かし、減った持ち物を戻す */
export function tickRange(w: World) {
  const r = w.range!;
  const p = w.player;
  const byId = new Map(w.actors.map((a) => [a.id, a]));
  const targetOf = new Map(r.targets.map((t) => [t.actor, t]));
  for (const ev of w.events) {
    if (ev.type === "shot" && ev.actor === p.id) {
      r.pelletsFired += weapon(p).def.pellets;
    } else if (ev.type === "hit" && ev.by === p.id) {
      const t = targetOf.get(ev.actor);
      if (!t) continue;
      t.firstHitT ??= w.time;
      t.lastHitT = w.time;
      r.recent.push({ t: w.time, amount: ev.amount });
    } else if (ev.type === "death") {
      const t = targetOf.get(ev.actor);
      if (!t) continue;
      t.deadT = w.time;
      if (ev.by === p.id && t.firstHitT !== null) {
        r.kills.unshift({ weapon: weapon(p).def.name, distance: t.distance, moving: t.moving, time: w.time - t.firstHitT });
        r.kills.length = Math.min(r.kills.length, KILL_LOG);
      }
    }
  }
  r.recent = r.recent.filter((h) => w.time - h.t <= DPS_SPAN);

  for (const t of r.targets) {
    const a = byId.get(t.actor)!;
    if (!a.alive) {
      a.vel = { x: 0, y: 0 };
      t.deadT ??= w.time;
      if (w.time - t.deadT >= RESPAWN_T) {
        a.alive = true;
        a.pos = { ...t.home };
        a.prev = { ...t.home };
        restore(a);
        t.deadT = null;
        t.firstHitT = null;
      }
      continue;
    }
    if (t.firstHitT !== null && w.time - t.lastHitT >= RESET_T) {
      restore(a);
      t.firstHitT = null;
    }
    if (t.moving) {
      if (a.pos.x >= t.home.x + MOVING.amp) t.dir = -1;
      else if (a.pos.x <= t.home.x - MOVING.amp) t.dir = 1;
      a.vel = { x: t.dir * MOVING.speed, y: 0 };
    }
  }

  for (const [item, n] of r.stock) {
    const lack = n - bagCount(w.bag, item);
    if (lack > 0) bagAdd(w.bag, item, lack);
  }
}

/** 射撃場の画面に出す数値 */
export function rangeReadout(w: World) {
  const r = w.range!;
  return {
    dps: r.recent.reduce((s, h) => s + h.amount, 0) / DPS_SPAN,
    accuracy: r.pelletsFired > 0 ? r.pelletsHit / r.pelletsFired : null,
    weapon: weapon(w.player).def,
    kills: r.kills,
  };
}
