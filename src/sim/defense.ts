// 脱出の迎えを待つ間の防衛。壁を立て、勢力の違う敵のグループを別々の方向から寄せ、円の中にいる間にカバンの中身を送る
import { DT, ENEMY_SPAWNS, EXTRACT_CALL_HEAR, EXTRACT_CALL_TIME, EXTRACT_DEFENSE, EXTRACT_RADIUS, ITEM_ORDER, ITEMS, SECURABLE, type ItemId } from "./data";
import { alert, hostile } from "./ai";
import { flying } from "./evac";
import { bagCount, bagRemove } from "./inventory";
import type { Vec } from "./map";
import { raiseWall } from "./skills";
import { makeEnemy, townFaction } from "./spawn";
import type { Actor, Extract, World } from "./world";

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

/** 防衛の間に送る物。死んでも持ち帰れる枠に入れられる物と同じ */
const SENDABLE: ItemId[] = ITEM_ORDER.filter((id) => SECURABLE.includes(ITEMS[id].category));

/** 迎えを呼ぶ。防衛中なら呼べない */
export function callExtract(w: World, e: Extract, caller: Actor): boolean {
  if (w.defense && !w.defense.extract.ready) {
    w.events.push({ type: "notice", text: "ほかの脱出地点で迎えを待っている" });
    return false;
  }
  const D = EXTRACT_DEFENSE;
  e.readyAt = w.time + EXTRACT_CALL_TIME;
  const rng = w.rng;
  const factions = ENEMY_SPAWNS.map((f) => f.faction);
  const home = townFaction(w.map.areaAt(e.pos.x, e.pos.y));
  const away = factions.find((f) => f !== home) ?? home;
  const base = rng.range(-Math.PI, Math.PI);
  w.defense = {
    extract: e,
    share: w.defense?.share ?? 0,
    waves: D.waves.map((at, i) => ({
      at,
      faction: i % 2 === 0 ? away : home,
      angle: base + (i * Math.PI * 2) / D.waves.length + rng.range(-0.3, 0.3),
      done: false,
    })),
    rally: new Map(),
    startedAt: w.time,
  };
  raiseWalls(w, e);
  w.events.push({ type: "extractCall", pos: { ...e.pos } });
  w.events.push({ type: "notice", text: `脱出の迎えを呼んだ。${EXTRACT_CALL_TIME}秒耐える。円の中にいる間、持ち物を送る` });
  for (const o of w.actors) {
    if (!o.ai || o.team !== "enemy" || !o.alive || !hostile(o, caller)) continue;
    if (dist(o.pos, e.pos) < EXTRACT_CALL_HEAR) addRally(w, o, Math.atan2(o.pos.y - e.pos.y, o.pos.x - e.pos.x));
  }
  return true;
}

function raiseWalls(w: World, e: Extract) {
  const D = EXTRACT_DEFENSE;
  const until = e.readyAt! + D.wallLinger;
  const rng = w.rng;
  const at = (ang: number, r: number) => ({ x: Math.floor(e.pos.x + Math.cos(ang) * r), y: Math.floor(e.pos.y + Math.sin(ang) * r) });
  // 円の外の四方に、円へ向かう線と直角な壁を立てる
  const turn = rng.range(0, Math.PI / 2);
  for (let i = 0; i < D.inner.count; i++) {
    const ang = turn + (i * Math.PI * 2) / D.inner.count;
    const c = at(ang, D.inner.radius);
    raiseWall(w, -1, c.x, c.y, Math.abs(Math.sin(ang)) > Math.abs(Math.cos(ang)), D.inner.length, D.inner.hp, until);
  }
  for (let i = 0; i < D.outer.count; i++) {
    const ang = rng.range(-Math.PI, Math.PI);
    const c = at(ang, rng.range(D.outer.radius[0], D.outer.radius[1]));
    raiseWall(w, -1, c.x, c.y, rng.chance(0.5), D.outer.length, D.outer.hp, until);
  }
}

