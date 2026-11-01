import { ATTACHMENTS, type AttachmentId, type Modifier } from "../data/attachments";
import { PLAYER_MIN_TTK, TTK_TARGET_HP } from "../data/constants";
import type { ActorStats } from "../data/skills";
import { WEAPON_BASES, type WeaponDef, type WeaponStats, type WeaponType } from "../data/weapons";

const INTEGER_STATS: string[] = ["mag", "pellets", "dashCharges"];

/** 同じ項目の修正は、加算を全部足してから (1 + 割合の合計) を掛ける。base に無い項目の修正は無視する */
function stack<T extends Record<string, number>>(base: T, mods: readonly Modifier<string>[]): T {
  const add: Record<string, number> = {};
  const mul: Record<string, number> = {};
  for (const m of mods) {
    if (m.add) add[m.stat] = (add[m.stat] ?? 0) + m.add;
    if (m.mul) mul[m.stat] = (mul[m.stat] ?? 0) + m.mul;
  }
  const out: Record<string, number> = { ...base };
  for (const k of Object.keys(out)) {
    let v = (base[k] + (add[k] ?? 0)) * Math.max(0.05, 1 + (mul[k] ?? 0));
    if (INTEGER_STATS.includes(k)) v = Math.max(1, Math.round(v));
    out[k] = v;
  }
  return out as T;
}

export function applyModifiers(base: WeaponStats, mods: readonly Modifier<string>[]): WeaponStats {
  return stack(base, mods);
}

export function applyActorModifiers(base: ActorStats, mods: readonly Modifier<string>[]): ActorStats {
  return stack(base, mods);
}

/** 全弾命中・初弾を 0 秒としたときの、相手を倒すまでの時間 */
export function theoreticalTtk(s: WeaponStats, hp = TTK_TARGET_HP): { shots: number; ttk: number; fitsMag: boolean } {
  const perShot = s.damage * s.pellets;
  const shots = Math.ceil(hp / perShot);
  return { shots, ttk: (shots - 1) / s.rate, fitsMag: shots <= s.mag };
}

/** 性能から付ける傾向の名前（仮の基準） */
function styleOf(type: WeaponType, s: WeaponStats): string | null {
  if (type === "long") {
    if (s.damage >= 65) return "スナイパー寄り";
    if (s.rate >= 2) return "連射寄り";
    return null;
  }
  if (type === "smg" && s.damage >= 13 && s.spreadPerShot >= 1.25) return "高火力・高反動";
  if (type === "shotgun" && s.pelletSpread <= 6) return "集弾寄り";
  return null;
}

/** 理論 TTK の下限はアタッチメントまでの性能にだけ掛ける。extra（スキル・バフ）はその後に掛けるので、効いている間は下限を下回ってよい */
export function computeWeapon(
  type: WeaponType, attachments: AttachmentId[], extra: readonly Modifier<string>[] = [], minTtk = PLAYER_MIN_TTK,
): WeaponDef {
  const base = WEAPON_BASES[type];
  const mods = attachments.flatMap((id) => ATTACHMENTS[id].mods);
  const s = applyModifiers(base.stats, mods);
  const { shots, ttk } = theoreticalTtk(s);
  let rateClamped = false;
  if (shots > 1 && ttk < minTtk) {
    s.rate = (shots - 1) / minTtk;
    rateClamped = true;
  }
  const style = styleOf(type, s);
  const out = extra.length ? applyModifiers(s, extra) : s;
  return { ...out, type, name: base.name, ammo: base.ammo, rateClamped, style };
}
