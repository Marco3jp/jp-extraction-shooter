import {
  ENEMY, ENEMY_BULLET_SPEED_MUL, HEALTH_MAX, ITEMS, LOOT_AMMO_BIAS, LOOT_TABLE, PLAYER_FACTION, DASH, ENEMY_MIN_TTK, PASSIVES, PARTNER, PARTNER_MODELS, PARTNER_SLOTS, PARTNER_TACTICS, PLAYER_MIN_TTK, ULT_START_READY, ULTS,
  type ActorStats, type BuffId, type AmmoId, type AttachmentId, type EnemyKind, type HealKind, type ItemId, type KitChoice,
  type SkillId, type StatMod, type ThrowableId, type UltId, type WeaponDef, type WeaponType,
} from "./data";
import type { RunLoadout } from "../meta/profile";
import { computeWeapon } from "./stats";
import { refreshStats } from "./skills";
import { bagAdd, makeBag, type Bag, type Stack } from "./inventory";
import { GameMap, type Vec } from "./map";
import { Rng } from "./rng";
import { syncSpawns, type ChunkMemory, type SpawnRef } from "./spawn";

export type WeaponState = { def: WeaponDef; mag: number };

export type Heal = { kind: HealKind; t: number; total: number; items: number };

/** patrol〜push は敵、follow〜return はパートナー */
export type AiState = "patrol" | "engage" | "retreat" | "push" | "follow" | "fight" | "heal" | "return";

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
  /** 武器の理論 TTK の下限 */
  minTtk: number;
};

/** パートナーだけが持つ状態。index は 0 始まりの番号で、付く位置（左後ろ・右後ろ）も決める */
export type PartnerState = {
  index: number;
  model: 1 | 2;
  /** 倒れている間、起こしてもらっている秒数 */
  reviveT: number;
  /** 付く位置を決めるときのプレイヤーの向き。プレイヤーの向きへゆっくり寄せる */
  heading: number;
  /** 遮蔽へ引いてから使う回復 */
  healKind: HealKind | null;
  /** 撃ち合いで使っている遮蔽。hide は敵から隠れる所、peek は出て撃つ所、threat は探したときの敵の位置 */
  cover: { hide: Vec; peek: Vec; threat: Vec; t: number } | null;
  /** 隠れているか、出て撃っているか */
  phase: "hide" | "peek";
  /** 出たときのシールドとヘルスの合計。ここから減った分で隠れ直す */
  peekHp: number;
  /** 今隠れている間に、もう巻いたか。隠れるたびに1回だけ巻く */
  hideHealed: boolean;
};

/** 持ち込んだスキル。Cd は次に使えるまで、T は効いている残り時間 */
export type Kit = KitChoice & { skillCd: number; skillT: number; ultCd: number; ultT: number };

export type Actor = {
  id: number;
  team: "player" | "enemy" | "partner";
  kind: "player" | "partner" | EnemyKind;
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
  /** スキルとダッシュのクールダウンに掛ける倍率 */
  skillCdMul: number;
  dashCdMul: number;
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
  partner: PartnerState | null;
  /** 区画から置いた敵。プレイヤーとパートナーは null */
  spawn: SpawnRef | null;
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

/** 遮蔽物のスキルで立てた壁。cells はマスの座標 */
export type Barrier = { id: number; owner: number; cells: Vec[]; hp: number; until: number };

export type Rail = { id: number; owner: number; a: Vec; b: Vec; until: number };

/** 巻き検知の円。next の時刻に置き直す */
export type HealMark = { actor: number; pos: Vec; next: number };

export type LootKind = "ground" | "bin" | "deathbox";

export type Loot = {
  id: number;
  /** 区画から置いた箱・落ちている物。倒した敵の持ち物やプレイヤーが捨てた物は null */
  spawn: SpawnRef | null;
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
  | { type: "killShield"; actor: number; amount: number }
  | { type: "revive"; actor: number; pos: Vec };

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
  /** 同じ種類が効いているときに拾った強化パーツ。パートナーに渡せる */
  spareBuffs: BuffId[];
  /** プレイヤーが最後に当てた相手と、その時刻。パートナーが優先して狙う */
  focus: { actor: number; t: number } | null;
  debug: { sightLevel: number; beaconLevel: number };
  nextId: number;
  startPos: Vec;
  /** 持ち込んだ武器の弾薬。箱から出やすくする */
  preferAmmo: AmmoId[];
  /** 敵と箱を置いた区画と、そこに置いた箱・落ちている物の番号 */
  spawned: Map<string, { loot: number[] }>;
  /** 捨てた区画で、倒した敵と、中身が変わった箱・拾われた物 */
  memory: Map<string, ChunkMemory>;
  nextGroup: number;
  nextSolo: number;
};

export function makeActor(id: number, team: Actor["team"], kind: Actor["kind"], faction: number, pos: Vec, weapons: WeaponDef[], shieldMax: number): Actor {
  return {
    id, team, kind, faction,
    pos: { ...pos }, prev: { ...pos }, vel: { x: 0, y: 0 },
    radius: 0.42,
    facing: 0, prevFacing: 0,
    shield: shieldMax, shieldMax, health: HEALTH_MAX, moveMul: 1,
    overshield: 0, overshieldT: 0, killShield: 0, skillCdMul: 1, dashCdMul: 1,
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
    partner: null,
    spawn: null,
  };
}

function makePartner(id: number, index: number, model: 1 | 2, pos: Vec): Actor {
  const spec = PARTNER.weapon;
  const shield = PARTNER_MODELS[model].shield;
  const a = makeActor(id, "partner", "partner", PLAYER_FACTION, pos, [computeWeapon(spec.type, spec.attachments, [], ENEMY_MIN_TTK)], shield);
  a.facing = -Math.PI / 2;
  a.build = {
    weapons: [{ type: spec.type, attachments: spec.attachments }],
    stats: { moveMul: 1, shieldMax: shield, dashCharges: 1, killShield: 0, skillCd: 1, dashCd: 1 },
    minTtk: ENEMY_MIN_TTK,
  };
  // 敵と同じく弾を遅くし、ダメージを落とす
  a.mods.push({
    source: "partner",
    mods: [{ stat: "damage", mul: PARTNER.damageMul - 1 }, { stat: "bulletSpeed", mul: ENEMY_BULLET_SPEED_MUL - 1 }],
    until: null,
  });
  refreshStats(a);
  a.shield = a.shieldMax;
  for (const ws of a.weapons) ws.mag = ws.def.mag;
  a.ai = {
    state: "follow", group: -1, home: { ...pos },
    path: [], pathTarget: null, repathT: 0,
    target: null, lastSeen: null, lastSeenT: 0, canSee: false, scanT: 0, reactT: 0,
    strafe: 1, strafeT: 0, stateT: 0, waitT: 0,
    // 回復の回数を数えるのは前の作りのときだけ（PARTNER_TACTICS）
    heals: PARTNER_TACTICS.mode === "classic" ? PARTNER_TACTICS.classicHeals : 0,
    roam: false,
    burstT: 0, burstLen: 0.8, restT: 0,
  };
  a.partner = { index, model, reviveT: 0, heading: -Math.PI / 2, healKind: null,
    cover: null, phase: "hide", peekHp: 0, hideHealed: false,
  };
  return a;
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
export function enemyWeapon(kind: EnemyKind): WeaponDef {
  let w = enemyWeapons.get(kind);
  if (!w) {
    const spec = ENEMY[kind].weapon;
    const base = computeWeapon(spec.type, spec.attachments, [], ENEMY_MIN_TTK);
    w = { ...base, bulletSpeed: base.bulletSpeed * ENEMY_BULLET_SPEED_MUL };
    enemyWeapons.set(kind, w);
  }
  return w;
}

export function pickWeighted(rng: Rng, weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) < 0) return i;
  return weights.length - 1;
}

