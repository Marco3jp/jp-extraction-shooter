export type ArmorId = "standard" | "reinforced" | "heavy";
export type BagId = "standard" | "medium" | "large";
export type ShoesId = "standard" | "light" | "racing";

/** 名前と数値は仮 */
export const ARMORS: Record<ArmorId, { name: string; shield: number; moveMul: number }> = {
  standard: { name: "標準防具", shield: 100, moveMul: 1 },
  reinforced: { name: "強化防具", shield: 125, moveMul: 0.97 },
  heavy: { name: "重装防具", shield: 150, moveMul: 0.94 },
};

export const BAGS: Record<BagId, { name: string; slots: number }> = {
  standard: { name: "標準カバン", slots: 12 },
  medium: { name: "中型カバン", slots: 16 },
  large: { name: "大型カバン", slots: 20 },
};

/** 移動速度だけが上がり、ほかに下がるものはない。名前と数値は仮 */
export const SHOES: Record<ShoesId, { name: string; moveMul: number }> = {
  standard: { name: "普段の靴", moveMul: 1 },
  light: { name: "軽量シューズ", moveMul: 1.06 },
  racing: { name: "競技用シューズ", moveMul: 1.12 },
};