/** 脱出地点から angle の向きに rally m の所。建物の中や見通せない所なら、近く・横へずらす */
function rallyPoint(w: World, e: Extract, angle: number): Vec {
  for (let r = EXTRACT_DEFENSE.rally; r >= 5; r -= 2) {
    for (const da of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9]) {
      const p = { x: e.pos.x + Math.cos(angle + da) * r, y: e.pos.y + Math.sin(angle + da) * r };
      if (w.map.walkable(p.x, p.y) && w.map.los(e.pos, p)) return p;
    }
  }
  return { ...e.pos };
}

function addRally(w: World, o: Actor, angle: number) {
  w.defense!.rally.set(o.id, rallyPoint(w, w.defense!.extract, angle));
  o.ai!.rival = true;
}

/** angle の向きの、脱出地点から wave m ほどの歩ける所にグループを置く */
function spawnWave(w: World, faction: number, angle: number) {
  const D = EXTRACT_DEFENSE;
  const e = w.defense!.extract;
  const map = w.map;
  const rng = w.rng;
  let center: Vec | null = null;
  for (let tries = 0; tries < 80 && !center; tries++) {
    const a = angle + rng.range(-0.6, 0.6);
    const r = rng.range(D.wave[0], D.wave[1]);
    const p = { x: e.pos.x + Math.cos(a) * r, y: e.pos.y + Math.sin(a) * r };
    if (!map.blocked(Math.floor(p.x), Math.floor(p.y)) && dist(p, w.player.pos) > 30) center = p;
  }
  if (!center) return;
  const members = rng.pick(ENEMY_SPAWNS.find((f) => f.faction === faction)!.groups);
  const gid = w.nextGroup++;
  for (const kind of members) {
    let p = center;
    for (let k = 0; k < 30; k++) {
      const q = { x: center.x + rng.range(-3, 3), y: center.y + rng.range(-3, 3) };
      if (!map.blockedAt(q.x, q.y) && map.los(center, q)) {
        p = q;
        break;
      }
    }
    const o = makeEnemy(w, rng, kind, faction, { ...p }, gid, false);
    w.actors.push(o);
    addRally(w, o, angle);
  }
}

/** 円の中にいる間、カバンの中身を少しずつ送る */
function send(w: World) {
  const d = w.defense!;
  const p = w.player;
  const max = EXTRACT_DEFENSE.secureShare;
  if (d.extract.ready || d.share >= max || !p.alive || flying(p) || dist(p.pos, d.extract.pos) > EXTRACT_RADIUS) return;
  d.share = Math.min(max, d.share + (max * DT) / EXTRACT_CALL_TIME);
  const move = (item: ItemId, sent: number): number => {
    const have = bagCount(w.bag, item);
    const want = Math.floor((have + sent) * d.share) - sent;
    return want > 0 ? bagRemove(w.bag, item, Math.min(want, have)) : 0;
  };
  w.sent.money += move("money", w.sent.money);
  let changed = false;
  for (const id of SENDABLE) {
    const n = move(id, w.sent.items[id] ?? 0);
    if (n > 0) {
      w.sent.items[id] = (w.sent.items[id] ?? 0) + n;
      changed = true;
    }
  }
  if (changed) w.events.push({ type: "lootChanged" });
}

export function tickDefense(w: World) {
  const d = w.defense;
  if (!d) return;
  for (const wave of d.waves) {
    if (wave.done || w.time - d.startedAt < wave.at) continue;
    wave.done = true;
    spawnWave(w, wave.faction, wave.angle);
  }
  // 見失った敵も、脱出地点の自分の側へ戻らせる
  for (const o of w.actors) {
    const to = d.rally.get(o.id);
    const ai = o.ai;
    if (!to || !ai || !o.alive || ai.canSee) continue;
    if (ai.state === "patrol") alert(w, o, to, null, false);
    else if (!ai.lastSeen || w.time - ai.lastSeenT > 2) {
      ai.lastSeen = { ...to };
      ai.lastSeenT = w.time;
    }
  }
  send(w);
}
