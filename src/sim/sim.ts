import { alert, hostile, updateEnemy } from "./ai";
import { applyBuff, canGiveBuff, GIVE_RANGE, hasBuff } from "./buffs";
import { updatePartner } from "./partner";
import {
  applyDamage, burnMul, cancelHeal, pullTrigger, releaseTrigger, startHeal, startReload, swapTo, tickFireCd, tickTimers,
} from "./combat";
import {
  BEACON_RADIUS, DASH, DT, EXTRACT_CALL_HEAR, EXTRACT_CALL_TIME, EXTRACT_RADIUS, EXTRACT_TIME, HEAL_MOVE_SPEED, HEAR_RANGE, ITEMS, LOOT_PANEL_RANGE, MOVE_SPEED,
  PARTNER_REVIVE, PICKUP_RANGE, RELOAD_MOVE_SPEED, SCAN, SIGHT_RANGE, SLIDE, SPRINT_SPEED, SPRINT_TO_FIRE,
  type BuffId, type HealKind, type ItemId, type ThrowableId,
} from "./data";
import { boardRail, hitBarrier, nearRail, rideStep, tickSkillObjects, tickSkills, useSkill, useUlt } from "./skills";
import { bagAdd, sortBag } from "./inventory";
import { throwGrenade, updateThrowables } from "./throwables";
import type { Vec } from "./map";
import type { Actor, Extract, Loot, World } from "./world";

export type Command =
  | { type: "open"; loot: number }
  | { type: "take"; loot: number; index: number }
  | { type: "takeAll"; loot: number }
  | { type: "drop"; slot: number }
  /** 予備の強化パーツをパートナーに渡す */
  | { type: "giveBuff"; buff: BuffId; partner: number };

export type Input = {
  move: Vec;
  aim: Vec;
  fire: boolean;
  sprint: boolean;
  reload: boolean;
  swap: number | null;
  heal: HealKind | null;
  cancel: boolean;
  /** 一番近い落ちている物を拾う／箱を開ける */
  interact: boolean;
  /** E を押し続けているか（倒れたパートナーを起こす） */
  interactHeld: boolean;
  dash: boolean;
  throw: ThrowableId | null;
  /** スキル（Q）とアルティメット（F） */
  skill: boolean;
  ult: boolean;
  commands: Command[];
};

export const emptyInput = (): Input => ({
  move: { x: 0, y: 0 }, aim: { x: 0, y: 0 },
  fire: false, sprint: false, reload: false, swap: null, heal: null, cancel: false, interact: false, interactHeld: false,
  dash: false, throw: null, skill: false, ult: false,
  commands: [],
});

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

export function nearestLoot(w: World, range = PICKUP_RANGE, containersOnly = false): Loot | null {
  let best: Loot | null = null;
  let bd = range;
  for (const l of w.loot) {
    if (l.items.length === 0) continue;
    if (containersOnly && l.kind === "ground") continue;
    const d = dist(l.pos, w.player.pos);
    if (d <= bd) {
      bd = d;
      best = l;
    }
  }
  return best;
}

/** プレイヤーが中にいる脱出地点 */
export function extractAt(w: World, pos: Vec): Extract | null {
  return w.extracts.find((e) => dist(e.pos, pos) <= EXTRACT_RADIUS) ?? null;
}

/** 迎えを呼ぶ。呼んだ音で、近くの敵が呼んだ人を狙って寄ってくる */
function callExtract(w: World, e: Extract, caller: Actor) {
  e.readyAt = w.time + EXTRACT_CALL_TIME;
  w.events.push({ type: "extractCall", pos: { ...e.pos } });
  w.events.push({ type: "notice", text: `脱出の迎えを呼んだ。${EXTRACT_CALL_TIME}秒で来る` });
  for (const o of w.actors) {
    if (!o.ai || !o.alive || !hostile(o, caller)) continue;
    if (dist(o.pos, e.pos) < EXTRACT_CALL_HEAR) alert(w, o, caller.pos, caller, false);
  }
}

