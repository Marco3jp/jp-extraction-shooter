// 区画ごとの敵と箱。ランの seed と区画の番号から決めるので、同じランで区画を読み直すと同じものが出る
import {
  BIN_CLUSTER_SIZE_WEIGHTS, BIN_CLUSTERS_PER_10K, BIN_ITEMS, BUILDING_USE, ENEMY_SHIELD, ENEMY_SPAWNS, GROUND_ITEMS_PER_10K,
  GROUP_MIN_FROM_START, GROUPS_PER_10K, LOOT_TILT, ROAMING_GROUP_RATE, SOLO_FACTION_BASE, SOLO_KINDS, SOLO_MIN_FROM_START, SOLOS_PER_10K,
  type EnemyKind,
} from "./data";
import type { Stack } from "./inventory";
import { CHUNK, Ground, Solid, chunkKey, type LoadedChunk, type Vec } from "./map";
import { Rng } from "./rng";
import { enemyWeapon, makeActor, pickWeighted, rollStack, type Actor, type Loot, type World } from "./world";

/** 区画と、その区画の中で置いた順番 */
export type SpawnRef = { chunk: string; n: number };

/** 捨てた区画で変わったこと。loot の値が null なら拾われてなくなった */
export type ChunkMemory = { dead: Set<number>; loot: Map<number, { items: Stack[]; opened: boolean } | null> };

const FACTION_IDS = ENEMY_SPAWNS.map((f) => f.faction);

/** 町の勢力。町名だけで決めるので、ランが変わっても同じ */
export function townFaction(name: string | null): number {
  if (!name) return FACTION_IDS[0];
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return FACTION_IDS[(h >>> 0) % FACTION_IDS.length];
}