/** start を渡すと、その近くの空いている場所から始める（キャンプ）。渡さなければマップの出発地点から */
export function createWorld(map: GameMap, seed: number, loadout: RunLoadout, start?: Vec): World {
  const rng = new Rng(seed);

  const nearestFree = (px: number, py: number): Vec | null => {
    const tx = Math.floor(px), ty = Math.floor(py);
    for (let r = 0; r < 300; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = tx + dx, y = ty + dy;
          if (map.blocked(x, y)) continue;
          if (map.blocked(x + 1, y) || map.blocked(x - 1, y) || map.blocked(x, y + 1) || map.blocked(x, y - 1)) continue;
          return { x: x + 0.5, y: y + 0.5 };
        }
      }
    }
    return null;
  };

  map.resetSolid();
  const layout = map.index.layout;
  const startPos = start
    ? nearestFree(start.x, start.y)
    : nearestFree(layout.start[0] * map.w, layout.start[1] * map.h);
  if (!startPos) throw new Error("出発地点の周りに空いている場所が見つからない");
  // 遠くてまだ読んでいない脱出地点は、書いてある位置のまま置く
  const extracts: Extract[] = layout.extracts.map(([fx, fy]) => ({
    pos: nearestFree(fx * map.w, fy * map.h) ?? { x: fx * map.w, y: fy * map.h }, readyAt: null, ready: false, progress: 0,
  }));

  let nextId = 1;
  const player = makeActor(nextId++, "player", "player", PLAYER_FACTION, startPos, loadout.weapons, loadout.shieldMax);
  player.facing = -Math.PI / 2;
  player.build = {
    weapons: loadout.builds,
    stats: { moveMul: loadout.moveMul, shieldMax: loadout.shieldMax, dashCharges: DASH.charges, killShield: 0, skillCd: 1, dashCd: 1 },
    minTtk: PLAYER_MIN_TTK,
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

  const bag = makeBag(loadout.bagSlots);
  for (const [k, v] of loadout.startItems) bagAdd(bag, k, v);

  const w: World = {
    map, rng, seed,
    time: 0, tick: 0,
    actors, player,
    bullets: [], grenades: [], fires: [], barriers: [], rails: [], healMarks: [], loot: [], lootVersion: 1, bag,
    extracts,
    events: [],
    outcome: "playing",
    kills: 0,
    spareBuffs: [],
    focus: null,
    debug: { sightLevel: 3, beaconLevel: 1 },
    nextId,
    startPos,
    preferAmmo,
    spawned: new Map(),
    memory: new Map(),
    nextGroup: 0,
    nextSolo: 0,
  };
  syncSpawns(w);

  // 敵と箱を置いた後に出す。パートナーの有無で敵と箱の並びが変わらないように
  for (const { index, model } of loadout.partners) {
    const slot = PARTNER_SLOTS[index % PARTNER_SLOTS.length];
    const ang = player.facing + (slot.angle * Math.PI) / 180;
    const pos = nearestFree(startPos.x + Math.cos(ang) * slot.dist, startPos.y + Math.sin(ang) * slot.dist) ?? startPos;
    w.actors.push(makePartner(w.nextId++, index, model, pos));
  }
  return w;
}
