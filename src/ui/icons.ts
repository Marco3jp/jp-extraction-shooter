import type { ItemId } from "../data/items";
import { PASSIVES, SKILLS, ULTS, type PassiveId, type SkillId, type Style, type UltId } from "../data/skills";

const OUTLINE = `stroke="#15171b" stroke-width="0.7" stroke-linejoin="round"`;

function round(x: number, top: number, w: number, h: number, tipH: number, caseC: string, tipC: string) {
  const ty = top + tipH;
  const tip = `M${x} ${ty}C${x} ${top + tipH * 0.35} ${x + w * 0.25} ${top} ${x + w / 2} ${top}C${x + w * 0.75} ${top} ${x + w} ${top + tipH * 0.35} ${x + w} ${ty}Z`;
  const bottom = top + h;
  return `<rect x="${x}" y="${ty}" width="${w}" height="${bottom - ty}" fill="${caseC}" ${OUTLINE}/>` +
    `<path d="${tip}" fill="${tipC}" ${OUTLINE}/>` +
    `<rect x="${x - 0.3}" y="${bottom - 1.1}" width="${w + 0.6}" height="1.1" fill="#8a6420" ${OUTLINE}/>`;
}

function gearPath(cx: number, cy: number, teeth: number, ro: number, ri: number) {
  const pts: string[] = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    for (const [da, r] of [[-0.3, ri], [-0.18, ro], [0.18, ro], [0.3, ri]] as const) {
      const t = a + da * step * 1.4;
      pts.push(`${(cx + Math.cos(t) * r).toFixed(2)} ${(cy + Math.sin(t) * r).toFixed(2)}`);
    }
  }
  return `M${pts.join("L")}Z`;
}

const BRASS = "#d9a845";

/** 強化パーツは六角形の部品の枠に、効き目の印を入れる */
function module(color: string, inner: string) {
  return `<path d="M10 1.2L17.8 5.6V14.4L10 18.8L2.2 14.4V5.6Z" fill="#20252c" stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>${inner}`;
}

