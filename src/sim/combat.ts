import { DT, HEALS, ITEMS, HEALTH_MAX, SWAP_TIME, THERMITE, type HealKind } from "./data";
import { bagCount, bagRemove } from "./inventory";
import type { Vec } from "./map";
import { bottomlessOn, onKill } from "./skills";
import type { Actor, World } from "./world";

const DEG = Math.PI / 180;

export function weapon(a: Actor) {
  return a.weapons[a.cur];
}

export function reserve(w: World, a: Actor): number {
  if (a.team !== "player") return Infinity;
  return bagCount(w.bag, weapon(a).def.ammo);
}

/** テルミットで遅くなっているときの移動速度の倍率 */
export function burnMul(a: Actor): number {
  return a.burnT > 0 ? THERMITE.slowMul : 1;
}

export function isMoving(a: Actor): boolean {
  return Math.hypot(a.vel.x, a.vel.y) > 0.8;
}

export function startReload(w: World, a: Actor): boolean {
  const ws = weapon(a);
  if (a.reloadT > 0 || a.heal || a.swapT > 0 || bottomlessOn(a)) return false;
  if (ws.mag >= ws.def.mag || reserve(w, a) <= 0) return false;
  a.reloadT = ws.def.reload;
  w.events.push({ type: "reloadStart", actor: a.id, pos: { ...a.pos } });
  return true;
}

export function swapTo(w: World, a: Actor, idx: number) {
  if (idx === a.cur || idx < 0 || idx >= a.weapons.length) return;
  if (a.heal) cancelHeal(w, a);
  a.cur = idx;
  a.reloadT = 0;
  a.swapT = SWAP_TIME;
  a.bloom = 0;
  w.events.push({ type: "swap", actor: a.id, pos: { ...a.pos } });
}

function healItems(w: World, a: Actor, kind: HealKind): number {
  const def = HEALS[kind];
  let needed: number;
  if (def.shieldPerItem > 0) {
    needed = Math.ceil((a.shieldMax - a.shield) / def.shieldPerItem);
  } else {
    needed = a.health < HEALTH_MAX ? 1 : 0;
  }
  let n = Math.min(def.maxItems, needed);
  if (a.team === "player") n = Math.min(n, bagCount(w.bag, def.item));
  return n;
}

export function startHeal(w: World, a: Actor, kind: HealKind): boolean {
  if (a.heal || !a.alive) return false;
  const items = healItems(w, a, kind);
  if (items <= 0) {
    if (a.team === "player") {
      const def = HEALS[kind];
      const have = bagCount(w.bag, def.item);
      w.events.push({ type: "notice", text: have <= 0 ? `${ITEMS[def.item].name}がない` : "回復の必要がない" });
    }
    return false;
  }
  a.reloadT = 0;
  a.sprinting = false;
  const def = HEALS[kind];
  a.heal = { kind, t: def.time, total: def.time, items };
  w.events.push({ type: "healStart", actor: a.id, pos: { ...a.pos }, kind });
  return true;
}

export function cancelHeal(w: World, a: Actor) {
  if (!a.heal) return;
  a.heal = null;
  w.events.push({ type: "healCancel", actor: a.id, pos: { ...a.pos } });
}

/** 各種タイマーを進める。終わったものを反映する */
export function tickTimers(w: World, a: Actor) {
  const ws = weapon(a);
  a.bloom = Math.max(0, a.bloom - ws.def.spreadRecover * DT);
  if (a.swapT > 0) a.swapT = Math.max(0, a.swapT - DT);
  if (a.readyT > 0) a.readyT = Math.max(0, a.readyT - DT);
  if (a.burnT > 0) a.burnT = Math.max(0, a.burnT - DT);
  if (a.reloadT > 0) {
    a.reloadT -= DT;
    if (a.reloadT <= 0) {
      a.reloadT = 0;
      const need = ws.def.mag - ws.mag;
      if (a.team === "player") {
        ws.mag += bagRemove(w.bag, ws.def.ammo, need);
      } else {
        ws.mag += need;
      }
    }
  }
  if (a.heal) {
    a.heal.t -= DT;
    if (a.heal.t <= 0) {
      const def = HEALS[a.heal.kind];
      a.shield = Math.min(a.shieldMax, a.shield + def.shieldPerItem * a.heal.items);
      a.health = Math.min(HEALTH_MAX, a.health + def.health);
      if (a.team === "player") bagRemove(w.bag, def.item, a.heal.items);
      a.heal = null;
      w.events.push({ type: "healDone", actor: a.id, pos: { ...a.pos } });
    }
  }
}

