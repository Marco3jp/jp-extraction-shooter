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
};

/**
 * パートナーの回復。アイテムは減らない。
 * 狙う相手を最後に見てから combatHold 秒までは戦闘中。戦闘中は相手から隠れている間に1回だけ巻く。
 * ヘルスは oneHealBelow を切ったらヘルス小を1回、fullHealBelow を切ったら遮蔽へ引いてヘルス大。
 * シールドが割れてもヘルスが breakRetreatBelow 以上なら引かない。
 * 相手の残り体力が finishHp 以下のとき、敵が closeRange 以内にいるとき、撃ち合いに勝っているときは、ヘルス大のほかは巻かない
 */
export const PARTNER_HEAL = { combatHold: 4, oneHealBelow: 50, fullHealBelow: 25, breakRetreatBelow: 60, finishHp: 50, closeRange: 7 };

/**
 * 撃ち合いでの遮蔽の使い方。敵から隠れられて、peekDist だけ出れば撃てる場所を、付く位置から searchRadius 以内・
 * プレイヤーから maxFromPlayer 以内で探す。出てから peekDamage 受けたら隠れ直す。
 * 狙う相手が threatMove 動いたか、refresh 秒たったら探し直す
 */
export const PARTNER_COVER = { searchRadius: 7, maxFromPlayer: 12, peekDist: [1.2, 2.2], peekDamage: 50, threatMove: 5, refresh: 3 };

/**
 * 撃ち合いと回復の作り。cover は遮蔽を使う今の作り。
 * classic は遮蔽を使わずに付く位置で撃ち合い、シールドが割れてヘルスが 60 を切ったときだけ、1ランに classicHeals 回まで引いて巻く前の作り。
 * 遊び比べるために残している。どちらにするか決まったら、使わないほうを消す
 */
export const PARTNER_TACTICS: { mode: "cover" | "classic"; classicHeals: number } = { mode: "cover", classicHeals: 2 };

/** 相手のシールドとヘルスの合計が、自分よりこれだけ少なければ撃ち合いに勝っているとして、隠れずに撃ち続ける */
export const PARTNER_WIN_MARGIN = 30;

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
