import { SHIELD_PER_CELL } from "./constants";
import type { ItemId } from "./items";

export type HealKind = "cell" | "cellBatch" | "medSmall" | "medLarge";

export type HealDef = {
  name: string;
  item: ItemId;
  time: number;
  shieldPerItem: number;
  health: number;
  /** まとめて使う最大個数 */
  maxItems: number;
};

export const HEALS: Record<HealKind, HealDef> = {
  cell: { name: "シールド", item: "cell", time: 2, shieldPerItem: SHIELD_PER_CELL, health: 0, maxItems: 1 },
  cellBatch: { name: "シールドまとめて", item: "cell", time: 5, shieldPerItem: SHIELD_PER_CELL, health: 0, maxItems: 4 },
  medSmall: { name: "ヘルス小", item: "medSmall", time: 3.5, shieldPerItem: 0, health: 40, maxItems: 1 },
  medLarge: { name: "ヘルス大", item: "medLarge", time: 8, shieldPerItem: 0, health: 100, maxItems: 1 },
};
