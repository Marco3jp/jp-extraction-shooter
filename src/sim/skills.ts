import { cancelHeal } from "./combat";
import {
  BARRIER, DASH, DT, FIXED_RAIL, HEAL_SENSE, OVERSHIELD, RAIL, RAPID_FIRE, SCAN, SKILLS, SLIDE, ULTS, type StatMod,
} from "./data";
import { Solid, type Vec } from "./map";
import { applyActorModifiers, computeWeapon } from "./stats";
import type { Actor, Rail, World } from "./world";

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

function closestOnSeg(p: Vec, a: Vec, b: Vec): Vec {
  const dx = b.x - a.x, dy = b.y - a.y;
  const ll = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / ll));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/** mods を積み上げて、武器の性能・移動速度・シールドの上限などを計算し直す */
export function refreshStats(a: Actor) {
  if (!a.build) return;
  const mods = a.mods.flatMap((m) => m.mods);
  const s = applyActorModifiers(a.build.stats, mods);
  a.moveMul = s.moveMul;
  a.shieldMax = Math.round(s.shieldMax);
  a.shield = Math.min(a.shield, a.shieldMax);
  a.killShield = s.killShield;
  a.skillCdMul = s.skillCd;
  a.dashCdMul = s.dashCd;
  const dashMax = Math.max(1, Math.round(s.dashCharges));
  if (dashMax !== a.dashMax) {
    a.dashCharges = Math.min(a.dashCharges + Math.max(0, dashMax - a.dashMax), dashMax);
    a.dashMax = dashMax;
  }
  a.build.weapons.forEach((b, i) => {
    const ws = a.weapons[i];
    if (!ws) return;
    ws.def = computeWeapon(b.type, b.attachments, mods, a.build!.minTtk);
    ws.mag = Math.min(ws.mag, ws.def.mag);
  });
}

function addTimedMods(w: World, a: Actor, source: string, mods: StatMod[], duration: number) {
  a.mods = a.mods.filter((m) => m.source !== source);
  a.mods.push({ source, mods, until: w.time + duration });
  refreshStats(a);
}

export function bottomlessOn(a: Actor): boolean {
  return !!a.kit && a.kit.ult === "bottomless" && a.kit.ultT > 0;
}

/** スキル（Q）。使えたら true */
export function useSkill(w: World, a: Actor, aim: Vec, move: Vec): boolean {
  const k = a.kit;
  if (!k || !a.alive || k.skillCd > 0) return false;
  const def = SKILLS[k.skill];
  switch (k.skill) {
    case "overshield":
      a.overshield = OVERSHIELD.amount;
      a.overshieldT = OVERSHIELD.duration;
      break;
    case "haste":
    case "rapidFire":
      addTimedMods(w, a, `skill:${k.skill}`, def.mods!, def.duration);
      break;
    case "slide": {
      if (a.ride) a.ride = null;
      const ml = Math.hypot(move.x, move.y);
      const ang = Math.atan2(aim.y - a.pos.y, aim.x - a.pos.x);
      a.dashDir = ml > 0 ? { x: move.x / ml, y: move.y / ml } : { x: Math.cos(ang), y: Math.sin(ang) };
      a.dashT = SLIDE.time;
      a.dashSpeed = SLIDE.distance / SLIDE.time;
      a.dashSteer = true;
      a.sprinting = false;
      if (a.heal) cancelHeal(w, a);
      w.events.push({ type: "dash", actor: a.id, pos: { ...a.pos }, dir: { ...a.dashDir } });
      break;
    }
  }
  k.skillCd = def.cooldown * a.skillCdMul;
  k.skillT = def.duration;
  w.events.push({ type: "skill", actor: a.id, pos: { ...a.pos }, id: k.skill });
  return true;
}

