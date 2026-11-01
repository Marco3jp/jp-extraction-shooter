import type { AmmoId } from "./items";

export type WeaponType = "ar" | "smg" | "long" | "shotgun" | "pistol";

/** アタッチメントで変わる性能。修正はすべてこの項目に対してかける */
export type WeaponStats = {
  /** 1発（散弾なら1粒）のダメージ */
  damage: number;
  /** 1秒あたりの発射数 */
  rate: number;
  mag: number;
  reload: number;
  /** 1回撃つと出る弾の数（散弾） */
  pellets: number;
  /** 散弾の広がり（度） */
  pelletSpread: number;
  /** 度。撃つたびに spreadPerShot ずつ広がり、spreadRecover 度/秒で戻る */
  spreadBase: number;
  spreadPerShot: number;
  spreadMax: number;
  spreadRecover: number;
  /** 移動中に足す拡散（度） */
  spreadMoving: number;
  bulletSpeed: number;
  range: number;
};

export type WeaponStat = keyof WeaponStats;

export type WeaponBase = {
  type: WeaponType;
  name: string;
  ammo: AmmoId;
  role: string;
  stats: WeaponStats;
};

const S = (s: Partial<WeaponStats> & Pick<WeaponStats, "damage" | "rate" | "mag" | "reload" | "bulletSpeed" | "range">): WeaponStats => ({
  pellets: 1,
  pelletSpread: 0,
  spreadBase: 1,
  spreadPerShot: 0.5,
  spreadMax: 5,
  spreadRecover: 8,
  spreadMoving: 1.5,
  ...s,
});

export const WEAPON_BASES: Record<WeaponType, WeaponBase> = {
  ar: {
    type: "ar", name: "アサルトライフル", ammo: "rifle", role: "安定して使える",
    stats: S({ damage: 15, rate: 7.5, mag: 22, reload: 2.0, spreadBase: 1.0, spreadPerShot: 0.45, spreadMax: 5, spreadRecover: 8, spreadMoving: 1.5, bulletSpeed: 110, range: 45 }),
  },
  smg: {
    type: "smg", name: "サブマシンガン", ammo: "smg", role: "火力が高い。弾薬のスタックが少ない",
    stats: S({ damage: 11, rate: 10.5, mag: 28, reload: 1.7, spreadBase: 2.2, spreadPerShot: 0.5, spreadMax: 7, spreadRecover: 10, spreadMoving: 0.8, bulletSpeed: 90, range: 24 }),
  },
  long: {
    type: "long", name: "遠距離武器", ammo: "long", role: "遠くから戦う。アタッチメントで連射寄りにも単発火力寄りにもなる",
    stats: S({ damage: 45, rate: 1.6, mag: 6, reload: 2.6, spreadBase: 0.4, spreadPerShot: 1.2, spreadMax: 4, spreadRecover: 4, spreadMoving: 3.5, bulletSpeed: 160, range: 70 }),
  },
  shotgun: {
    type: "shotgun", name: "ショットガン", ammo: "shell", role: "突っ込んで戦う",
    stats: S({ damage: 9, pellets: 8, pelletSpread: 9, rate: 1.15, mag: 6, reload: 2.8, spreadBase: 0.5, spreadPerShot: 1, spreadMax: 3, spreadRecover: 6, spreadMoving: 0.5, bulletSpeed: 85, range: 15 }),
  },
  pistol: {
    type: "pistol", name: "ピストル", ammo: "light", role: "弾薬がカバン1枠で足りる。楽なエリアの周回向け",
    stats: S({ damage: 18, rate: 5, mag: 14, reload: 1.4, spreadBase: 0.8, spreadPerShot: 0.6, spreadMax: 4, spreadRecover: 10, spreadMoving: 1.0, bulletSpeed: 95, range: 35 }),
  },
};

export const WEAPON_TYPES = Object.keys(WEAPON_BASES) as WeaponType[];

/** アタッチメントを付けた後の、実際に使う性能 */
export type WeaponDef = WeaponStats & {
  type: WeaponType;
  name: string;
  ammo: AmmoId;
  /** 理論 TTK の下限に合わせて連射速度を下げたか */
  rateClamped: boolean;
  /** 性能から付けた傾向の名前（遠距離武器の「スナイパー寄り」など） */
  style: string | null;
};
