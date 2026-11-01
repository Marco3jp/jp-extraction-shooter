// ダッシュパッドと自転車
import { BIKE_DISMOUNT, DASH_PAD, DT } from "./data";
import type { Vec } from "./map";
import type { Actor, Pad, World } from "./world";

export function padUnder(w: World, pos: Vec): Pad | null {
  const r2 = DASH_PAD.radius * DASH_PAD.radius;
  for (const p of w.pads) if ((p.pos.x - pos.x) ** 2 + (p.pos.y - pos.y) ** 2 <= r2) return p;
  return null;
}

/** move は歩いている向き（長さ 1）。パッドの軸に沿って歩いていれば、その向きへ飛ばす。飛んだら true */
export function padLaunch(w: World, a: Actor, move: Vec): boolean {
  if (a.dashT > 0 || a.ride || a.heal) return false;
  const pad = padUnder(w, a.pos);
  if (!pad) return false;
  const ux = Math.cos(pad.angle), uy = Math.sin(pad.angle);
  const dot = move.x * ux + move.y * uy;
  if (Math.abs(dot) < DASH_PAD.minDot) return false;
  const s = Math.sign(dot);
  a.dashDir = { x: ux * s, y: uy * s };
  a.dashT = DASH_PAD.time;
  a.dashSpeed = DASH_PAD.distance / DASH_PAD.time;
  a.dashSteer = false;
  a.sprinting = false;
  w.events.push({ type: "dash", actor: a.id, pos: { ...a.pos }, dir: { ...a.dashDir }, pad: true });
  return true;
}

/** 自転車に乗りかけ・乗っている・降りかけのどれか */
export function onBike(a: Actor): boolean {
  return !!a.bike && a.bike.state !== "off";
}

/** C を押したとき。止まって乗り始めるか、降り始める */
export function toggleBike(a: Actor) {
  const b = a.bike;
  if (!b) return;
  if (b.state === "off") {
    if (a.heal || a.ride || a.dashT > 0 || !a.alive) return;
    b.state = "mounting";
    b.t = b.mount;
    a.sprinting = false;
  } else {
    startDismount(a);
  }
}

/** 撃とうとしたとき・撃たれたときも呼ぶ。乗りかけなら、すぐやめる */
export function startDismount(a: Actor) {
  const b = a.bike;
  if (!b) return;
  if (b.state === "mounting") {
    b.state = "off";
  } else if (b.state === "on") {
    b.state = "dismounting";
    b.t = BIKE_DISMOUNT;
  }
}

export function tickBike(a: Actor) {
  const b = a.bike;
  if (!b || (b.state !== "mounting" && b.state !== "dismounting")) return;
  b.t -= DT;
  if (b.t <= 0) {
    b.t = 0;
    b.state = b.state === "mounting" ? "on" : "off";
  }
}