/** 引き金を引いている間、毎ティック呼ぶ。撃てたら true */
export function pullTrigger(w: World, a: Actor, aimAngle: number, extraSpreadDeg = 0): boolean {
  const ws = weapon(a);
  if (a.heal || a.swapT > 0 || a.reloadT > 0 || a.readyT > 0) return false;
  // 弾倉なしの間は、マガジンの代わりにカバンの弾を減らす
  const bottomless = bottomlessOn(a);
  const loaded = () => (bottomless ? reserve(w, a) > 0 : ws.mag > 0);
  if (!loaded()) {
    if (!bottomless) startReload(w, a);
    return false;
  }
  let fired = false;
  while (a.fireCd <= 0 && loaded()) {
    const def = ws.def;
    const cone = (def.spreadBase + a.bloom + (isMoving(a) ? def.spreadMoving : 0) + extraSpreadDeg) * DEG;
    const center = aimAngle + (w.rng.next() + w.rng.next() - 1) * cone * 0.5;
    for (let k = 0; k < def.pellets; k++) {
      // 散弾は扇の中にほぼ均等に並べ、少しだけ揺らす
      const spread = def.pellets > 1 ? ((k / (def.pellets - 1) - 0.5) * def.pelletSpread + (w.rng.next() - 0.5) * def.pelletSpread * 0.3) * DEG : 0;
      const ang = center + spread;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const start = { x: a.pos.x + dx * (a.radius + 0.15), y: a.pos.y + dy * (a.radius + 0.15) };
      w.bullets.push({
        pos: start, prev: { ...start },
        vel: { x: dx * def.bulletSpeed, y: dy * def.bulletSpeed },
        damage: def.damage, faction: a.faction, owner: a.id,
        life: def.range / def.bulletSpeed, alive: true,
      });
    }
    if (bottomless) bagRemove(w.bag, def.ammo, 1);
    else ws.mag--;
    a.bloom = Math.min(def.spreadMax - def.spreadBase, a.bloom + def.spreadPerShot);
    a.fireCd += 1 / def.rate;
    fired = true;
    w.events.push({ type: "shot", actor: a.id, pos: { ...a.pos }, faction: a.faction });
  }
  return fired;
}

export function releaseTrigger(a: Actor) {
  if (a.fireCd < 0) a.fireCd = 0;
}

export function tickFireCd(a: Actor) {
  a.fireCd -= DT;
}

export function applyDamage(w: World, target: Actor, dmg: number, by: Actor | undefined, at: Vec) {
  if (!target.alive) return;
  const over = Math.min(target.overshield, dmg);
  target.overshield -= over;
  dmg -= over;
  const hadShield = target.shield > 0;
  const absorbed = Math.min(target.shield, dmg);
  const amount = over + absorbed + Math.min(target.health, dmg - absorbed);
  target.shield -= absorbed;
  target.health -= dmg - absorbed;
  w.events.push({ type: "hit", actor: target.id, by: by?.id ?? 0, pos: { ...at }, shield: over + absorbed > 0, amount });
  if (hadShield && target.shield <= 0) {
    w.events.push({ type: "shieldBreak", actor: target.id, pos: { ...target.pos } });
  }
  if (target.health <= 0) {
    target.health = 0;
    target.alive = false;
    target.heal = null;
    target.reloadT = 0;
    target.ride = null;
    w.events.push({ type: "death", actor: target.id, by: by?.id ?? 0, pos: { ...target.pos } });
    if (by && by !== target) onKill(w, by);
    if (target.team === "enemy") {
      if (by?.team === "player") w.kills++;
      w.loot.push({
        id: w.nextId++, pos: { ...target.pos }, kind: "deathbox",
        items: target.carry.map((s) => ({ ...s })), opened: false, angle: target.facing,
      });
      w.lootVersion++;
      w.events.push({ type: "lootChanged" });
    } else {
      w.outcome = "dead";
    }
  }
}