/** アルティメット（F）。使えたら true */
export function useUlt(w: World, a: Actor, aim: Vec): boolean {
  const k = a.kit;
  if (!k || !a.alive || k.ultCd > 0) return false;
  switch (k.ult) {
    case "barrier":
      if (!placeBarrier(w, a, aim)) {
        w.events.push({ type: "notice", text: "そこには壁を立てられない" });
        return false;
      }
      break;
    case "scan":
      for (const e of w.actors) {
        if (e.team === "enemy" && e.alive && dist(e.pos, a.pos) <= SCAN.range) e.revealUntil = w.time + SCAN.duration;
      }
      break;
    case "rail": {
      const rail = layRail(w, a, aim);
      if (!rail) {
        w.events.push({ type: "notice", text: "その向きにはレールを敷けない" });
        return false;
      }
      a.ride = { rail: rail.id, dir: 1 };
      a.dashT = 0;
      if (a.heal) cancelHeal(w, a);
      break;
    }
    case "bottomless":
      a.reloadT = 0;
      break;
  }
  k.ultCd = ULTS[k.ult].cooldown;
  k.ultT = ULTS[k.ult].duration;
  w.events.push({ type: "skill", actor: a.id, pos: { ...a.pos }, id: k.ult });
  return true;
}

/** 倒したとき */
export function onKill(w: World, killer: Actor) {
  if (!killer.alive) return;
  const k = killer.kit;
  if (k?.skill === "rapidFire" && k.skillT > 0) {
    const m = killer.mods.find((x) => x.source === "skill:rapidFire");
    if (m?.until != null) m.until += RAPID_FIRE.killExtend;
    k.skillT += RAPID_FIRE.killExtend;
  }
  if (k?.skill === "slide") k.skillCd = 0;
  if (killer.killShield <= 0) return;
  const before = killer.shield;
  killer.shield = Math.min(killer.shieldMax, killer.shield + killer.killShield);
  if (killer.shield > before) w.events.push({ type: "killShield", actor: killer.id, amount: killer.shield - before });
}

/** 毎ティック、生きている人ごとに呼ぶ */
export function tickSkills(w: World, a: Actor) {
  if (a.dashCharges < a.dashMax) {
    a.dashCd -= DT;
    if (a.dashCd <= 0) {
      a.dashCharges++;
      a.dashCd = a.dashCharges < a.dashMax ? DASH.cooldown * a.dashCdMul + a.dashCd : 0;
    }
  }
  if (a.overshieldT > 0) {
    a.overshieldT = Math.max(0, a.overshieldT - DT);
    if (a.overshieldT <= 0) a.overshield = 0;
  }
  const n = a.mods.length;
  a.mods = a.mods.filter((m) => m.until === null || m.until > w.time);
  if (a.mods.length !== n) refreshStats(a);

  const k = a.kit;
  if (!k) return;
  k.skillCd = Math.max(0, k.skillCd - DT);
  k.ultCd = Math.max(0, k.ultCd - DT);
  k.skillT = Math.max(0, k.skillT - DT);
  k.ultT = Math.max(0, k.ultT - DT);
  if (k.skill === "overshield" && a.overshield <= 0) k.skillT = 0;
  if (k.ult === "barrier") k.ultT = Math.max(0, ...w.barriers.filter((b) => b.owner === a.id).map((b) => b.until - w.time));
  if (k.ult === "rail") k.ultT = Math.max(0, ...w.rails.filter((r) => r.owner === a.id).map((r) => r.until - w.time));
  if (k.passive === "healSense") updateHealMarks(w, a);
}

/** 置いた壁・レールの時間切れ */
export function tickSkillObjects(w: World) {
  for (const b of w.barriers) if (b.until <= w.time) removeBarrier(w, b.id, false);
  w.rails = w.rails.filter((r) => r.until > w.time);
  for (const a of w.actors) {
    if (a.ride && !w.rails.some((r) => r.id === a.ride!.rail)) a.ride = null;
  }
}

// ---- 巻き検知 ----

function updateHealMarks(w: World, a: Actor) {
  const keep = new Set<number>();
  for (const e of w.actors) {
    if (e.team !== "enemy" || !e.alive || !e.heal || dist(e.pos, a.pos) > HEAL_SENSE.range) continue;
    keep.add(e.id);
    let m = w.healMarks.find((x) => x.actor === e.id);
    if (!m) {
      m = { actor: e.id, pos: { ...e.pos }, next: 0 };
      w.healMarks.push(m);
    }
    if (w.time < m.next) continue;
    const ang = w.rng.range(0, Math.PI * 2);
    const r = w.rng.range(HEAL_SENSE.offsetMin, HEAL_SENSE.offsetMax);
    m.pos = { x: e.pos.x + Math.cos(ang) * r, y: e.pos.y + Math.sin(ang) * r };
    m.next = w.time + HEAL_SENSE.every;
  }
  w.healMarks = w.healMarks.filter((m) => keep.has(m.actor));
}

