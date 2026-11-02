// 画面なしでゲームを回して、例外が出ないか、処理時間、敵どうしの撃ち合い、漁れる物の量を見る。
// 使い方: npm run smoke            全部の項目を、CPU の数だけ並べて回す
//         npm run smoke -- 自転車 パートナー   名前にどれかを含む項目だけ回す
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { format } from "node:util";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import {
  BARRIER, BIKES, BIN_ITEMS, BUFF_IDS, DEVICE_ACTIVE_RANGE, DEVICES, EVAC, EXTRACT_CALL_TIME, EXTRACT_DEFENSE, EXTRACT_RADIUS, FIXED_RAIL, HEALS, SELF_REVIVE, PARTNER_CATCH_UP, PARTNER_TACTICS, BUFFS, BUILDING_USE, DASH, DT, HEAL_SENSE, ITEMS, OVERSHIELD, PARTNER_LEASH, PARTNER_REVIVE, SCAN, SKILLS, THERMITE,
  type BuffId, type KitChoice,
} from "../src/sim/data";
import { buffsOf } from "../src/sim/buffs";
import { applyDamage } from "../src/sim/combat";
import type { Vec } from "../src/sim/map";
import { bagAdd, bagCount, bagRemove, bagUsed } from "../src/sim/inventory";
import { CHUNK, GameMap, decodeChunk, type ChunkJson, type LoadedChunk, type MapIndex } from "../src/sim/map";
import { ChunkStreamer, STREAM_RANGE, type StreamRange } from "../src/stream";
import { Rng } from "../src/sim/rng";
import { makeEnemy, syncSpawns } from "../src/sim/spawn";
import { emptyInput, nearestLoot, step, type Input } from "../src/sim/sim";
import { createWorld, type Actor, type World } from "../src/sim/world";
import { alert, angleDiff } from "../src/sim/ai";
import {
  applyRunResult, craft, craftBlocker, defaultProfile, makeRunLoadout, setAttachment, setLoadoutBike, setLoadoutRevive, setLoadoutSecureBag, setLoadoutWeapon, type Profile,
} from "../src/meta/profile";
import { RECIPES } from "../src/data/recipes";
import type { WeaponType } from "../src/data/weapons";

const baseLoadout = makeRunLoadout(defaultProfile());

const MAP_DIR = "public/maps/akihabara";
const mapIndex = JSON.parse(readFileSync(`${MAP_DIR}/index.json`, "utf8")) as MapIndex;
const readChunk = (i: number, j: number) =>
  decodeChunk(JSON.parse(gunzipSync(readFileSync(`${MAP_DIR}/${i}_${j}.json.gz`)).toString("utf8")) as ChunkJson);
const decoded = new Map<string, LoadedChunk>();
const cachedChunk = (i: number, j: number) => {
  const k = `${i}_${j}`;
  if (!decoded.has(k)) decoded.set(k, readChunk(i, j));
  return Promise.resolve(decoded.get(k)!);
};
const [BX0, BY0, BX1, BY1] = mapIndex.bounds;
const layoutStart: Vec = { x: mapIndex.layout.start[0], y: mapIndex.layout.start[1] };
/** ゲームの出撃と同じく、p から読む距離の内の区画だけ置いたマップ。マップ全体は区画の置き場所に収まらない */
const mapAround = async (p: Vec) => {
  const m = new GameMap(mapIndex);
  await new ChunkStreamer(m, cachedChunk).loadAround(p);
  return m;
};
// 区画を読み直す項目が区画の並びを変えるので、どの順で回しても同じ結果になるよう項目ごとに作り直す
let map: GameMap;

type Section = { name: string; run: () => void | Promise<void>; timed: boolean };
const sections: Section[] = [];
const section = (name: string, run: Section["run"]) => {
  sections.push({ name, run, timed: false });
};
/** 1ティックの処理時間を測る項目。ほかの項目と同時に回すと CPU を取り合って何倍にも出るので、1つずつ回す */
const timedSection = (name: string, run: Section["run"]) => {
  sections.push({ name, run, timed: true });
};

section("漁れる物の量", () => {
  const w = createWorld(map, 1, baseLoadout);
  const bins = w.loot.filter((l) => l.kind === "bin");
  const ground = w.loot.filter((l) => l.kind === "ground");
  const sizes = new Map<number, number>();
  for (const b of bins) {
    const n = bins.filter((o) => Math.hypot(o.pos.x - b.pos.x, o.pos.y - b.pos.y) < 8).length;
    sizes.set(n, (sizes.get(n) ?? 0) + 1);
  }
  const enemies = w.actors.filter((a) => a.team === "enemy");
  const byFaction = new Map<string, number>();
  for (const e of enemies) {
    const k = e.faction >= 100 ? "単独" : `勢力${e.faction}`;
    byFaction.set(k, (byFaction.get(k) ?? 0) + 1);
  }
  console.log(`出撃時に読む ${STREAM_RANGE.load}m の内: 箱 ${bins.length}個（山 ${bins.length * 4}）　地面 ${ground.length}山　敵 ${enemies.length}人`, Object.fromEntries(byFaction));
  const byUse = new Map<string, number>();
  for (const b of bins) {
    const cx = Math.floor(b.pos.x), cy = Math.floor(b.pos.y);
    let use = "接していない";
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const b = map.buildingAt(cx + dx, cy + dy);
      if (b) {
        use = BUILDING_USE[b];
        break;
      }
    }
    byUse.set(use, (byUse.get(use) ?? 0) + 1);
  }
  console.log("箱が接している建物の用途", Object.fromEntries(byUse));
});

// プレイヤーを置いたまま3分回し、敵どうしで何人倒れるか
for (const seed of [1, 2, 3]) timedSection(`敵どうし3分 seed=${seed}`, () => {
  const w = createWorld(map, seed, baseLoadout);
  w.player.pos = { ...w.extracts[0].pos };
  let worst = 0;
  const t0 = performance.now();
  for (let i = 0; i < 30 * 180; i++) {
    const s = performance.now();
    const input = emptyInput();
    input.aim = { x: w.player.pos.x + 1, y: w.player.pos.y };
    step(w, input);
    if (w.outcome !== "playing") {
      w.outcome = "playing";
      w.player.alive = true;
      w.player.health = 100;
    }
    worst = Math.max(worst, performance.now() - s);
  }
  const ms = performance.now() - t0;
  const dead = w.actors.filter((a) => a.team === "enemy" && !a.alive).length;
  const boxes = w.loot.filter((l) => l.kind === "deathbox").length;
  console.log(
    `seed=${seed} 敵どうし3分: 倒れた敵 ${dead}人 落ちた持ち物 ${boxes}個　1ティック平均 ${(ms / w.tick).toFixed(3)}ms 最大 ${worst.toFixed(2)}ms（予算 ${(DT * 1000).toFixed(1)}ms）`,
  );
});

// 脱出地点まで歩きながら、近くの物を拾っていく
for (const seed of [1, 2]) section(`漁りながら脱出 seed=${seed}`, () => {
  const w = createWorld(map, seed, baseLoadout);
  const p = w.player;
  const goal = w.extracts.reduce((a, b) => (Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) < Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y) ? a : b));
  const route = map.findPath(p.pos, goal.pos, 400000) ?? [];
  let opened = 0;
  for (let i = 0; i < 30 * 300 && w.outcome === "playing"; i++) {
    const input = emptyInput();
    while (route.length && Math.hypot(route[0].x - p.pos.x, route[0].y - p.pos.y) < 0.8) route.shift();
    const next = route[0] ?? goal.pos;
    input.move = { x: next.x - p.pos.x, y: next.y - p.pos.y };
    input.sprint = true;
    const enemy = w.actors.find((a) => a.alive && a.team === "enemy" && a.seen);
    input.aim = enemy ? { ...enemy.pos } : { x: p.pos.x + 1, y: p.pos.y };
    input.fire = !!enemy;
    if (p.shield < 50 && !p.heal && !enemy && bagCount(w.bag, "cell") > 0) input.heal = "cellBatch";
    const l = nearestLoot(w);
    if (l && i % 10 === 0) {
      if (l.kind === "ground") input.interact = true;
      else {
        input.commands.push({ type: "takeAll", loot: l.id });
        opened++;
      }
    }
    if (!l && goal.readyAt === null && Math.hypot(goal.pos.x - p.pos.x, goal.pos.y - p.pos.y) < 3) input.interact = true;
    step(w, input);
  }
  console.log(
    `seed=${seed} 漁りながら脱出: 結果=${w.outcome} ${w.time.toFixed(0)}秒 撃破 ${w.kills} 箱 ${opened}回 カバン ${bagUsed(w.bag)}枠 お金 ${w.bag.money}円 金属くず ${bagCount(w.bag, "junk")} 電子部品 ${bagCount(w.bag, "circuit")}`,
  );
});

// キャンプから始めると、その近くに出て、近くに敵がいない。迎えを呼ぶと近くの敵が寄ってくる
section("キャンプ", async () => {
  const camp = { x: BX0 + (BX1 - BX0) * 0.2, y: BY0 + (BY1 - BY0) * 0.3 };
  for (const seed of [1, 2, 3]) {
    map = await mapAround(camp);
    const w = createWorld(map, seed, baseLoadout, camp);
    const p = w.player;
    const off = Math.hypot(p.pos.x - camp.x, p.pos.y - camp.y);
    const nearest = Math.min(...w.actors.filter((a) => a.team === "enemy").map((a) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y)));
    const ex = w.extracts[seed % w.extracts.length];
    p.pos = { ...ex.pos };
    const input = emptyInput();
    input.interact = true;
    input.aim = { x: p.pos.x + 1, y: p.pos.y };
    step(w, input);
    const alerted = w.actors.filter((a) => a.ai && a.ai.target === p.id).length;
    let t = 0;
    while (w.outcome === "playing" && t < 30 * 30) {
      const idle = emptyInput();
      idle.aim = input.aim;
      p.health = 100;
      p.pos = { ...ex.pos };
      step(w, idle);
      t++;
    }
    console.log(
      `seed=${seed} キャンプ: 出た位置のずれ ${off.toFixed(1)}m 一番近い敵 ${nearest.toFixed(0)}m　迎えを呼んで寄ってきた敵 ${alerted}人　脱出まで ${(t / 30).toFixed(1)}秒 結果=${w.outcome}`,
    );
  }
});

/** 敵1人と正面 18m から撃ち合う（撃ち返すだけで動かないボット）。置ける場所が無ければ null。each で毎ティックの入力を足せる */
function duel(prof: Profile, seed: number, each?: (w: World, input: Input) => void): { win: boolean; time: number } | null {
  const w = createWorld(map, seed, makeRunLoadout(prof));
  if (w.player.kit) w.player.kit.ultCd = 0;
  // 相手は近距離型にする。グループの組み合わせは区画ごとに変わるので、型で選ぶ
  const e = w.actors.find((a) => a.team === "enemy" && a.kind === "short")!;
  // 離れた敵も毎ティック動き、1戦にかかる時間のほとんどがその分になるので、相手以外は全員止める
  for (const o of w.actors) if (o.ai && o !== e) o.alive = false;
  let placed = false;
  for (let k = 0; k < 64 && !placed; k++) {
    const a = (k / 64) * Math.PI * 2;
    const q = { x: e.pos.x + Math.cos(a) * 18, y: e.pos.y + Math.sin(a) * 18 };
    if (!map.blockedAt(q.x, q.y) && map.los(q, e.pos)) {
      w.player.pos = { ...q };
      placed = true;
    }
  }
  if (!placed) return null;
  for (let i = 0; i < 30 * 40 && w.outcome === "playing"; i++) {
    const input = emptyInput();
    input.aim = e.seen ? { ...e.pos } : { x: w.player.pos.x + 1, y: w.player.pos.y };
    input.fire = e.alive && e.seen;
    each?.(w, input);
    step(w, input);
    if (!e.alive) break;
  }
  return { win: w.player.alive && !e.alive, time: w.time };
}

const rich = (): Profile => {
  const p = defaultProfile();
  p.money = 1e6;
  p.materials = { junk: 999, circuit: 999, precision: 999 };
  for (const r of ["wpn-smg", "wpn-shotgun", "wpn-long"]) craft(p, r);
  return p;
};

const profWith = (n: number, model: 1 | 2 = 1) => {
  const prof = rich();
  for (let i = 0; i < n; i++) prof.partners[i] = { model, enabled: true };
  return prof;
};

