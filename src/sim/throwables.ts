import { alert } from "./ai";
import { applyDamage, cancelHeal } from "./combat";
import { DT, FRAG, THERMITE, THROW_TIME, THROWABLES, type ThrowableId } from "./data";
import { bagCount, bagRemove } from "./inventory";
import type { GameMap, Vec } from "./map";
import type { Actor, Fire, World } from "./world";

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

/** 狙った場所に投げたときの着地点。壁に当たるならその手前に落ちる */
export function throwLanding(map: GameMap, from: Vec, kind: ThrowableId, aim: Vec): { to: Vec; angle: number } {
  const spec = THROWABLES[kind];
  const angle = Math.atan2(aim.y - from.y, aim.x - from.x);
  const d = Math.min(spec.range, dist(from, aim));
  let to = { x: from.x + Math.cos(angle) * d, y: from.y + Math.sin(angle) * d };
  const hit = map.raycast(from.x, from.y, to.x, to.y);
  if (hit <= 1) {
    const k = Math.max(0, hit - 0.6 / Math.max(d, 0.01));
    to = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
  }
  return { to, angle };
}

/** テルミットが燃える線分。投げた向きと直角に、左右それぞれ壁に当たるまで伸ばす */
export function thermiteLine(map: GameMap, at: Vec, angle: number): { a: Vec; b: Vec } {
  const px = -Math.sin(angle), py = Math.cos(angle);
  const end = (sign: number): Vec => {
    const far = { x: at.x + px * sign * THERMITE.halfLength, y: at.y + py * sign * THERMITE.halfLength };
    const t = Math.min(1, map.raycast(at.x, at.y, far.x, far.y));
    const k = t >= 1 ? 1 : Math.max(0, t - 0.3 / THERMITE.halfLength);
    return { x: at.x + (far.x - at.x) * k, y: at.y + (far.y - at.y) * k };
  };
  return { a: end(-1), b: end(1) };
}

export function throwGrenade(w: World, a: Actor, kind: ThrowableId, aim: Vec): boolean {
  if (!a.alive || a.readyT > 0 || a.swapT > 0) return false;
  if (a.team === "player") {
    if (bagCount(w.bag, kind) <= 0) {
      w.events.push({ type: "notice", text: `${THROWABLES[kind].name}がない` });
      return false;
    }
    bagRemove(w.bag, kind, 1);
  }
  const spec = THROWABLES[kind];
  const { to, angle: ang } = throwLanding(w.map, a.pos, kind, aim);
  if (a.heal) cancelHeal(w, a);
  a.reloadT = 0;
  a.sprinting = false;
  a.readyT = THROW_TIME;
  w.grenades.push({
    id: w.nextId++, kind, owner: a.id,
    from: { ...a.pos }, to, t: 0, flight: Math.max(0.3, dist(a.pos, to) / spec.speed), angle: ang,
  });
  w.events.push({ type: "throw", actor: a.id, pos: { ...a.pos }, kind });
  return true;
}

export function grenadePos(g: { from: Vec; to: Vec; t: number; flight: number }): { x: number; y: number; h: number } {
  const s = Math.min(1, g.t / g.flight);
  const peak = Math.min(4, 1 + g.flight * 2.2);
  return {
    x: g.from.x + (g.to.x - g.from.x) * s,
    y: g.from.y + (g.to.y - g.from.y) * s,
    h: 1 + 4 * peak * s * (1 - s) - s * 0.8,
  };
}

function explode(w: World, at: Vec, owner: Actor | undefined) {
  w.events.push({ type: "explosion", pos: { ...at }, radius: FRAG.radius });
  for (const a of w.actors) {
    if (!a.alive) continue;
    const d = dist(a.pos, at);
    if (d > FRAG.radius + a.radius) continue;
    if (!w.map.los(at, a.pos)) continue;
    const k = Math.min(1, d / FRAG.radius);
    applyDamage(w, a, FRAG.damageCenter + (FRAG.damageEdge - FRAG.damageCenter) * k, owner, a.pos);
    if (a.ai && owner) alert(w, a, owner.pos, owner);
  }
}

function ignite(w: World, at: Vec, angle: number, owner: number) {
  const { a, b } = thermiteLine(w.map, at, angle);
  w.fires.push({ id: w.nextId++, owner, a, b, t: THERMITE.duration, tickT: 0 });
  // 炎を避けた経路に引き直させる
  for (const o of w.actors) if (o.ai) o.ai.repathT = 0;
  w.events.push({ type: "fireStart", a, b });
}

function segDist(p: Vec, a: Vec, b: Vec) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const ll = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / ll));
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

function inFire(a: Actor, f: Fire) {
  return segDist(a.pos, f.a, f.b) <= THERMITE.width / 2 + a.radius;
}

export function updateThrowables(w: World, byId: Map<number, Actor>) {
  for (const g of w.grenades) {
    g.t += DT;
    if (g.kind === "frag" && g.t >= FRAG.fuse) {
      explode(w, g.to, byId.get(g.owner));
      g.t = -1;
    } else if (g.kind === "thermite" && g.t >= g.flight) {
      ignite(w, g.to, g.angle, g.owner);
      g.t = -1;
    }
  }
  w.grenades = w.grenades.filter((g) => g.t >= 0);

  for (const f of w.fires) {
    f.t -= DT;
    f.tickT -= DT;
    for (const a of w.actors) {
      if (a.alive && inFire(a, f)) a.burnT = THERMITE.slowLinger;
    }
    if (f.tickT > 0) continue;
    f.tickT = THERMITE.tick;
    const owner = byId.get(f.owner);
    for (const a of w.actors) {
      if (!a.alive) continue;
      if (inFire(a, f)) {
        applyDamage(w, a, THERMITE.dps * THERMITE.tick, owner, a.pos);
        if (a.ai && owner) alert(w, a, owner.pos, owner);
      }
    }
  }
  w.fires = w.fires.filter((f) => f.t > 0);
}