// ---- 遮蔽物 ----

function repathAll(w: World) {
  for (const o of w.actors) if (o.ai) o.ai.repathT = 0;
}

/** カーソルの位置に、狙った向きと直角に、マス目に沿った壁を立てる。人がいるマスと塞がったマスは飛ばす */
function placeBarrier(w: World, a: Actor, aim: Vec): boolean {
  const map = w.map;
  const ang = Math.atan2(aim.y - a.pos.y, aim.x - a.pos.x);
  const d = Math.min(BARRIER.range, dist(a.pos, aim));
  let at = { x: a.pos.x + Math.cos(ang) * d, y: a.pos.y + Math.sin(ang) * d };
  const hit = map.raycast(a.pos.x, a.pos.y, at.x, at.y);
  if (hit <= 1) {
    const k = Math.max(0, hit - 0.8 / Math.max(d, 0.01));
    at = { x: a.pos.x + (at.x - a.pos.x) * k, y: a.pos.y + (at.y - a.pos.y) * k };
  }
  const alongX = Math.abs(Math.sin(ang)) > Math.abs(Math.cos(ang));
  return raiseWall(w, a.id, Math.floor(at.x), Math.floor(at.y), alongX, BARRIER.length, BARRIER.hp, w.time + BARRIER.duration);
}

/** (cx, cy) のマスを真ん中に、マス目に沿って length マスの壁を立てる。人がいるマスと塞がったマスは飛ばす。owner は立てた人の番号 */
export function raiseWall(w: World, owner: number, cx: number, cy: number, alongX: boolean, length: number, hp: number, until: number): boolean {
  const map = w.map;
  const cells: Vec[] = [];
  const half = Math.floor(length / 2);
  for (let i = -half; i < length - half; i++) {
    const x = alongX ? cx + i : cx, y = alongX ? cy : cy + i;
    if (map.blocked(x, y)) continue;
    const occupied = w.actors.some((o) => {
      if (!o.alive) return false;
      const qx = Math.max(x, Math.min(o.pos.x, x + 1)), qy = Math.max(y, Math.min(o.pos.y, y + 1));
      return Math.hypot(o.pos.x - qx, o.pos.y - qy) < o.radius + 0.05;
    });
    if (occupied) continue;
    cells.push({ x, y });
  }
  if (!cells.length) return false;
  for (const c of cells) map.setSolid(c.x, c.y, Solid.cover);
  w.barriers.push({ id: w.nextId++, owner, cells, hp, maxHp: hp, until });
  repathAll(w);
  return true;
}

function removeBarrier(w: World, id: number, broken: boolean) {
  const b = w.barriers.find((x) => x.id === id);
  if (!b) return;
  for (const c of b.cells) w.map.setSolid(c.x, c.y, Solid.free);
  w.barriers = w.barriers.filter((x) => x !== b);
  repathAll(w);
  if (broken) {
    const c = b.cells[b.cells.length >> 1];
    w.events.push({ type: "barrierBreak", pos: { x: c.x + 0.5, y: c.y + 0.5 } });
  }
}

/** 弾が塞がったマスに当たったとき。そこが壁なら耐久を減らす */
export function hitBarrier(w: World, cx: number, cy: number, damage: number) {
  const b = w.barriers.find((x) => x.cells.some((c) => c.x === cx && c.y === cy));
  if (!b) return;
  b.hp -= damage;
  if (b.hp <= 0) removeBarrier(w, b.id, true);
}

// ---- 長距離移動レール ----