// 武器ごとに、敵1人と撃ち合って勝てるか
{
  const builds: [string, WeaponType, string[]][] = [
    ["アサルトライフル", "ar", []],
    ["サブマシンガン", "smg", []],
    ["SMG 強装機関部", "smg", ["att-heavyReceiver"]],
    ["遠距離 連射寄り", "long", ["att-rapidReceiver", "att-extMag"]],
    ["遠距離 スナイパー寄り", "long", ["att-precisionReceiver"]],
    ["ショットガン", "shotgun", []],
    ["ピストル", "pistol", []],
  ];
  for (const [label, type, recipes] of builds) section(`武器の1対1 ${label}`, () => {
    let wins = 0, total = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const prof = rich();
      setLoadoutWeapon(prof, 0, type);
      for (const r of recipes) {
        craft(prof, r);
        const id = r.replace("att-", "") as Parameters<typeof setAttachment>[3] & string;
        const slot = id.endsWith("Receiver") ? "receiver" : id.endsWith("Mag") ? "magazine" : id.endsWith("Barrel") ? "barrel" : "stock";
        setAttachment(prof, type, slot, id);
      }
      const r = duel(prof, seed);
      if (!r) continue;
      total++;
      if (r.win) wins++;
    }
    console.log(`${label}: 1対1の勝ち ${wins}/${total}`);
  });
}

section("投げ物とダッシュ", () => {
  const w = createWorld(map, 7, baseLoadout);
  const p = w.player;
  for (const a of w.actors) if (a.ai) a.alive = false;
  const e = w.actors.find((a) => a.team === "enemy" && a.kind === "short")!;
  // 見通しのいい場所で、10m 先に敵を1人置く
  let spot = null;
  const spotRng = new Rng(7);
  for (let tries = 0; tries < 2000 && !spot; tries++) {
    const q = { x: BX0 + 20 + spotRng.next() * (BX1 - BX0 - 40), y: BY0 + 20 + spotRng.next() * (BY1 - BY0 - 40) };
    const r = { x: q.x + 10, y: q.y };
    if (map.walkable(q.x, q.y) && map.walkable(r.x, r.y) && map.walkLine(q, r, 1.5)) spot = [q, r];
  }
  const [q, r] = spot!;
  p.pos = { ...q };
  e.alive = true;
  e.pos = { ...r };
  e.ai!.state = "patrol";
  const before = e.shield + e.health;
  bagAddForTest();
  const run = (n: number, f: (i: number) => Partial<ReturnType<typeof emptyInput>>) => {
    for (let i = 0; i < n; i++) {
      const input = { ...emptyInput(), aim: { ...e.pos }, ...f(i) };
      e.pos = { ...r };
      e.vel = { x: 0, y: 0 };
      // 投げ物の効き目だけを見るので、敵には撃たせない。プレイヤーが倒れると後の項目が測れない
      if (e.ai) e.ai.restT = 1;
      step(w, input);
    }
  };
  run(60, (i) => ({ throw: i === 0 ? "frag" : null }));
  const afterFrag = e.shield + e.health;
  run(1, () => ({ throw: "thermite" }));
  run(20, () => ({}));
  const fire = w.fires[0];
  const fireLen = fire ? Math.hypot(fire.b.x - fire.a.x, fire.b.y - fire.a.y) : 0;
  run(90, () => ({}));
  const afterFire = e.alive ? e.shield + e.health : 0;
  console.log(`グレネード: 10m 先の敵に ${(before - afterFrag).toFixed(0)} ダメージ`);
  console.log(`テルミット: 炎の長さ ${fireLen.toFixed(1)}m、3秒で ${(afterFrag - afterFire).toFixed(0)} ダメージ`);

  // 炎の真ん中から投げた向き（+x）へ歩いて抜ける。炎の外で同じだけ歩いた距離と比べる
  if (fire && w.fires.length) {
    const walk = (from: Vec) => {
      p.pos = { ...from };
      p.vel = { x: 0, y: 0 };
      p.health = p.shield = 100;
      const hp = p.health + p.shield;
      let out = -1;
      for (let i = 0; i < 30; i++) {
        const input = { ...emptyInput(), aim: { x: p.pos.x + 5, y: p.pos.y }, move: { x: 1, y: 0 } };
        step(w, input);
        if (out < 0 && p.burnT < THERMITE.slowLinger) out = (i + 1) * DT;
      }
      return { moved: p.pos.x - from.x, lost: hp - p.health - p.shield, out };
    };
    const mid = { x: (fire.a.x + fire.b.x) / 2, y: (fire.a.y + fire.b.y) / 2 };
    const inside = walk(mid);
    p.burnT = 0;
    const outside = walk({ x: q.x, y: q.y });
    console.log(`テルミットの減速: 1秒で炎の中から ${inside.moved.toFixed(2)}m（炎の外なら ${outside.moved.toFixed(2)}m）、抜けるまで ${inside.out.toFixed(2)}秒、${inside.lost.toFixed(0)} ダメージ`);
  }

  // 敵の足元に投げ物を落とし、着地してからは止めずに逃げてダメージが減るかを見る。プレイヤーの体力は毎ティック戻す
  const free = (kind: "frag" | "thermite", playerHp: number) => {
    w.grenades = [];
    w.fires = [];
    bagAddForTest();
    p.pos = { ...q };
    e.pos = { ...r };
    e.vel = { x: 0, y: 0 };
    e.alive = true;
    e.burnT = 0;
    e.shield = 100;
    e.health = 100;
    e.heal = null;
    e.ai!.state = "engage";
    e.ai!.target = p.id;
    const hp = 200;
    for (let i = 0; i < 120 && e.alive; i++) {
      p.shield = 0;
      p.health = playerHp;
      // プレイヤーが倒れると狙いが外れるので撃たせない
      e.ai!.restT = 1;
      // 足元に落ちた状況にするため、着地するまでは動かさない
      if (i === 0 || w.grenades.some((g) => g.t < g.flight)) {
        e.pos = { ...r };
        e.vel = { x: 0, y: 0 };
      }
      step(w, { ...emptyInput(), aim: i === 0 ? { ...r } : { ...e.pos }, throw: i === 0 ? kind : null });
          }
    return hp - (e.alive ? e.shield + e.health : 0);
  };
  console.log(`敵の回避: グレネードで ${free("frag", 100).toFixed(0)} ダメージ（動かなければ ${(before - afterFrag).toFixed(0)}）、テルミット4秒で ${free("thermite", 100).toFixed(0)} ダメージ、相手が瀕死ならテルミット4秒で ${free("thermite", 30).toFixed(0)} ダメージ`);
  // プレイヤーとの間に長さ6mの炎を置き、詰めてくる敵が回り込むかを見る
  {
    w.grenades = [];
    const mid = { x: (q.x + r.x) / 2, y: (q.y + r.y) / 2 };
    w.fires = [{ id: w.nextId++, owner: 0, a: { x: mid.x, y: mid.y - 3 }, b: { x: mid.x, y: mid.y + 3 }, t: 99, tickT: 99 }];
    p.pos = { ...q };
    e.pos = { ...r };
    e.vel = { x: 0, y: 0 };
    e.alive = true;
    e.shield = e.health = 100;
    e.ai!.state = "push";
    e.ai!.stateT = 99;
    e.ai!.target = p.id;
    e.ai!.repathT = 0;
    let inFire = 0, closest = Infinity;
    for (let i = 0; i < 90; i++) {
      p.health = 100;
      p.heal = { kind: "medLarge", t: 99, total: 99, items: 1 };
      e.ai!.restT = 1;
      step(w, { ...emptyInput(), aim: { ...e.pos } });
      if (Math.abs(e.pos.x - mid.x) <= THERMITE.width / 2 + e.radius && Math.abs(e.pos.y - mid.y) <= 3) inFire++;
      closest = Math.min(closest, Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y));
    }
    p.heal = null;
    console.log(`炎の回り込み: 炎の向こうから詰める敵が炎の中にいた時間 ${(inFire * DT).toFixed(2)}秒、プレイヤーに一番近づいた距離 ${closest.toFixed(1)}m`);
  }
  w.grenades = [];
  w.fires = [];
  p.burnT = 0;
  p.pos = { ...q };
  p.health = 100;

  e.alive = false;
  const start = { ...p.pos };
  run(1, () => ({ dash: true, move: { x: 0, y: 1 } }));
  run(10, () => ({}));
  const moved = Math.hypot(p.pos.x - start.x, p.pos.y - start.y);
  const cd1 = p.dashCd;
  const pos2 = { ...p.pos };
  run(1, () => ({ dash: true, move: { x: 0, y: -1 } }));
  run(5, () => ({}));
  const moved2 = Math.hypot(p.pos.x - pos2.x, p.pos.y - pos2.y);
  console.log(`ダッシュ: 1回目 ${moved.toFixed(2)}m、直後の残りクールダウン ${cd1.toFixed(2)}秒、クールダウン中の2回目で動いた距離 ${moved2.toFixed(2)}m`);

  function bagAddForTest() {
    w.bag.slots[w.bag.slots.length - 1] = { item: "frag", count: 2 };
    w.bag.slots[w.bag.slots.length - 2] = { item: "thermite", count: 2 };
  }
});

