import { ATTACHMENTS, SLOT_ORDER, type AttachmentId, type SlotId } from "../data/attachments";
import { DEATH_LOSES_RUN_LOOT, START_AMMO_MAGS, START_HEALS } from "../data/constants";
import { ARMORS, BAGS, SHOES, type ArmorId, type BagId, type ShoesId } from "../data/gear";
import { ITEMS, MATERIALS, type ItemId, type MaterialId } from "../data/items";
import { RECIPES, type Recipe } from "../data/recipes";
import { WEAPON_TYPES, type WeaponDef, type WeaponType } from "../data/weapons";
import { computeWeapon } from "../sim/stats";

export const PROFILE_VERSION = 1;

/** ランの外で持ち続けるもの。保存の単位 */
export type Profile = {
  version: number;
  money: number;
  materials: Record<MaterialId, number>;
  /** 持っている武器（種類ごとに1つ） */
  weapons: WeaponType[];
  /** 持っているアタッチメントの数。武器に付けている分も含む */
  attachments: Partial<Record<AttachmentId, number>>;
  /** 武器ごとに、どの箇所に何を付けているか */
  weaponConfig: Record<WeaponType, Partial<Record<SlotId, AttachmentId>>>;
  armors: ArmorId[];
  bags: BagId[];
  shoes: ShoesId[];
  loadout: { weapons: [WeaponType, WeaponType]; armor: ArmorId; bag: BagId; shoes: ShoesId };
  stats: { runs: number; extractions: number; deaths: number; kills: number };
};

export function defaultProfile(): Profile {
  const weaponConfig = {} as Profile["weaponConfig"];
  for (const t of WEAPON_TYPES) weaponConfig[t] = {};
  return {
    version: PROFILE_VERSION,
    money: 500,
    materials: { junk: 0, circuit: 0, precision: 0 },
    weapons: ["ar", "pistol"],
    attachments: {},
    weaponConfig,
    armors: ["standard"],
    bags: ["standard"],
    shoes: ["standard"],
    loadout: { weapons: ["ar", "pistol"], armor: "standard", bag: "standard", shoes: "standard" },
    stats: { runs: 0, extractions: 0, deaths: 0, kills: 0 },
  };
}

/** 読み込んだデータの欠けを埋める */
export function normalizeProfile(p: Partial<Profile>): Profile {
  const d = defaultProfile();
  const out: Profile = {
    ...d,
    ...p,
    materials: { ...d.materials, ...(p.materials ?? {}) },
    weaponConfig: { ...d.weaponConfig, ...(p.weaponConfig ?? {}) },
    loadout: { ...d.loadout, ...(p.loadout ?? {}) },
    stats: { ...d.stats, ...(p.stats ?? {}) },
    version: PROFILE_VERSION,
  };
  return out;
}

// ---- アタッチメントの付け外し ----

/** 付けている数 */
export function attachmentsInUse(p: Profile, id: AttachmentId): number {
  let n = 0;
  for (const t of WEAPON_TYPES) for (const s of SLOT_ORDER) if (p.weaponConfig[t][s] === id) n++;
  return n;
}

/** 付けずに余っている数 */
export function attachmentsFree(p: Profile, id: AttachmentId): number {
  return (p.attachments[id] ?? 0) - attachmentsInUse(p, id);
}

/** 付ける。余りがなければ false。id が null なら外す */
export function setAttachment(p: Profile, weapon: WeaponType, slot: SlotId, id: AttachmentId | null): boolean {
  if (id === null) {
    delete p.weaponConfig[weapon][slot];
    return true;
  }
  if (ATTACHMENTS[id].slot !== slot) return false;
  if (p.weaponConfig[weapon][slot] === id) return true;
  if (attachmentsFree(p, id) <= 0) return false;
  p.weaponConfig[weapon][slot] = id;
  return true;
}

export function weaponAttachments(p: Profile, weapon: WeaponType): AttachmentId[] {
  return SLOT_ORDER.map((s) => p.weaponConfig[weapon][s]).filter((x): x is AttachmentId => !!x);
}

/** 今の付け方での武器の性能 */
export function profileWeapon(p: Profile, weapon: WeaponType): WeaponDef {
  return computeWeapon(weapon, weaponAttachments(p, weapon));
}

// ---- 持ち込む装備 ----

