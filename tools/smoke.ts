// 画面なしでゲームを回して、例外が出ないか、処理時間、敵どうしの撃ち合い、漁れる物の量を見る。
// 使い方: npm run smoke
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  BARRIER, BUFF_IDS, PARTNER_TACTICS, BUFFS, BUILDING_USE, DASH, DT, HEAL_SENSE, ITEMS, OVERSHIELD, PARTNER_LEASH, PARTNER_REVIVE, SCAN, SKILLS, THERMITE,
  type BuffId, type KitChoice,
} from "../src/sim/data";
import { buffsOf } from "../src/sim/buffs";
import { applyDamage } from "../src/sim/combat";
import type { Vec } from "../src/sim/map";
import { bagCount, bagUsed } from "../src/sim/inventory";
import { CHUNK, GameMap, decodeChunk, type ChunkJson, type MapIndex } from "../src/sim/map";
import { ChunkStreamer } from "../src/stream";
import { Rng } from "../src/sim/rng";
import { emptyInput, nearestLoot, step, type Input } from "../src/sim/sim";
import { createWorld, type Actor, type World } from "../src/sim/world";
import { craft, craftBlocker, defaultProfile, makeRunLoadout, setAttachment, setLoadoutWeapon, type Profile } from "../src/meta/profile";
import { RECIPES } from "../src/data/recipes";
import type { WeaponType } from "../src/data/weapons";

const baseLoadout = makeRunLoadout(defaultProfile());

const MAP_DIR = "public/maps/akihabara";
const mapIndex = JSON.parse(readFileSync(`${MAP_DIR}/index.json`, "utf8")) as MapIndex;
const readChunk = (i: number, j: number) =>
  decodeChunk(JSON.parse(gunzipSync(readFileSync(`${MAP_DIR}/${i}_${j}.json.gz`)).toString("utf8")) as ChunkJson);
const map = new GameMap(mapIndex);
for (const [i, j] of map.index.chunks) map.addChunk(readChunk(i, j));

// 漁れる物の量
{
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
  console.log(`箱 ${bins.length}個（山 ${bins.length * 4}）　地面 ${ground.length}山　敵 ${enemies.length}人`, Object.fromEntries(byFaction));
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
}

// プレイヤーを置いたまま3分回し、敵どうしで何人倒れるか
for (const seed of [1, 2, 3]) {
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
}

// 脱出地点まで歩きながら、近くの物を拾っていく
for (const seed of [1, 2]) {
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
}

