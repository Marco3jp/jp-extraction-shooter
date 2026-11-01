import {
  BIN_CLUSTER_SIZE_WEIGHTS, BIN_CLUSTERS, BIN_ITEMS, BUILDING_USE, ENEMY, ENEMY_BULLET_SPEED_MUL, ENEMY_SHIELD, ENEMY_SPAWNS,
  GROUND_ITEMS, HEALTH_MAX, ITEMS, LOOT_AMMO_BIAS, LOOT_TABLE, PLAYER_FACTION, ROAMING_GROUP_RATE, SOLO_COUNT,
  LOOT_TILT, SOLO_FACTION_BASE, SOLO_KINDS,
  DASH, ENEMY_MIN_TTK, PASSIVES, ULT_START_READY, ULTS,
  type ActorStats, type AmmoId, type AttachmentId, type EnemyKind, type HealKind, type ItemId, type KitChoice,
  type SkillId, type StatMod, type ThrowableId, type UltId, type WeaponDef, type WeaponType,
} from "./data";
import type { RunLoadout } from "../meta/profile";
import { computeWeapon } from "./stats";
import { refreshStats } from "./skills";
import { bagAdd, makeBag, type Bag, type Stack } from "./inventory";
import { GameMap, Solid, type Vec } from "./map";
import { Rng } from "./rng";

export type WeaponState = { def: WeaponDef; mag: number };

export type Heal = { kind: HealKind; t: number; total: number; items: number };

export type AiState = "patrol" | "engage" | "retreat" | "push";

export type Ai = {
  state: AiState;
  group: number;
  home: Vec;
  path: Vec[];
  pathTarget: Vec | null;
  repathT: number;
  /** 狙っている相手。見えていなくても覚えている */
  target: number | null;
  lastSeen: Vec | null;
  lastSeenT: number;
  canSee: boolean;
  scanT: number;
  reactT: number;
  strafe: number;
  strafeT: number;
  stateT: number;
  waitT: number;
  heals: number;
  /** 巡回の中心を、ときどき遠くへ移す（漁りに出かける） */
  roam: boolean;
  /** 連射を続けている時間。burstLen を超えたら restT だけ撃つのをやめる */
  burstT: number;
  burstLen: number;
  restT: number;
};

/** ラン中に足したり外したりする修正。until が null なら外すまで続く（パッシブ・バフアイテム） */
export type ActorMod = { source: string; mods: StatMod[]; until: number | null };

/** 修正をかける前の性能。これに mods を積み上げて、武器の性能・移動速度などを計算し直す */
export type ActorBuild = {
  weapons: { type: WeaponType; attachments: AttachmentId[] }[];
  stats: ActorStats;
};

/** 持ち込んだスキル。Cd は次に使えるまで、T は効いている残り時間 */
export type Kit = KitChoice & { skillCd: number; skillT: number; ultCd: number; ultT: number };

export type Actor = {
  id: number;
  team: "player" | "enemy";
  kind: "player" | EnemyKind;
  /** 違う勢力どうしは撃ち合う。プレイヤーは 0、単独の敵は1人ずつ別の番号 */
  faction: number;
  pos: Vec;
  prev: Vec;
  vel: Vec;
  radius: number;
  facing: number;
  prevFacing: number;
  shield: number;
  shieldMax: number;
  health: number;
  /** 防具の重さなどによる移動速度の倍率 */
  moveMul: number;
  /** シールドより先に減る追加シールドと、消えるまでの残り時間 */
  overshield: number;
  overshieldT: number;
  /** 倒したときに回復するシールドの量 */
  killShield: number;
  /** null なら修正をかけない（敵） */
  build: ActorBuild | null;
  mods: ActorMod[];
  kit: Kit | null;
  weapons: WeaponState[];
  cur: number;
  swapT: number;
  reloadT: number;
  fireCd: number;
  /** ダッシュをやめた直後など、撃てるようになるまでの残り時間 */
  readyT: number;
  bloom: number;
  sprinting: boolean;
  /** ダッシュの残り時間・向き・速さ。dashSteer なら進む間に移動キーの向きへ曲がる */
  dashT: number;
  dashDir: Vec;
  dashSpeed: number;
  dashSteer: boolean;
  /** 溜まっているダッシュの回数・上限・次の1回が溜まるまでの時間 */
  dashCharges: number;
  dashMax: number;
  dashCd: number;
  /** 乗っているレール。dir が 1 なら a→b、-1 なら b→a へ進む */
  ride: { rail: number; dir: 1 | -1 } | null;
  /** テルミットの炎で足が遅くなっている残り時間 */
  burnT: number;
  heal: Heal | null;
  alive: boolean;
  /** 情報の見え方の段階（敵のみ）。0:なし 1:影 2:影＋型 3:影＋型＋体力 */
  info: number;
  /** 自分の視線が通っているか（敵のみ） */
  seen: boolean;
  /** 広域探知で、この時刻まで段階3で見える（敵のみ） */
  revealUntil: number;
  /** 倒されたときに落とす持ち物（敵のみ） */
  carry: Stack[];
  ai: Ai | null;
};

