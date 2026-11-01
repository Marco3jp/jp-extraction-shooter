import type { Rarity } from "./items";
import type { WeaponStat } from "./weapons";

export type SlotId = "barrel" | "receiver" | "magazine" | "stock";

export const SLOTS: Record<SlotId, { name: string }> = {
  barrel: { name: "銃身" },
  receiver: { name: "機関部" },
  magazine: { name: "マガジン" },
  stock: { name: "ストック" },
};
export const SLOT_ORDER = Object.keys(SLOTS) as SlotId[];

/** add は足す量、mul は割合（0.3 で +30%）。同じ項目の修正は、加算を全部足してから (1 + 割合の合計) を掛ける */
export type Modifier = { stat: WeaponStat; add?: number; mul?: number };

export type AttachmentId =
  | "longBarrel" | "shortBarrel" | "chokeBarrel"
  | "rapidReceiver" | "heavyReceiver" | "precisionReceiver"
  | "extMag" | "quickMag" | "drumMag"
  | "stableStock" | "lightStock";

export type AttachmentDef = {
  name: string;
  slot: SlotId;
  rarity: Rarity;
  mods: Modifier[];
};

/** 名前と数値は仮。上がる性能と下がる性能を組にしている */
export const ATTACHMENTS: Record<AttachmentId, AttachmentDef> = {
  longBarrel: {
    name: "長銃身", slot: "barrel", rarity: "common",
    mods: [{ stat: "range", mul: 0.3 }, { stat: "bulletSpeed", mul: 0.25 }, { stat: "spreadBase", mul: -0.3 }, { stat: "spreadMoving", mul: 0.3 }],
  },
  shortBarrel: {
    name: "短銃身", slot: "barrel", rarity: "common",
    mods: [{ stat: "spreadMoving", mul: -0.45 }, { stat: "range", mul: -0.25 }, { stat: "spreadBase", mul: 0.2 }],
  },
  chokeBarrel: {
    name: "絞り銃身", slot: "barrel", rarity: "rare",
    mods: [{ stat: "pelletSpread", mul: -0.4 }, { stat: "spreadBase", mul: -0.15 }, { stat: "range", mul: 0.15 }, { stat: "rate", mul: -0.05 }],
  },
  rapidReceiver: {
    name: "高速機関部", slot: "receiver", rarity: "rare",
    mods: [{ stat: "rate", mul: 0.3 }, { stat: "damage", mul: -0.15 }, { stat: "spreadPerShot", mul: 0.25 }],
  },
  heavyReceiver: {
    name: "強装機関部", slot: "receiver", rarity: "rare",
    mods: [{ stat: "damage", mul: 0.25 }, { stat: "spreadPerShot", mul: 0.8 }, { stat: "spreadMax", mul: 0.5 }, { stat: "rate", mul: -0.05 }],
  },
  precisionReceiver: {
    name: "精密機関部", slot: "receiver", rarity: "epic",
    mods: [{ stat: "damage", mul: 0.7 }, { stat: "rate", mul: -0.45 }, { stat: "spreadBase", mul: -0.4 }, { stat: "bulletSpeed", mul: 0.3 }],
  },
  extMag: {
    name: "大容量マガジン", slot: "magazine", rarity: "common",
    mods: [{ stat: "mag", mul: 0.5 }, { stat: "reload", mul: 0.25 }],
  },
  quickMag: {
    name: "クイックマガジン", slot: "magazine", rarity: "common",
    mods: [{ stat: "reload", mul: -0.35 }, { stat: "mag", mul: -0.2 }],
  },
  drumMag: {
    name: "ドラムマガジン", slot: "magazine", rarity: "rare",
    mods: [{ stat: "mag", mul: 1.0 }, { stat: "reload", mul: 0.6 }, { stat: "spreadMoving", mul: 0.2 }],
  },
  stableStock: {
    name: "安定ストック", slot: "stock", rarity: "common",
    mods: [{ stat: "spreadPerShot", mul: -0.35 }, { stat: "spreadRecover", mul: 0.35 }, { stat: "spreadMoving", mul: 0.25 }],
  },
  lightStock: {
    name: "軽量ストック", slot: "stock", rarity: "common",
    mods: [{ stat: "spreadMoving", mul: -0.45 }, { stat: "spreadRecover", mul: -0.2 }],
  },
};

export const ATTACHMENT_IDS = Object.keys(ATTACHMENTS) as AttachmentId[];

/** 性能の項目の表示名 */
export const STAT_LABELS: Record<WeaponStat, string> = {
  damage: "ダメージ",
  rate: "連射速度",
  mag: "マガジン",
  reload: "リロード時間",
  pellets: "散弾の数",
  pelletSpread: "散弾の広がり",
  spreadBase: "拡散",
  spreadPerShot: "反動",
  spreadMax: "最大拡散",
  spreadRecover: "反動の戻り",
  spreadMoving: "移動中の拡散",
  bulletSpeed: "弾速",
  range: "射程",
};

/** 値が小さいほど良い項目 */
export const LOWER_IS_BETTER: WeaponStat[] = ["reload", "pelletSpread", "spreadBase", "spreadPerShot", "spreadMax", "spreadMoving"];
