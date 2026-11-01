import { SHIELD_PER_CELL } from "./constants";
import type { ItemId } from "./items";

/** 回復と、同じく時間をかけて使う物（アルティメット加速・長距離移動アイテム） */
export type HealKind = "cell" | "cellBatch" | "medSmall" | "medLarge" | "ultCharge" | "evac";

export type HealDef = {
  name: string;
  item: ItemId;
  time: number;
  shieldPerItem: number;
  health: number;
  /** まとめて使う最大個数 */
  maxItems: number;
  /** アルティメットのクールダウンを縮める秒数 */
  ultCut?: number;
  /** 使い終えたら全体マップで行き先を選び、飛んでいく。アイテムは飛び立つときに減る */
  evac?: boolean;
  /** 使っている間に撃たれると止まる */
  stopOnHit?: boolean;
};

export const HEALS: Record<HealKind, HealDef> = {
  cell: { name: "シールド", item: "cell", time: 2, shieldPerItem: SHIELD_PER_CELL, health: 0, maxItems: 1 },
  cellBatch: { name: "シールドまとめて", item: "cell", time: 5, shieldPerItem: SHIELD_PER_CELL, health: 0, maxItems: 4 },
  medSmall: { name: "ヘルス小", item: "medSmall", time: 3.5, shieldPerItem: 0, health: 40, maxItems: 1 },
  medLarge: { name: "ヘルス大", item: "medLarge", time: 8, shieldPerItem: 0, health: 100, maxItems: 1 },
  ultCharge: { name: "アルティメット加速", item: "ultCharge", time: 2, shieldPerItem: 0, health: 0, maxItems: 1, ultCut: 40 },
  evac: { name: "長距離移動", item: "evac", time: 3, shieldPerItem: 0, health: 0, maxItems: 1, evac: true, stopOnHit: true },
};
