import type { AttachmentId } from "./attachments";
import type { ArmorId, BagId, BikeId, ShoesId } from "./gear";
import type { MaterialId } from "./items";
import type { WeaponType } from "./weapons";

export type RecipeOutput =
  | { kind: "material"; id: MaterialId; count: number }
  | { kind: "attachment"; id: AttachmentId }
  | { kind: "weapon"; id: WeaponType }
  | { kind: "armor"; id: ArmorId }
  | { kind: "bag"; id: BagId }
  | { kind: "shoes"; id: ShoesId }
  | { kind: "bike"; id: BikeId }
  /** index 番目のパートナーを model の型にする。作っていなければ作る */
  | { kind: "partner"; index: number; model: 1 | 2 };

export type RecipeCategory = "material" | "attachment" | "weapon" | "gear" | "partner";

export type Recipe = {
  id: string;
  category: RecipeCategory;
  output: RecipeOutput;
  money: number;
  materials: Partial<Record<MaterialId, number>>;
};

const att = (id: AttachmentId, money: number, materials: Recipe["materials"]): Recipe => ({
  id: `att-${id}`, category: "attachment", output: { kind: "attachment", id }, money, materials,
});

/** 必要な素材とお金は仮 */
export const RECIPES: Recipe[] = [
  { id: "mat-circuit", category: "material", output: { kind: "material", id: "circuit", count: 1 }, money: 200, materials: { junk: 5 } },
  { id: "mat-precision", category: "material", output: { kind: "material", id: "precision", count: 1 }, money: 500, materials: { circuit: 4 } },

  att("longBarrel", 300, { junk: 6 }),
  att("shortBarrel", 300, { junk: 6 }),
  att("chokeBarrel", 600, { junk: 6, circuit: 2 }),
  att("rapidReceiver", 700, { junk: 4, circuit: 3 }),
  att("heavyReceiver", 700, { junk: 6, circuit: 3 }),
  att("precisionReceiver", 1500, { circuit: 4, precision: 1 }),
  att("extMag", 300, { junk: 8 }),
  att("quickMag", 300, { junk: 5, circuit: 1 }),
  att("drumMag", 800, { junk: 10, circuit: 2 }),
  att("stableStock", 300, { junk: 7 }),
  att("lightStock", 300, { junk: 5, circuit: 1 }),

  { id: "wpn-smg", category: "weapon", output: { kind: "weapon", id: "smg" }, money: 800, materials: { junk: 10, circuit: 2 } },
  { id: "wpn-shotgun", category: "weapon", output: { kind: "weapon", id: "shotgun" }, money: 1000, materials: { junk: 12, circuit: 2 } },
  { id: "wpn-long", category: "weapon", output: { kind: "weapon", id: "long" }, money: 1500, materials: { junk: 8, circuit: 4, precision: 1 } },

  { id: "arm-reinforced", category: "gear", output: { kind: "armor", id: "reinforced" }, money: 1500, materials: { circuit: 4, precision: 1 } },
  { id: "arm-heavy", category: "gear", output: { kind: "armor", id: "heavy" }, money: 4000, materials: { circuit: 8, precision: 3 } },
  { id: "bag-medium", category: "gear", output: { kind: "bag", id: "medium" }, money: 800, materials: { junk: 15, circuit: 2 } },
  { id: "bag-large", category: "gear", output: { kind: "bag", id: "large" }, money: 2500, materials: { circuit: 6, precision: 2 } },
  { id: "shoes-light", category: "gear", output: { kind: "shoes", id: "light" }, money: 600, materials: { junk: 8, circuit: 1 } },
  { id: "shoes-racing", category: "gear", output: { kind: "shoes", id: "racing" }, money: 2000, materials: { circuit: 4, precision: 1 } },
  { id: "bike-city", category: "gear", output: { kind: "bike", id: "city" }, money: 1000, materials: { junk: 14, circuit: 1 } },
  { id: "bike-road", category: "gear", output: { kind: "bike", id: "road" }, money: 3000, materials: { junk: 10, circuit: 4, precision: 2 } },

  // 2体目は1体目を作ってから、1体目の改良は2体目を作ってから
  { id: "ptn-1", category: "partner", output: { kind: "partner", index: 0, model: 1 }, money: 1200, materials: { junk: 12, circuit: 3 } },
  { id: "ptn-2", category: "partner", output: { kind: "partner", index: 1, model: 2 }, money: 3500, materials: { circuit: 6, precision: 2 } },
  { id: "ptn-1-up", category: "partner", output: { kind: "partner", index: 0, model: 2 }, money: 2000, materials: { circuit: 4, precision: 1 } },
];
