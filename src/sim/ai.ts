import { DT, ENEMY, ENEMY_SPEED, HEAL_MOVE_SPEED, ROAM_CHANCE, ROAM_DISTANCE } from "./data";
import { cancelHeal, pullTrigger, releaseTrigger, startHeal, startReload, weapon } from "./combat";
import type { Vec } from "./map";
import type { Actor, World } from "./world";

const SCAN_INTERVAL = 0.2;
/** 見失ってから巡回に戻るまで */
const FORGET_AFTER = 8;

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

export function hostile(a: Actor, b: Actor) {
  return a.faction !== b.faction;
}

function angleDiff(a: number, b: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function turnTo(e: Actor, target: number, rate: number) {
  const d = angleDiff(e.facing, target);
  const step = rate * DT;
  e.facing += Math.abs(d) <= step ? d : Math.sign(d) * step;
}

function spec(e: Actor) {
  return ENEMY[e.kind as keyof typeof ENEMY];
}

/** at に敵がいると知らせる。source が分かっていれば狙う相手にする */
export function alert(w: World, e: Actor, at: Vec, source: Actor | null, spread = true) {
  const ai = e.ai;
  if (!ai || !e.alive) return;
  if (source && !hostile(e, source)) return;
  if (!ai.canSee) {
    ai.lastSeen = { ...at };
    ai.lastSeenT = w.time;
    if (source) ai.target = source.id;
  }
  if (ai.state === "patrol") {
    ai.state = "engage";
    ai.reactT = spec(e).reaction * w.rng.range(1, 2.2) + 0.2;
    ai.path = [];
    ai.pathTarget = null;
  }
  if (!spread) return;
  for (const o of w.actors) {
    if (o === e || !o.ai || !o.alive || o.ai.group !== ai.group) continue;
    if (dist(o.pos, e.pos) < 60) alert(w, o, at, source, false);
  }
}

/** target へ向かう速度ベクトルを返す。経路は必要なときだけ引き直す */
function seek(w: World, e: Actor, target: Vec, speed: number): Vec {
  const ai = e.ai!;
  ai.repathT -= DT;
  const moved = !ai.pathTarget || dist(ai.pathTarget, target) > 2.5;
  if (moved || ai.repathT <= 0) {
    if (w.map.walkLine(e.pos, target, 0.45)) {
      ai.path = [{ ...target }];
    } else {
      ai.path = w.map.findPath(e.pos, target, 12000) ?? [];
    }
    ai.pathTarget = { ...target };
    ai.repathT = ai.state === "patrol" ? 4 : 0.8 + w.rng.next() * 0.4;
  }
  while (ai.path.length && dist(ai.path[0], e.pos) < 0.6) ai.path.shift();
  const next = ai.path[0];
  if (!next) return { x: 0, y: 0 };
  const dx = next.x - e.pos.x, dy = next.y - e.pos.y;
  const l = Math.hypot(dx, dy) || 1;
  return { x: (dx / l) * speed, y: (dy / l) * speed };
}

/** グループの先頭（生きている中で番号が一番小さい者）だけが行き先を決める */
function isLeader(w: World, e: Actor) {
  for (const o of w.actors) {
    if (o.ai && o.alive && o.ai.group === e.ai!.group) return o === e;
  }
  return false;
}

function roamTo(w: World, e: Actor): boolean {
  for (let k = 0; k < 20; k++) {
    const ang = w.rng.range(0, Math.PI * 2);
    const r = w.rng.range(ROAM_DISTANCE[0], ROAM_DISTANCE[1]);
    const q = { x: e.pos.x + Math.cos(ang) * r, y: e.pos.y + Math.sin(ang) * r };
    if (!w.map.walkable(q.x, q.y)) continue;
    for (const o of w.actors) {
      if (!o.ai || !o.alive || o.ai.group !== e.ai!.group || o.ai.state !== "patrol") continue;
      o.ai.home = { ...q };
      o.ai.pathTarget = null;
      o.ai.path = [];
      o.ai.waitT = 0;
    }
    return true;
  }
  return false;
}

function findCover(w: World, e: Actor, threat: Vec): Vec | null {
  let best: Vec | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 28; i++) {
    const ang = (i / 28) * Math.PI * 2 + w.rng.next() * 0.2;
    const r = 4 + (i % 4) * 3;
    const p = { x: e.pos.x + Math.cos(ang) * r, y: e.pos.y + Math.sin(ang) * r };
    if (!w.map.walkable(p.x, p.y)) continue;
    if (w.map.los(p, threat)) continue;
    const score = dist(p, threat) * 0.5 - dist(p, e.pos);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** 見えている敵対相手のうち、一番近いものを探す */
function scan(w: World, e: Actor): Actor | null {
  const ai = e.ai!;
  const sight = spec(e).sight;
  let best: Actor | null = null;
  let bestScore = Infinity;
  for (const o of w.actors) {
    if (!o.alive || !hostile(e, o)) continue;
    const d = dist(e.pos, o.pos);
    if (d > sight) continue;
    if (ai.state === "patrol" && d > 6) {
      const a = Math.atan2(o.pos.y - e.pos.y, o.pos.x - e.pos.x);
      if (Math.abs(angleDiff(e.facing, a)) > 1.2) continue;
    }
    const score = o.team === "player" ? d * 0.9 : d;
    if (score >= bestScore) continue;
    if (!w.map.los(e.pos, o.pos)) continue;
    best = o;
    bestScore = score;
  }
  return best;
}

export function updateEnemy(w: World, e: Actor, byId: Map<number, Actor>) {
  const ai = e.ai!;
  const sp = spec(e);
  ai.stateT -= DT;

  ai.scanT -= DT;
  if (ai.scanT <= 0) {
    ai.scanT = SCAN_INTERVAL;
    const found = scan(w, e);
    if (found && found.id !== ai.target) {
      const cur = ai.target !== null ? byId.get(ai.target) : undefined;
      if (!cur || !cur.alive || !ai.canSee || dist(e.pos, found.pos) < dist(e.pos, cur.pos) - 5) ai.target = found.id;
    }
  }

  let t = ai.target !== null ? byId.get(ai.target) : undefined;
  if (t && !t.alive) {
    ai.target = null;
    t = undefined;
    ai.canSee = false;
  }
  const d = t ? dist(e.pos, t.pos) : Infinity;
  ai.canSee = !!t && d < sp.sight * 1.15 && w.map.los(e.pos, t.pos);
  if (t && ai.canSee) {
    if (ai.state === "patrol") alert(w, e, t.pos, t);
    ai.lastSeen = { ...t.pos };
    ai.lastSeenT = w.time;
    for (const o of w.actors) {
      if (o === e || !o.ai || !o.alive || o.ai.group !== ai.group || o.ai.canSee) continue;
      if (dist(o.pos, e.pos) < 60) alert(w, o, t.pos, t, false);
    }
    ai.reactT -= DT;
  } else if (ai.reactT < sp.reaction * 0.5) {
    ai.reactT = sp.reaction * 0.5;
  }

  let vel: Vec = { x: 0, y: 0 };
  let trigger = false;
  const toT = t ? Math.atan2(t.pos.y - e.pos.y, t.pos.x - e.pos.x) : e.facing;

  if (e.heal) {
    if (t && ai.canSee && d < 7 && e.health > 35) cancelHeal(w, e);
    else if (t && ai.canSee) {
      vel = { x: -Math.cos(toT) * HEAL_MOVE_SPEED, y: -Math.sin(toT) * HEAL_MOVE_SPEED };
    }
  }

  if (!e.heal) {
    switch (ai.state) {
      case "patrol": {
        ai.waitT -= DT;
        if (ai.waitT <= 0 && (!ai.pathTarget || dist(e.pos, ai.pathTarget) < 1)) {
          if (ai.roam && dist(e.pos, ai.home) < 20 && w.rng.chance(ROAM_CHANCE) && isLeader(w, e)) roamTo(w, e);
          for (let k = 0; k < 10; k++) {
            const q = { x: ai.home.x + w.rng.range(-18, 18), y: ai.home.y + w.rng.range(-18, 18) };
            if (w.map.walkable(q.x, q.y)) {
              ai.pathTarget = null;
              ai.path = [];
              vel = seek(w, e, q, ENEMY_SPEED.patrol);
              break;
            }
          }
          ai.waitT = w.rng.range(1.5, 4);
        } else if (ai.pathTarget && dist(e.pos, ai.pathTarget) >= 1) {
          const far = dist(e.pos, ai.home) > 30;
          vel = seek(w, e, ai.pathTarget, far ? ENEMY_SPEED.move * 0.7 : ENEMY_SPEED.patrol);
        }
        if (Math.hypot(vel.x, vel.y) > 0.1) turnTo(e, Math.atan2(vel.y, vel.x), 4);
        break;
      }
      case "engage": {
        if (!ai.canSee && (!ai.lastSeen || w.time - ai.lastSeenT > FORGET_AFTER)) {
          ai.state = "patrol";
          ai.target = null;
          ai.pathTarget = null;
          ai.path = [];
          ai.waitT = 0;
          break;
        }
        if (e.shield <= 0 && e.health < 60 && ai.heals > 0) {
          ai.state = "retreat";
          ai.pathTarget = null;
          ai.stateT = 6;
          break;
        }
        const exposed = !!t && (t.heal !== null || t.reloadT > 0);
        if (t && ai.canSee && exposed && e.shield + e.health >= 120 && d < 30) {
          ai.state = "push";
          ai.stateT = 2.5;
          break;
        }
        if (t && ai.canSee) {
          const keep = sp.keepDistance;
          const speed = ENEMY_SPEED.move;
          if (e.reloadT > 0 && d < keep + 5) {
            vel = { x: -Math.cos(toT) * speed, y: -Math.sin(toT) * speed };
          } else if (d > keep + 4) {
            vel = seek(w, e, t.pos, speed);
          } else if (d < keep - 3) {
            vel = { x: -Math.cos(toT) * speed * 0.8, y: -Math.sin(toT) * speed * 0.8 };
          } else {
            ai.strafeT -= DT;
            if (ai.strafeT <= 0) {
              ai.strafe = w.rng.chance(0.5) ? 1 : -1;
              ai.strafeT = w.rng.range(0.7, 1.8);
            }
            const s = ai.strafe * speed * 0.7;
            vel = { x: -Math.sin(toT) * s, y: Math.cos(toT) * s };
          }
          turnTo(e, toT, 7);
          trigger = ai.reactT <= 0 && d <= weapon(e).def.range && Math.abs(angleDiff(e.facing, toT)) < 0.12;
        } else if (ai.lastSeen) {
          if (dist(e.pos, ai.lastSeen) > 1.5) {
            vel = seek(w, e, ai.lastSeen, ENEMY_SPEED.move);
            if (Math.hypot(vel.x, vel.y) > 0.1) turnTo(e, Math.atan2(vel.y, vel.x), 6);
          } else {
            turnTo(e, e.facing + 1, 2);
          }
        }
        break;
      }
      case "retreat": {
        const threat = t?.pos ?? ai.lastSeen ?? e.pos;
        if (!ai.pathTarget || ai.stateT <= 0) {
          const cover = findCover(w, e, threat);
          ai.stateT = 6;
          if (cover) {
            ai.path = [];
            ai.pathTarget = null;
            vel = seek(w, e, cover, ENEMY_SPEED.move);
          } else {
            if (startHeal(w, e, "cellBatch")) ai.heals--;
            ai.state = "engage";
          }
          break;
        }
        const arrived = dist(e.pos, ai.pathTarget) < 1;
        if (arrived || (!ai.canSee && w.time - ai.lastSeenT > 0.8)) {
          const kind = e.shield >= 50 && e.health < 60 ? "medSmall" : "cellBatch";
          if (startHeal(w, e, kind)) ai.heals--;
          ai.state = "engage";
          ai.pathTarget = null;
        } else {
          vel = seek(w, e, ai.pathTarget, ENEMY_SPEED.move);
          if (Math.hypot(vel.x, vel.y) > 0.1) turnTo(e, Math.atan2(vel.y, vel.x), 6);
        }
        break;
      }
      case "push": {
        const exposed = !!t && (t.heal !== null || t.reloadT > 0);
        if (!t || ai.stateT <= 0 || (!exposed && ai.stateT < 1.5)) {
          ai.state = "engage";
          break;
        }
        vel = d < 4 ? { x: 0, y: 0 } : seek(w, e, t.pos, ENEMY_SPEED.push);
        if (ai.canSee) {
          turnTo(e, toT, 8);
          trigger = ai.reactT <= 0 && d <= weapon(e).def.range && Math.abs(angleDiff(e.facing, toT)) < 0.15;
        }
        break;
      }
    }
  }

  if (e.reloadT > 0 || e.heal) {
    const s = Math.hypot(vel.x, vel.y);
    const max = e.heal ? HEAL_MOVE_SPEED : 4.4;
    if (s > max) {
      vel.x = (vel.x / s) * max;
      vel.y = (vel.y / s) * max;
    }
  }

  const k = 1 - Math.exp(-DT * 12);
  e.vel.x += (vel.x - e.vel.x) * k;
  e.vel.y += (vel.y - e.vel.y) * k;

  if (ai.restT > 0) {
    ai.restT -= DT;
    trigger = false;
  }
  if (trigger) {
    pullTrigger(w, e, e.facing, sp.aimError);
    ai.burstT += DT;
    if (ai.burstT >= ai.burstLen) {
      ai.burstT = 0;
      ai.burstLen = w.rng.range(sp.burst[0], sp.burst[1]);
      ai.restT = w.rng.range(sp.rest[0], sp.rest[1]);
    }
  } else {
    releaseTrigger(e);
    if (weapon(e).mag === 0) startReload(w, e);
  }
}