/** 起こせる距離にいる、倒れたパートナーのうち一番近いもの */
export function downedPartnerNear(w: World): Actor | null {
  let best: Actor | null = null;
  let bd = PARTNER_REVIVE.range;
  for (const a of w.actors) {
    if (a.team !== "partner" || a.alive) continue;
    const d = dist(a.pos, w.player.pos);
    if (d <= bd) {
      bd = d;
      best = a;
    }
  }
  return best;
}

function revivePartner(w: World, a: Actor) {
  a.alive = true;
  a.health = PARTNER_REVIVE.health;
  a.shield = 0;
  a.vel = { x: 0, y: 0 };
  a.partner!.reviveT = 0;
  const ai = a.ai!;
  ai.state = "follow";
  ai.path = [];
  ai.pathTarget = null;
  ai.target = null;
  w.events.push({ type: "revive", actor: a.id, pos: { ...a.pos } });
  w.events.push({ type: "notice", text: `パートナー${a.partner!.index + 1}が立ち上がった` });
}

/** 強化パーツはカバンに入れず、拾った時点で効かせる。もう効いていれば、パートナーに渡せるときだけ予備として持つ */
function takeBuff(w: World, s: { item: ItemId; count: number }, got: Map<ItemId, number>) {
  const id = s.item as BuffId;
  if (hasBuff(w.player, id)) {
    if (!w.actors.some((a) => canGiveBuff(a, id))) {
      w.events.push({ type: "notice", text: `${ITEMS[id].name}はもう効いている` });
      return;
    }
    w.spareBuffs.push(id);
  } else {
    applyBuff(w.player, id);
  }
  got.set(id, (got.get(id) ?? 0) + 1);
  s.count = 0;
}

/** 山を1つカバンへ移す。全部入ったら true */
function takeStack(w: World, l: Loot, index: number, got: Map<ItemId, number>): boolean {
  const s = l.items[index];
  if (!s) return true;
  if (ITEMS[s.item].category === "buff") {
    takeBuff(w, s, got);
    return true;
  }
  const added = bagAdd(w.bag, s.item, s.count);
  if (added > 0) got.set(s.item, (got.get(s.item) ?? 0) + added);
  s.count -= added;
  return s.count <= 0;
}

function finishTake(w: World, l: Loot, got: Map<ItemId, number>, full: boolean) {
  l.items = l.items.filter((s) => s.count > 0);
  if (l.kind === "ground" && l.items.length === 0) w.loot = w.loot.filter((x) => x !== l);
  if (got.size) w.events.push({ type: "pickup", text: [...got].map(([k, n]) => `${ITEMS[k].name} +${n}`).join("　") });
  if (full) w.events.push({ type: "notice", text: "カバンがいっぱい" });
  w.lootVersion++;
  w.events.push({ type: "lootChanged" });
}

function runCommand(w: World, c: Command) {
  const p = w.player;
  if (c.type === "drop") {
    const s = w.bag.slots[c.slot];
    if (!s) return;
    w.bag.slots[c.slot] = null;
    sortBag(w.bag);
    const ang = w.rng.range(0, Math.PI * 2);
    const pos = { x: p.pos.x + Math.cos(ang) * 0.7, y: p.pos.y + Math.sin(ang) * 0.7 };
    if (w.map.blockedAt(pos.x, pos.y)) {
      pos.x = p.pos.x;
      pos.y = p.pos.y;
    }
    w.loot.push({ id: w.nextId++, pos, kind: "ground", items: [s], opened: true, angle: ang });
    w.lootVersion++;
    w.events.push({ type: "lootChanged" });
    return;
  }
  if (c.type === "giveBuff") {
    const to = w.actors.find((a) => a.id === c.partner);
    const i = w.spareBuffs.indexOf(c.buff);
    if (!to || i < 0 || dist(to.pos, p.pos) > GIVE_RANGE || !canGiveBuff(to, c.buff)) return;
    w.spareBuffs.splice(i, 1);
    applyBuff(to, c.buff);
    w.events.push({ type: "notice", text: `パートナー${to.partner!.index + 1}に${ITEMS[c.buff].name}を渡した` });
    return;
  }
  const l = w.loot.find((x) => x.id === c.loot);
  if (!l || dist(l.pos, p.pos) > LOOT_PANEL_RANGE) return;
  if (c.type === "open") {
    if (l.kind === "ground") return;
    l.opened = true;
    w.lootVersion++;
    w.events.push({ type: "lootChanged" });
    w.events.push({ type: "lootOpened", loot: l.id });
    return;
  }
  const got = new Map<ItemId, number>();
  let full = false;
  if (c.type === "take") {
    full = !takeStack(w, l, c.index, got);
  } else {
    for (let i = 0; i < l.items.length; i++) if (!takeStack(w, l, i, got)) full = true;
  }
  finishTake(w, l, got, full);
}