const BODIES: Record<ItemId, string> = {
  rifle: round(4.6, 2, 4.2, 16, 5.5, BRASS, "#c8743c") + round(11.2, 2, 4.2, 16, 5.5, BRASS, "#c8743c"),
  smg: round(2.4, 6.5, 4, 11, 3.2, BRASS, "#b9c0c8") + round(8, 6.5, 4, 11, 3.2, BRASS, "#b9c0c8") + round(13.6, 6.5, 4, 11, 3.2, BRASS, "#b9c0c8"),
  long: `<g transform="rotate(38 10 10)">${round(8.3, 0.2, 3.4, 19.6, 7.5, BRASS, "#d65a3c")}</g>`,
  shell:
    `<rect x="4.5" y="2" width="11" height="11.5" rx="1.6" fill="#d23c30" ${OUTLINE}/>` +
    `<path d="M7.5 2.6V12.8M10 2.6V12.8M12.5 2.6V12.8" stroke="#8e2018" stroke-width="0.8"/>` +
    `<rect x="4.5" y="13" width="11" height="4" fill="${BRASS}" ${OUTLINE}/>` +
    `<rect x="3.6" y="16.8" width="12.8" height="1.6" rx="0.4" fill="#8a6420" ${OUTLINE}/>`,
  light: round(3.4, 8, 5.4, 9.6, 4, BRASS, "#c98a4a") + round(11.2, 8, 5.4, 9.6, 4, BRASS, "#c98a4a"),
  cell:
    `<path d="M10 1.4L17.6 5.7V14.3L10 18.6L2.4 14.3V5.7Z" fill="#163556" stroke="#4aa0ff" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<path d="M11.2 4L6.6 11H9.6L8.6 16L13.4 9H10.4Z" fill="#bfe2ff"/>`,
  medSmall:
    `<g transform="rotate(45 10 10)">` +
    `<rect x="9.3" y="0.8" width="1.4" height="4" fill="#cfd8dc"/>` +
    `<rect x="6.8" y="0.6" width="6.4" height="1.4" rx="0.5" fill="#e8eef0" ${OUTLINE}/>` +
    `<rect x="5.8" y="4.3" width="8.4" height="1.4" rx="0.5" fill="#e8eef0" ${OUTLINE}/>` +
    `<rect x="7.4" y="5.6" width="5.2" height="9" fill="#e8eef0" ${OUTLINE}/>` +
    `<rect x="8.2" y="9" width="3.6" height="5" fill="#50e070"/>` +
    `<rect x="9.55" y="14.6" width="0.9" height="4.8" fill="#b8c0c4"/>` +
    `</g>`,
  medLarge:
    `<path d="M7 5.2V3.2H13V5.2" fill="none" stroke="#d8dee0" stroke-width="1.6"/>` +
    `<rect x="1.8" y="5" width="16.4" height="12.8" rx="2" fill="#2f9a50" ${OUTLINE}/>` +
    `<path d="M8.4 7.4H11.6V9.8H14V13H11.6V15.4H8.4V13H6V9.8H8.4Z" fill="#f4f8f6"/>`,
  frag:
    `<rect x="8.2" y="1.6" width="4.6" height="3.4" rx="0.6" fill="#8c939a" ${OUTLINE}/>` +
    `<path d="M12.6 2.4C15.6 2.2 17 3.6 16.4 6.2" fill="none" stroke="#c9cdd2" stroke-width="1.2" stroke-linecap="round"/>` +
    `<ellipse cx="10" cy="11.8" rx="6.6" ry="7" fill="#3f5a32" ${OUTLINE}/>` +
    `<path d="M4 9.6H16M4 13.8H16M10 5V18.6" stroke="#2a3d22" stroke-width="0.9"/>`,
  thermite:
    `<rect x="5.6" y="5" width="8.8" height="13.4" rx="1.4" fill="#5a5f66" ${OUTLINE}/>` +
    `<rect x="5.6" y="9.4" width="8.8" height="3" fill="#e0642c"/>` +
    `<rect x="7.6" y="3.2" width="4.8" height="2.2" rx="0.5" fill="#8c939a" ${OUTLINE}/>` +
    `<path d="M10 0.6C11.6 2 12.4 3 11.4 4C12.6 3.6 13.4 2.4 13 1.2" fill="none" stroke="#ff9a3c" stroke-width="1" stroke-linecap="round"/>`,
  junk:
    `<g transform="rotate(35 13.5 8.5)">` +
    `<rect x="10.4" y="1.4" width="6.2" height="3" rx="0.4" fill="#b4bac0" ${OUTLINE}/>` +
    `<rect x="12" y="4.4" width="3" height="9.4" fill="#9aa1a8" ${OUTLINE}/>` +
    `<path d="M12 6.4L15 7.2M12 8.4L15 9.2M12 10.4L15 11.2" stroke="#5f666d" stroke-width="0.7"/>` +
    `</g>` +
    `<path d="M7.5 7.6L12 10.2V15.4L7.5 18L3 15.4V10.2Z" fill="#8c939a" ${OUTLINE}/>` +
    `<circle cx="7.5" cy="12.8" r="2.1" fill="#2a2e33"/>`,
  circuit:
    `<path d="M7.5 2V5M10 2V5M12.5 2V5M7.5 15V18M10 15V18M12.5 15V18M2 7.5H5M2 10H5M2 12.5H5M15 7.5H18M15 10H18M15 12.5H18" stroke="#c9cdd2" stroke-width="1.2" stroke-linecap="round"/>` +
    `<rect x="4.6" y="4.6" width="10.8" height="10.8" rx="1.2" fill="#1c2a3c" stroke="#4aa0ff" stroke-width="1.2"/>` +
    `<rect x="7.6" y="7.6" width="4.8" height="4.8" rx="0.6" fill="#4aa0ff"/>`,
  precision:
    `<path d="${gearPath(10, 10, 8, 9.2, 6.8)}" fill="#cbb8ea" stroke="#5c2f9c" stroke-width="0.8" stroke-linejoin="round"/>` +
    `<circle cx="10" cy="10" r="4" fill="#b060ff" stroke="#5c2f9c" stroke-width="0.8"/>` +
    `<circle cx="8.7" cy="8.7" r="1.2" fill="#f2e6ff"/>`,
  ultCharge:
    `<circle cx="10" cy="10" r="8.4" fill="#2a2414" stroke="#ffd040" stroke-width="1.4"/>` +
    `<path d="M11.4 3.6L6.4 11H9.6L8.6 16.4L13.6 9H10.4Z" fill="#ffd040"/>`,
  revive:
    `<path d="M10 17.6C5 14 2.2 11.2 2.2 7.6C2.2 5 4.2 3 6.6 3C8 3 9.2 3.7 10 4.8C10.8 3.7 12 3 13.4 3C15.8 3 17.8 5 17.8 7.6C17.8 11.2 15 14 10 17.6Z" fill="#3a1418" stroke="#ffc030" stroke-width="1.3" stroke-linejoin="round"/>` +
    `<path d="M4.6 9.6H7.4L8.6 7L10.6 12.4L12 9.6H15.4" fill="none" stroke="#ff7060" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  evac:
    `<path d="M10 1.6L14.4 8H11.6V13H8.4V8H5.6Z" fill="#ffc030" stroke="#8a6420" stroke-width="0.8" stroke-linejoin="round"/>` +
    `<path d="M4.2 18.4L7 13.6H13L15.8 18.4Z" fill="#5a5f66" ${OUTLINE}/>` +
    `<path d="M2.6 18.4H17.4" stroke="#c9cdd2" stroke-width="1.2" stroke-linecap="round"/>`,
  shieldCore: module("#4aa0ff", `<path d="M10 5L14 6.6V9.8C14 12.4 12.3 14.2 10 15.2C7.7 14.2 6 12.4 6 9.8V6.6Z" fill="#4aa0ff"/>`),
  magKit: module(BRASS, `<rect x="6.6" y="5.6" width="2.6" height="8.8" rx="0.6" fill="${BRASS}"/><rect x="10.8" y="5.6" width="2.6" height="8.8" rx="0.6" fill="${BRASS}"/>`),
  stabilizer: module("#c9cdd2", `<circle cx="10" cy="10" r="3.6" fill="none" stroke="#c9cdd2" stroke-width="1.3"/><path d="M10 4.6V7.4M10 12.6V15.4M4.6 10H7.4M12.6 10H15.4" stroke="#c9cdd2" stroke-width="1.3" stroke-linecap="round"/>`),
  quickLoader: module("#ffd040", `<path d="M13.6 8A4 4 0 1 0 14 11.4" fill="none" stroke="#ffd040" stroke-width="1.6" stroke-linecap="round"/><path d="M14.6 5.2V8.6H11.2" fill="none" stroke="#ffd040" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`),
  lightFrame: module("#50e070", `<path d="M6 6.4L9.6 10L6 13.6M10.4 6.4L14 10L10.4 13.6" fill="none" stroke="#50e070" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`),
  coolingUnit: module("#9ad8ff", `<path d="M10 5V15M5.7 7.5L14.3 12.5M5.7 12.5L14.3 7.5" stroke="#9ad8ff" stroke-width="1.5" stroke-linecap="round"/>`),
  spareBattery: module("#50e070", `<rect x="6" y="6.6" width="7.4" height="6.8" rx="0.8" fill="none" stroke="#50e070" stroke-width="1.4"/><rect x="13.4" y="8.6" width="1.4" height="2.8" fill="#50e070"/><rect x="7.4" y="8" width="2.4" height="4" fill="#50e070"/>`),
  money:
    `<circle cx="10" cy="10" r="8.6" fill="#ffc030" stroke="#9a6e0c" stroke-width="1.1"/>` +
    `<circle cx="10" cy="10" r="6.5" fill="none" stroke="#e0a020" stroke-width="0.8"/>` +
    `<path d="M6.9 5.4L10 9.6L13.1 5.4M10 9.6V15M7 10.6H13M7 13H13" fill="none" stroke="#6e4c06" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
};