function chunkSeed(seed: number, i: number, j: number) {
  let h = (seed ^ Math.imul(i, 0x9e3779b1) ^ Math.imul(j, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

/** 敵を1人作る。w.actors には入れない */
export function makeEnemy(w: World, rng: Rng, kind: EnemyKind, faction: number, pos: Vec, group: number, roam: boolean): Actor {
  const e = makeActor(w.nextId++, "enemy", kind, faction, pos, [enemyWeapon(kind)], ENEMY_SHIELD);
  e.facing = rng.range(-Math.PI, Math.PI);
  e.ai = {
    state: "patrol", why: "", hold: "noTarget", group, home: { ...pos },
    path: [], pathTarget: null, repathT: 0,
    target: null, lastSeen: null, lastSeenT: 0, canSee: false, scanT: rng.next() * 0.2, reactT: 0,
    strafe: 1, strafeT: 0, stateT: 0, waitT: rng.range(0, 3),
    heals: 2,
    roam,
    outmatchedBy: null, playerHitT: -Infinity,
    burstT: 0, burstLen: 0.8, restT: 0,
  };
  const ammo = e.weapons[0].def.ammo;
  e.carry.push({ item: ammo, count: 30 + rng.int(4) * 10 });
  if (rng.chance(0.75)) e.carry.push({ item: "cell", count: 1 + rng.int(3) });
  if (rng.chance(0.5)) e.carry.push({ item: "medSmall", count: 1 + rng.int(2) });
  if (rng.chance(0.15)) e.carry.push({ item: "medLarge", count: 1 });
  if (rng.chance(0.5)) e.carry.push({ item: "junk", count: 2 + rng.int(4) });
  if (rng.chance(0.25)) e.carry.push({ item: "circuit", count: 1 + rng.int(2) });
  if (rng.chance(0.06)) e.carry.push({ item: "precision", count: 1 });
  e.carry.push({ item: "money", count: (10 + rng.int(60)) * 10 });
  return e;
}

function populate(w: World, c: LoadedChunk) {
  const key = chunkKey(c.i, c.j);
  const map = w.map;
  const rng = new Rng(chunkSeed(w.seed, c.i, c.j));
  const mem = w.memory.get(key);
  const x0 = c.i * CHUNK, y0 = c.j * CHUNK;
  // マップの外のマスも塞がっているが、建物の壁ではないので箱を寄せない
  const isBuilding = (x: number, y: number) => map.solidAt(x, y) === Solid.building && map.groundAt(x, y) !== Ground.outside;

  // 区画の外のマスは読んでいないことがあるので、縁の1マスには置かない
  const free: Vec[] = [];
  const wallSide: Vec[] = [];
  for (let y = y0 + 1; y < y0 + CHUNK - 1; y++) {
    for (let x = x0 + 1; x < x0 + CHUNK - 1; x++) {
      if (map.blocked(x, y)) continue;
      const p = { x: x + 0.5, y: y + 0.5 };
      free.push(p);
      if (isBuilding(x + 1, y) || isBuilding(x - 1, y) || isBuilding(x, y + 1) || isBuilding(x, y - 1)) wallSide.push(p);
    }
  }
  const lootNs: number[] = [];
  w.spawned.set(key, { loot: lootNs });
  for (const [ax, ay, bx, by] of c.rails) {
    w.rails.push({ id: w.nextFixed--, owner: null, chunk: key, a: { x: ax, y: ay }, b: { x: bx, y: by }, until: Infinity });
  }
  for (const [x, y, angle] of c.pads) w.pads.push({ id: w.nextFixed--, chunk: key, pos: { x, y }, angle });
  if (!free.length) return;

  const per10k = free.length / 10000;
  const count = (rate: number) => {
    const e = rate * per10k;
    return Math.floor(e) + (rng.next() < e - Math.floor(e) ? 1 : 0);
  };
  let n = 0;

  const spawnEnemy = (kind: EnemyKind, faction: number, pos: Vec, group: number, roam: boolean) => {
    const e = makeEnemy(w, rng, kind, faction, pos, group, roam);
    e.spawn = { chunk: key, n: n++ };
    // 倒した敵も同じだけ乱数を使ってから外す。後に置くものの中身を変えないため
    if (!mem?.dead.has(e.spawn.n)) w.actors.push(e);
  };

  const anchors: Vec[] = [];
  const pickSpot = (minFromStart: number, minFromAnchors: number): Vec | null => {
    for (let d = minFromAnchors; d >= 10; d -= 10) {
      for (let tries = 0; tries < 60; tries++) {
        const p = rng.pick(free);
        if (dist(p, w.startPos) < minFromStart) continue;
        if (anchors.some((o) => dist(p, o) < d)) continue;
        return p;
      }
    }
    return null;
  };

  const groups = count(GROUPS_PER_10K);
  for (let g = 0; g < groups; g++) {
    const center = pickSpot(GROUP_MIN_FROM_START, 45);
    if (!center) continue;
    anchors.push(center);
    const faction = townFaction(map.areaAt(center.x, center.y));
    const members = rng.pick(ENEMY_SPAWNS.find((f) => f.faction === faction)!.groups);
    const gid = w.nextGroup++;
    const roam = rng.chance(ROAMING_GROUP_RATE);
    for (const kind of members) {
      let p = center;
      for (let k = 0; k < 30; k++) {
        const q = { x: center.x + rng.range(-4, 4), y: center.y + rng.range(-4, 4) };
        if (!map.blockedAt(q.x, q.y) && map.los(center, q)) {
          p = q;
          break;
        }
      }
      spawnEnemy(kind, faction, p, gid, roam);
    }
  }
  const solos = count(SOLOS_PER_10K);
  for (let s = 0; s < solos; s++) {
    const p = pickSpot(SOLO_MIN_FROM_START, 35);
    if (!p) continue;
    anchors.push(p);
    spawnEnemy(rng.pick(SOLO_KINDS), SOLO_FACTION_BASE + w.nextSolo, p, 1000 + w.nextSolo, true);
    w.nextSolo++;
  }

  const placed: Loot[] = [];
  const lootAt = (p: Vec, d: number) => placed.some((l) => dist(l.pos, p) < d);
  const addLoot = (l: Omit<Loot, "id" | "spawn">) => {
    const sn = n++;
    lootNs.push(sn);
    const loot: Loot = { ...l, id: w.nextId++, spawn: { chunk: key, n: sn } };
    placed.push(loot);
    const was = mem?.loot.get(sn);
    if (was === null) return;
    if (was) {
      loot.items = was.items;
      loot.opened = was.opened;
    }
    w.loot.push(loot);
  };
  /** 箱が接している建物の用途に合わせた、出やすさの倍率 */
  const tiltAt = (p: Vec) => {
    const x = Math.floor(p.x), y = Math.floor(p.y);
    for (const [nx, ny] of [[x, y - 1], [x, y + 1], [x - 1, y], [x + 1, y]]) {
      const b = map.buildingAt(nx, ny);
      if (b) return LOOT_TILT[BUILDING_USE[b]] ?? {};
    }
    return {};
  };
  const wallAngle = (p: Vec) => {
    const x = Math.floor(p.x), y = Math.floor(p.y);
    return isBuilding(x, y - 1) || isBuilding(x, y + 1) ? 0 : Math.PI / 2;
  };

  const clusters = wallSide.length ? count(BIN_CLUSTERS_PER_10K) : 0;
  for (let k = 0; k < clusters; k++) {
    let center: Vec | null = null;
    for (let tries = 0; tries < 200; tries++) {
      const p = rng.pick(wallSide);
      if (dist(p, w.startPos) < 10 || placed.some((l) => l.kind === "bin" && dist(l.pos, p) < 28)) continue;
      center = p;
      break;
    }
    if (!center) continue;
    const size = 1 + pickWeighted(rng, BIN_CLUSTER_SIZE_WEIGHTS);
    const cp = center;
    const near = wallSide.filter((p) => dist(p, cp) < 7);
    let made = 0;
    for (let tries = 0; tries < 60 && made < size; tries++) {
      const p = made === 0 ? cp : rng.pick(near);
      if (lootAt(p, 1.6)) continue;
      const items: Stack[] = [];
      const tilt = tiltAt(p);
      for (let b = 0; b < BIN_ITEMS; b++) items.push(rollStack(rng, w.preferAmmo, tilt));
      addLoot({ pos: { ...p }, kind: "bin", items, opened: false, angle: wallAngle(p) });
      made++;
    }
  }

  const grounds = count(GROUND_ITEMS_PER_10K);
  for (let g = 0; g < grounds; g++) {
    for (let tries = 0; tries < 50; tries++) {
      const c0 = rng.pick(free);
      const p = { x: c0.x + rng.range(-0.3, 0.3), y: c0.y + rng.range(-0.3, 0.3) };
      if (dist(p, w.startPos) < 6 || lootAt(p, 4)) continue;
      addLoot({ pos: p, kind: "ground", items: [rollStack(rng, w.preferAmmo)], opened: true, angle: rng.range(0, Math.PI) });
      break;
    }
  }
  w.lootVersion++;
}

/** 区画を捨てるときに、その区画の敵（グループの全員）・箱・固定レール・ダッシュパッドを外し、倒した敵と箱の中身を覚えておく */
function depopulate(w: World, key: string) {
  const sp = w.spawned.get(key)!;
  w.spawned.delete(key);
  const mem = w.memory.get(key) ?? { dead: new Set<number>(), loot: new Map() };
  w.memory.set(key, mem);
  w.actors = w.actors.filter((a) => {
    if (a.spawn?.chunk !== key) return true;
    if (!a.alive) mem.dead.add(a.spawn.n);
    return false;
  });
  const left = new Set<number>();
  w.loot = w.loot.filter((l) => {
    if (l.spawn?.chunk !== key) return true;
    left.add(l.spawn.n);
    mem.loot.set(l.spawn.n, { items: l.items, opened: l.opened });
    return false;
  });
  for (const n of sp.loot) if (!left.has(n)) mem.loot.set(n, null);
  w.rails = w.rails.filter((r) => r.chunk !== key);
  w.pads = w.pads.filter((p) => p.chunk !== key);
  if (w.focus && !w.actors.some((a) => a.id === w.focus!.actor)) w.focus = null;
  w.lootVersion++;
}

/** GameMap に置いてある区画と、敵と箱を置いた区画を揃える */
export function syncSpawns(w: World) {
  for (const key of [...w.spawned.keys()]) if (!w.map.chunks.has(key)) depopulate(w, key);
  for (const [key, c] of w.map.chunks) if (!w.spawned.has(key)) populate(w, c);
}
