import { ATTACHMENTS, SLOT_ORDER, type AttachmentId, type SlotId } from "../data/attachments";
import { DEATH_LOSES_RUN_LOOT, START_AMMO_MAGS, START_HEALS } from "../data/constants";
import { ARMORS, BAGS, BIKES, SECURE_BAGS, SHOES, type ArmorId, type BagId, type BikeId, type SecureBagId, type ShoesId } from "../data/gear";
import { ITEMS, MATERIALS, type ItemId, type MaterialId } from "../data/items";
import { RECIPES, type Recipe } from "../data/recipes";
import { PARTNER_COUNT, type PartnerModel } from "../data/partners";
import { PASSIVES, SKILLS, ULTS, type KitChoice, type PassiveId, type SkillId, type UltId } from "../data/skills";
import { WEAPON_TYPES, type WeaponDef, type WeaponType } from "../data/weapons";
import { computeWeapon } from "../sim/stats";

export const PROFILE_VERSION = 5;

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
  bikes: BikeId[];
  secureBags: SecureBagId[];
  /** 保管庫にある、ラン中に使う物 */
  items: { revive: number };
  /** revive は蘇生アイテムを1個持ち込むか */
  loadout: { weapons: [WeaponType, WeaponType]; armor: ArmorId; bag: BagId; shoes: ShoesId; bike: BikeId; secureBag: SecureBagId; revive: boolean } & KitChoice;
  stats: { runs: number; extractions: number; deaths: number; kills: number };
  /** ランを始める場所。null ならマップの出発地点から */
  camp: Camp | null;
  /** パートナー。並びが番号になる。model が 0 ならまだ作っていない */
  partners: { model: PartnerModel; enabled: boolean }[];
};

/** map はマップの id（public/maps/ の下のディレクトリ名）、x・y はゲームの座標 */
export type Camp = { map: string; x: number; y: number };

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
    bikes: ["none"],
    secureBags: ["none"],
    items: { revive: 0 },
    loadout: {
      weapons: ["ar", "pistol"], armor: "standard", bag: "standard", shoes: "standard", bike: "none", secureBag: "none", revive: false,
      skill: "overshield", passive: "killShield", ult: "barrier",
    },
    stats: { runs: 0, extractions: 0, deaths: 0, kills: 0 },
    camp: null,
    partners: Array.from({ length: PARTNER_COUNT }, () => ({ model: 0 as PartnerModel, enabled: false })),
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
    items: { ...d.items, ...(p.items ?? {}) },
    partners: d.partners.map((x, i) => {
      const y = { ...x, ...(p.partners?.[i] ?? {}) };
      if (![0, 1, 2].includes(y.model)) y.model = 0;
      return y;
    }),
    version: PROFILE_VERSION,
  };
  // スキルの名前を変えたり消したりしたときに、古いセーブが読めなくならないように
  if (!(out.loadout.skill in SKILLS)) out.loadout.skill = d.loadout.skill;
  if (!(out.loadout.passive in PASSIVES)) out.loadout.passive = d.loadout.passive;
  if (!(out.loadout.ult in ULTS)) out.loadout.ult = d.loadout.ult;
  if (!out.bikes.includes(out.loadout.bike)) out.loadout.bike = d.loadout.bike;
  if (!out.secureBags.includes(out.loadout.secureBag)) out.loadout.secureBag = d.loadout.secureBag;
  if (out.items.revive <= 0) out.loadout.revive = false;
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

export function setLoadoutBike(p: Profile, bike: BikeId): boolean {
  if (!p.bikes.includes(bike)) return false;
  p.loadout.bike = bike;
  return true;
}

export function setLoadoutSecureBag(p: Profile, bag: SecureBagId): boolean {
  if (!p.secureBags.includes(bag)) return false;
  p.loadout.secureBag = bag;
  return true;
}

/** 蘇生アイテムを持ち込むか。保管庫に無ければ持ち込めない */
export function setLoadoutRevive(p: Profile, on: boolean): boolean {
  if (on && p.items.revive <= 0) return false;
  p.loadout.revive = on;
  return true;
}

/** スキルは最初から全部選べる */
export function setLoadoutSkill(p: Profile, id: SkillId) {
  p.loadout.skill = id;
}

export function setLoadoutPassive(p: Profile, id: PassiveId) {
  p.loadout.passive = id;
}

export function setLoadoutUlt(p: Profile, id: UltId) {
  p.loadout.ult = id;
}

export function setPartnerEnabled(p: Profile, index: number, enabled: boolean) {
  const x = p.partners[index];
  if (x && x.model > 0) x.enabled = enabled;
}

// ---- クラフト ----

