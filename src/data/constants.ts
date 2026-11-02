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
export const DASH = { distance: 4.5, time: 0.16, cooldown: 5, charges: 1 };
/** ダッシュをやめてから撃てるようになるまで */
export const SPRINT_TO_FIRE = 0.15;

export const SIGHT_RANGE = 38;
export const BEACON_RADIUS = 22;
/** 迎えが来てから、中に何秒いれば脱出できるか */
export const EXTRACT_TIME = 2;
/** 脱出地点で E を押して呼んでから、迎えが来るまで。この間は防衛になる（仮） */
export const EXTRACT_CALL_TIME = 45;
/**
 * 迎えを待つ間の防衛。数値は仮
 * - 脱出地点の円の中にいる間だけ、カバンのお金・素材・蘇生アイテムを secureShare まで少しずつ送る。送った分は死んでも持ち帰れる
 * - 迎えが来るまで callEvery 秒ごとに、呼んだ音を EXTRACT_CALL_HEAR m まで鳴らす。聞いた敵は遠くの銃声を聞いたときと同じく脱出地点へ寄り、見えた相手とはいつもどおり撃ち合う
 * - 呼んだ時から waves 秒後に、wave の距離に敵のグループを1つずつ置く。勢力は交互にして、着いた勢力どうしも撃ち合わせる
 * - 脱出地点の周りに壁を立てる。inner は脱出地点のすぐ周り、outer はその外に散らばる遮蔽
 */
export const EXTRACT_DEFENSE = {
  secureShare: 0.6,
  waves: [0, 8, 16],
  callEvery: 4,
  wave: [70, 100] as [number, number],
  inner: { count: 4, radius: 7, length: 4, hp: 600 },
  outer: { count: 7, radius: [13, 22] as [number, number], length: 3, hp: 400 },
  /** 迎えが来てから壁が消えるまで */
  wallLinger: 30,
};
/** 脱出地点の円の半径。防衛で立てる壁が全部入るように、一番外の壁の端まで取る */
export const EXTRACT_RADIUS = Math.ceil(EXTRACT_DEFENSE.outer.radius[1] + EXTRACT_DEFENSE.outer.length / 2);
/** 呼んだ音が届いて、敵が寄ってくる距離（仮） */
export const EXTRACT_CALL_HEAR = 120;
/** 脱出した地点から、キャンプを置ける距離（仮） */
export const CAMP_RADIUS = 250;
export const PICKUP_RANGE = 2.2;
/** 開いた箱から離れたら閉じる距離 */
export const LOOT_PANEL_RANGE = 3.2;
/** 銃声を聞いた敵が、撃った相手を狙って寄ってくる距離 */
export const HEAR_RANGE = 35;
/** 敵に銃声が届く距離。HEAR_RANGE より遠くで聞いた敵は、撃った相手を決めずに撃ち合っている所へ寄る */
export const SHOT_HEAR_RANGE = 100;
/** プレイヤーに銃声が届く距離。ミニマップの輪・画面の端の波・効果音で知らせ、遠いほど弱くする */
export const SHOT_NOTICE_RANGE = 160;

/**
 * 理論 TTK の下限。これを下回る武器・アタッチメントの組み合わせは、連射速度を下げて揃える。
 * プレイヤーは、理論値で倒すには全弾命中などの条件がそろう必要があるので低めにしている。強すぎたら 1.5・1.25・1.0 と段階的に下げる形にする
 */
export const PLAYER_MIN_TTK = 0.75;
export const ENEMY_MIN_TTK = 1.5;
/** 理論 TTK を測るときの相手の体力（敵のシールド100＋ヘルス100） */
export const TTK_TARGET_HP = 200;

/** 蘇生アイテムで立ち上がったときのヘルスと、ダメージを受けない秒数（仮） */
export const SELF_REVIVE = { health: 50, invulnerable: 2 };

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