// スキル・パッシブ・アルティメット
{
  const withKit = (kit: Partial<KitChoice>, seed = 7) => {
    const prof = defaultProfile();
    Object.assign(prof.loadout, kit);
    const w = createWorld(map, seed, makeRunLoadout(prof));
    w.player.kit!.ultCd = 0;
    for (const a of w.actors) if (a.ai) a.alive = false;
    return w;
  };
  // 幅 1.5m で +x 方向に len だけまっすぐ歩ける場所。マップの左上から順に探すので毎回同じ所になる
  const openLine = (len: number): Vec => {
    for (let y = BY0 + 20; y < BY1 - 20; y += 3) {
      for (let x = BX0 + 20; x < BX1 - 20 - len; x += 3) {
        const q = { x: x + 0.5, y: y + 0.5 };
        if (map.walkable(q.x, q.y) && map.walkable(q.x + len, q.y) && map.walkLine(q, { x: q.x + len, y: q.y }, 1.5)) return q;
      }
    }
    throw new Error(`${len}m まっすぐ歩ける場所がない`);
  };
  const runFor = (w: World, ticks: number, f: (i: number) => Partial<Input>) => {
    for (let i = 0; i < ticks; i++) step(w, { ...emptyInput(), aim: { x: w.player.pos.x + 10, y: w.player.pos.y }, ...f(i) });
  };
  const enemyAt = (w: World, pos: Vec) => {
    const e = w.actors.find((a) => a.team === "enemy" && a.kind === "short")!;
    e.alive = true;
    e.pos = { ...pos };
    e.vel = { x: 0, y: 0 };
    e.shield = 100;
    e.health = 100;
    return e;
  };

  section("シールド追加・キルでシールド回復", () => {
    const w = withKit({ skill: "overshield" });
    const p = w.player;
    runFor(w, 1, () => ({ skill: true }));
    const over = p.overshield;
    applyDamage(w, p, 80, undefined, p.pos);
    const after = { over: p.overshield, shield: p.shield, health: p.health };
    runFor(w, 30 * (OVERSHIELD.duration + 0.1), () => ({}));
    const w2 = withKit({ passive: "killShield" });
    const e = enemyAt(w2, { x: w2.player.pos.x + 5, y: w2.player.pos.y });
    w2.player.shield = 0;
    applyDamage(w2, e, 999, w2.player, e.pos);
    console.log(
      `シールド追加: 張った量 ${over}、80 ダメージを受けて 追加 ${after.over}・シールド ${after.shield}/${p.shieldMax}・ヘルス ${after.health}、${OVERSHIELD.duration}秒後の追加シールド ${p.overshield}　キルでシールド回復: 0 から ${w2.player.shield}`,
    );
  });

  // 速射は効いている時間が伸び、横滑りダッシュはクールダウンが終わる
  section("倒したときのスキル", () => {
    const w = withKit({ skill: "rapidFire" });
    const k = w.player.kit!;
    runFor(w, 30, (i) => ({ skill: i === 0 }));
    const before = k.skillT;
    const e = enemyAt(w, { x: w.player.pos.x + 5, y: w.player.pos.y });
    applyDamage(w, e, 999, w.player, e.pos);
    const after = k.skillT;
    const until = w.player.mods.find((m) => m.source === "skill:rapidFire")?.until ?? 0;
    const w2 = withKit({ skill: "slide" });
    runFor(w2, 30, (i) => ({ skill: i === 0 }));
    const cd = w2.player.kit!.skillCd;
    const e2 = enemyAt(w2, { x: w2.player.pos.x + 5, y: w2.player.pos.y });
    applyDamage(w2, e2, 999, w2.player, e2.pos);
    console.log(
      `倒したとき: 速射の残り ${before.toFixed(2)} → ${after.toFixed(2)}秒（修正が切れるまで ${(until - w.time).toFixed(2)}秒）、横滑りダッシュのクールダウン ${cd.toFixed(2)} → ${w2.player.kit!.skillCd.toFixed(2)}秒`,
    );
  });

  section("2秒で進んだ距離", () => {
    const q = openLine(60);
    const go = (kit: Partial<KitChoice>, f: (i: number) => Partial<Input>) => {
      const w = withKit(kit);
      w.player.pos = { ...q };
      runFor(w, 60, (i) => ({ move: { x: 1, y: 0 }, ...f(i) }));
      return { x: w.player.pos.x - q.x, y: w.player.pos.y - q.y };
    };
    const walk = go({}, () => ({})).x;
    const haste = go({ skill: "haste" }, (i) => ({ skill: i === 0 })).x;
    const dash1 = go({}, (i) => ({ dash: i === 0 || i === 8 })).x;
    const dash2 = go({ passive: "doubleDash" }, (i) => ({ dash: i === 0 || i === 8 })).x;
    const slide = go({ skill: "slide" }, (i) => ({ skill: i === 0 })).x;
    // 横滑りダッシュの途中で下（+y）へ曲げる
    const turn = go({ skill: "slide" }, (i) => ({ skill: i === 0, move: i < 3 ? { x: 1, y: 0 } : { x: 0, y: 1 } }));
    const rail = go({ ult: "rail" }, (i) => ({ ult: i === 0, move: { x: 0, y: 0 } })).x;
    console.log(
      `2秒で進んだ距離: 歩き ${walk.toFixed(1)}m、加速 ${haste.toFixed(1)}m、ダッシュ2回押し ${dash1.toFixed(1)}m（ダッシュ2回のパッシブ ${dash2.toFixed(1)}m）、横滑りダッシュ ${slide.toFixed(1)}m（途中で曲げると 横 ${turn.y.toFixed(1)}m）、レール ${rail.toFixed(1)}m`,
    );
  });

  // 1対1 の勝ち数と、倒すまでの時間
  {
    const cases: [string, Partial<KitChoice>, boolean][] = [
      ["スキルなし", { skill: "overshield", passive: "killShield" }, false],
      ["速射", { skill: "rapidFire" }, true],
      ["弾の威力", { passive: "damageUp" }, false],
    ];
    for (const [label, kit, use] of cases) section(`スキルの1対1 ${label}`, () => {
      let wins = 0, total = 0, time = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const prof = rich();
        Object.assign(prof.loadout, kit);
        const r = duel(prof, seed, (_w, input) => {
          if (use && input.fire) input.skill = true;
        });
        if (!r) continue;
        total++;
        if (r.win) {
          wins++;
          time += r.time;
        }
      }
      console.log(`アサルトライフル ${label}: 1対1の勝ち ${wins}/${total} 倒すまで平均 ${(time / Math.max(wins, 1)).toFixed(2)}秒`);
    });
  }

  // 置いた壁で弾が止まるか、敵が回り込むか、消えた後に元の格子に戻るか
  section("遮蔽物", () => {
    const w = withKit({ ult: "barrier" });
    const q = openLine(14);
    const p = w.player;
    p.pos = { ...q };
    const r = { x: q.x + 12, y: q.y };
    const e = enemyAt(w, r);
    const solidNow = () => {
      const out: number[] = [];
      for (let y = Math.floor(BY0); y < BY1; y++) for (let x = Math.floor(BX0); x < BX1; x++) out.push(w.map.solidAt(x, y));
      return out;
    };
    const before = solidNow();
    runFor(w, 1, () => ({ ult: true, aim: { x: q.x + 6, y: q.y } }));
    const b = w.barriers[0];
    const cells = b?.cells.length ?? 0;
    for (let i = 0; i < 45; i++) {
      e.pos = { ...r };
      e.vel = { x: 0, y: 0 };
      e.ai!.restT = 1;
      step(w, { ...emptyInput(), aim: { ...r }, fire: true });
    }
    const enemyHp = e.shield + e.health;
    const wallHp = b?.hp ?? 0;
    e.ai!.state = "push";
    e.ai!.stateT = 99;
    e.ai!.target = p.id;
    e.ai!.repathT = 0;
    let closest = Infinity;
    for (let i = 0; i < 30 * 6; i++) {
      p.health = 100;
      p.heal = { kind: "medLarge", t: 99, total: 99, items: 1 };
      e.ai!.restT = 1;
      step(w, { ...emptyInput(), aim: { ...e.pos } });
      closest = Math.min(closest, Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y));
    }
    p.heal = null;
    if (b) b.until = w.time;
    step(w, { ...emptyInput(), aim: { ...e.pos } });
    let diff = 0;
    const after = solidNow();
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) diff++;
    console.log(
      `遮蔽物: 立てたマス ${cells}、1.5秒撃って 敵の体力 ${enemyHp}/200・壁の耐久 ${wallHp}/${BARRIER.hp}、壁の向こうから詰める敵が一番近づいた距離 ${closest.toFixed(1)}m、消えた後に元と違うマス ${diff}`,
    );
  });

  // 巻き検知の円の中心が敵の位置と一致しないか。広域探知で見える段階
  section("巻き検知・広域探知", () => {
    const w = withKit({ passive: "healSense", ult: "scan" });
    const q = openLine(25);
    w.player.pos = { ...q };
    const e = enemyAt(w, { x: q.x + 20, y: q.y });
    e.ai!.restT = 99;
    let min = Infinity, max = 0, moves = 0, last: Vec | null = null;
    for (let i = 0; i < 90; i++) {
      e.heal = { kind: "medLarge", t: 99, total: 99, items: 1 };
      e.pos = { x: q.x + 20, y: q.y };
      e.vel = { x: 0, y: 0 };
      step(w, { ...emptyInput(), aim: { x: q.x - 10, y: q.y } });
      const m = w.healMarks[0];
      if (!m) continue;
      const d = Math.hypot(m.pos.x - e.pos.x, m.pos.y - e.pos.y);
      min = Math.min(min, d);
      max = Math.max(max, d);
      if (!last || last.x !== m.pos.x || last.y !== m.pos.y) moves++;
      last = { ...m.pos };
    }
    e.heal = null;
    step(w, emptyInput());
    const cleared = w.healMarks.length === 0;
    // 視線で見える段階を1（影だけ）にして、広域探知で段階が上がるかを見る
    w.debug.sightLevel = 1;
    step(w, emptyInput());
    const before = e.info;
    step(w, { ...emptyInput(), ult: true });
    const during = e.info;
    for (let i = 0; i < 30 * (SCAN.duration + 0.2); i++) step(w, emptyInput());
    console.log(
      `巻き検知: 円の中心と敵の距離 ${min.toFixed(2)}〜${max.toFixed(2)}m（半径 ${HEAL_SENSE.radius}m）、3秒で置き直した回数 ${moves}、回復をやめたら消えるか ${cleared}　広域探知: 段階 ${before} → ${during} → ${SCAN.duration}秒後 ${e.info}`,
    );
  });

  // マガジンが減らず、カバンの弾が減る
  section("弾倉なし", () => {
    const w = withKit({ ult: "bottomless" });
    const p = w.player;
    const ws = p.weapons[p.cur];
    const mag = ws.mag, bag = bagCount(w.bag, ws.def.ammo);
    runFor(w, 30 * 3, (i) => ({ ult: i === 0, fire: true }));
    console.log(`弾倉なし: 3秒撃って マガジン ${mag} → ${ws.mag}、カバンの弾 ${bag} → ${bagCount(w.bag, ws.def.ammo)}、リロードしていない ${p.reloadT === 0}`);
  });
}

// 1ランに出る数と、拾ったときの効き目
section("強化パーツ", () => {
  let total = 0;
  const byId = new Map<BuffId, number>();
  const seeds = [1, 2, 3, 4, 5, 6];
  for (const seed of seeds) {
    const w = createWorld(map, seed, baseLoadout);
    for (const l of w.loot) {
      for (const s of l.items) {
        if (ITEMS[s.item].category !== "buff") continue;
        total++;
        byId.set(s.item as BuffId, (byId.get(s.item as BuffId) ?? 0) + 1);
      }
    }
  }
  const avg = Object.fromEntries(BUFF_IDS.map((id) => [BUFFS[id].name, ((byId.get(id) ?? 0) / seeds.length).toFixed(1)]));
  console.log(`強化パーツ: 出撃時に読む ${STREAM_RANGE.load}m の内に平均 ${(total / seeds.length).toFixed(1)}個`, avg);

  // 足元に強化パーツを1つ置いて E で拾わせる
  const pick = (w: World, id: BuffId) => {
    const p = w.player;
    w.loot.push({ id: w.nextId++, spawn: null, pos: { ...p.pos }, kind: "ground", items: [{ item: id, count: 1 }], opened: true, angle: 0 });
    step(w, { ...emptyInput(), aim: { x: p.pos.x + 1, y: p.pos.y }, interact: true });
  };
  const withPartners = (n: number) => {
    const prof = defaultProfile();
    for (let i = 0; i < n; i++) prof.partners[i] = { model: 1, enabled: true };
    const w = createWorld(map, 7, makeRunLoadout(prof));
    for (const a of w.actors) if (a.team === "enemy") a.alive = false;
    return w;
  };
  const rows: string[] = [];
  for (const id of BUFF_IDS) {
    const w = withPartners(0);
    const p = w.player;
    const ws = p.weapons[0];
    const before = { shield: p.shieldMax, mag: ws.def.mag, spread: ws.def.spreadPerShot, reload: ws.def.reload, move: p.moveMul, skill: p.skillCdMul, dash: p.dashCdMul };
    pick(w, id);
    const after = { shield: p.shieldMax, mag: ws.def.mag, spread: ws.def.spreadPerShot, reload: ws.def.reload, move: p.moveMul, skill: p.skillCdMul, dash: p.dashCdMul };
    const changed = (Object.keys(before) as (keyof typeof before)[])
      .filter((k) => Math.abs(before[k] - after[k]) > 1e-9)
      .map((k) => `${k} ${+before[k].toFixed(3)}→${+after[k].toFixed(3)}`);
    // 2個目はパートナーがいなければ拾えずに残る
    pick(w, id);
    const left = w.loot.filter((l) => l.items.some((s) => s.item === id)).length;
    rows.push(`${BUFFS[id].name}: ${changed.join("・") || "変化なし"}（2個目 残った山 ${left}）`);
  }
  console.log(rows.join("\n"));
  {
    const w = withPartners(1);
    const p = w.player;
    p.kit!.skillCd = 0;
    pick(w, "coolingUnit");
    step(w, { ...emptyInput(), aim: { x: p.pos.x + 1, y: p.pos.y }, skill: true });
    const skillCd = p.kit!.skillCd;
    pick(w, "spareBattery");
    step(w, { ...emptyInput(), aim: { x: p.pos.x + 1, y: p.pos.y }, dash: true });
    const dashCd = p.dashCd;
    console.log(
      `冷却ユニット: スキルのクールダウン ${SKILLS[p.kit!.skill].cooldown}秒 → ${(skillCd + DT).toFixed(2)}秒　予備バッテリー: ダッシュのクールダウン ${DASH.cooldown}秒 → ${(dashCd + DT).toFixed(2)}秒`,
    );
    const partner = w.actors.find((a) => a.team === "partner")!;
    partner.pos = { x: p.pos.x + 1, y: p.pos.y };
    pick(w, "shieldCore");
    pick(w, "shieldCore");
    const spare = [...w.spareBuffs];
    const before = partner.shieldMax;
    step(w, { ...emptyInput(), aim: { x: p.pos.x + 1, y: p.pos.y }, commands: [{ type: "giveBuff", buff: "shieldCore", partner: partner.id }] });
    pick(w, "coolingUnit");
    console.log(
      `受け渡し: 2個目のシールドコアは予備に ${spare.join(",")}、渡すとパートナーのシールドの上限 ${before} → ${partner.shieldMax}、パートナーの強化パーツ ${buffsOf(partner).join(",")}、パートナーに効かない冷却ユニットの2個目は予備に入らない ${!w.spareBuffs.includes("coolingUnit")}`,
    );
  }
});

