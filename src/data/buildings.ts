import type { ItemId } from "./items";

/** 建物の種類。tools/buildings.py が付ける名前と揃える */
export type BuildingType =
  | "house" | "apartment" | "mansion"
  | "convenience" | "supermarket" | "restaurant" | "shop" | "mall"
  | "office" | "hotel" | "station" | "hospital" | "school" | "civic"
  | "temple" | "shrine" | "industrial" | "farm" | "parking";

/** 箱の中身が寄る用途 */
export type BuildingUse = "home" | "food" | "store" | "office" | "medical" | "public" | "shrine" | "industry";

export const BUILDING_USE: Record<BuildingType, BuildingUse> = {
  house: "home", apartment: "home", mansion: "home",
  convenience: "food", supermarket: "food", restaurant: "food",
  shop: "store", mall: "store",
  office: "office", hotel: "office",
  station: "public", school: "public", civic: "public", parking: "public",
  hospital: "medical",
  temple: "shrine", shrine: "shrine",
  industrial: "industry", farm: "industry",
};

/** 建物に接した箱で、出やすさ（LOOT_TABLE の weight）に掛ける倍率。書いていないものは1倍。数値は仮 */
export const LOOT_TILT: Record<BuildingUse, Partial<Record<ItemId, number>>> = {
  home: { money: 2, medSmall: 1.8 },
  food: { cell: 2, medSmall: 2 },
  store: { circuit: 2.2, money: 1.6 },
  office: { circuit: 2, precision: 2.5 },
  medical: { medSmall: 2.5, medLarge: 3.5 },
  public: { rifle: 1.8, smg: 1.8, long: 1.8, shell: 1.8, light: 1.8, frag: 2 },
  shrine: { money: 3 },
  industry: { junk: 2.5, precision: 2, thermite: 2 },
};
