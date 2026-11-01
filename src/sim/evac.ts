import { DT, EVAC } from "./data";
import { bagCount, bagRemove } from "./inventory";
import { CHUNK, type Vec } from "./map";
import type { Actor, World } from "./world";

export function flying(a: Actor): boolean {
  return a.evac?.state === "fly";
}

/** 行き先として選べるか。選べなければ理由を返す */
export function evacBlocker(w: World, a: Actor, to: Vec): string | null {
  if (Math.hypot(to.x - a.pos.x, to.y - a.pos.y) > EVAC.range) return `${EVAC.range}m より遠い`;
  if (!w.map.walkable(to.x, to.y)) return "そこには降りられない";
  return null;
}

/** 行き先を決めて飛び立つ。アイテムはここで減らす */
export function launchEvac(w: World, a: Actor, to: Vec): boolean {
  if (a.evac?.state !== "pick") return false;
  const why = evacBlocker(w, a, to);
  if (why || bagCount(w.bag, "evac") <= 0) {
    w.events.push({ type: "notice", text: why ?? "長距離移動アイテムがない" });
    return false;
  }
  bagRemove(w.bag, "evac", 1);
  const d = Math.hypot(to.x - a.pos.x, to.y - a.pos.y);
  a.evac = { state: "fly", from: { ...a.pos }, to: { ...to }, t: 0, total: EVAC.rise * 2 + d / EVAC.speed };
  a.heal = null;
  a.reloadT = 0;
  a.ride = null;
  a.dashT = 0;
  a.sprinting = false;
  w.events.push({ type: "evacLaunch", actor: a.id, pos: { ...a.pos }, to: { ...to } });
  return true;
}

export function cancelEvac(a: Actor) {
  if (a.evac?.state === "pick") a.evac = null;
}

/** 上がる間と降りる間は横に進まず、その間を一定の速さで進む */
function progress(t: number, total: number): number {
  const cruise = total - EVAC.rise * 2;
  if (cruise <= 0) return Math.min(1, t / total);
  return Math.max(0, Math.min(1, (t - EVAC.rise) / cruise));
}

/** 飛んでいる高さ（描画用） */
export function evacHeight(a: Actor): number {
  const e = a.evac;
  if (e?.state !== "fly") return 0;
  const up = Math.min(1, e.t / EVAC.rise);
  const down = Math.min(1, Math.max(0, e.total - e.t) / EVAC.rise);
  const k = Math.min(up, down);
  return EVAC.height * (1 - (1 - k) * (1 - k));
}

/**
 * 1ティック進める。pos は直接書き換え、vel には進んでいる速さを入れる（区画の先読みに使う）。
 * 行き先の区画をまだ読んでいなければ、読み終えるまで行き先の上で待つ
 */
export function evacStep(w: World, a: Actor) {
  const e = a.evac;
  if (e?.state !== "fly") return;
  const before = { ...a.pos };
  e.t = Math.min(e.total, e.t + DT);
  const k = progress(e.t, e.total);
  a.pos.x = e.from.x + (e.to.x - e.from.x) * k;
  a.pos.y = e.from.y + (e.to.y - e.from.y) * k;
  a.vel = { x: (a.pos.x - before.x) / DT, y: (a.pos.y - before.y) / DT };
  if (e.t < e.total || !w.map.hasChunk(Math.floor(e.to.x / CHUNK), Math.floor(e.to.y / CHUNK))) return;
  a.evac = null;
  a.vel = { x: 0, y: 0 };
  w.events.push({ type: "evacLand", actor: a.id, pos: { ...a.pos } });
}