// パートナー
{
  // 1体目 → 2体目 → 1体目の改良
  section("パートナーのクラフト", () => {
    const prof = rich();
    const order: string[] = [];
    const tryAll = () => RECIPES.filter((r) => r.category === "partner").map((r) => `${r.id}:${craftBlocker(prof, r) ?? "作れる"}`).join(" ");
    order.push(tryAll());
    for (const id of ["ptn-1", "ptn-2", "ptn-1-up"]) {
      craft(prof, id);
      order.push(tryAll());
    }
    const run = makeRunLoadout(prof).partners.map((x) => `${x.index + 1}:${x.model}`).join(",");
    console.log(`パートナーのクラフト:\n  ${order.join("\n  ")}\n  連れていく ${run}`);
  });

  // 脱出地点まで歩く。パートナーが付いてこられるか、どれだけ離れるか
  for (const seed of [1, 2]) timedSection(`パートナー2体と歩く seed=${seed}`, () => {
    const w = createWorld(map, seed, makeRunLoadout(profWith(2)));
    for (const a of w.actors) if (a.team === "enemy") a.alive = false;
    const p = w.player;
    const partners = w.actors.filter((a) => a.team === "partner");
    const goal = w.extracts.reduce((a, b) => (Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) < Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y) ? a : b));
    const route = map.findPath(p.pos, goal.pos, 400000) ?? [];
    let far = 0, sum = 0, n = 0, max = 0;
    const t0 = performance.now();
    for (let i = 0; i < 30 * 120 && route.length; i++) {
      const input = emptyInput();
      while (route.length && Math.hypot(route[0].x - p.pos.x, route[0].y - p.pos.y) < 0.8) route.shift();
      const next = route[0] ?? goal.pos;
      input.move = { x: next.x - p.pos.x, y: next.y - p.pos.y };
      input.aim = { x: p.pos.x + input.move.x * 5, y: p.pos.y + input.move.y * 5 };
      input.sprint = i % 300 < 200;
      step(w, input);
      for (const a of partners) {
        const d = Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y);
        if (d > PARTNER_LEASH) far++;
        sum += d;
        max = Math.max(max, d);
        n++;
      }
    }
    const ms = performance.now() - t0;
    console.log(
      `seed=${seed} パートナー2体と歩く: ${w.time.toFixed(0)}秒 プレイヤーとの距離 平均 ${(sum / n).toFixed(1)}m 最大 ${max.toFixed(1)}m、${PARTNER_LEASH}m より離れていた時間 ${((far / n) * 100).toFixed(1)}%　1ティック平均 ${(ms / w.tick).toFixed(3)}ms`,
    );
  });

  // 敵の3人組と撃ち合う。プレイヤー役は動かずに、見えている一番近い敵を撃つ。シールドが割れて敵が見えていなければ巻く
  const squad = (partnerCount: number, seed: number) => {
    const w = createWorld(map, seed, makeRunLoadout(profWith(partnerCount)));
    const p = w.player;
    // 近距離・中距離・遠距離が1人ずつのグループと撃ち合う。グループの組み合わせは区画ごとに変わるので、組み合わせで選ぶ
    const byGroup = new Map<number, Actor[]>();
    for (const a of w.actors) if (a.ai && a.team === "enemy") byGroup.set(a.ai.group, [...(byGroup.get(a.ai.group) ?? []), a]);
    const group = [...byGroup.values()].find((g) => g.map((a) => a.kind).sort().join() === "long,mid,short");
    if (!group) return null;
    const center = group[0].pos;
    for (const o of w.actors) if (o.team === "enemy" && !group.includes(o)) o.alive = false;
    let placed = false;
    for (let k = 0; k < 64 && !placed; k++) {
      const ang = (k / 64) * Math.PI * 2;
      const q = { x: center.x + Math.cos(ang) * 18, y: center.y + Math.sin(ang) * 18 };
      if (!map.blockedAt(q.x, q.y) && map.los(q, center)) {
        p.pos = { ...q };
        p.facing = Math.atan2(center.y - q.y, center.x - q.x);
        placed = true;
      }
    }
    if (!placed) return null;
    const partners = w.actors.filter((a) => a.team === "partner");
    partners.forEach((a, i) => {
      a.partner!.heading = p.facing;
      const back = p.facing + Math.PI + (i === 0 ? -0.6 : 0.6);
      const q = { x: p.pos.x + Math.cos(back) * 3, y: p.pos.y + Math.sin(back) * 3 };
      a.pos = map.blockedAt(q.x, q.y) ? { ...p.pos } : q;
    });
    let downs = 0, far = 0, samples = 0;
    for (let i = 0; i < 30 * 60 && w.outcome === "playing"; i++) {
      const input = emptyInput();
      let target = null as null | (typeof group)[number];
      for (const e of group) {
        if (!e.alive || !e.seen) continue;
        if (!target || Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y) < Math.hypot(target.pos.x - p.pos.x, target.pos.y - p.pos.y)) target = e;
      }
      input.aim = target ? { ...target.pos } : { x: p.pos.x + Math.cos(p.facing), y: p.pos.y + Math.sin(p.facing) };
      input.fire = !!target;
      if (!target && p.shield < 25 && !p.heal && bagCount(w.bag, "cell") > 0) input.heal = "cellBatch";
      step(w, input);
      for (const ev of w.events) if (ev.type === "death" && partners.some((a) => a.id === ev.actor)) downs++;
      for (const a of partners) {
        samples++;
        if (Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) > PARTNER_LEASH) far++;
      }
      if (group.every((e) => !e.alive)) break;
    }
    const win = p.alive && group.every((e) => !e.alive);
    return { win, hp: p.alive ? p.shield + p.health : 0, downs, far, samples, time: w.time };
  };
  for (const n of [0, 1, 2]) section(`パートナー${n}体 対 3人組`, () => {
    let wins = 0, total = 0, hp = 0, downs = 0, far = 0, samples = 0, time = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const r = squad(n, seed);
      if (!r) continue;
      total++;
      if (r.win) {
        wins++;
        hp += r.hp;
        time += r.time;
      }
      downs += r.downs;
      far += r.far;
      samples += r.samples;
    }
    console.log(
      `パートナー${n}体 対 3人組: 勝ち ${wins}/${total} 勝ったときの残り体力 平均 ${(hp / Math.max(wins, 1)).toFixed(0)}/200 倒すまで平均 ${(time / Math.max(wins, 1)).toFixed(1)}秒` +
        (n ? `　パートナーが倒れた回数 ${downs}（1戦あたり ${(downs / total).toFixed(2)}）、${PARTNER_LEASH}m より離れていた時間 ${((far / Math.max(samples, 1)) * 100).toFixed(1)}%` : ""),
    );
  });

  // パートナー1体と敵の中距離型1人が 18m で撃ち合う。プレイヤーは倒れた扱いにして、敵に狙わせない
  for (const [model, mode] of [[1, "cover"], [2, "cover"], [1, "classic"], [2, "classic"]] as const) section(`パートナー（${model === 1 ? "初期型" : "改良型"}・${mode === "cover" ? "遮蔽を使う" : "前の作り"}） 対 敵の中距離型`, () => {
    PARTNER_TACTICS.mode = mode;
    let wins = 0, total = 0, hp = 0;
    try {
    for (let seed = 1; seed <= 100; seed++) {
      const w = createWorld(map, seed, makeRunLoadout(profWith(1, model)));
      const a = w.actors.find((x) => x.team === "partner")!;
      const e = w.actors.find((x) => x.team === "enemy" && x.kind === "mid")!;
      for (const o of w.actors) if (o.team === "enemy" && o !== e) o.alive = false;
      let spot: Vec | null = null;
      for (let k = 0; k < 64 && !spot; k++) {
        const ang = (k / 64) * Math.PI * 2;
        const q = { x: e.pos.x + Math.cos(ang) * 18, y: e.pos.y + Math.sin(ang) * 18 };
        if (!map.blockedAt(q.x, q.y) && map.los(q, e.pos)) spot = q;
      }
      if (!spot) continue;
      const p = w.player;
      p.alive = false;
      p.facing = Math.atan2(e.pos.y - spot.y, e.pos.x - spot.x);
      p.pos = { x: spot.x - Math.cos(p.facing) * 2, y: spot.y - Math.sin(p.facing) * 2 };
      a.pos = { ...spot };
      a.partner!.heading = p.facing;
      for (let i = 0; i < 30 * 40 && a.alive && e.alive; i++) step(w, { ...emptyInput(), aim: { ...e.pos } });
      total++;
      if (a.alive && !e.alive) {
        wins++;
        hp += a.shield + a.health;
      }
    }
    } finally {
      PARTNER_TACTICS.mode = "cover";
    }
    console.log(`パートナー（${model === 1 ? "初期型" : "改良型"}・${mode === "cover" ? "遮蔽を使う" : "前の作り"}） 対 敵の中距離型 1対1: 勝ち ${wins}/${total} 勝ったときの残り体力 平均 ${(hp / Math.max(wins, 1)).toFixed(0)}/${model === 1 ? 200 : 225}`);
  });

  // 散策中は満タンまで巻き、戦闘中は隙を見て巻く
  section("パートナーの回復", () => {
    const setup = () => {
      const w = createWorld(map, 7, makeRunLoadout(profWith(1)));
      for (const o of w.actors) if (o.team === "enemy") o.alive = false;
      const a = w.actors.find((x) => x.team === "partner")!;
      return { w, a, p: w.player };
    };
    const record = (w: World, a: Actor, ticks: number, each?: () => void) => {
      const log: string[] = [];
      for (let i = 0; i < ticks; i++) {
        each?.();
        step(w, { ...emptyInput(), aim: { x: w.player.pos.x + 1, y: w.player.pos.y } });
        for (const ev of w.events) {
          if (ev.type === "healStart" && ev.actor === a.id) log.push(`${(w.time).toFixed(1)}s ${ev.kind}`);
          if (ev.type === "reloadStart" && ev.actor === a.id) log.push(`${(w.time).toFixed(1)}s リロード`);
          if (ev.type === "healCancel" && ev.actor === a.id) log.push(`${(w.time).toFixed(1)}s やめた`);
        }
      }
      return log;
    };
    // 散策中：シールド 0・ヘルス 30 から
    {
      const { w, a } = setup();
      a.shield = 0;
      a.health = 30;
      const log = record(w, a, 30 * 25);
      console.log(`パートナーの回復（散策中）: ${log.join("、")} → シールド ${a.shield}/${a.shieldMax} ヘルス ${a.health}`);
    }
    // 戦闘中：撃ってこない敵を前に、条件を変えて最初の数秒を見る。hidden なら敵を見えない所（45m 先）に置き、見失った直後にする
    const fight = (label: string, f: (a: Actor, e: Actor) => void, ticks = 30 * 6, hidden = false) => {
      const { w, a, p } = setup();
      const e = w.actors.find((x) => x.team === "enemy")!;
      let spot: Vec | null = null;
      for (let k = 0; k < 64 && !spot; k++) {
        const ang = (k / 64) * Math.PI * 2;
        const r = hidden ? 45 : 20;
        const q = { x: a.pos.x + Math.cos(ang) * r, y: a.pos.y + Math.sin(ang) * r };
        if (!map.blockedAt(q.x, q.y) && map.los(q, a.pos)) spot = q;
      }
      e.alive = true;
      e.pos = spot!;
      a.ai!.target = e.id;
      a.ai!.lastSeen = { ...spot! };
      a.ai!.lastSeenT = w.time;
      f(a, e);
      const log = record(w, a, ticks, () => {
        e.pos = { ...spot! };
        e.vel = { x: 0, y: 0 };
        e.ai!.restT = 1;
        e.shield = Math.max(e.shield, 1);
        p.health = 100;
      });
      console.log(`パートナーの回復（${label}）: ${log.join("、") || "巻かない"} → シールド ${a.shield}/${a.shieldMax} ヘルス ${a.health}`);
    };
    fight("戦闘中・見えていない・マガジンが空でシールド 50", (a) => {
      a.shield = 50;
      a.weapons[0].mag = 0;
    }, 30 * 3, true);
    fight("戦闘中・見えていない・ヘルス 45", (a) => {
      a.health = 45;
    }, 30 * 4, true);
    fight("戦闘中・見えている・マガジンが空でシールド 50", (a) => {
      a.shield = 50;
      a.weapons[0].mag = 0;
    }, 30 * 3);
    fight("戦闘中・見えている・シールド 0 でヘルス 80", (a) => {
      a.shield = 0;
      a.health = 80;
    }, 30 * 1);
    fight("戦闘中・相手の残りが 40", (a, e) => {
      a.shield = 50;
      a.weapons[0].mag = 0;
      e.shield = 0;
      e.health = 40;
    }, 30 * 1);
    fight("戦闘中・ヘルス 20", (a) => {
      a.health = 20;
    }, 30 * 12);
  });

  // 撃たれたら押し直しになる
  section("倒れたパートナーを起こす", () => {
    const w = createWorld(map, 7, makeRunLoadout(profWith(1)));
    for (const a of w.actors) if (a.team === "enemy") a.alive = false;
    const p = w.player;
    const a = w.actors.find((x) => x.team === "partner")!;
    a.pos = { x: p.pos.x + 1, y: p.pos.y };
    applyDamage(w, a, 999, undefined, a.pos);
    const downed = !a.alive && w.outcome === "playing";
    const hold = () => step(w, { ...emptyInput(), aim: { x: p.pos.x + 1, y: p.pos.y }, interactHeld: true });
    for (let i = 0; i < 30 * 2; i++) hold();
    const half = a.partner!.reviveT;
    // 次のティックでプレイヤーに当たる弾を置く
    const from = { x: p.pos.x - 0.6, y: p.pos.y };
    w.bullets.push({ pos: from, prev: { ...from }, vel: { x: 30, y: 0 }, damage: 5, faction: 1, owner: 0, life: 1, alive: true });
    hold();
    const reset = a.partner!.reviveT;
    const t1 = w.time;
    for (let i = 0; i < 30 * 6 && !a.alive; i++) hold();
    console.log(
      `パートナーを起こす: 倒れてもランは続く ${downed}、2秒押して ${half.toFixed(2)}秒分、撃たれたら ${reset.toFixed(2)} に戻る、そこから立ち上がるまで ${(w.time - t1).toFixed(2)}秒（必要 ${PARTNER_REVIVE.time}秒）、立ち上がったヘルス ${a.health}`,
    );
  });
}