export type Bullet = {
  pos: Vec;
  prev: Vec;
  vel: Vec;
  damage: number;
  faction: number;
  owner: number;
  life: number;
  alive: boolean;
};

/** 飛んでいる投げ物。from から to へ放物線を描いて飛ぶ */
export type Grenade = {
  id: number;
  kind: ThrowableId;
  owner: number;
  from: Vec;
  to: Vec;
  /** 投げてからの経過時間と、着地までの時間 */
  t: number;
  flight: number;
  /** 投げた向き（テルミットはこれと直角に燃え広がる） */
  angle: number;
};

/** テルミットの炎。a から b までの線分に沿って燃える */
export type Fire = {
  id: number;
  owner: number;
  a: Vec;
  b: Vec;
  t: number;
  tickT: number;
};

/** 遮蔽物のスキルで立てた壁。cells は map.solid の添字 */
export type Barrier = { id: number; owner: number; cells: number[]; hp: number; until: number };

export type Rail = { id: number; owner: number; a: Vec; b: Vec; until: number };

/** 巻き検知の円。next の時刻に置き直す */
export type HealMark = { actor: number; pos: Vec; next: number };

export type LootKind = "ground" | "bin" | "deathbox";

export type Loot = {
  id: number;
  pos: Vec;
  kind: LootKind;
  items: Stack[];
  opened: boolean;
  /** 箱の向き（描画用） */
  angle: number;
};

export type GameEvent =
  | { type: "shot"; actor: number; pos: Vec; faction: number }
  | { type: "hit"; actor: number; by: number; pos: Vec; shield: boolean; amount: number }
  | { type: "wallHit"; pos: Vec }
  | { type: "shieldBreak"; actor: number; pos: Vec }
  | { type: "reloadStart"; actor: number; pos: Vec }
  | { type: "healStart"; actor: number; pos: Vec; kind: HealKind }
  | { type: "healDone"; actor: number; pos: Vec }
  | { type: "healCancel"; actor: number; pos: Vec }
  | { type: "swap"; actor: number; pos: Vec }
  | { type: "death"; actor: number; by: number; pos: Vec }
  | { type: "pickup"; text: string }
  | { type: "lootChanged" }
  | { type: "lootOpened"; loot: number }
  | { type: "notice"; text: string }
  | { type: "throw"; actor: number; pos: Vec; kind: ThrowableId }
  | { type: "explosion"; pos: Vec; radius: number }
  | { type: "fireStart"; a: Vec; b: Vec }
  | { type: "dash"; actor: number; pos: Vec; dir: Vec }
  | { type: "extractCall"; pos: Vec }
  | { type: "extractReady"; pos: Vec }
  | { type: "skill"; actor: number; pos: Vec; id: SkillId | UltId }
  | { type: "barrierBreak"; pos: Vec }
  | { type: "killShield"; actor: number; amount: number };

export type Outcome = "playing" | "dead" | "extracted";

