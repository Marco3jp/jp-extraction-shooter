import { BUFFS, type BuffId } from "./data";
import { refreshStats } from "./skills";
import type { Actor } from "./world";

/** 持ち物の画面でパートナーに渡せる距離 */
export const GIVE_RANGE = 4;

const source = (id: BuffId) => `buff:${id}`;

export function hasBuff(a: Actor, id: BuffId): boolean {
  return a.mods.some((m) => m.source === source(id));
}

export function buffsOf(a: Actor): BuffId[] {
  return a.mods.filter((m) => m.source.startsWith("buff:")).map((m) => m.source.slice(5) as BuffId);
}

/** 同じ種類は1個までしか効かない。効かせたら true */
export function applyBuff(a: Actor, id: BuffId): boolean {
  if (hasBuff(a, id)) return false;
  a.mods.push({ source: source(id), mods: BUFFS[id].mods, until: null });
  refreshStats(a);
  return true;
}

export function canGiveBuff(partner: Actor, id: BuffId): boolean {
  return partner.team === "partner" && BUFFS[id].partner && !hasBuff(partner, id);
}