section("固定レール・ダッシュパッド・自転車", () => {
  // E は拾うのがレールに乗るより先なので、乗り場の近くに落ちている物も片付ける。固定レールの維持費の金属くずを持たせる
  const quiet = (w: World) => {
    for (const a of w.actors) if (a.team === "enemy") a.alive = false;
    w.loot = [];
    bagAdd(w.bag, "junk", 30);
  };
  const near = (a: Vec, b: Vec, r: number) => Math.hypot(a.x - b.x, a.y - b.y) <= r;

  // 固定レールの数と、端どうしで乗り継げるつながり
  {
    const w = createWorld(map, 5, baseLoadout);
    const rails = w.rails.filter((r) => r.owner === null);
    const lens = rails.map((r) => Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y));
    // 端が乗り場の円の中で重なるレールどうしをつなぐ
    const parent = rails.map((_, i) => i);
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    let joints = 0;
    for (let i = 0; i < rails.length; i++) {
      for (let j = i + 1; j < rails.length; j++) {
        const hit = [rails[i].a, rails[i].b].some((e) => [rails[j].a, rails[j].b].some((f) => near(e, f, FIXED_RAIL.board)));
        if (hit) {
          joints++;
          parent[root(i)] = root(j);
        }
      }
    }
    const groups = new Map<number, number>();
    rails.forEach((_, i) => groups.set(root(i), (groups.get(root(i)) ?? 0) + lens[i]));
    const sizes = [...groups.values()].sort((a, b) => b - a);
    console.log(
      `固定レール: ${rails.length}本 合計 ${lens.reduce((a, b) => a + b, 0).toFixed(0)}m 最短 ${Math.min(...lens).toFixed(0)}m 最長 ${Math.max(...lens).toFixed(0)}m、`
        + `乗り継げる組 ${joints}、つながったまとまり ${sizes.length}個（大きい順に ${sizes.slice(0, 4).map((x) => x.toFixed(0)).join("・")}m）、ダッシュパッド ${w.pads.length}個`,
    );
  }

  // 1本に乗る：端で E を押すと反対の端まで進む。乗っている間も撃てる
  {
    const w = createWorld(map, 5, baseLoadout);
    quiet(w);
    const p = w.player;
    const rails = w.rails.filter((r) => r.owner === null);
    const r = rails.reduce((a, b) => (Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) > Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) ? a : b));
    const len = Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y);
    p.pos = { x: r.a.x, y: r.a.y };
    const junk = bagCount(w.bag, "junk");
    bagRemove(w.bag, "junk", junk);
    step(w, { ...emptyInput(), interact: true, aim: { ...r.b } });
    const boardedBroke = !!p.ride;
    bagAdd(w.bag, "junk", junk);
    step(w, { ...emptyInput(), interact: true, aim: { ...r.b } });
    const boarded = p.ride?.rail === r.id;
    const paid = junk - bagCount(w.bag, "junk");
    const t0 = w.time;
    let shots = 0;
    for (let i = 0; i < 30 * 30 && p.ride; i++) {
      step(w, { ...emptyInput(), fire: i % 20 < 3, aim: { x: p.pos.x, y: p.pos.y - 10 } });
      shots += w.events.filter((e) => e.type === "shot" && e.actor === p.id).length;
    }
    const t = w.time - t0;
    console.log(
      `固定レールに乗る: 金属くずが無いと乗れた ${boardedBroke}、乗れた ${boarded}・払った金属くず ${paid}個（決めた値 ${FIXED_RAIL.fare}）、${len.toFixed(0)}m を ${t.toFixed(2)}秒（秒速 ${(len / t).toFixed(1)}m・決めた値 ${FIXED_RAIL.speed}m）、降りた所と端のずれ ${Math.hypot(p.pos.x - r.b.x, p.pos.y - r.b.y).toFixed(2)}m、乗っている間に撃った ${shots}発`,
    );
  }

  // 乗り継ぎ：出発した所から一番遠くまで行ける乗り継ぎ方を地図の上で探し、カーソルを次のレールの先へ向けて E を押しながらたどる
  {
    const w = createWorld(map, 5, baseLoadout);
    quiet(w);
    const p = w.player;
    const rails = w.rails.filter((r) => r.owner === null);
    type Leg = { rail: number; from: Vec; to: Vec };
    let best: Leg[] = [];
    let bestReach = 0;
    for (const r0 of rails) {
      for (const [from0, to0] of [[r0.a, r0.b], [r0.b, r0.a]]) {
        const plan: Leg[] = [{ rail: r0.id, from: from0, to: to0 }];
        const used = new Set([r0.id]);
        for (;;) {
          const at = plan[plan.length - 1].to;
          let next: Leg | null = null;
          for (const r of rails) {
            if (used.has(r.id)) continue;
            for (const [f, t] of [[r.a, r.b], [r.b, r.a]]) {
              if (near(f, at, FIXED_RAIL.board) && (!next || Math.hypot(t.x - from0.x, t.y - from0.y) > Math.hypot(next.to.x - from0.x, next.to.y - from0.y))) next = { rail: r.id, from: f, to: t };
            }
          }
          if (!next || Math.hypot(next.to.x - from0.x, next.to.y - from0.y) <= Math.hypot(at.x - from0.x, at.y - from0.y)) break;
          used.add(next.rail);
          plan.push(next);
        }
        const end = plan[plan.length - 1].to;
        const reach = Math.hypot(end.x - from0.x, end.y - from0.y);
        if (reach > bestReach) {
          bestReach = reach;
          best = plan;
        }
      }
    }
    p.pos = { ...best[0].from };
    const t0 = w.time;
    let wrong = 0, ridden = 0;
    for (const leg of best) {
      step(w, { ...emptyInput(), interact: true, aim: { ...leg.to } });
      if (!p.ride) break;
      if (p.ride.rail !== leg.rail) wrong++;
      while (p.ride) step(w, { ...emptyInput(), aim: { ...leg.to } });
      ridden++;
    }
    const reached = Math.hypot(p.pos.x - best[0].from.x, p.pos.y - best[0].from.y);
    console.log(`固定レールを乗り継ぐ: ${ridden}/${best.length}本 乗り継いで、出発した所から ${reached.toFixed(0)}m 離れた所まで ${(w.time - t0).toFixed(1)}秒、狙っていないレールに乗った回数 ${wrong}`);
  }

  // ダッシュパッド：軸に沿って踏むと飛ぶ。横切っても飛ばない
  {
    const w = createWorld(map, 5, baseLoadout);
    quiet(w);
    const p = w.player;
    const pad = w.pads.find((x) => {
      const u = { x: Math.cos(x.angle), y: Math.sin(x.angle) };
      return map.walkLine({ x: x.pos.x - u.x * 4, y: x.pos.y - u.y * 4 }, { x: x.pos.x + u.x * 32, y: x.pos.y + u.y * 32 }, 0.45);
    })!;
    const u = { x: Math.cos(pad.angle), y: Math.sin(pad.angle) };
    const walk = (from: Vec, dir: Vec, secs: number) => {
      p.pos = { ...from };
      p.vel = { x: 0, y: 0 };
      p.dashT = 0;
      let launched = false;
      for (let i = 0; i < secs * 30; i++) {
        step(w, { ...emptyInput(), move: dir, aim: { x: p.pos.x + dir.x * 5, y: p.pos.y + dir.y * 5 } });
        if (w.events.some((e) => e.type === "dash")) launched = true;
      }
      return { launched, moved: Math.hypot(p.pos.x - from.x, p.pos.y - from.y) };
    };
    const along = walk({ x: pad.pos.x - u.x * 2, y: pad.pos.y - u.y * 2 }, u, 1.5);
    const plain = walk({ x: pad.pos.x - u.x * 2 + u.y * 4, y: pad.pos.y - u.y * 2 - u.x * 4 }, u, 1.5);
    const across = walk({ x: pad.pos.x + u.y * 2, y: pad.pos.y - u.x * 2 }, { x: -u.y, y: u.x }, 0.8);
    console.log(
      `ダッシュパッド: 軸に沿って踏むと 飛んだ ${along.launched}・1.5秒で ${along.moved.toFixed(1)}m（パッドの無い所を歩くと ${plain.moved.toFixed(1)}m）、横切ると 飛んだ ${across.launched}`,
    );
  }

  // 自転車：乗るのにかかる時間・速さ・撃とうとすると降りる・撃たれると降りる
  {
    const prof = rich();
    craft(prof, "bike-city");
    setLoadoutBike(prof, "city");
    const w = createWorld(map, 5, makeRunLoadout(prof));
    quiet(w);
    const p = w.player;
    const r = w.rails.filter((x) => x.owner === null).reduce((a, b) => (Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) > Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) ? a : b));
    const len = Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y);
    const u = { x: (r.b.x - r.a.x) / len, y: (r.b.y - r.a.y) / len };
    p.pos = { x: r.a.x + u.x * 2, y: r.a.y + u.y * 2 };
    const go = (extra: Partial<Input> = {}) => step(w, { ...emptyInput(), move: u, aim: { x: p.pos.x + u.x * 5, y: p.pos.y + u.y * 5 }, ...extra });
    go({ bike: true });
    let mountT = 0;
    while (p.bike!.state === "mounting") {
      go();
      mountT += DT;
    }
    const from = { ...p.pos };
    for (let i = 0; i < 30 * 4; i++) go();
    const speed4 = Math.hypot(p.vel.x, p.vel.y);
    const avg = Math.hypot(p.pos.x - from.x, p.pos.y - from.y) / 4;
    // 左クリックを押し続ける。降りきるまで弾は出ない
    let shotsOnBike = 0, toOff = 0;
    while (p.bike!.state !== "off" && toOff < 3) {
      go({ fire: true });
      if (p.bike!.state !== "off") shotsOnBike += w.events.filter((e) => e.type === "shot" && e.actor === p.id).length;
      toOff += DT;
    }
    go({ bike: true });
    while (p.bike!.state === "mounting") go();
    for (let i = 0; i < 30; i++) go();
    applyDamage(w, p, 1, undefined, p.pos);
    const hitState = p.bike!.state;
    go({ heal: "cell", dash: true });
    const blocked = !p.heal && p.dashT <= 0;
    console.log(
      `自転車（${BIKES.city.name}）: 乗るまで ${mountT.toFixed(2)}秒、4秒後の速さ ${speed4.toFixed(1)}m/s・4秒の平均 ${avg.toFixed(1)}m/s（決めた値 ${BIKES.city.speed}）、`
        + `撃とうとしてから降りるまで ${toOff.toFixed(2)}秒・降りきる前に出た弾 ${shotsOnBike}発、撃たれた後 ${hitState}、乗ったまま回復とダッシュを止められた ${blocked}`,
    );
  }

  // パートナーと動く：自転車で走る・固定レールを乗り継ぐ間に、どれだけ離れるか。80m を超えたら後ろへ移す
  {
    const prof = rich();
    craft(prof, "bike-city");
    setLoadoutBike(prof, "city");
    prof.partners[0] = { model: 1, enabled: true };
    prof.partners[1] = { model: 1, enabled: true };
    const w = createWorld(map, 6, makeRunLoadout(prof));
    quiet(w);
    const p = w.player;
    const partners = w.actors.filter((a) => a.team === "partner");
    const rails = w.rails.filter((x) => x.owner === null);
    const r = rails.reduce((a, b) => (Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) > Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) ? a : b));
    const measure = (label: "自転車" | "固定レール") => {
      p.pos = { ...r.a };
      for (const a of partners) {
        a.pos = { x: r.a.x + 1, y: r.a.y + 1 };
        a.prev = { ...a.pos };
        a.vel = { x: 0, y: 0 };
      }
      for (let i = 0; i < 30; i++) step(w, { ...emptyInput(), aim: { ...r.b } });
      let max = 0, warps = 0;
      const last = partners.map((a) => ({ ...a.pos }));
      const tick = (input: Input) => {
        step(w, input);
        partners.forEach((a, k) => {
          if (Math.hypot(a.pos.x - last[k].x, a.pos.y - last[k].y) > 30) warps++;
          last[k] = { ...a.pos };
          max = Math.max(max, Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y));
        });
      };
      if (label === "自転車") {
        const u = { x: r.b.x - r.a.x, y: r.b.y - r.a.y };
        tick({ ...emptyInput(), bike: true, aim: { ...r.b } });
        for (let i = 0; i < 30 * 15; i++) tick({ ...emptyInput(), move: u, aim: { ...r.b } });
      } else {
        tick({ ...emptyInput(), interact: true, aim: { ...r.b } });
        while (p.ride) tick({ ...emptyInput(), aim: { ...r.b } });
      }
      for (let i = 0; i < 30 * 4; i++) tick({ ...emptyInput(), aim: { ...r.b } });
      const end = partners.map((a) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y).toFixed(1)).join("・");
      console.log(`パートナー2体と${label}: 一番離れた ${max.toFixed(1)}m、後ろへ移した回数 ${warps}、止まって4秒後の距離 ${end}m`);
    };
    measure("自転車");
    measure("固定レール");
    const a = partners[0];
    a.pos = { x: p.pos.x + PARTNER_CATCH_UP.warp + 20, y: p.pos.y };
    step(w, emptyInput());
    const d = Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y);
    console.log(`パートナーが ${PARTNER_CATCH_UP.warp + 20}m 離れると: 次のティックで ${d.toFixed(1)}m の所へ移る、そこからプレイヤーまで歩いて行ける ${map.walkLine(a.pos, p.pos, 0.45)}`);
  }
});

