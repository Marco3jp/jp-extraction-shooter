import type { AttachmentId } from "./attachments";
import type { WeaponType } from "./weapons";

export const ENEMY_SHIELD = 100;

/** 敵の種類。武器はプレイヤーと同じ武器とアタッチメントの仕組みで作る */
export const ENEMY = {
  short: {
    name: "近距離型",
    weapon: { type: "smg" as WeaponType, attachments: [] as AttachmentId[] },
    sight: 30,
    keepDistance: 9,
    aimError: 3.5,
    reaction: 0.45,
    /** 連射の長さと、次の連射までの間（秒） */
    burst: [0.5, 1.0] as [number, number],
    rest: [0.4, 0.9] as [number, number],
  },
  mid: {
    name: "中距離型",
    weapon: { type: "ar" as WeaponType, attachments: [] as AttachmentId[] },
    sight: 35,
    keepDistance: 16,
    aimError: 2.2,
    reaction: 0.55,
    burst: [0.6, 1.2] as [number, number],
    rest: [0.4, 0.9] as [number, number],
  },
  long: {
    name: "遠距離型",
    weapon: { type: "long" as WeaponType, attachments: ["rapidReceiver", "extMag"] as AttachmentId[] },
    sight: 42,
    keepDistance: 26,
    aimError: 1.2,
    reaction: 0.7,
    burst: [0.8, 1.6] as [number, number],
    rest: [0.5, 1.0] as [number, number],
  },
};

export type EnemyKind = keyof typeof ENEMY;

/** 敵の弾はプレイヤーが避けられるように遅くする */
export const ENEMY_BULLET_SPEED_MUL = 0.5;

export const ENEMY_SPEED = { patrol: 2.6, move: 5.2, push: 6.2 };

/** 勢力。名前と構成は仮 */
export type FactionDef = { name: string; color: number };
export const PLAYER_FACTION = 0;
export const SOLO_FACTION_BASE = 100;
export const FACTIONS: Record<number, FactionDef> = {
  0: { name: "自分", color: 0x4fb0ff },
  1: { name: "勢力A", color: 0xe0643c },
  2: { name: "勢力B", color: 0xd8c040 },
};
export const SOLO_FACTION: FactionDef = { name: "単独", color: 0xa8a8b8 };

export function factionDef(f: number): FactionDef {
  return FACTIONS[f] ?? SOLO_FACTION;
}

/** 配置する敵。縄張りはマップごとに決める（マップの JSON の layout.factionAreas） */
export const ENEMY_SPAWNS: { faction: number; groups: EnemyKind[][] }[] = [
  {
    faction: 1,
    groups: [
      ["short", "mid", "long"],
      ["short", "long", "long"],
      ["short", "short", "mid"],
      ["mid", "mid", "long"],
      ["short", "long"],
    ],
  },
  {
    faction: 2,
    groups: [
      ["short", "short", "mid", "long"],
      ["short", "short", "short"],
      ["mid", "long", "long"],
      ["short", "mid", "long"],
      ["long", "long"],
    ],
  },
];
export const SOLO_COUNT = 9;
export const SOLO_KINDS: EnemyKind[] = ["short", "mid", "long"];
/** 巡回先を移しながら漁り歩くグループの割合。単独の敵は全員そうする */
export const ROAMING_GROUP_RATE = 0.5;
/** 巡回先を移すときの、1回あたりの確率と距離（m） */
export const ROAM_CHANCE = 0.35;
export const ROAM_DISTANCE: [number, number] = [60, 140];