function updatePlayer(w: World, input: Input) {
  const p = w.player;
  if (!p.alive) return;

  for (const c of input.commands) runCommand(w, c);

  if (input.swap !== null) swapTo(w, p, input.swap);
  if (input.cancel && p.heal) cancelHeal(w, p);
  if (input.heal) startHeal(w, p, input.heal);
  if (input.reload) startReload(w, p);

  if (input.interact) {
    const l = nearestLoot(w);
    if (l && l.kind === "ground") {
      runCommand(w, { type: "takeAll", loot: l.id });
    } else if (l) {
      l.opened = true;
      w.lootVersion++;
      w.events.push({ type: "lootChanged" });
      w.events.push({ type: "lootOpened", loot: l.id });
    } else {
      const ex = extractAt(w, p.pos);
      const rail = p.ride ? null : nearRail(w, p);
      if (ex && ex.readyAt === null) callExtract(w, ex, p);
      else if (rail) boardRail(p, rail);
    }
  }

  const down = input.interactHeld ? downedPartnerNear(w) : null;
  for (const a of w.actors) {
    if (a.partner && a !== down) a.partner.reviveT = 0;
  }
  if (down) {
    down.partner!.reviveT += DT;
    if (down.partner!.reviveT >= PARTNER_REVIVE.time) revivePartner(w, down);
  }

  const aimAng = Math.atan2(input.aim.y - p.pos.y, input.aim.x - p.pos.x);
  p.facing = aimAng;
  if (input.throw) throwGrenade(w, p, input.throw, input.aim);

  let mx = input.move.x, my = input.move.y;
  const ml = Math.hypot(mx, my);
  if (ml > 0) {
    mx /= ml;
    my /= ml;
  }

  if (input.skill) useSkill(w, p, input.aim, { x: mx, y: my });
  if (input.ult) useUlt(w, p, input.aim);

  if (input.dash && p.dashCharges > 0 && p.dashT <= 0) {
    p.ride = null;
    // 動いていなければ狙っている向きへ
    p.dashDir = ml > 0 ? { x: mx, y: my } : { x: Math.cos(aimAng), y: Math.sin(aimAng) };
    p.dashT = DASH.time;
    p.dashSpeed = DASH.distance / DASH.time;
    p.dashSteer = false;
    if (p.dashCharges === p.dashMax) p.dashCd = DASH.cooldown * p.dashCdMul;
    p.dashCharges--;
    p.sprinting = false;
    if (p.heal) cancelHeal(w, p);
    w.events.push({ type: "dash", actor: p.id, pos: { ...p.pos }, dir: { ...p.dashDir } });
  }
  if (p.ride && rideStep(w, p)) {
    p.sprinting = false;
    if (input.fire) pullTrigger(w, p, aimAng);
    else releaseTrigger(p);
    return;
  }
  if (p.dashT > 0) {
    p.dashT -= DT;
    if (p.dashSteer && ml > 0) {
      // 移動キーの向きへ、1ティックに曲がれる角度まで曲げる
      const cur = Math.atan2(p.dashDir.y, p.dashDir.x);
      let diff = Math.atan2(my, mx) - cur;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const maxTurn = (SLIDE.turnRate * Math.PI / 180) * DT;
      const next = cur + Math.max(-maxTurn, Math.min(maxTurn, diff));
      p.dashDir = { x: Math.cos(next), y: Math.sin(next) };
    }
    const v = p.dashSpeed;
    p.vel.x = p.dashDir.x * v;
    p.vel.y = p.dashDir.y * v;
    if (p.dashT <= 0) {
      p.vel.x = p.dashDir.x * MOVE_SPEED;
      p.vel.y = p.dashDir.y * MOVE_SPEED;
    }
    if (input.fire) pullTrigger(w, p, aimAng);
    else releaseTrigger(p);
    return;
  }
  const wantSprint = input.sprint && ml > 0 && !p.heal && !input.fire;
  if (p.sprinting && !wantSprint) p.readyT = Math.max(p.readyT, SPRINT_TO_FIRE);
  p.sprinting = wantSprint;
  const speed = (p.heal ? HEAL_MOVE_SPEED : p.sprinting ? SPRINT_SPEED : p.reloadT > 0 ? RELOAD_MOVE_SPEED : MOVE_SPEED) * p.moveMul * burnMul(p);
  const k = 1 - Math.exp(-DT * 16);
  p.vel.x += (mx * speed - p.vel.x) * k;
  p.vel.y += (my * speed - p.vel.y) * k;

  if (input.fire) {
    if (p.heal) {
      cancelHeal(w, p);
      releaseTrigger(p);
    } else {
      pullTrigger(w, p, aimAng);
    }
  } else {
    releaseTrigger(p);
  }
}

