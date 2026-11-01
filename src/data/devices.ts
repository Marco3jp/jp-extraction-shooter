/**
 * 拠点で作って持ち込み、ラン中に置く設置物。置いた物はマップに残り、次のランでも同じ所にある。数値は仮
 * - max はマップに置いておける数
 * - プレイヤーから DEVICE_ACTIVE_RANGE m より遠い物は止まる
 */
export type DeviceKind = "sensor" | "turret";

export const DEVICES = {
  /** radius m 以内の敵を、視線が通らなくても level 段階で見せる */
  sensor: { name: "センサー", max: 4, radius: 30, level: 2 },
  /** range m 以内で視線が通る敵を撃つ。敵からも狙われ、壊れたらなくなる */
  turret: { name: "タレット", max: 2, range: 26, health: 250, turnRate: 5, aimErrorDeg: 3, scanEvery: 0.25 },
} as const;

export const DEVICE_KINDS: DeviceKind[] = ["sensor", "turret"];
export const DEVICE_ACTIVE_RANGE = 200;
/** 置いた物どうしをこれより近くに置かない */
export const DEVICE_SPACING = 1.5;
