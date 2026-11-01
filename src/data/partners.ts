import type { AttachmentId } from "./attachments";
import { ENEMY } from "./enemies";
import type { WeaponType } from "./weapons";

/** 連れていける数 */
export const PARTNER_COUNT = 2;

/** パートナーの型。0 はまだ作っていない。改良型はシールドだけが多い（数値は仮） */
export type PartnerModel = 0 | 1 | 2;
export const PARTNER_MODELS: Record<1 | 2, { name: string; shield: number }> = {
  1: { name: "初期型", shield: 100 },
  2: { name: "改良型", shield: 125 },
};

/**
 * パートナーの戦い方。敵の中距離型より少し弱くする（数値は仮）。
 * damageMul は武器のダメージに掛ける割合で、敵と同じ武器の作り方をしてから掛ける。
 * 敵と同じ数値でも、プレイヤーの近くを離れない分だけ1対1では負け越す（npm run smoke の「パートナー 対 敵の中距離型」）
 */
export const PARTNER = {
  ...ENEMY.mid,
  name: "パートナー",
  weapon: { type: "ar" as WeaponType, attachments: [] as AttachmentId[] },
  reaction: ENEMY.mid.reaction * 1.15,
  damageMul: 0.85,
  /** 自分で持って始める回復の回数（敵と同じ数え方） */
  heals: 2,
};

/** プレイヤーの左後ろ・右後ろに付く位置。プレイヤーの向きから見た角度（度）と距離（m） */
export const PARTNER_SLOTS = [
  { angle: 135, dist: 4 },
  { angle: -135, dist: 4 },
];

/** これ以上プレイヤーから離れたら、撃ち合いをやめて戻る。戻り始めたら returnUntil まで寄る */
export const PARTNER_LEASH = 25;
export const PARTNER_RETURN_UNTIL = 10;
/** プレイヤーが撃った相手を、パートナーが優先して狙い続ける秒数 */
export const PARTNER_FOCUS_TIME = 3;
/** プレイヤーが回復している間、敵の方へこれだけ出て撃ち返す */
export const PARTNER_COVER_DIST = 3;

/** 倒れたパートナーを起こす。近くで E を time 秒押し続けると、ヘルス health で立ち上がる */
export const PARTNER_REVIVE = { range: 2.2, time: 4, health: 50 };