function separate(w: World) {
  const as = w.actors;
  for (let i = 0; i < as.length; i++) {
    const a = as[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < as.length; j++) {
      const b = as[j];
      if (!b.alive) continue;
      const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
      const r = a.radius + b.radius;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = (r - d) / 2;
      a.pos.x -= (dx / d) * push;
      a.pos.y -= (dy / d) * push;
      b.pos.x += (dx / d) * push;
      b.pos.y += (dy / d) * push;
    }
  }
}

function segCircle(a: Vec, b: Vec, c: Vec, r: number): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const fx = a.x - c.x, fy = a.y - c.y;
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  if (C <= 0) return 0;
  const disc = B * B - 4 * A * C;
  if (disc < 0 || A === 0) return Infinity;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  return t >= 0 && t <= 1 ? t : Infinity;
}

function updateBullets(w: World, byId: Map<number, Actor>) {
  for (const b of w.bullets) {
    if (!b.alive) continue;
    b.prev = { ...b.pos };
    const to = { x: b.pos.x + b.vel.x * DT, y: b.pos.y + b.vel.y * DT };
    const tw = w.map.raycast(b.pos.x, b.pos.y, to.x, to.y);
    let hitT = tw <= 1 ? tw : Infinity;
    let hitActor: Actor | null = null;
    for (const a of w.actors) {
      if (!a.alive || a.faction === b.faction) continue;
      const t = segCircle(b.pos, to, a.pos, a.radius + 0.05);
      if (t < hitT) {
        hitT = t;
        hitActor = a;
      }
    }
    if (hitT <= 1) {
      const at = { x: b.pos.x + (to.x - b.pos.x) * hitT, y: b.pos.y + (to.y - b.pos.y) * hitT };
      b.pos = at;
      b.alive = false;
      if (hitActor) {
        const shooter = byId.get(b.owner);
        applyDamage(w, hitActor, b.damage, shooter, at);
        if (shooter === w.player) w.focus = { actor: hitActor.id, t: w.time };
        if (hitActor.ai && shooter) alert(w, hitActor, shooter.pos, shooter);
      } else {
        w.events.push({ type: "wallHit", pos: at });
        // 当たった位置から少し進めた所が、塞がっているマス
        const sp = Math.hypot(b.vel.x, b.vel.y) || 1;
        const cx = Math.floor(at.x + (b.vel.x / sp) * 0.01), cy = Math.floor(at.y + (b.vel.y / sp) * 0.01);
        if (w.barriers.length) hitBarrier(w, cx + cy * w.map.w, b.damage);
      }
      continue;
    }
    b.pos = to;
    b.life -= DT;
    if (b.life <= 0) b.alive = false;
  }
  w.bullets = w.bullets.filter((b) => b.alive);
}

