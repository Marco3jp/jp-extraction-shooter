// 画面なしでゲームを回して、例外が出ないか、処理時間、敵どうしの撃ち合い、漁れる物の量を見る。
// 使い方: npm run smoke
import { readFileSync } from "node:fs";
import { BUILDING_USE, DT, THERMITE } from "../src/sim/data";
import type { Vec } from "../src/sim/map";
import { bagCount, bagUsed } from "../src/sim/inventory";
import { GameMap, type MapJson } from "../src/sim/map";
import { emptyInput, nearestLoot, step } from "../src/sim/sim";
import { createWorld } from "../src/sim/world";
import { craft, defaultProfile, makeRunLoadout, setAttachment, setLoadoutWeapon, type Profile } from "../src/meta/profile";
import type { WeaponType } from "../src/data/weapons";

const baseLoadout = makeRunLoadout(defaultProfile());

const json = JSON.parse(readFileSync("public/maps/akihabara.json", "utf8")) as MapJson;
const map = new GameMap(json);

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
      const bi = map.buildingIndex[cx + dx + (cy + dy) * map.w];
      if (bi >= 0) {
        use = BUILDING_USE[map.json.buildings[bi].type];
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
  w.player.pos = { ...w.extract.pos };
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
    w.extract.progress = 0;
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
  const route = map.findPath(p.pos, w.extract.pos, 400000) ?? [];
  let opened = 0;
  for (let i = 0; i < 30 * 300 && w.outcome === "playing"; i++) {
    const input = emptyInput();
    while (route.length && Math.hypot(route[0].x - p.pos.x, route[0].y - p.pos.y) < 0.8) route.shift();
    const next = route[0] ?? w.extract.pos;
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
    step(w, input);
  }
  console.log(
    `seed=${seed} 漁りながら脱出: 結果=${w.outcome} ${w.time.toFixed(0)}秒 撃破 ${w.kills} 箱 ${opened}回 カバン ${bagUsed(w.bag)}枠 お金 ${w.bag.money}円 金属くず ${bagCount(w.bag, "junk")} 電子部品 ${bagCount(w.bag, "circuit")}`,
  );
}

// 武器ごとに、敵1人と正面 18m から撃ち合って勝てるか（撃ち返すだけで動かないボット）
{
  const rich = (): Profile => {
    const p = defaultProfile();
    p.money = 1e6;
    p.materials = { junk: 999, circuit: 999, precision: 999 };
    for (const r of ["wpn-smg", "wpn-shotgun", "wpn-long"]) craft(p, r);
    return p;
  };
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
    let wins = 0, total = 0, kills = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const prof = rich();
      setLoadoutWeapon(prof, 0, type);
      for (const r of recipes) {
        craft(prof, r);
        const id = r.replace("att-", "") as Parameters<typeof setAttachment>[3] & string;
        const slot = id.endsWith("Receiver") ? "receiver" : id.endsWith("Mag") ? "magazine" : id.endsWith("Barrel") ? "barrel" : "stock";
        setAttachment(prof, type, slot, id);
      }
      const w = createWorld(map, seed, makeRunLoadout(prof));
      const e = w.actors.filter((a) => a.ai && a.ai.group === 0)[0];
      for (const o of w.actors) if (o.ai && o !== e && Math.hypot(o.pos.x - e.pos.x, o.pos.y - e.pos.y) < 90) o.alive = false;
      const group = [e];
      let placed = false;
      for (let k = 0; k < 64 && !placed; k++) {
        const a = (k / 64) * Math.PI * 2;
        const q = { x: e.pos.x + Math.cos(a) * 18, y: e.pos.y + Math.sin(a) * 18 };
        if (!map.blockedAt(q.x, q.y) && group.every((o) => map.los(q, o.pos))) {
          w.player.pos = { ...q };
          placed = true;
        }
      }
      if (!placed) continue;
      total++;
      for (let i = 0; i < 30 * 40 && w.outcome === "playing"; i++) {
        const input = emptyInput();
        const t = w.actors.filter((a) => a.alive && a.ai && a.seen).sort((a, b) => Math.hypot(a.pos.x - w.player.pos.x, a.pos.y - w.player.pos.y) - Math.hypot(b.pos.x - w.player.pos.x, b.pos.y - w.player.pos.y))[0];
        input.aim = t ? { ...t.pos } : { x: w.player.pos.x + 1, y: w.player.pos.y };
        input.fire = !!t;
        step(w, input);
        if (group.every((a) => !a.alive)) break;
      }
      kills += group.filter((a) => !a.alive).length;
      if (w.player.alive) wins++;
    }
    console.log(`${label}: 1対1の勝ち ${wins}/${total}`);
    void kills;
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
  for (let tries = 0; tries < 2000 && !spot; tries++) {
    const q = { x: 20 + Math.random() * (map.w - 40), y: 20 + Math.random() * (map.h - 40) };
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
