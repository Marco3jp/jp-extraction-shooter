import { ATTACHMENTS, type AttachmentId, type Modifier } from "../data/attachments";
import { MIN_TTK, TTK_TARGET_HP } from "../data/constants";
import { WEAPON_BASES, type WeaponDef, type WeaponStat, type WeaponStats, type WeaponType } from "../data/weapons";

const INTEGER_STATS: WeaponStat[] = ["mag", "pellets"];

/** 同じ項目の修正は、加算を全部足してから (1 + 割合の合計) を掛ける */
export function applyModifiers(base: WeaponStats, mods: Modifier[]): WeaponStats {
  const add: Partial<Record<WeaponStat, number>> = {};
  const mul: Partial<Record<WeaponStat, number>> = {};
  for (const m of mods) {
    if (m.add) add[m.stat] = (add[m.stat] ?? 0) + m.add;
    if (m.mul) mul[m.stat] = (mul[m.stat] ?? 0) + m.mul;
  }
  const out = { ...base };
  for (const k of Object.keys(out) as WeaponStat[]) {
    let v = (base[k] + (add[k] ?? 0)) * Math.max(0.05, 1 + (mul[k] ?? 0));
    if (INTEGER_STATS.includes(k)) v = Math.max(1, Math.round(v));
    out[k] = v;
  }
  return out;
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
  if (type === "smg" && s.damage >= 13 && s.spreadPerShot >= 0.8) return "高火力・高反動";
  if (type === "shotgun" && s.pelletSpread <= 6) return "集弾寄り";
  return null;
}

export function computeWeapon(type: WeaponType, attachments: AttachmentId[]): WeaponDef {
  const base = WEAPON_BASES[type];
  const mods = attachments.flatMap((id) => ATTACHMENTS[id].mods);
  const s = applyModifiers(base.stats, mods);
  const { shots, ttk } = theoreticalTtk(s);
  let rateClamped = false;
  if (shots > 1 && ttk < MIN_TTK) {
    s.rate = (shots - 1) / MIN_TTK;
    rateClamped = true;
  }
  return { ...s, type, name: base.name, ammo: base.ammo, rateClamped, style: styleOf(type, s) };
}