/** 作れない理由。作れるなら null */
export function craftBlocker(p: Profile, r: Recipe): string | null {
  const o = r.output;
  if (o.kind === "weapon" && p.weapons.includes(o.id)) return "持っている";
  if (o.kind === "armor" && p.armors.includes(o.id)) return "持っている";
  if (o.kind === "bag" && p.bags.includes(o.id)) return "持っている";
  if (o.kind === "shoes" && p.shoes.includes(o.id)) return "持っている";
  if (o.kind === "bike" && p.bikes.includes(o.id)) return "持っている";
  if (o.kind === "secureBag" && p.secureBags.includes(o.id)) return "持っている";
  if (o.kind === "partner") {
    const cur = p.partners[o.index]?.model ?? 0;
    const upgrade = o.index === 0 && o.model === 2;
    if (cur >= o.model) return upgrade ? "改良済み" : "持っている";
    if (o.index > 0 && p.partners[o.index - 1].model === 0) return `${o.index}体目を先に作る`;
    if (upgrade && cur === 0) return "1体目を先に作る";
    if (upgrade && p.partners[1].model < 2) return "2体目を先に作る";
  }
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
    case "bike": p.bikes.push(o.id); break;
    case "secureBag": p.secureBags.push(o.id); break;
    case "partner": {
      const x = p.partners[o.index];
      if (x.model === 0) x.enabled = true;
      x.model = o.model;
      break;
    }
  }
  return true;
}

// ---- キャンプ ----

/** そのマップでのキャンプの位置。別のマップのキャンプなら null。
 * マップの名前で保存していた頃のキャンプは、座標の決め方が今と違うので、id と一致せず使われない */
export function campOn(p: Profile, map: string): { x: number; y: number } | null {
  return p.camp && p.camp.map === map ? { x: p.camp.x, y: p.camp.y } : null;
}

// ---- ランとのやりとり ----

/** ランに持ち込むもの。ゲームの計算はこれだけを見る */
export type RunLoadout = {
  weapons: WeaponDef[];
  /** ラン中に修正が変わったときに、武器の性能を計算し直すのに使う */
  builds: { type: WeaponType; attachments: AttachmentId[] }[];
  kit: KitChoice;
  shieldMax: number;
  moveMul: number;
  /** 持ち込む自転車。持ち込まなければ null */
  bike: { speed: number; mount: number } | null;
  bagSlots: number;
  /** 死んでも持ち帰れる枠の数 */
  secureSlots: number;
  /** 持ち込む蘇生アイテムの数（0 か 1） */
  revive: number;
  startItems: [ItemId, number][];
  /** 連れていくパートナーの番号（0 始まり）と型 */
  partners: { index: number; model: 1 | 2 }[];
};

export function makeRunLoadout(p: Profile): RunLoadout {
  const weapons = p.loadout.weapons.map((t) => profileWeapon(p, t));
  const startItems: [ItemId, number][] = weapons.map((w) => [w.ammo, w.mag * START_AMMO_MAGS]);
  startItems.push(...START_HEALS);
  const armor = ARMORS[p.loadout.armor];
  const { skill, passive, ult } = p.loadout;
  return {
    weapons,
    builds: p.loadout.weapons.map((t) => ({ type: t, attachments: weaponAttachments(p, t) })),
    kit: { skill, passive, ult },
    shieldMax: armor.shield,
    moveMul: armor.moveMul * SHOES[p.loadout.shoes].moveMul,
    bike: p.loadout.bike === "none" ? null : { speed: BIKES[p.loadout.bike].speed, mount: BIKES[p.loadout.bike].mount },
    bagSlots: BAGS[p.loadout.bag].slots,
    secureSlots: SECURE_BAGS[p.loadout.secureBag].slots,
    revive: p.loadout.revive && p.items.revive > 0 ? 1 : 0,
    startItems,
    partners: p.partners.flatMap((x, index) => (x.enabled && x.model > 0 ? [{ index, model: x.model as 1 | 2 }] : [])),
  };
}

/** ランで持ち帰る物。お金・素材・蘇生アイテム */
export type Haul = { money: number; materials: Partial<Record<MaterialId, number>>; revive: number };

export function emptyHaul(): Haul {
  return { money: 0, materials: {}, revive: 0 };
}

export type RunResult = {
  outcome: "extracted" | "dead";
  kills: number;
  /** カバンの中身 */
  bag: Haul;
  /** 死んでも持ち帰れる枠の中身 */
  secure: Haul;
  /** 持ち込んだ蘇生アイテムを使ったか */
  usedCarriedRevive: boolean;
};

function addHaul(p: Profile, h: Haul) {
  p.money += h.money;
  for (const m of MATERIALS) p.materials[m] += h.materials[m] ?? 0;
  p.items.revive += h.revive;
}

/** ランの結果を保管庫に反映し、実際に持ち帰った分と失った分を返す */
export function applyRunResult(p: Profile, r: RunResult): { gained: Haul; lost: Haul } {
  p.stats.runs++;
  p.stats.kills += r.kills;
  if (r.outcome === "extracted") p.stats.extractions++;
  else p.stats.deaths++;
  if (r.usedCarriedRevive) {
    p.items.revive = Math.max(0, p.items.revive - 1);
    if (p.items.revive <= 0) p.loadout.revive = false;
  }
  const keepBag = r.outcome === "extracted" || !DEATH_LOSES_RUN_LOOT;
  addHaul(p, r.secure);
  if (keepBag) addHaul(p, r.bag);
  const gained = keepBag ? mergeHaul(r.bag, r.secure) : r.secure;
  return { gained, lost: keepBag ? emptyHaul() : r.bag };
}

export function mergeHaul(a: Haul, b: Haul): Haul {
  const materials: Partial<Record<MaterialId, number>> = {};
  for (const m of MATERIALS) {
    const n = (a.materials[m] ?? 0) + (b.materials[m] ?? 0);
    if (n > 0) materials[m] = n;
  }
  return { money: a.money + b.money, materials, revive: a.revive + b.revive };
}