/** 脱出地点。E で呼ぶと readyAt に迎えが来て、それから中に EXTRACT_TIME いれば脱出できる */
export type Extract = {
  pos: Vec;
  /** 迎えが来る時刻。呼んでいなければ null */
  readyAt: number | null;
  ready: boolean;
  progress: number;
};

export type World = {
  map: GameMap;
  rng: Rng;
  seed: number;
  time: number;
  tick: number;
  actors: Actor[];
  player: Actor;
  bullets: Bullet[];
  grenades: Grenade[];
  fires: Fire[];
  barriers: Barrier[];
  rails: Rail[];
  healMarks: HealMark[];
  loot: Loot[];
  /** 箱や落ちている物が変わるたびに増える（描画の作り直し用） */
  lootVersion: number;
  bag: Bag;
  extracts: Extract[];
  events: GameEvent[];
  outcome: Outcome;
  kills: number;
  debug: { sightLevel: number; beaconLevel: number };
  nextId: number;
};

function makeActor(id: number, team: Actor["team"], kind: Actor["kind"], faction: number, pos: Vec, weapons: WeaponDef[], shieldMax: number): Actor {
  return {
    id, team, kind, faction,
    pos: { ...pos }, prev: { ...pos }, vel: { x: 0, y: 0 },
    radius: 0.42,
    facing: 0, prevFacing: 0,
    shield: shieldMax, shieldMax, health: HEALTH_MAX, moveMul: 1,
    overshield: 0, overshieldT: 0, killShield: 0,
    build: null, mods: [], kit: null,
    weapons: weapons.map((def) => ({ def, mag: def.mag })),
    cur: 0, swapT: 0, reloadT: 0, fireCd: 0, readyT: 0, bloom: 0,
    sprinting: false,
    dashT: 0, dashDir: { x: 0, y: 0 }, dashSpeed: 0, dashSteer: false,
    dashCharges: 1, dashMax: 1, dashCd: 0,
    ride: null,
    burnT: 0,
    heal: null, alive: true,
    info: 0, seen: false, revealUntil: 0,
    carry: [],
    ai: null,
  };
}

/** preferAmmo を渡すと、弾薬が出たときに一定の確率でその弾薬に置き換える。tilt は出やすさに掛ける倍率 */
export function rollStack(rng: Rng, preferAmmo: AmmoId[] = [], tilt: Partial<Record<ItemId, number>> = {}): Stack {
  const weight = (t: (typeof LOOT_TABLE)[number]) => t.weight * (tilt[t.item] ?? 1);
  const total = LOOT_TABLE.reduce((a, t) => a + weight(t), 0);
  let r = rng.next() * total;
  for (const t of LOOT_TABLE) {
    if ((r -= weight(t)) < 0) {
      if (ITEMS[t.item].category === "ammo" && preferAmmo.length && rng.chance(LOOT_AMMO_BIAS)) {
        const want = rng.pick(preferAmmo);
        const wt = LOOT_TABLE.find((x) => x.item === want)!;
        return { item: want, count: wt.min + rng.int(wt.max - wt.min + 1) };
      }
      let count = t.min + rng.int(t.max - t.min + 1);
      if (t.item === "money") count = Math.round(count / 10) * 10;
      return { item: t.item, count };
    }
  }
  return { item: "rifle", count: 30 };
}

const enemyWeapons = new Map<EnemyKind, WeaponDef>();
function enemyWeapon(kind: EnemyKind): WeaponDef {
  let w = enemyWeapons.get(kind);
  if (!w) {
    const spec = ENEMY[kind].weapon;
    const base = computeWeapon(spec.type, spec.attachments, [], ENEMY_MIN_TTK);
    w = { ...base, bulletSpeed: base.bulletSpeed * ENEMY_BULLET_SPEED_MUL };
    enemyWeapons.set(kind, w);
  }
  return w;
}

function pickWeighted(rng: Rng, weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) < 0) return i;
  return weights.length - 1;
}

