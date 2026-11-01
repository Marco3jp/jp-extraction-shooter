import type { Modifier } from "./attachments";
import { DASH } from "./constants";
import type { WeaponStat } from "./weapons";

/** 武器のほかに修正をかけられる項目。skillCd・dashCd はクールダウンに掛ける倍率で、基礎値は 1 */
export type ActorStat = "moveMul" | "shieldMax" | "dashCharges" | "killShield" | "skillCd" | "dashCd";
export type ActorStats = Record<ActorStat, number>;
export type StatMod = Modifier<WeaponStat | ActorStat>;

export type SkillId = "overshield" | "haste" | "slide" | "rapidFire";
export type PassiveId = "killShield" | "doubleDash" | "healSense" | "damageUp";
export type UltId = "barrier" | "scan" | "rail" | "bottomless";

/** 数値はすべて仮 */
export const OVERSHIELD = { amount: 50, duration: 10 };
export const HASTE = { duration: 8, moveMul: 0.3 };
/** turnRate は 1 秒に曲がれる角度（度） */
export const SLIDE = { distance: 18, time: 1.2, turnRate: 150 };
/** killExtend は、効いている間に倒すと伸びる秒数 */
export const RAPID_FIRE = { duration: 8, rate: 0.25, reload: -0.4, killExtend: 3 };
export const KILL_SHIELD = 50;
export const DAMAGE_UP = 0.06;
/** offsetMin〜offsetMax だけ敵の位置から中心をずらす。回復中は遅いので、置き直すまでの 1 秒では円の外へ出ない */
export const HEAL_SENSE = { range: 40, radius: 6, every: 1, offsetMin: 1.5, offsetMax: 3 };
/** range はカーソルの位置へ置ける最大距離 */
export const BARRIER = { length: 4, hp: 400, duration: 30, range: 25, height: 1.6 };
export const SCAN = { range: 80, duration: 8, level: 3 };
/** board はレールに乗り直せる距離 */
export const RAIL = { length: 80, speed: 22, duration: 60, board: 1.6 };
export const BOTTOMLESS = { duration: 12 };

/** ラン開始時にアルティメットが溜まっているか */
export const ULT_START_READY = false;

export type Style = "守り" | "移動" | "奇襲" | "攻撃";

export type SkillDef = {
  name: string;
  style: Style;
  text: string;
  cooldown: number;
  /** 効いている時間。0 なら一瞬で終わる */
  duration: number;
  /** 効いている間だけ足す修正 */
  mods?: StatMod[];
};

export type PassiveDef = {
  name: string;
  style: Style;
  text: string;
  /** ランの間ずっと足す修正 */
  mods?: StatMod[];
};

export type UltDef = {
  name: string;
  text: string;
  cooldown: number;
  duration: number;
};

export const SKILLS: Record<SkillId, SkillDef> = {
  overshield: {
    name: "シールド追加", style: "守り", cooldown: 25, duration: OVERSHIELD.duration,
    text: `シールドの上に ${OVERSHIELD.amount} の追加シールドを張る。${OVERSHIELD.duration}秒で消える`,
  },
  haste: {
    name: "加速", style: "移動", cooldown: 20, duration: HASTE.duration,
    text: `${HASTE.duration}秒間、移動速度 +${HASTE.moveMul * 100}%`,
    mods: [{ stat: "moveMul", mul: HASTE.moveMul }],
  },
  slide: {
    name: "横滑りダッシュ", style: "奇襲", cooldown: 18, duration: SLIDE.time,
    text: `${SLIDE.time}秒かけて ${SLIDE.distance}m 進む。移動キーの向きへ曲がれる。撃てる。倒すとクールダウンが終わる`,
  },
  rapidFire: {
    name: "速射", style: "攻撃", cooldown: 25, duration: RAPID_FIRE.duration,
    text: `${RAPID_FIRE.duration}秒間、連射速度 +${RAPID_FIRE.rate * 100}%・リロード時間 −${-RAPID_FIRE.reload * 100}%。効いている間に倒すと ${RAPID_FIRE.killExtend}秒伸びる`,
    mods: [{ stat: "rate", mul: RAPID_FIRE.rate }, { stat: "reload", mul: RAPID_FIRE.reload }],
  },
};

export const PASSIVES: Record<PassiveId, PassiveDef> = {
  killShield: {
    name: "キルでシールド回復", style: "守り",
    text: `倒すとシールドが ${KILL_SHIELD} 回復する`,
    mods: [{ stat: "killShield", add: KILL_SHIELD }],
  },
  doubleDash: {
    name: "ダッシュ2回", style: "移動",
    text: `ダッシュを2回まで溜められる。1回分は ${DASH.cooldown}秒で戻る`,
    mods: [{ stat: "dashCharges", add: 1 }],
  },
  healSense: {
    name: "巻き検知", style: "奇襲",
    text: `${HEAL_SENSE.range}m 以内で回復している敵を、半径 ${HEAL_SENSE.radius}m の円で示す。円の中心はずれていて、${HEAL_SENSE.every}秒ごとに置き直す。壁越しにも出る`,
  },
  damageUp: {
    name: "弾の威力", style: "攻撃",
    text: `1発のダメージ +${DAMAGE_UP * 100}%`,
    mods: [{ stat: "damage", mul: DAMAGE_UP }],
  },
};

export const ULTS: Record<UltId, UltDef> = {
  barrier: {
    name: "遮蔽物", cooldown: 90, duration: BARRIER.duration,
    text: `カーソルの位置に長さ ${BARRIER.length}m の壁を立てる。弾を止め、耐久 ${BARRIER.hp} で壊れる。${BARRIER.duration}秒で消える`,
  },
  scan: {
    name: "広域探知", cooldown: 100, duration: SCAN.duration,
    text: `${SCAN.range}m 以内の敵を、壁越しに型と体力まで ${SCAN.duration}秒間見せる`,
  },
  rail: {
    name: "長距離移動レール", cooldown: 120, duration: RAIL.duration,
    text: `カーソルの方向へ最大 ${RAIL.length}m のレールを敷き、秒速 ${RAIL.speed}m で進む。撃てる。レールは ${RAIL.duration}秒残り、E で乗り直せる。クールダウンは敷いた時点から数える`,
  },
  bottomless: {
    name: "弾倉なし", cooldown: 75, duration: BOTTOMLESS.duration,
    text: `${BOTTOMLESS.duration}秒間、カバンの弾を直接撃つ。リロードしない`,
  },
};

export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];
export const PASSIVE_IDS = Object.keys(PASSIVES) as PassiveId[];
export const ULT_IDS = Object.keys(ULTS) as UltId[];

/** 持ち込むスキルの組み合わせ */
export type KitChoice = { skill: SkillId; passive: PassiveId; ult: UltId };
