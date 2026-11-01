import type { Rarity } from "./items";
import type { StatMod } from "./skills";

export type BuffId = "shieldCore" | "magKit" | "stabilizer" | "quickLoader" | "lightFrame" | "coolingUnit" | "spareBattery";

export type BuffDef = {
  name: string;
  rarity: Rarity;
  text: string;
  mods: StatMod[];
  /** パートナーに渡しても効くか。スキルを持たないパートナーには、スキルとダッシュの修正は効かない */
  partner: boolean;
};

/** 拾った時点からラン中ずっと効く強化パーツ。負の効き目は付けない。数値は仮 */
export const BUFFS: Record<BuffId, BuffDef> = {
  shieldCore: {
    name: "シールドコア", rarity: "epic", partner: true,
    text: "シールドの上限 +25",
    mods: [{ stat: "shieldMax", add: 25 }],
  },
  magKit: {
    name: "拡張マガジンキット", rarity: "rare", partner: true,
    text: "マガジン量 +15%",
    mods: [{ stat: "mag", mul: 0.15 }],
  },
  stabilizer: {
    name: "スタビライザー", rarity: "rare", partner: true,
    text: "撃ち続けたときのブレ −15%",
    mods: [{ stat: "spreadPerShot", mul: -0.15 }],
  },
  quickLoader: {
    name: "クイックローダー", rarity: "rare", partner: true,
    text: "リロード時間 −15%",
    mods: [{ stat: "reload", mul: -0.15 }],
  },
  lightFrame: {
    name: "軽量フレーム", rarity: "rare", partner: true,
    text: "移動速度 +4%",
    mods: [{ stat: "moveMul", mul: 0.04 }],
  },
  coolingUnit: {
    name: "冷却ユニット", rarity: "epic", partner: false,
    text: "スキルのクールダウン −15%",
    mods: [{ stat: "skillCd", mul: -0.15 }],
  },
  spareBattery: {
    name: "予備バッテリー", rarity: "rare", partner: false,
    text: "ダッシュのクールダウン −20%",
    mods: [{ stat: "dashCd", mul: -0.2 }],
  },
};

export const BUFF_IDS = Object.keys(BUFFS) as BuffId[];