/** アイテムのアイコン（SVG の文字列）。拠点の画面とラン中の HUD の両方で使う */
export function itemIcon(id: ItemId, size = 20): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" aria-hidden="true">${BODIES[id]}</svg>`;
}

const STYLE_COLORS: Record<Style, string> = { 守り: "#4aa0ff", 移動: "#50e070", 奇襲: "#b080ff", 攻撃: "#ff8a3c" };
export const ULT_COLOR = "#ffd040";

const SHIELD_PATH = "M10 1.6L17 4.2V9.6C17 13.8 14 16.8 10 18.4C6 16.8 3 13.8 3 9.6V4.2Z";

const KIT_BODIES: Record<SkillId | PassiveId | UltId, (c: string) => string> = {
  overshield: (c) => `<path d="${SHIELD_PATH}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 6V13M6.5 9.5H13.5" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`,
  haste: (c) => `<path d="M3 4L9 10L3 16M10 4L16 10L10 16" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  slide: (c) => `<path d="M3 16C6 16 8 13 9 10C10 7 12 4 16 4" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"/><path d="M12.5 2.4L16.4 4L14.6 7.6" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  rapidFire: (c) => `<path d="M3 5H11M3 10H14M3 15H11" stroke="${c}" stroke-width="2" stroke-linecap="round"/><path d="M14 3L17.5 5L14 7M15.5 13L19 15L15.5 17" fill="${c}"/>`,
  killShield: (c) => `<path d="${SHIELD_PATH}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 7L13 13M13 7L7 13" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`,
  doubleDash: (c) => `<path d="M3 6L7 10L3 14M8.5 6L12.5 10L8.5 14" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><text x="17" y="17.5" font-size="8" font-weight="700" fill="${c}" text-anchor="middle">2</text>`,
  healSense: (c) => `<circle cx="10" cy="10" r="7.6" fill="none" stroke="${c}" stroke-width="1.5" stroke-dasharray="2.6 2"/><path d="M12 6.5V11.5M9.5 9H14.5" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`,
  damageUp: (c) => `<path d="M5 17V9C5 6.5 6.5 4.5 8 3.5C9.5 4.5 11 6.5 11 9V17Z" fill="${c}"/><path d="M15 16V5M12.4 7.6L15 5L17.6 7.6" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  barrier: (c) => `<path d="M2 6H18V16H2Z" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/><path d="M2 11H18M7 6V11M13 6V11M4.5 11V16M10 11V16M15.5 11V16" stroke="${c}" stroke-width="1.3"/>`,
  scan: (c) => `<circle cx="10" cy="10" r="2" fill="${c}"/><circle cx="10" cy="10" r="5" fill="none" stroke="${c}" stroke-width="1.3"/><circle cx="10" cy="10" r="8.2" fill="none" stroke="${c}" stroke-width="1.3" opacity="0.6"/>`,
  rail: (c) => `<path d="M6 18L9 2M14 18L11 2" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/><path d="M5 15H15M6 10.5H14M7 6H13" stroke="${c}" stroke-width="1.3" stroke-linecap="round"/>`,
  bottomless: (c) => `<path d="M10 10C8 7 5 6.5 3.8 8.2C2.6 10 3.6 13 6.2 13C8 13 9 11.5 10 10C11 8.5 12 7 13.8 7C16.4 7 17.4 10 16.2 11.8C15 13.5 12 13 10 10Z" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round"/>`,
};

/** スキル・パッシブ・アルティメットのアイコン。色は寄せ方（アルティメットは共通の色） */
export function kitIcon(id: SkillId | PassiveId | UltId, size = 20): string {
  const color = id in ULTS ? ULT_COLOR : STYLE_COLORS[(SKILLS[id as SkillId] ?? PASSIVES[id as PassiveId]).style];
  return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" aria-hidden="true">${KIT_BODIES[id](color)}</svg>`;
}