function hearShots(w: World, byId: Map<number, Actor>) {
  const heard = new Set<number>();
  for (const ev of w.events) {
    if (ev.type !== "shot" || heard.has(ev.actor)) continue;
    heard.add(ev.actor);
    const shooter = byId.get(ev.actor);
    if (!shooter) continue;
    for (const e of w.actors) {
      if (!e.ai || !e.alive || e.ai.canSee || !hostile(e, shooter)) continue;
      if (dist(e.pos, ev.pos) < HEAR_RANGE) alert(w, e, ev.pos, shooter, false);
    }
  }
}

/** プレイヤーとパートナーの視線で、敵の見え方の段階を決める。パートナーが見ている敵はプレイヤーが見ているのと同じ段階になる */
function updateInfo(w: World) {
  const p = w.player;
  const partners = w.actors.filter((a) => a.team === "partner" && a.alive);
  for (const e of w.actors) {
    if (e.team !== "enemy") continue;
    if (!e.alive) {
      e.info = 0;
      e.seen = false;
      continue;
    }
    const d = dist(e.pos, p.pos);
    e.seen = d <= SIGHT_RANGE && w.map.los(p.pos, e.pos);
    const partnerSees = !e.seen && partners.some((o) => dist(o.pos, e.pos) <= SIGHT_RANGE && w.map.los(o.pos, e.pos));
    let level = e.seen || partnerSees ? w.debug.sightLevel : 0;
    if (d <= BEACON_RADIUS) level = Math.max(level, w.debug.beaconLevel);
    if (w.time < e.revealUntil) level = Math.max(level, SCAN.level);
    e.info = level;
  }
}

export function step(w: World, input: Input) {
  if (w.outcome !== "playing") return;
  w.events = [];
  w.tick++;
  w.time += DT;
  const byId = new Map(w.actors.map((a) => [a.id, a]));

  for (const a of w.actors) {
    a.prev = { ...a.pos };
    a.prevFacing = a.facing;
    if (!a.alive) continue;
    tickTimers(w, a);
    tickSkills(w, a);
    tickFireCd(a);
  }
  tickSkillObjects(w);

  updatePlayer(w, input);
  for (const a of w.actors) {
    if (!a.alive || !a.ai) continue;
    if (a.team === "partner") updatePartner(w, a, byId);
    else updateEnemy(w, a, byId);
  }

  for (const a of w.actors) {
    if (!a.alive) continue;
    a.pos.x += a.vel.x * DT;
    a.pos.y += a.vel.y * DT;
    w.map.collide(a.pos, a.radius);
  }
  separate(w);
  for (const a of w.actors) if (a.alive) w.map.collide(a.pos, a.radius);

  hearShots(w, byId);
  updateBullets(w, byId);
  updateThrowables(w, byId);
  updateInfo(w);
  // 起こしている途中で撃たれたら押し直し
  if (w.events.some((ev) => ev.type === "hit" && ev.actor === w.player.id)) {
    for (const a of w.actors) if (a.partner) a.partner.reviveT = 0;
  }

  const p = w.player;
  for (const e of w.extracts) {
    if (!e.ready && e.readyAt !== null && w.time >= e.readyAt) {
      e.ready = true;
      w.events.push({ type: "extractReady", pos: { ...e.pos } });
      w.events.push({ type: "notice", text: "脱出の迎えが来た" });
    }
    if (p.alive && e.ready && dist(p.pos, e.pos) <= EXTRACT_RADIUS) {
      e.progress += DT;
      if (e.progress >= EXTRACT_TIME) w.outcome = "extracted";
    } else {
      e.progress = 0;
    }
  }
}
