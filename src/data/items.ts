import { BUFF_IDS, BUFFS, type BuffId } from "./buffs";

export type AmmoId = "rifle" | "smg" | "long" | "shell" | "light";
export type HealItemId = "cell" | "medSmall" | "medLarge";
export type ThrowableId = "frag" | "thermite";
export type MaterialId = "junk" | "circuit" | "precision";
export type ItemId = AmmoId | HealItemId | ThrowableId | MaterialId | BuffId | "money";
export type Rarity = "common" | "rare" | "epic" | "legendary";
/** buff はカバンに入らず、拾った時点で効く */
export type ItemCategory = "ammo" | "heal" | "throwable" | "material" | "buff" | "money";

export type ItemDef = {
  name: string;
  short: string;
  /** 1枠に入る数。お金は枠を使わない */
  stack: number;
  rarity: Rarity;
  category: ItemCategory;
};

/** 並び順はカバンを整理するときの順番でもある */
export const ITEMS: Record<ItemId, ItemDef> = {
  rifle: { name: "ライフル弾", short: "ライフル", stack: 60, rarity: "common", category: "ammo" },
  smg: { name: "SMG弾", short: "SMG", stack: 40, rarity: "common", category: "ammo" },
  long: { name: "長距離弾", short: "長距離", stack: 20, rarity: "common", category: "ammo" },
  shell: { name: "ショットシェル", short: "シェル", stack: 16, rarity: "common", category: "ammo" },
  light: { name: "ピストル弾", short: "ピストル", stack: 60, rarity: "common", category: "ammo" },
  cell: { name: "シールドセル", short: "セル", stack: 6, rarity: "common", category: "heal" },
  medSmall: { name: "ヘルス小", short: "ヘルス小", stack: 4, rarity: "common", category: "heal" },
  medLarge: { name: "ヘルス大", short: "ヘルス大", stack: 2, rarity: "rare", category: "heal" },
  frag: { name: "グレネード", short: "グレ", stack: 3, rarity: "rare", category: "throwable" },
  thermite: { name: "テルミット", short: "テルミット", stack: 3, rarity: "rare", category: "throwable" },
  junk: { name: "金属くず", short: "金属くず", stack: 10, rarity: "common", category: "material" },
  circuit: { name: "電子部品", short: "電子部品", stack: 6, rarity: "rare", category: "material" },
  precision: { name: "精密部品", short: "精密部品", stack: 3, rarity: "epic", category: "material" },
  ...(Object.fromEntries(
    BUFF_IDS.map((id) => [id, { name: BUFFS[id].name, short: BUFFS[id].name, stack: 1, rarity: BUFFS[id].rarity, category: "buff" }]),
  ) as Record<BuffId, ItemDef>),
  money: { name: "お金", short: "円", stack: 0, rarity: "common", category: "money" },
};

export const ITEM_ORDER = Object.keys(ITEMS) as ItemId[];
export const MATERIALS: MaterialId[] = ["junk", "circuit", "precision"];

export const RARITY_COLORS: Record<Rarity, number> = {
  common: 0xe8e8e8,
  rare: 0x4aa0ff,
  epic: 0xb060ff,
  legendary: 0xffc030,
};

/** 強化パーツ1種類あたりの出やすさ。マップ全体の山はおよそ 900 なので、1種類が1ランに 1 個前後出る（仮） */
export const BUFF_WEIGHT = { rare: 0.14, epic: 0.08 };

/** 拾ったときの1山の数（最小〜最大）と、出やすさ */
export const LOOT_TABLE: { item: ItemId; min: number; max: number; weight: number }[] = [
  { item: "rifle", min: 20, max: 40, weight: 6 },
  { item: "smg", min: 20, max: 30, weight: 6 },
  { item: "long", min: 8, max: 14, weight: 5 },
  { item: "shell", min: 8, max: 12, weight: 5 },
  { item: "light", min: 20, max: 40, weight: 6 },
  { item: "cell", min: 1, max: 3, weight: 16 },
  { item: "medSmall", min: 1, max: 2, weight: 11 },
  { item: "medLarge", min: 1, max: 1, weight: 3 },
  { item: "frag", min: 1, max: 2, weight: 5 },
  { item: "thermite", min: 1, max: 2, weight: 4 },
  { item: "junk", min: 2, max: 5, weight: 14 },
  { item: "circuit", min: 1, max: 2, weight: 6 },
  { item: "precision", min: 1, max: 1, weight: 1.5 },
  { item: "money", min: 100, max: 600, weight: 8 },
  ...BUFF_IDS.map((id) => ({ item: id, min: 1, max: 1, weight: BUFFS[id].rarity === "epic" ? BUFF_WEIGHT.epic : BUFF_WEIGHT.rare })),
];

/** 1つの箱に入っている山の数 */
export const BIN_ITEMS = 4;
/** 歩けるマス1万あたりの、箱がまとまって置かれている場所の数。1か所あたりの箱の数の出やすさ（1〜4個） */
export const BIN_CLUSTERS_PER_10K = 7.1;
export const BIN_CLUSTER_SIZE_WEIGHTS = [30, 30, 25, 15];
/** 歩けるマス1万あたりの、地面にそのまま落ちている山の数 */
export const GROUND_ITEMS_PER_10K = 26;
