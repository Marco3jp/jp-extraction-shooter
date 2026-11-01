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

export type BikeId = "none" | "city" | "road";

/**
 * 自転車。靴とは別の枠で持ち込む。C で乗り降りする。乗るのに mount 秒かかり、その間は止まる。
 * 乗っている間は撃てず、回復・ダッシュ・投げ物・スキルも使えない。撃とうとするか撃たれると降りる。名前と数値は仮
 */
export const BIKES: Record<BikeId, { name: string; speed: number; mount: number }> = {
  none: { name: "自転車なし", speed: 0, mount: 0 },
  city: { name: "ママチャリ", speed: 12, mount: 0.6 },
  road: { name: "ロードバイク", speed: 13.5, mount: 0.4 },
};
/** 乗っている間の速さの追いつき方（1/秒）。小さいほど、走り出しと曲がるのが遅い */
export const BIKE_ACCEL = 2.5;
/** 降りるのにかかる時間。降りきるまで撃てない */
export const BIKE_DISMOUNT = 0.3;
