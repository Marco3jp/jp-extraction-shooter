// 設置物（センサー・タレット）のラン中の処理
import { DEVICE_ACTIVE_RANGE, DEVICE_SPACING, DEVICES, DT, PICKUP_RANGE, type DeviceKind } from "./data";
import { angleDiff, hostile, turnTo } from "./ai";
import { pullTrigger, releaseTrigger, startReload, weapon } from "./combat";
import type { Vec } from "./map";
import { addDevice, type Actor, type Device, type World } from "./world";

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

export function deviceActive(w: World, d: Device): boolean {
  return dist(d.pos, w.player.pos) <= DEVICE_ACTIVE_RANGE;
}

/** 置けない理由。置けるなら null */
export function placeBlocker(w: World, kind: DeviceKind): string | null {
  const p = w.player;
  const name = DEVICES[kind].name;
  if (w.carried[kind] <= 0) return `${name}を持っていない`;
  if (w.devices.filter((d) => d.kind === kind).length >= DEVICES[kind].max) return `${name}はマップに${DEVICES[kind].max}個までしか置けない。E で回収してから置く`;
  if (!w.map.walkable(p.pos.x, p.pos.y)) return "ここには置けない";
  if (w.devices.some((d) => dist(d.pos, p.pos) < DEVICE_SPACING)) return "近くに置いた物がある";
  return null;
}

/** 足元に置く */
export function placeDevice(w: World, kind: DeviceKind): boolean {
  const why = placeBlocker(w, kind);
  if (why) {
    w.events.push({ type: "notice", text: why });
    return false;
  }
  w.carried[kind]--;
  const d = addDevice(w, kind, w.player.pos);
  w.events.push({ type: "devicePlaced", kind, pos: { ...d.pos } });
  return true;
}

/** E で回収できる、一番近い設置物 */
export function deviceNear(w: World): Device | null {
  let best: Device | null = null;
  let bd = PICKUP_RANGE;
  for (const d of w.devices) {
    const k = dist(d.pos, w.player.pos);
    if (k <= bd) {
      best = d;
      bd = k;
    }
  }
  return best;
}

export function pickupDevice(w: World, d: Device) {
  removeDevice(w, d);
  w.carried[d.kind]++;
  w.events.push({ type: "notice", text: `${DEVICES[d.kind].name}を回収した` });
}

function removeDevice(w: World, d: Device) {
  w.devices = w.devices.filter((x) => x !== d);
  if (d.actor !== null) w.actors = w.actors.filter((a) => a.id !== d.actor);
}

/** センサーで見える段階。センサーの範囲に入っていなければ 0 */
export function sensorLevel(w: World, e: Actor): number {
  for (const d of w.devices) {
    if (d.kind !== "sensor" || !deviceActive(w, d)) continue;
    if (dist(d.pos, e.pos) <= DEVICES.sensor.radius) return DEVICES.sensor.level;
  }
  return 0;
}

function turretTarget(w: World, t: Actor): Actor | null {
  const range = DEVICES.turret.range;
  let best: Actor | null = null;
  let bd = Infinity;
  for (const o of w.actors) {
    if (o.team !== "enemy" || !o.alive || !hostile(t, o)) continue;
    const d = dist(t.pos, o.pos);
    if (d > range || d >= bd || !w.map.los(t.pos, o.pos)) continue;
    best = o;
    bd = d;
  }
  return best;
}

function updateTurret(w: World, d: Device, t: Actor, byId: Map<number, Actor>) {
  const T = DEVICES.turret;
  t.vel = { x: 0, y: 0 };
  d.scanT -= DT;
  let target = d.target !== null ? byId.get(d.target) : undefined;
  const lost = !target || !target.alive || dist(t.pos, target.pos) > T.range * 1.1 || !w.map.los(t.pos, target.pos);
  if (lost || d.scanT <= 0) {
    d.scanT = T.scanEvery;
    target = turretTarget(w, t) ?? undefined;
    d.target = target?.id ?? null;
  }
  if (!target) {
    releaseTrigger(t);
    if (weapon(t).mag < weapon(t).def.mag) startReload(w, t);
    return;
  }
  const ang = Math.atan2(target.pos.y - t.pos.y, target.pos.x - t.pos.x);
  turnTo(t, ang, T.turnRate);
  if (Math.abs(angleDiff(t.facing, ang)) < 0.08) pullTrigger(w, t, t.facing, T.aimErrorDeg);
  else releaseTrigger(t);
}

export function tickDevices(w: World, byId: Map<number, Actor>) {
  for (const d of [...w.devices]) {
    if (d.actor === null) continue;
    // このティックに置いたタレットは byId に入っていない
    const t = byId.get(d.actor) ?? w.actors.find((a) => a.id === d.actor);
    if (!t || !t.alive) {
      removeDevice(w, d);
      w.events.push({ type: "notice", text: `${DEVICES.turret.name}が壊された` });
      continue;
    }
    if (deviceActive(w, d)) updateTurret(w, d, t, byId);
    else releaseTrigger(t);
  }
}
