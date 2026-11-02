// 武器ごとに、アタッチメントの全組み合わせの理論 TTK（全弾命中、初弾を 0 秒とする）を確かめる。
// 使い方: npm run ttk
import { ATTACHMENT_IDS, ATTACHMENTS, SLOT_ORDER, type AttachmentId } from "../src/data/attachments";
import { ENEMY_MIN_TTK, PLAYER_MIN_TTK, TTK_TARGET_HP } from "../src/data/constants";
import { ENEMY } from "../src/data/enemies";
import { PASSIVES, SKILLS } from "../src/data/skills";
import { WEAPON_BASES, WEAPON_TYPES } from "../src/data/weapons";
import { computeWeapon, theoreticalTtk } from "../src/sim/stats";

function combos(): AttachmentId[][] {
  let out: AttachmentId[][] = [[]];
  for (const slot of SLOT_ORDER) {
    const opts = ATTACHMENT_IDS.filter((id) => ATTACHMENTS[id].slot === slot);
    const next: AttachmentId[][] = [];
    for (const c of out) {
      next.push(c);
      for (const o of opts) next.push([...c, o]);
    }
    out = next;
  }
  return out;
}

const all = combos();
/** スキルとパッシブの修正を全部。武器に関係しない項目は computeWeapon が無視する */
const buffs = [...Object.values(SKILLS), ...Object.values(PASSIVES)].flatMap((d) => d.mods ?? []);
console.log(`相手の体力 ${TTK_TARGET_HP}、下限 プレイヤー ${PLAYER_MIN_TTK}秒（スキルを掛ける前の性能にだけ掛ける）・敵 ${ENEMY_MIN_TTK}秒、組み合わせ ${all.length}通り/武器\n`);
console.log(["武器", "素のTTK", "最短", "最長", "スキルを全部掛けた最短", "連射を下げた組み合わせ", "傾向の名前が付く組み合わせ"].join("\t"));
let violations = 0;
for (const t of WEAPON_TYPES) {
  const base = computeWeapon(t, []);
  let min = Infinity, max = 0, clamped = 0, buffed = Infinity;
  const styles = new Map<string, number>();
  for (const c of all) {
    const w = computeWeapon(t, c);
    const { ttk } = theoreticalTtk(w);
    min = Math.min(min, ttk);
    max = Math.max(max, ttk);
    if (w.rateClamped) clamped++;
    if (w.style) styles.set(w.style, (styles.get(w.style) ?? 0) + 1);
    if (ttk < PLAYER_MIN_TTK - 1e-9) violations++;
    buffed = Math.min(buffed, theoreticalTtk(computeWeapon(t, c, buffs)).ttk);
  }
  const st = [...styles].map(([k, n]) => `${k} ${n}`).join("、") || "なし";
  console.log([WEAPON_BASES[t].name, theoreticalTtk(base).ttk.toFixed(2), min.toFixed(2), max.toFixed(2), buffed.toFixed(2), clamped, st].join("\t"));
}

console.log("\n■ 敵の武器（プレイヤーの標準防具：シールド100＋ヘルス100）");
for (const [kind, spec] of Object.entries(ENEMY)) {
  const base = computeWeapon(spec.weapon.type, spec.weapon.attachments, [], ENEMY_MIN_TTK);
  const w = computeWeapon(spec.weapon.type, spec.weapon.attachments, [{ stat: "damage", mul: spec.damageMul - 1 }], ENEMY_MIN_TTK);
  const { ttk, shots } = theoreticalTtk(w, 200);
  console.log(`${spec.name}\t${w.name}${base.style ? `（${base.style}）` : ""}\t1発 ${w.damage.toFixed(1)}\tDPS ${(w.damage * w.rate).toFixed(0)}\t${shots}発\t${ttk.toFixed(2)}秒`);
  if (theoreticalTtk(base, 200).ttk < ENEMY_MIN_TTK - 1e-9) violations++;
  void kind;
}

console.log(violations ? `\n下限を下回る組み合わせが ${violations} 件ある` : "\nすべて下限以上");
process.exitCode = violations ? 1 : 0;