// 区画を出し入れしながら、マップを左右に往復して走る。12m/s（自転車の速さ）
const streamRun = async (range: StreamRange, label: string) => {
  const m = new GameMap(mapIndex);
  const streamer = new ChunkStreamer(m, (i, j) => Promise.resolve(readChunk(i, j)), range);
  const start = { x: BX0 + 20, y: BY0 + 20 };
  await streamer.loadAround(start);
  const w = createWorld(m, 3, baseLoadout, start);
  for (const a of w.actors) if (a !== w.player) a.alive = false;
  const speed = 12;
  const legs: Vec[] = [];
  for (let y = BY0 + 20, k = 0; y < BY1 - 20; y += 200, k++) {
    legs.push({ x: k % 2 ? BX1 - 20 : BX0 + 20, y }, { x: k % 2 ? BX0 + 20 : BX1 - 20, y });
  }
  let leg = 0, ticks = 0, worst = 0, total = 0, missing = 0, maxLoaded = 0;
  // 建物に押し戻されないよう、自分で進めた位置に毎ティック置き直す
  const at = { ...start };
  while (leg < legs.length) {
    const p = w.player;
    const to = legs[leg];
    const d = Math.hypot(to.x - at.x, to.y - at.y);
    const v = d < 1e-6 ? { x: 0, y: 0 } : { x: ((to.x - at.x) / d) * speed, y: ((to.y - at.y) / d) * speed };
    if (d <= speed * DT) {
      at.x = to.x;
      at.y = to.y;
      leg++;
    } else {
      at.x += v.x * DT;
      at.y += v.y * DT;
    }
    p.pos = { ...at };
    p.vel = v;
    const s = performance.now();
    streamer.update(p.pos, p.vel);
    step(w, { ...emptyInput(), aim: { x: p.pos.x + 1, y: p.pos.y } });
    const ms = performance.now() - s;
    total += ms;
    worst = Math.max(worst, ms);
    ticks++;
    maxLoaded = Math.max(maxLoaded, m.chunks.size);
    // 届いた区画を次のティックまでに受け取る
    await Promise.resolve();
    // プレイヤーのいる区画とその周りが読めているか
    const ci = Math.floor(p.pos.x / CHUNK), cj = Math.floor(p.pos.y / CHUNK);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di, j = cj + dj;
        if (mapIndex.chunks.some(([a, b]) => a === i && b === j) && !m.hasChunk(i, j)) missing++;
      }
    }
  }
  console.log(
    `区画の出し入れ（${label}）: ${ticks}ティック 読んだ ${streamer.loads}回 捨てた ${streamer.drops}回 置き場所の取り合い ${m.evictions}回 同時に持った区画 最大 ${maxLoaded}/${mapIndex.chunks.length}、`
      + `周りの区画が間に合わなかった回数 ${missing}　1ティック平均 ${(total / ticks).toFixed(3)}ms 最大 ${worst.toFixed(2)}ms`,
  );
};
timedSection("区画の出し入れ 本来の距離", () => streamRun(STREAM_RANGE, `読む ${STREAM_RANGE.load}m・捨てる ${STREAM_RANGE.drop}m`));
timedSection("区画の出し入れ 縮めた距離", () => streamRun({ load: 160, drop: 240, lookahead: 8 }, "読む 160m・捨てる 240m"));

// 区画を捨てて読み直すと、同じ敵と箱が出て、倒した敵・開けた箱・拾った物は元に戻らない
section("区画を読み直す", () => {
  const w = createWorld(map, 11, baseLoadout);
  const snap = (key: string) => ({
    enemies: w.actors.filter((a) => a.spawn?.chunk === key).map((a) => `${a.spawn!.n}:${a.kind}:${a.pos.x.toFixed(2)},${a.pos.y.toFixed(2)}`),
    loot: w.loot.filter((l) => l.spawn?.chunk === key).map((l) => `${l.spawn!.n}:${l.kind}:${l.pos.x.toFixed(2)},${l.pos.y.toFixed(2)}:${l.items.map((i) => i.item + i.count).join("+")}`),
  });
  const e = w.actors.find((a) => a.team === "enemy" && a.spawn)!;
  const key = e.spawn!.chunk;
  const bin = w.loot.find((l) => l.kind === "bin" && l.spawn?.chunk === key);
  const ground = w.loot.find((l) => l.kind === "ground" && l.spawn?.chunk === key);
  const before = snap(key);
  e.alive = false;
  if (bin) {
    bin.items = bin.items.slice(1);
    bin.opened = true;
  }
  if (ground) w.loot = w.loot.filter((l) => l !== ground);
  const [i, j] = key.split("_").map(Number);
  // step の始めに揃うのと同じ処理を呼ぶ。step を回すと、置いた敵がそのティックのうちに動いて位置が比べられない
  map.removeChunk(i, j);
  syncSpawns(w);
  const gone = snap(key);
  map.addChunk(readChunk(i, j));
  syncSpawns(w);
  const after = snap(key);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, k) => x === b[k]);
  const expectEnemies = before.enemies.filter((x) => !x.startsWith(`${e.spawn!.n}:`));
  const binAfter = bin && w.loot.find((l) => l.spawn?.chunk === key && l.spawn.n === bin.spawn!.n);
  console.log(
    `区画を読み直す（${key}）: 捨てた後の敵 ${gone.enemies.length}人・箱と物 ${gone.loot.length}個、`
      + `読み直した敵 ${after.enemies.length}/${before.enemies.length}人（倒した1人を除いて同じ ${same(after.enemies.filter((x) => expectEnemies.some((y) => y.split(":")[0] === x.split(":")[0])), expectEnemies)}）、`
      + `箱 ${bin ? `中身 ${binAfter?.items.length}/${BIN_ITEMS} 開いている ${binAfter?.opened}` : "なし"}、拾った物 ${ground ? (w.loot.some((l) => l.spawn?.chunk === key && l.spawn.n === ground.spawn!.n) ? "戻った" : "戻らない") : "なし"}`,
  );
});

section("ラン中に使うアイテム", () => {
  const ids = ["ultCharge", "revive", "evac"] as const;
  const seeds = [1, 2, 3, 4, 5, 6];
  const found = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const seed of seeds) {
    const w = createWorld(map, seed, baseLoadout);
    for (const l of w.loot) for (const s of l.items) if (found.has(s.item)) found.set(s.item, found.get(s.item)! + s.count);
  }
  console.log(`ラン中に使うアイテム: 出撃時に読む ${STREAM_RANGE.load}m の内に平均`, Object.fromEntries(ids.map((id) => [ITEMS[id].name, (found.get(id)! / seeds.length).toFixed(2)])));

  const quietWorld = (prof = defaultProfile()) => {
    const w = createWorld(map, 9, makeRunLoadout(prof));
    for (const a of w.actors) if (a.team === "enemy") a.alive = false;
    w.loot = [];
    return w;
  };
  const wait = (w: World, sec: number, input: Partial<Input> = {}) => {
    for (let i = 0; i < Math.round(sec / DT); i++) step(w, { ...emptyInput(), aim: { x: w.player.pos.x + 1, y: w.player.pos.y }, ...input });
  };

  {
    const w = quietWorld();
    const p = w.player;
    p.kit!.ultCd = 100;
    bagAdd(w.bag, "ultCharge", 2);
    step(w, { ...emptyInput(), heal: "ultCharge" });
    wait(w, HEALS.ultCharge.time + 0.1);
    const after = p.kit!.ultCd;
    p.kit!.ultCd = 0;
    step(w, { ...emptyInput(), heal: "ultCharge" });
    console.log(`アルティメット加速: クールダウン 100 → ${after.toFixed(1)}秒（決めた値 −${HEALS.ultCharge.ultCut}）、残り ${bagCount(w.bag, "ultCharge")}個、溜まっているときに使おうとすると始まらない ${p.heal === null}`);
  }

  {
    const prof = defaultProfile();
    prof.items.revive = 1;
    setLoadoutRevive(prof, true);
    const w = quietWorld(prof);
    const p = w.player;
    bagAdd(w.bag, "revive", 1);
    const kill = () => applyDamage(w, p, 1000, undefined, p.pos);
    kill();
    const first = `${p.alive} ヘルス ${p.health} 残り カバン ${bagCount(w.bag, "revive")}・持ち込み ${w.carriedRevive}`;
    wait(w, 1);
    kill();
    const invuln = p.alive && p.health === SELF_REVIVE.health;
    wait(w, SELF_REVIVE.invulnerable);
    kill();
    const second = `${p.alive} 持ち込みを使った ${w.usedCarriedRevive}`;
    wait(w, SELF_REVIVE.invulnerable + 0.1);
    kill();
    console.log(`蘇生アイテム: 1回目 立ち上がった ${first}、${SELF_REVIVE.invulnerable}秒以内はダメージを受けない ${invuln}、2回目 立ち上がった ${second}、3回目 結果=${w.outcome}`);
  }

  {
    const prof = defaultProfile();
    prof.secureBags.push("medium");
    setLoadoutSecureBag(prof, "medium");
    const w = quietWorld(prof);
    bagAdd(w.bag, "circuit", 3);
    bagAdd(w.bag, "revive", 1);
    bagAdd(w.bag, "junk", 7);
    w.bag.money = 900;
    const slotOf = (item: string) => w.bag.slots.findIndex((x) => x?.item === item);
    const order: string[] = [];
    for (const item of ["rifle", "circuit", "revive", "junk"]) {
      step(w, { ...emptyInput(), commands: [{ type: "secure", slot: slotOf(item) }] });
      order.push(`${ITEMS[item as keyof typeof ITEMS].name}→${w.secure.slots.some((x) => x?.item === item) ? "入った" : "入らない"}`);
    }
    applyDamage(w, w.player, 1000, undefined, w.player.pos);
    const haul = (b: typeof w.bag) => ({ money: b.money, materials: { junk: bagCount(b, "junk"), circuit: bagCount(b, "circuit") }, revive: bagCount(b, "revive") });
    const before = { money: prof.money, circuit: prof.materials.circuit, junk: prof.materials.junk, revive: prof.items.revive };
    const r = applyRunResult(prof, { outcome: "dead", kills: 0, bag: haul(w.bag), secure: haul(w.secure), usedCarriedRevive: false });
    console.log(
      `特殊カバン（中・2枠）: ${order.join("・")}。死んで 保管庫 お金 +${prof.money - before.money}・電子部品 +${prof.materials.circuit - before.circuit}・金属くず +${prof.materials.junk - before.junk}・蘇生 +${prof.items.revive - before.revive}、失った お金 ${r.lost.money}・金属くず ${r.lost.materials.junk ?? 0}`,
    );
  }

  {
    const w = quietWorld();
    const p = w.player;
    bagAdd(w.bag, "evac", 1);
    step(w, { ...emptyInput(), heal: "evac" });
    wait(w, 1);
    applyDamage(w, p, 1, undefined, p.pos);
    const stopped = p.heal === null;
    step(w, { ...emptyInput(), heal: "evac" });
    wait(w, HEALS.evac.time + 0.1);
    const picking = p.evac?.state === "pick";
    const far = w.extracts.find((e) => Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y) > EVAC.range + 50);
    if (far) step(w, { ...emptyInput(), commands: [{ type: "evacTo", to: far.pos }] });
    const refused = p.evac?.state === "pick" && bagCount(w.bag, "evac") === 1;
    const goal = w.extracts
      .filter((e) => Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y) <= EVAC.range)
      .sort((a, b) => Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y) - Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y))[0];
    const from = { ...p.pos };
    step(w, { ...emptyInput(), commands: [{ type: "evacTo", to: goal.pos }] });
    const t0 = w.time;
    let shot = 0, hits = 0;
    while (p.evac && w.time - t0 < 60) {
      step(w, { ...emptyInput(), fire: true, aim: { x: p.pos.x + 1, y: p.pos.y } });
      shot += w.events.filter((e) => e.type === "shot" && e.actor === p.id).length;
      if (w.time - t0 > 4 && !hits) {
        applyDamage(w, p, 10, undefined, p.pos);
        hits++;
      }
    }
    const d = Math.hypot(goal.pos.x - from.x, goal.pos.y - from.y);
    console.log(
      `長距離移動: 使っている間に撃たれると止まる ${stopped}、使い終えたら行き先を選ぶ ${picking}、${EVAC.range}m より遠い所は選べない ${refused}、`
      + `${d.toFixed(0)}m を ${(w.time - t0).toFixed(1)}秒で飛んだ（降りた所のずれ ${Math.hypot(p.pos.x - goal.pos.x, p.pos.y - goal.pos.y).toFixed(2)}m）、飛んでいる間に撃った ${shot}発・撃たれたシールド ${p.shield}/${p.shieldMax}、残り ${bagCount(w.bag, "evac")}個`,
    );
  }
});

