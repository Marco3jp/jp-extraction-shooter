export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;

export const HEALTH_MAX = 100;
/** シールドセル1個で回復する量 */
export const SHIELD_PER_CELL = 25;

export const MOVE_SPEED = 6;
export const SPRINT_SPEED = 8.5;
export const HEAL_MOVE_SPEED = 2.6;
export const RELOAD_MOVE_SPEED = 5;
export const SWAP_TIME = 0.45;
/** スペースキーの短距離ダッシュ。数値は仮 */
export const DASH = { distance: 4.5, time: 0.16, cooldown: 5 };
/** ダッシュをやめてから撃てるようになるまで */
export const SPRINT_TO_FIRE = 0.15;

export const SIGHT_RANGE = 38;
export const BEACON_RADIUS = 22;
export const EXTRACT_RADIUS = 4;
export const EXTRACT_TIME = 5;
export const PICKUP_RANGE = 2.2;
/** 開いた箱から離れたら閉じる距離 */
export const LOOT_PANEL_RANGE = 3.2;
/** 銃声が聞こえる距離 */
export const HEAR_RANGE = 35;

/** 理論 TTK の下限。どの武器・アタッチメントの組み合わせでも、これを下回るときは連射速度を下げて揃える */
export const MIN_TTK = 1.5;
/** 理論 TTK を測るときの相手の体力（敵のシールド100＋ヘルス100） */
export const TTK_TARGET_HP = 200;

/** 死んだとき、そのランで拾った素材とお金を失うか。持ち込んだ装備は失わない（仮） */
export const DEATH_LOSES_RUN_LOOT = true;

/** ラン開始時に毎回もらう回復アイテム（仮） */
export const START_HEALS: [import("./items").ItemId, number][] = [
  ["cell", 4],
  ["medSmall", 2],
];
/** ラン開始時にもらう弾薬は、持ち込む武器ごとにマガジン何本分か（仮） */
export const START_AMMO_MAGS = 3;
/** 拾える弾薬が、持ち込んだ武器の弾薬に置き換わる確率（仮） */
export const LOOT_AMMO_BIAS = 0.5;