// キャンプから始めると、その近くに出て、近くに敵がいない。迎えを呼ぶと近くの敵が寄ってくる
{
  const camp = { x: map.w * 0.2, y: map.h * 0.3 };
  for (const seed of [1, 2, 3]) {
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
}

/** 敵1人と正面 18m から撃ち合う（撃ち返すだけで動かないボット）。置ける場所が無ければ null。each で毎ティックの入力を足せる */
function duel(prof: Profile, seed: number, each?: (w: World, input: Input) => void): { win: boolean; time: number } | null {
  const w = createWorld(map, seed, makeRunLoadout(prof));
  if (w.player.kit) w.player.kit.ultCd = 0;
  const e = w.actors.filter((a) => a.ai && a.ai.group === 0)[0];
  for (const o of w.actors) if (o.ai && o !== e && Math.hypot(o.pos.x - e.pos.x, o.pos.y - e.pos.y) < 90) o.alive = false;
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
  for (const [label, type, recipes] of builds) {
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
  }
}

// 投げ物とダッシュ
{
  const w = createWorld(map, 7, baseLoadout);
  const p = w.player;
  for (const a of w.actors) if (a.ai) a.alive = false;
  const e = w.actors.find((a) => a.ai)!;
  // 見通しのいい場所で、10m 先に敵を1人置く
  let spot = null;
  const spotRng = new Rng(7);
  for (let tries = 0; tries < 2000 && !spot; tries++) {
    const q = { x: 20 + spotRng.next() * (map.w - 40), y: 20 + spotRng.next() * (map.h - 40) };
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
}

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
    for (let y = 20; y < map.h - 20; y += 3) {
      for (let x = 20; x < map.w - 20 - len; x += 3) {
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
    const e = w.actors.find((a) => a.ai)!;
    e.alive = true;
    e.pos = { ...pos };
    e.vel = { x: 0, y: 0 };
    e.shield = 100;
    e.health = 100;
    return e;
  };

  // 受けたダメージと残りのシールド
  {
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
  }

  // 一定時間で進んだ距離
  {
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
  }

  // 1対1 の勝ち数と、倒すまでの時間
  {
    const cases: [string, Partial<KitChoice>, boolean][] = [
      ["スキルなし", { skill: "overshield", passive: "killShield" }, false],
      ["速射", { skill: "rapidFire" }, true],
      ["弾の威力", { passive: "damageUp" }, false],
    ];
    for (const [label, kit, use] of cases) {
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
    }
  }

  // 置いた壁で弾が止まるか、敵が回り込むか、消えた後に元の格子に戻るか
  {
    const w = withKit({ ult: "barrier" });
    const q = openLine(14);
    const p = w.player;
    p.pos = { ...q };
    const r = { x: q.x + 12, y: q.y };
    const e = enemyAt(w, r);
    const solidNow = () => {
      const out: number[] = [];
      for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) out.push(w.map.solidAt(x, y));
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
  }

  // 巻き検知の円の中心が敵の位置と一致しないか。広域探知で見える段階
  {
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
  }

  // 弾倉なし：マガジンが減らず、カバンの弾が減る
  {
    const w = withKit({ ult: "bottomless" });
    const p = w.player;
    const ws = p.weapons[p.cur];
    const mag = ws.mag, bag = bagCount(w.bag, ws.def.ammo);
    runFor(w, 30 * 3, (i) => ({ ult: i === 0, fire: true }));
    console.log(`弾倉なし: 3秒撃って マガジン ${mag} → ${ws.mag}、カバンの弾 ${bag} → ${bagCount(w.bag, ws.def.ammo)}、リロードしていない ${p.reloadT === 0}`);
  }
}

// 強化パーツ：1ランに出る数と、拾ったときの効き目
{
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
  console.log(`強化パーツ: 1ランに平均 ${(total / seeds.length).toFixed(1)}個`, avg);

  // 足元に強化パーツを1つ置いて E で拾わせる
  const pick = (w: World, id: BuffId) => {
    const p = w.player;
    w.loot.push({ id: w.nextId++, pos: { ...p.pos }, kind: "ground", items: [{ item: id, count: 1 }], opened: true, angle: 0 });
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
}

// パートナー
{
  const profWith = (n: number, model: 1 | 2 = 1) => {
    const prof = rich();
    for (let i = 0; i < n; i++) prof.partners[i] = { model, enabled: true };
    return prof;
  };

  // クラフトの順番：1体目 → 2体目 → 1体目の改良
  {
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
  }

  // 脱出地点まで歩く。パートナーが付いてこられるか、どれだけ離れるか
  for (const seed of [1, 2]) {
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
  }

  // 敵の3人組と撃ち合う。プレイヤー役は動かずに、見えている一番近い敵を撃つ。シールドが割れて敵が見えていなければ巻く
  const squad = (partnerCount: number, seed: number) => {
    const w = createWorld(map, seed, makeRunLoadout(profWith(partnerCount)));
    const p = w.player;
    const group = w.actors.filter((a) => a.ai && a.team === "enemy" && a.ai.group === 0);
    const center = group[0].pos;
    for (const o of w.actors) if (o.team === "enemy" && !group.includes(o) && Math.hypot(o.pos.x - center.x, o.pos.y - center.y) < 120) o.alive = false;
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
  for (const n of [0, 1, 2]) {
    let wins = 0, total = 0, hp = 0, downs = 0, far = 0, samples = 0, time = 0;
    const t0 = performance.now();
    let ticks = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const r = squad(n, seed);
      if (!r) continue;
      total++;
      ticks += r.time / DT;
      if (r.win) {
        wins++;
        hp += r.hp;
        time += r.time;
      }
      downs += r.downs;
      far += r.far;
      samples += r.samples;
    }
    const ms = performance.now() - t0;
    console.log(
      `パートナー${n}体 対 3人組: 勝ち ${wins}/${total} 勝ったときの残り体力 平均 ${(hp / Math.max(wins, 1)).toFixed(0)}/200 倒すまで平均 ${(time / Math.max(wins, 1)).toFixed(1)}秒` +
        (n ? `　パートナーが倒れた回数 ${downs}（1戦あたり ${(downs / total).toFixed(2)}）、${PARTNER_LEASH}m より離れていた時間 ${((far / Math.max(samples, 1)) * 100).toFixed(1)}%` : "") +
        `　1ティック平均 ${(ms / ticks).toFixed(3)}ms`,
    );
  }

  // パートナー1体と敵の中距離型1人が 18m で撃ち合う。プレイヤーは倒れた扱いにして、敵に狙わせない
  for (const [model, mode] of [[1, "cover"], [2, "cover"], [1, "classic"], [2, "classic"]] as const) {
    PARTNER_TACTICS.mode = mode;
    let wins = 0, total = 0, hp = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const w = createWorld(map, seed, makeRunLoadout(profWith(1, model)));
      const a = w.actors.find((x) => x.team === "partner")!;
      const e = w.actors.find((x) => x.team === "enemy" && x.kind === "mid")!;
      for (const o of w.actors) if (o.team === "enemy" && o !== e && Math.hypot(o.pos.x - e.pos.x, o.pos.y - e.pos.y) < 120) o.alive = false;
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
    PARTNER_TACTICS.mode = "cover";
    console.log(`パートナー（${model === 1 ? "初期型" : "改良型"}・${mode === "cover" ? "遮蔽を使う" : "前の作り"}） 対 敵の中距離型 1対1: 勝ち ${wins}/${total} 勝ったときの残り体力 平均 ${(hp / Math.max(wins, 1)).toFixed(0)}/${model === 1 ? 200 : 225}`);
  }

  // パートナーの回復。散策中は満タンまで巻き、戦闘中は隙を見て巻く
  {
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
  }

  // 倒れたパートナーを起こす。撃たれたら押し直しになる
  {
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
  }
}

// 区画を出し入れしながら走る。秋葉原は狭いので、読む距離を縮めて捨てる所まで通す
{
  const m = new GameMap(mapIndex);
  const streamer = new ChunkStreamer(m, (i, j) => Promise.resolve(readChunk(i, j)), { load: 160, drop: 240, lookahead: 8 });
  const start = { x: 20, y: 20 };
  await streamer.loadAround(start);
  const w = createWorld(m, 3, baseLoadout, start);
  for (const a of w.actors) if (a !== w.player) a.alive = false;
  // マップを左右に往復しながら下へ進む。12m/s（自転車の速さの見当）
  const speed = 12;
  const legs: Vec[] = [];
  for (let y = 20, k = 0; y < m.h - 20; y += 110, k++) legs.push({ x: k % 2 ? m.w - 20 : 20, y }, { x: k % 2 ? 20 : m.w - 20, y });
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
    `区画の出し入れ（読む 160m・捨てる 240m）: ${ticks}ティック 読んだ ${streamer.loads}回 捨てた ${streamer.drops}回 同時に持った区画 最大 ${maxLoaded}/${mapIndex.chunks.length}、`
      + `周りの区画が間に合わなかった回数 ${missing}　1ティック平均 ${(total / ticks).toFixed(3)}ms 最大 ${worst.toFixed(2)}ms`,
  );
}