section("脱出の防衛", () => {
  const D = EXTRACT_DEFENSE;
  for (const seed of [1, 2, 3]) {
    const w = createWorld(map, seed, baseLoadout);
    const p = w.player;
    const ex = w.extracts.reduce((a, b) => (Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) < Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y) ? a : b));
    w.loot = w.loot.filter((l) => Math.hypot(l.pos.x - ex.pos.x, l.pos.y - ex.pos.y) > 4);
    p.pos = { ...ex.pos };
    bagAdd(w.bag, "junk", 10);
    bagAdd(w.bag, "circuit", 5);
    w.bag.money += 1000;
    const before = { junk: bagCount(w.bag, "junk"), circuit: bagCount(w.bag, "circuit"), money: w.bag.money };
    step(w, { ...emptyInput(), interact: true, aim: { x: p.pos.x + 1, y: p.pos.y } });
    const walls = w.barriers.filter((b) => b.owner === -1).length;
    const known = new Set(w.actors.map((a) => a.id));
    // 死なないようにして、迎えが来るまで円の中に立つ。途中の 8 秒は円の外に出る
    let infight = 0, byPlayerSide = 0, shareOut = 0, shareIn = 0, waveDmg = 0, dmgToPlayer = 0;
    // 寄せた敵が中心に固まっていないか。生きている敵の1ティックずつを数える
    let samples = 0, nearCenter = 0, distSum = 0;
    for (let i = 0; i < Math.round((EXTRACT_CALL_TIME + 0.5) / DT); i++) {
      p.invulnT = 1;
      const t = i * DT;
      const out = t >= 20 && t < 28;
      if (i === Math.round(20 / DT)) shareOut = w.defense!.share;
      if (i === Math.round(28 / DT)) shareIn = w.defense!.share;
      p.pos = out ? { x: ex.pos.x + EXTRACT_RADIUS + 2, y: ex.pos.y } : { ...ex.pos };
      step(w, { ...emptyInput(), aim: { x: p.pos.x + 1, y: p.pos.y } });
      const byId = new Map(w.actors.map((a) => [a.id, a]));
      for (const a of w.actors) {
        if (known.has(a.id) || a.team !== "enemy" || !a.alive) continue;
        const dc = Math.hypot(a.pos.x - ex.pos.x, a.pos.y - ex.pos.y);
        samples++;
        distSum += dc;
        if (dc < 10) nearCenter++;
      }
      for (const ev of w.events) {
        if (ev.type === "hit") {
          const v = byId.get(ev.actor), k = byId.get(ev.by);
          if (v && k && !known.has(v.id) && !known.has(k.id)) waveDmg += ev.amount;
          if (v === p && k) dmgToPlayer += ev.amount;
        }
        if (ev.type !== "death") continue;
        const v = byId.get(ev.actor), k = byId.get(ev.by);
        if (Math.hypot(ev.pos.x - ex.pos.x, ev.pos.y - ex.pos.y) > 50) continue;
        if (v?.team === "enemy" && k?.team === "enemy") infight++;
        else if (v?.team === "enemy") byPlayerSide++;
      }
    }
    const waves = w.actors.filter((a) => !known.has(a.id) && a.team === "enemy");
    const factions = [...new Set(waves.map((a) => a.faction))].join("・");
    const sent = w.sent;
    console.log(
      `脱出の防衛 seed=${seed}: 壁 ${walls}枚、寄せた敵 ${waves.length}人（勢力 ${factions}）・迎えが来た時に生きている ${waves.filter((a) => a.alive).length}人、`
        + `脱出地点の 50m 内で 敵どうしで倒れた ${infight}人・それ以外で倒れた ${byPlayerSide}人、寄せた敵どうしのダメージ ${waveDmg}・プレイヤーが受けたダメージ ${dmgToPlayer}、寄せた敵が脱出地点の 10m 内にいた割合 ${samples ? ((nearCenter / samples) * 100).toFixed(0) : "-"}%・距離の平均 ${samples ? (distSum / samples).toFixed(0) : "-"}m、迎えが来た時の距離 ${waves.filter((a) => a.alive).map((a) => Math.round(Math.hypot(a.pos.x - ex.pos.x, a.pos.y - ex.pos.y))).join("・")}m、迎えが来た ${ex.ready}、送った割合 ${(w.defense!.share * 100).toFixed(0)}%（上限 ${D.secureShare * 100}%）・円の外の8秒で増えた ${((shareIn - shareOut) * 100).toFixed(1)}%、`
        + `送った物 お金 ${sent.money}/${before.money}・金属くず ${sent.items.junk ?? 0}/${before.junk}・電子部品 ${sent.items.circuit ?? 0}/${before.circuit}`,
    );
  }
});

section("設置物", () => {
  const prof = defaultProfile();
  prof.devices = { sensor: 5, turret: 3 };
  const w = createWorld(map, 4, makeRunLoadout(prof, map.index.id));
  const p = w.player;
  for (const a of w.actors) if (a.team === "enemy") a.alive = false;
  w.loot = [];
  const placeAt = (kind: "sensor" | "turret", pos: Vec) => {
    p.pos = { ...pos };
    step(w, { ...emptyInput(), place: kind, aim: { x: p.pos.x + 1, y: p.pos.y } });
  };
  const start = { ...p.pos };
  for (let i = 0; i < 5; i++) placeAt("sensor", { x: start.x + i * 3, y: start.y });
  const sensors = w.devices.filter((d) => d.kind === "sensor").length;
  // 壁の向こうの敵が、センサーの範囲で型まで見えるか
  const s0 = w.devices.find((d) => d.kind === "sensor")!;
  const enemy = w.actors.find((a) => a.team === "enemy")!;
  enemy.alive = true;
  let hidden: Vec | null = null;
  for (let r = 6; r < DEVICES.sensor.radius && !hidden; r += 1) {
    for (let k = 0; k < 32 && !hidden; k++) {
      const q = { x: s0.pos.x + Math.cos(k / 5) * r, y: s0.pos.y + Math.sin(k / 5) * r };
      if (w.map.walkable(q.x, q.y) && !w.map.los(start, q) && Math.hypot(q.x - start.x, q.y - start.y) > 24) hidden = q;
    }
  }
  p.pos = { ...start };
  if (hidden) enemy.pos = { ...hidden };
  enemy.ai!.state = "patrol";
  step(w, { ...emptyInput(), aim: { x: p.pos.x + 1, y: p.pos.y } });
  const sensed = enemy.info;
  enemy.alive = false;

  // タレット：視線の通る 15m 先に敵を立たせる
  let tpos = start;
  for (let k = 0; k < 64; k++) {
    const q = { x: start.x + Math.cos(k / 10) * 4, y: start.y + Math.sin(k / 10) * 4 };
    if (w.map.walkable(q.x, q.y) && w.devices.every((d) => Math.hypot(d.pos.x - q.x, d.pos.y - q.y) > 2)) {
      tpos = q;
      break;
    }
  }
  placeAt("turret", tpos);
  const t = w.actors.find((a) => a.team === "device")!;
  let spot: Vec | null = null;
  for (let k = 0; k < 64 && !spot; k++) {
    const q = { x: t.pos.x + Math.cos(k / 10) * 15, y: t.pos.y + Math.sin(k / 10) * 15 };
    if (w.map.walkable(q.x, q.y) && w.map.los(t.pos, q)) spot = q;
  }
  const target = w.actors.filter((a) => a.team === "enemy")[1];
  target.alive = true;
  target.health = 100;
  target.shield = 100;
  target.pos = { ...spot! };
  target.ai!.state = "patrol";
  let turretShots = 0, turretHits = 0;
  const t0 = w.time;
  for (let i = 0; i < 30 * 15 && target.alive; i++) {
    p.invulnT = 1;
    step(w, { ...emptyInput(), aim: { x: p.pos.x + 1, y: p.pos.y } });
    turretShots += w.events.filter((e) => e.type === "shot" && e.actor === t.id).length;
    turretHits += w.events.filter((e) => e.type === "hit" && e.by === t.id).length;
  }
  const killT = w.time - t0;
  const duel = `命中 ${turretHits}発、敵の残り ${Math.round(target.shield + target.health)}・タレットの残り ${Math.round(t.health)}/${DEVICES.turret.health}`;

  // 遠くでは止まる
  p.pos = { x: t.pos.x + DEVICE_ACTIVE_RANGE + 20, y: t.pos.y };
  const far = { x: t.pos.x + 10, y: t.pos.y };
  const enemy2 = w.actors.filter((a) => a.team === "enemy")[2];
  enemy2.alive = true;
  enemy2.pos = far;
  let farShots = 0;
  for (let i = 0; i < 30 * 3; i++) {
    step(w, { ...emptyInput(), aim: { x: p.pos.x + 1, y: p.pos.y } });
    farShots += w.events.filter((e) => e.type === "shot" && e.actor === t.id).length;
  }
  enemy2.alive = false;

  // ランを終えて、次のランに引き継ぐ
  applyRunResult(prof, {
    outcome: "dead", kills: 0, bag: { money: 0, materials: {}, revive: 0 }, secure: { money: 0, materials: {}, revive: 0 }, usedCarriedRevive: false,
    devices: { map: map.index.id, carried: { ...w.carried }, placed: w.devices.map((d) => ({ kind: d.kind, x: d.pos.x, y: d.pos.y })) },
  });
  const w2 = createWorld(map, 5, makeRunLoadout(prof, map.index.id));
  const turrets2 = w2.actors.filter((a) => a.team === "device").length;
  const devices2 = w2.devices.length;
  // 壊されたら消える
  const t2 = w2.actors.find((a) => a.team === "device")!;
  applyDamage(w2, t2, 10000, undefined, t2.pos);
  step(w2, { ...emptyInput(), aim: { x: w2.player.pos.x + 1, y: w2.player.pos.y } });
  console.log(
    `設置物: センサーを5回置いて置けた ${sensors}個（上限 ${DEVICES.sensor.max}）、手持ち センサー ${w.carried.sensor}・タレット ${w.carried.turret}、`
      + `壁の向こうの敵の段階 ${hidden ? sensed : "置き場所なし"}（センサーは ${DEVICES.sensor.level}）、`
      + `タレットが 15m 先の敵を倒すまで ${target.alive ? "倒せない" : `${killT.toFixed(1)}秒`}・${turretShots}発（${duel}）、${DEVICE_ACTIVE_RANGE}m より離れたときに撃った ${farShots}発、`
      + `保管庫 手持ち ${prof.devices.sensor}・${prof.devices.turret} 置いている ${prof.placed.length}個、次のランの設置物 ${devices2}個（タレット ${turrets2}）、壊した後 ${w2.devices.length}個・結果 ${w2.outcome}`,
  );
});

