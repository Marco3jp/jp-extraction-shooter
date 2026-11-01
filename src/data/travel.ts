/** 地図に置いた固定レール。端から board m 以内で E を押すと、反対の端へ speed m/s で進む。進む間は撃てる。数値は仮 */
export const FIXED_RAIL = { speed: 20, board: 3.5 };

/**
 * ダッシュパッド。軸に沿って歩いて踏むと、歩いていた向きへ distance m を time 秒で飛ぶ。進む間は撃てる。
 * 歩く向きと軸の向きの cos が minDot より小さければ飛ばない。distance は tools/travel.py の PAD_JUMP と揃える。数値は仮
 */
export const DASH_PAD = { distance: 30, time: 0.9, radius: 1.3, minDot: 0.5 };