export function setLoadoutWeapon(p: Profile, index: 0 | 1, weapon: WeaponType): boolean {
  if (!p.weapons.includes(weapon)) return false;
  const other = p.loadout.weapons[index === 0 ? 1 : 0];
  if (other === weapon) {
    // 同じ武器を2つは持てないので入れ替える
    p.loadout.weapons = index === 0 ? [weapon, p.loadout.weapons[0]] : [p.loadout.weapons[1], weapon];
  } else {
    p.loadout.weapons[index] = weapon;
  }
  return true;
}

export function setLoadoutArmor(p: Profile, armor: ArmorId): boolean {
  if (!p.armors.includes(armor)) return false;
  p.loadout.armor = armor;
  return true;
}

export function setLoadoutBag(p: Profile, bag: BagId): boolean {
  if (!p.bags.includes(bag)) return false;
  p.loadout.bag = bag;
  return true;
}

export function setLoadoutShoes(p: Profile, shoes: ShoesId): boolean {
  if (!p.shoes.includes(shoes)) return false;
  p.loadout.shoes = shoes;
  return true;
}

// ---- クラフト ----

/** 作れない理由。作れるなら null */
export function craftBlocker(p: Profile, r: Recipe): string | null {
  const o = r.output;
  if (o.kind === "weapon" && p.weapons.includes(o.id)) return "持っている";
  if (o.kind === "armor" && p.armors.includes(o.id)) return "持っている";
  if (o.kind === "bag" && p.bags.includes(o.id)) return "持っている";
  if (o.kind === "shoes" && p.shoes.includes(o.id)) return "持っている";
  if (p.money < r.money) return "お金が足りない";
  for (const m of MATERIALS) if ((p.materials[m] ?? 0) < (r.materials[m] ?? 0)) return `${ITEMS[m].name}が足りない`;
  return null;
}

export function craft(p: Profile, recipeId: string): boolean {
  const r = RECIPES.find((x) => x.id === recipeId);
  if (!r || craftBlocker(p, r)) return false;
  p.money -= r.money;
  for (const m of MATERIALS) p.materials[m] -= r.materials[m] ?? 0;
  const o = r.output;
  switch (o.kind) {
    case "material": p.materials[o.id] += o.count; break;
    case "attachment": p.attachments[o.id] = (p.attachments[o.id] ?? 0) + 1; break;
    case "weapon": p.weapons.push(o.id); break;
    case "armor": p.armors.push(o.id); break;
    case "bag": p.bags.push(o.id); break;
    case "shoes": p.shoes.push(o.id); break;
  }
  return true;
}

// ---- ランとのやりとり ----

/** ランに持ち込むもの。ゲームの計算はこれだけを見る */
export type RunLoadout = {
  weapons: WeaponDef[];
  shieldMax: number;
  moveMul: number;
  bagSlots: number;
  startItems: [ItemId, number][];
};

export function makeRunLoadout(p: Profile): RunLoadout {
  const weapons = p.loadout.weapons.map((t) => profileWeapon(p, t));
  const startItems: [ItemId, number][] = weapons.map((w) => [w.ammo, w.mag * START_AMMO_MAGS]);
  startItems.push(...START_HEALS);
  const armor = ARMORS[p.loadout.armor];
  return {
    weapons,
    shieldMax: armor.shield,
    moveMul: armor.moveMul * SHOES[p.loadout.shoes].moveMul,
    bagSlots: BAGS[p.loadout.bag].slots,
    startItems,
  };
}

export type RunResult = {
  outcome: "extracted" | "dead";
  kills: number;
  money: number;
  materials: Partial<Record<MaterialId, number>>;
};

/** ランの結果を保管庫に反映し、実際に持ち帰った分を返す */
export function applyRunResult(p: Profile, r: RunResult): { money: number; materials: Partial<Record<MaterialId, number>> } {
  p.stats.runs++;
  p.stats.kills += r.kills;
  if (r.outcome === "extracted") p.stats.extractions++;
  else p.stats.deaths++;
  const keep = r.outcome === "extracted" || !DEATH_LOSES_RUN_LOOT;
  if (!keep) return { money: 0, materials: {} };
  p.money += r.money;
  for (const m of MATERIALS) p.materials[m] += r.materials[m] ?? 0;
  return { money: r.money, materials: r.materials };
}