/** start を渡すと、その近くの空いている場所から始める（キャンプ）。渡さなければマップの出発地点から */
export function createWorld(map: GameMap, seed: number, loadout: RunLoadout, start?: Vec): World {
  const rng = new Rng(seed);
  const W = map.w;

  const nearestFree = (px: number, py: number, mask: Uint8Array): Vec => {
    const tx = Math.floor(px), ty = Math.floor(py);
    for (let r = 0; r < 300; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = tx + dx, y = ty + dy;
          if (map.blocked(x, y)) continue;
          if (!mask[x + y * W]) continue;
          if (map.blocked(x + 1, y) || map.blocked(x - 1, y) || map.blocked(x, y + 1) || map.blocked(x, y - 1)) continue;
          return { x: x + 0.5, y: y + 0.5 };
        }
      }
    }
    throw new Error("空いている場所が見つからない");
  };

  map.resetSolid();
  const layout = map.json.layout;
  map.setReachMain();
  const reach = map.reach!;
  const startPos = start
    ? nearestFree(start.x, start.y, reach)
    : nearestFree(layout.start[0] * map.w, layout.start[1] * map.h, reach);
  const extracts: Extract[] = layout.extracts.map(([fx, fy]) => ({
    pos: nearestFree(fx * map.w, fy * map.h, reach), readyAt: null, ready: false, progress: 0,
  }));

  const freeCells: number[] = [];
  const wallSideCells: number[] = [];
  for (let i = 0; i < reach.length; i++) {
    if (!reach[i]) continue;
    const x = i % W, y = (i / W) | 0;
    if (x < 2 || y < 2 || x >= map.w - 2 || y >= map.h - 2) continue;
    freeCells.push(i);
    if (map.solid[i + 1] === Solid.building || map.solid[i - 1] === Solid.building || map.solid[i + W] === Solid.building || map.solid[i - W] === Solid.building) {
      wallSideCells.push(i);
    }
  }
  const cellPos = (i: number): Vec => ({ x: (i % W) + 0.5, y: ((i / W) | 0) + 0.5 });
  const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

  let nextId = 1;
  const player = makeActor(nextId++, "player", "player", PLAYER_FACTION, startPos, loadout.weapons, loadout.shieldMax);
  player.facing = -Math.PI / 2;
  player.build = {
    weapons: loadout.builds,
    stats: { moveMul: loadout.moveMul, shieldMax: loadout.shieldMax, dashCharges: DASH.charges, killShield: 0 },
  };
  const kit = loadout.kit;
  player.kit = { ...kit, skillCd: 0, skillT: 0, ultCd: ULT_START_READY ? 0 : ULTS[kit.ult].cooldown, ultT: 0 };
  const passive = PASSIVES[kit.passive].mods;
  if (passive) player.mods.push({ source: `passive:${kit.passive}`, mods: passive, until: null });
  refreshStats(player);
  player.shield = player.shieldMax;
  player.dashCharges = player.dashMax;
  for (const ws of player.weapons) ws.mag = ws.def.mag;
  const preferAmmo = loadout.weapons.map((w) => w.ammo);
  const actors: Actor[] = [player];

  const spawnEnemy = (kind: EnemyKind, faction: number, pos: Vec, group: number, roam: boolean) => {
    const e = makeActor(nextId++, "enemy", kind, faction, pos, [enemyWeapon(kind)], ENEMY_SHIELD);
    e.facing = rng.range(-Math.PI, Math.PI);
    e.ai = {
      state: "patrol", group, home: { ...pos },
      path: [], pathTarget: null, repathT: 0,
      target: null, lastSeen: null, lastSeenT: 0, canSee: false, scanT: rng.next() * 0.2, reactT: 0,
      strafe: 1, strafeT: 0, stateT: 0, waitT: rng.range(0, 3),
      heals: 2,
      roam,
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
    actors.push(e);
  };

  const anchors: Vec[] = [];
  const pickSpot = (area: [number, number, number, number], minFromStart: number, minFromAnchors: number): Vec => {
    const inArea = freeCells.filter((i) => {
      const x = (i % W) / map.w, y = ((i / W) | 0) / map.h;
      return x >= area[0] && x <= area[2] && y >= area[1] && y <= area[3];
    });
    for (let d = minFromAnchors; d >= 10; d -= 10) {
      for (let tries = 0; tries < 300; tries++) {
        const p = cellPos(rng.pick(inArea));
        if (dist(p, startPos) < minFromStart) continue;
        if (anchors.some((o) => dist(p, o) < d)) continue;
        return p;
      }
    }
    return cellPos(rng.pick(inArea));
  };

  let groupId = 0;
  for (const spec of ENEMY_SPAWNS) {
    for (const members of spec.groups) {
      const center = pickSpot(layout.factionAreas[String(spec.faction)] ?? [0, 0, 1, 1], 80, 45);
      anchors.push(center);
      const gid = groupId++;
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
        spawnEnemy(kind, spec.faction, p, gid, roam);
      }
    }
  }
  for (let s = 0; s < SOLO_COUNT; s++) {
    const p = pickSpot([0, 0, 1, 1], 60, 35);
    anchors.push(p);
    spawnEnemy(rng.pick(SOLO_KINDS), SOLO_FACTION_BASE + s, p, 1000 + s, true);
  }

  const loot: Loot[] = [];
  const lootAt = (p: Vec, d: number) => loot.some((l) => dist(l.pos, p) < d);
  /** 箱が接している建物の用途に合わせた、出やすさの倍率 */
  const tiltAt = (i: number) => {
    for (const n of [i - W, i + W, i - 1, i + 1]) {
      const b = map.buildingIndex[n];
      if (b >= 0) return LOOT_TILT[BUILDING_USE[map.json.buildings[b].type]] ?? {};
    }
    return {};
  };
  const wallAngle = (i: number) => {
    if (map.solid[i - W] === Solid.building || map.solid[i + W] === Solid.building) return 0;
    return Math.PI / 2;
  };

  for (let c = 0; c < BIN_CLUSTERS; c++) {
    let center: number | null = null;
    for (let tries = 0; tries < 200; tries++) {
      const i = rng.pick(wallSideCells);
      const p = cellPos(i);
      if (dist(p, startPos) < 10 || loot.some((l) => l.kind === "bin" && dist(l.pos, p) < 28)) continue;
      center = i;
      break;
    }
    if (center === null) continue;
    const n = 1 + pickWeighted(rng, BIN_CLUSTER_SIZE_WEIGHTS);
    const cp = cellPos(center);
    const near = wallSideCells.filter((i) => dist(cellPos(i), cp) < 7);
    let placed = 0;
    for (let tries = 0; tries < 60 && placed < n; tries++) {
      const i = placed === 0 ? center : rng.pick(near);
      const p = cellPos(i);
      if (lootAt(p, 1.6)) continue;
      const items: Stack[] = [];
      const tilt = tiltAt(i);
      for (let k = 0; k < BIN_ITEMS; k++) items.push(rollStack(rng, preferAmmo, tilt));
      loot.push({ id: nextId++, pos: p, kind: "bin", items, opened: false, angle: wallAngle(i) });
      placed++;
    }
  }

  for (let g = 0; g < GROUND_ITEMS; g++) {
    for (let tries = 0; tries < 50; tries++) {
      const p = cellPos(rng.pick(freeCells));
      p.x += rng.range(-0.3, 0.3);
      p.y += rng.range(-0.3, 0.3);
      if (dist(p, startPos) < 6 || lootAt(p, 4)) continue;
      loot.push({ id: nextId++, pos: p, kind: "ground", items: [rollStack(rng, preferAmmo)], opened: true, angle: rng.range(0, Math.PI) });
      break;
    }
  }

  const bag = makeBag(loadout.bagSlots);
  for (const [k, v] of loadout.startItems) bagAdd(bag, k, v);

  return {
    map, rng, seed,
    time: 0, tick: 0,
    actors, player,
    bullets: [], grenades: [], fires: [], barriers: [], rails: [], healMarks: [], loot, lootVersion: 1, bag,
    extracts,
    events: [],
    outcome: "playing",
    kills: 0,
    debug: { sightLevel: 3, beaconLevel: 1 },
    nextId,
  };
}
