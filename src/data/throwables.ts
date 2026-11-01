import type { ThrowableId } from "./items";

/** 名前と数値は仮 */
export const THROWABLES: Record<ThrowableId, {
  name: string;
  /** 投げられる最大距離（m） */
  range: number;
  /** 飛んでいく速さ（m/秒）。着地までの時間はこれで決まる */
  speed: number;
}> = {
  frag: { name: "グレネード", range: 22, speed: 18 },
  thermite: { name: "テルミット", range: 22, speed: 18 },
};

/** 投げてから次の行動（撃つ・もう一度投げる）ができるまで */
export const THROW_TIME = 0.45;

export const FRAG = {
  /** 投げてから爆発するまで */
  fuse: 1.6,
  radius: 5,
  /** 中心でのダメージと、半径の縁でのダメージ */
  damageCenter: 85,
  damageEdge: 25,
};

/** 投げた向きに対して横方向へ燃え広がる */
export const THERMITE = {
  /** 着地点から左右それぞれに伸びる長さ（壁で止まる） */
  halfLength: 6,
  /** 炎の幅（m） */
  width: 2,
  duration: 6,
  /** 1秒あたりのダメージ */
  dps: 32,
  /** 炎に触れている間と、離れてから slowLinger 秒の移動速度の倍率。ダッシュには効かない */
  slowMul: 0.35,
  slowLinger: 0.6,
  /** ダメージを与える間隔（秒） */
  tick: 0.25,
};