/** a から aim の向きへ、建物に当たる手前までレールを敷く */
function layRail(w: World, a: Actor, aim: Vec): Rail | null {
  const ang = Math.atan2(aim.y - a.pos.y, aim.x - a.pos.x);
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const far = { x: a.pos.x + dx * RAIL.length, y: a.pos.y + dy * RAIL.length };
  // 体の幅の分も通れるように、中心と左右の線で一番手前に当たる所を取る
  const nx = -dy * a.radius, ny = dx * a.radius;
  let t = 1;
  for (const s of [0, 1, -1]) {
    t = Math.min(t, w.map.raycast(a.pos.x + nx * s, a.pos.y + ny * s, far.x + nx * s, far.y + ny * s));
  }
  const len = Math.max(0, t * RAIL.length - 0.6);
  if (len < 2) return null;
  const rail: Rail = {
    id: w.nextId++, owner: a.id, chunk: null,
    a: { ...a.pos }, b: { x: a.pos.x + dx * len, y: a.pos.y + dy * len },
    until: w.time + RAIL.duration,
  };
  w.rails.push(rail);
  return rail;
}

export type Boarding = { rail: Rail; dir: 1 | -1 };

/**
 * 乗れるレールと進む向き。自分で敷いたレールはどこからでも遠いほうの端へ、固定レールは端からだけ反対の端へ乗る。
 * 交差点のように固定レールの端がいくつも集まっていたら、aim の向きに一番近いものを選ぶ
 */
export function nearRail(w: World, a: Actor, aim?: Vec): Boarding | null {
  let best: Boarding | null = null;
  let bestScore = Infinity;
  const aimAng = aim ? Math.atan2(aim.y - a.pos.y, aim.x - a.pos.x) : 0;
  const consider = (r: Rail, dir: 1 | -1, d: number) => {
    const from = dir === 1 ? r.a : r.b, to = dir === 1 ? r.b : r.a;
    const diff = Math.atan2(to.y - from.y, to.x - from.x) - aimAng;
    const score = aim ? Math.abs(Math.atan2(Math.sin(diff), Math.cos(diff))) : d;
    if (score < bestScore) {
      bestScore = score;
      best = { rail: r, dir };
    }
  };
  for (const r of w.rails) {
    if (r.owner === null) {
      const da = dist(a.pos, r.a), db = dist(a.pos, r.b);
      if (da <= FIXED_RAIL.board) consider(r, 1, da);
      if (db <= FIXED_RAIL.board) consider(r, -1, db);
    } else if (r.owner === a.id) {
      const d = dist(a.pos, closestOnSeg(a.pos, r.a, r.b));
      if (d <= RAIL.board) consider(r, dist(a.pos, r.b) >= dist(a.pos, r.a) ? 1 : -1, d);
    }
  }
  // consider の中で書き換えるので、ここで型を戻す
  return best as Boarding | null;
}

export function boardRail(a: Actor, b: Boarding) {
  a.ride = { rail: b.rail.id, dir: b.dir };
  a.dashT = 0;
  if (a.bike) a.bike.state = "off";
}

/** レールに乗っている間の速度。降りたら false */
export function rideStep(w: World, a: Actor): boolean {
  const ride = a.ride;
  if (!ride) return false;
  const r = w.rails.find((x) => x.id === ride.rail);
  if (!r) {
    a.ride = null;
    return false;
  }
  const end = ride.dir === 1 ? r.b : r.a;
  const speed = r.owner === null ? FIXED_RAIL.speed : RAIL.speed;
  const off = dist(a.pos, closestOnSeg(a.pos, r.a, r.b));
  const left = dist(a.pos, end);
  // 固定レールは端から乗るので、乗った直後は線から少し離れている
  const offMax = r.owner === null ? FIXED_RAIL.board + 0.5 : 1.2;
  // 人に押されてレールから外れたら降りる
  if (off > offMax || left < speed * DT) {
    const d = { x: (end.x - a.pos.x) / (left || 1), y: (end.y - a.pos.y) / (left || 1) };
    a.ride = null;
    a.vel = { x: d.x * Math.min(left / DT, speed * 0.3), y: d.y * Math.min(left / DT, speed * 0.3) };
    return false;
  }
  // レールの線へ寄せながら進む
  const to = closestOnSeg({ x: a.pos.x + (end.x - a.pos.x) * Math.min(1, (speed * DT) / left), y: a.pos.y + (end.y - a.pos.y) * Math.min(1, (speed * DT) / left) }, r.a, r.b);
  a.vel = { x: (to.x - a.pos.x) / DT, y: (to.y - a.pos.y) / DT };
  return true;
}
