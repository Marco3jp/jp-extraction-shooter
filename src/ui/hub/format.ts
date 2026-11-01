import { LOWER_IS_BETTER, STAT_LABELS, type Modifier } from "../../data/attachments";
import { RARITY_COLORS, type Rarity } from "../../data/items";
import type { WeaponStat } from "../../data/weapons";

export type Tone = "good" | "bad" | "same";

/** 値が増えたことが良いか悪いか */
export function toneOf(stat: WeaponStat, delta: number): Tone {
  if (Math.abs(delta) < 1e-6) return "same";
  const up = delta > 0;
  return up !== LOWER_IS_BETTER.includes(stat) ? "good" : "bad";
}

const sign = (v: number) => (v > 0 ? "+" : "−");

/** 「連射速度 +30%」のような表示 */
export function formatMod(m: Modifier): { text: string; tone: Tone }[] {
  const out: { text: string; tone: Tone }[] = [];
  const label = STAT_LABELS[m.stat];
  if (m.add) out.push({ text: `${label} ${sign(m.add)}${trimNum(Math.abs(m.add))}`, tone: toneOf(m.stat, m.add) });
  if (m.mul) out.push({ text: `${label} ${sign(m.mul)}${Math.round(Math.abs(m.mul) * 100)}%`, tone: toneOf(m.stat, m.mul) });
  return out;
}

export function trimNum(v: number, digits = 2): string {
  return String(Number(v.toFixed(digits)));
}

export function formatMoney(n: number): string {
  return `${n.toLocaleString("ja-JP")}円`;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function rarityColor(r: Rarity): string {
  return `#${RARITY_COLORS[r].toString(16).padStart(6, "0")}`;
}

/** 移動速度の倍率を「−3%」のように出す。変わらなければ null */
export function formatMoveMul(mul: number): string | null {
  const pct = Math.round((mul - 1) * 100);
  if (pct === 0) return null;
  return `移動速度 ${sign(pct)}${Math.abs(pct)}%`;
}