section("銃声で寄ってくる敵", () => {
  // タレットと勢力Aの1人が撃ち合っている所へ、70m 先の勢力Bの3人組が寄ってきて、勢力Aと撃ち合うか
  for (const seed of [1, 2, 3]) {
    const prof = defaultProfile();
    prof.devices = { sensor: 0, turret: 1 };
    const w = createWorld(map, seed, makeRunLoadout(prof, map.index.id));
    const p = w.player;
    for (const a of w.actors) if (a.team === "enemy") a.alive = false;
    w.actors = w.actors.filter((a) => a.alive);
    const rng = new Rng(seed);
    const free = (from: Vec, r: number, see: boolean): Vec | null => {
      for (let k = 0; k < 400; k++) {
        const a = rng.range(-Math.PI, Math.PI);
        const q = { x: from.x + Math.cos(a) * r, y: from.y + Math.sin(a) * r };
        if (w.map.walkable(q.x, q.y) && w.map.los(from, q) === see) return q;
      }
      return null;
    };
    step(w, { ...emptyInput(), place: "turret", aim: { x: p.pos.x + 1, y: p.pos.y } });
    const t = w.actors.find((a) => a.team === "device")!;
    const aPos = free(t.pos, 15, true), bPos = free(t.pos, 70, false), pPos = free(t.pos, 40, false);
    if (!aPos || !bPos || !pPos) {
      console.log(`銃声で寄ってくる敵 seed=${seed}: 置き場所が見つからない`);
      continue;
    }
    p.pos = { ...pPos };
    const a = makeEnemy(w, rng, "mid", 1, aPos, 9001, false);
    w.actors.push(a);
    const bs = (["short", "mid", "long"] as const).map((kind) => makeEnemy(w, rng, kind, 2, { x: bPos.x + rng.range(-2, 2), y: bPos.y + rng.range(-2, 2) }, 9002, false));
    w.actors.push(...bs);
    let near35 = -1, bToA = 0, aToB = 0, bToTurret = 0, bToPlayer = 0, minD = Infinity;
    for (let i = 0; i < 30 * 40; i++) {
      p.invulnT = 1;
      step(w, { ...emptyInput(), aim: { x: p.pos.x + 1, y: p.pos.y } });
      for (const ev of w.events) {
        if (ev.type !== "hit") continue;
        if (ev.actor === a.id && bs.some((b) => b.id === ev.by)) bToA += ev.amount;
        if (ev.by === a.id && bs.some((b) => b.id === ev.actor)) aToB += ev.amount;
        if (ev.actor === t.id && bs.some((b) => b.id === ev.by)) bToTurret += ev.amount;
        if (ev.actor === p.id && bs.some((b) => b.id === ev.by)) bToPlayer += ev.amount;
      }
      const d = Math.min(...bs.filter((b) => b.alive).map((b) => Math.hypot(b.pos.x - t.pos.x, b.pos.y - t.pos.y)));
      minD = Math.min(minD, d);
      if (near35 < 0 && d < 35) near35 = i * DT;
    }
    console.log(
      `銃声で寄ってくる敵 seed=${seed}: 70m 先の3人組がタレットの 35m 内に来るまで ${near35 < 0 ? "来ない" : `${near35.toFixed(1)}秒`}（一番近づいた ${minD.toFixed(0)}m）、`
        + `3人組から勢力Aへのダメージ ${Math.round(bToA)}・勢力Aから3人組へ ${Math.round(aToB)}・3人組からタレットへ ${Math.round(bToTurret)}・3人組からプレイヤーへ ${Math.round(bToPlayer)}、40秒後 勢力A ${a.alive ? "生きている" : "倒れた"}・3人組の生き残り ${bs.filter((b) => b.alive).length}人・タレット ${t.alive ? "残っている" : "壊れた"}`,
    );
  }
});

section("型ごとの近づき方", () => {
  // 38m 先の3人組（近距離・中距離・遠距離）を、プレイヤーが一番削れている敵から撃ち続ける。
  // 3秒目からの12秒で、狙った敵の手前にほかの敵が入って弾を受けた割合（狙った敵の残りが 60 以下のときも別に出す）と、プレイヤーから見た敵どうしの角度の開き・型ごとの距離を見る
  let aimed = 0, blocked = 0, aimedLow = 0, blockedLow = 0, spreadSum = 0, spreadN = 0, placed = 0;
  const distSum = { short: 0, mid: 0, long: 0 }, distN = { short: 0, mid: 0, long: 0 };
  for (let seed = 1; seed <= 120; seed++) {
    const w = createWorld(map, seed, baseLoadout);
    const p = w.player;
    w.actors = w.actors.filter((a) => a.team === "player");
    const rng = new Rng(seed);
    let gPos: Vec | null = null;
    for (let k = 0; k < 400 && !gPos; k++) {
      const ang = rng.range(-Math.PI, Math.PI);
      const q = { x: p.pos.x + Math.cos(ang) * 38, y: p.pos.y + Math.sin(ang) * 38 };
      if (w.map.walkable(q.x, q.y) && w.map.los(p.pos, q)) gPos = q;
    }
    if (!gPos) continue;
    placed++;
    const g = gPos;
    const es = (["short", "mid", "long"] as const).map((kind) => makeEnemy(w, rng, kind, 1, { x: g.x + rng.range(-2, 2), y: g.y + rng.range(-2, 2) }, 9001, false));
    w.actors.push(...es);
    for (const e of es) alert(w, e, p.pos, p, false);
    const ang = (e: Actor) => Math.atan2(e.pos.y - p.pos.y, e.pos.x - p.pos.x);
    for (let i = 0; i < 30 * 15; i++) {
      p.invulnT = 1;
      const ws = p.weapons[p.cur];
      ws.mag = ws.def.mag;
      const seen = es.filter((e) => e.alive && w.map.los(p.pos, e.pos));
      const target = seen.sort((a, b) => a.shield + a.health - (b.shield + b.health))[0];
      const low = !!target && target.shield + target.health <= 60;
      step(w, { ...emptyInput(), aim: target ? { ...target.pos } : { x: p.pos.x + 1, y: p.pos.y }, fire: !!target });
      if (i < 30 * 3) continue;
      for (const ev of w.events) {
        if (ev.type !== "hit" || ev.by !== p.id || !target) continue;
        if (ev.actor === target.id) aimed++;
        else blocked++;
        if (low && ev.actor === target.id) aimedLow++;
        else if (low) blockedLow++;
      }
      const alive = es.filter((e) => e.alive);
      for (let a = 0; a < alive.length; a++) {
        distSum[alive[a].kind as keyof typeof distSum] += Math.hypot(alive[a].pos.x - p.pos.x, alive[a].pos.y - p.pos.y);
        distN[alive[a].kind as keyof typeof distN]++;
        for (let b = a + 1; b < alive.length; b++) {
          spreadSum += Math.abs(angleDiff(ang(alive[a]), ang(alive[b]))) * 180 / Math.PI;
          spreadN++;
        }
      }
    }
  }
  const avg = (k: keyof typeof distSum) => (distSum[k] / Math.max(distN[k], 1)).toFixed(0);
  console.log(
    `型ごとの近づき方（${placed}回）: 手前の敵に吸われた弾 ${Math.round((blocked / Math.max(aimed + blocked, 1)) * 100)}%（${blocked}/${aimed + blocked}発）・残り 60 以下の敵を狙ったとき ${Math.round((blockedLow / Math.max(aimedLow + blockedLow, 1)) * 100)}%（${blockedLow}/${aimedLow + blockedLow}発）、`
      + `敵どうしの角度の開き 平均 ${(spreadSum / Math.max(spreadN, 1)).toFixed(0)}°、プレイヤーからの距離 平均 近距離型 ${avg("short")}m・中距離型 ${avg("mid")}m・遠距離型 ${avg("long")}m`,
  );
});

section("押されている敵はプレイヤーを後回しにする", () => {
  // 勢力Aの1人と勢力Bの3人組が撃ち合っている所に、両方から見える所へプレイヤーが来る。
  // 手を出さなければ勢力Aは3人組を狙い続け、勢力Aを撃てばプレイヤーへ向き直るか
  const run = (seed: number, shoot: boolean) => {
    const prof = defaultProfile();
    const w = createWorld(map, seed, makeRunLoadout(prof, map.index.id));
    const p = w.player;
    w.actors = w.actors.filter((a) => a.team === "player");
    const rng = new Rng(seed);
    const free = (from: Vec, r: number): Vec | null => {
      for (let k = 0; k < 400; k++) {
        const ang = rng.range(-Math.PI, Math.PI);
        const q = { x: from.x + Math.cos(ang) * r, y: from.y + Math.sin(ang) * r };
        if (w.map.walkable(q.x, q.y) && w.map.los(from, q)) return q;
      }
      return null;
    };
    const aPos = { ...p.pos };
    const bPos = free(aPos, 18);
    let pPos: Vec | null = null;
    for (let k = 0; k < 50 && bPos && !pPos; k++) {
      const q = free(aPos, 12);
      if (q && w.map.los(bPos, q)) pPos = q;
    }
    if (!bPos || !pPos) return null;
    p.pos = { ...pPos };
    const a = makeEnemy(w, rng, "mid", 1, aPos, 9001, false);
    const bs = (["short", "mid", "long"] as const).map((kind) => makeEnemy(w, rng, kind, 2, { ...bPos }, 9002, false));
    w.actors.push(a, ...bs);
    let aToB = 0, bToP = 0, aOnP = 0, aAlive = 0;
    for (let i = 0; i < 30 * 6; i++) {
      if (a.alive) {
        aAlive++;
        if (a.ai!.target === p.id) aOnP++;
      }
      p.invulnT = 0;
      const fire = shoot && i < 30 && a.alive;
      step(w, { ...emptyInput(), aim: fire ? { ...a.pos } : { x: p.pos.x + 1, y: p.pos.y }, fire });
      // プレイヤーは倒れないように、受けた分を戻す
      p.shield = p.shieldMax;
      p.health = 100;
      for (const ev of w.events) {
        if (ev.type !== "hit") continue;
        if (ev.by === a.id && bs.some((b) => b.id === ev.actor)) aToB += ev.amount;
        if (bs.some((b) => b.id === ev.by) && ev.actor === p.id) bToP += ev.amount;
      }
    }
    return `勢力Aがプレイヤーを狙っていた割合 ${Math.round((aOnP / Math.max(aAlive, 1)) * 100)}%・勢力A→3人組 ${Math.round(aToB)}・3人組→プレイヤー ${Math.round(bToP)}`;
  };
  for (const seed of [1, 2, 3]) {
    const idle = run(seed, false), shot = run(seed, true);
    console.log(`押されている敵 seed=${seed}: ${idle && shot ? `手を出さない 6秒 ${idle}／最初の1秒 勢力Aを撃つ 6秒 ${shot}` : "置き場所が見つからない"}`);
  }
});

type Done = { k: number; out: string; error?: string; ms: number };

if (isMainThread) {
  const want = process.argv.slice(2);
  const picked = sections.flatMap((s, k) => (!want.length || want.some((x) => s.name.includes(x)) ? [k] : []));
  if (!picked.length) {
    console.error(`名前に ${want.join("・")} を含む項目がない。項目: ${sections.map((s) => s.name).join(" / ")}`);
    process.exit(2);
  }
  const t0 = performance.now();
  const done = new Map<number, Done>();
  let printed = 0;
  const flush = () => {
    for (; printed < picked.length && done.has(picked[printed]); printed++) {
      const d = done.get(picked[printed])!;
      process.stdout.write(d.out);
      if (d.error) console.error(`「${sections[d.k].name}」で例外:\n${d.error}`);
    }
  };
  const pool = (queue: number[], n: number) => Promise.all(Array.from({ length: Math.min(n, queue.length) }, () => new Promise<void>((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url));
    const feed = () => {
      const k = queue.shift();
      if (k === undefined) w.terminate().then(() => resolve());
      else w.postMessage(k);
    };
    w.on("message", (d: Done) => {
      done.set(d.k, d);
      flush();
      feed();
    });
    w.on("error", reject);
    feed();
  })));
  const workers = availableParallelism();
  await pool(picked.filter((k) => sections[k].timed), 1);
  await pool(picked.filter((k) => !sections[k].timed), workers);
  const all = [...done.values()];
  const slow = all.sort((a, b) => b.ms - a.ms).slice(0, 3).map((d) => `${sections[d.k].name} ${(d.ms / 1000).toFixed(1)}秒`).join("、");
  const timed = picked.filter((k) => sections[k].timed).length;
  const how = timed ? `処理時間を測る ${timed}項目は1つずつ、残りは ${workers} 並列` : `${workers} 並列`;
  console.error(`${picked.length}項目を ${((performance.now() - t0) / 1000).toFixed(1)}秒（${how}）。長かった項目: ${slow}`);
  if (all.some((d) => d.error)) process.exitCode = 1;
} else {
  parentPort!.on("message", async (k: number) => {
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(format(...args) + "\n");
    };
    map = await mapAround(layoutStart);
    const t = performance.now();
    let error: string | undefined;
    try {
      await sections[k].run();
    } catch (e) {
      error = e instanceof Error ? e.stack : String(e);
    }
    parentPort!.postMessage({ k, out: lines.join(""), error, ms: performance.now() - t } satisfies Done);
  });
}
