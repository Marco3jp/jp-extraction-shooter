import "./inspect.css";
import type { Renderer } from "./render/renderer";
import { FORGET_AFTER, ignoresPlayer, PROVOKED_FOR, spec } from "./sim/ai";
import { isMoving, weapon } from "./sim/combat";
import {
  ATTACHMENTS, BUFFS, ENEMY, ENEMY_BULLET_SPEED_MUL, ENEMY_MIN_TTK, ENEMY_SPEED, HEALS, PARTNER, PARTNER_COVER, PARTNER_WIN_MARGIN,
  PASSIVES, SKILLS, TTK_TARGET_HP, WEAPON_BASES, DEVICES, factionDef,
  type ActorStat, type AttachmentId, type BuffId, type Modifier, type PassiveId, type SkillId, type WeaponStat, type WeaponType,
} from "./sim/data";
import type { Vec } from "./sim/map";
import { FORGET_AFTER as PARTNER_FORGET_AFTER, slotPos } from "./sim/partner";
import { applyModifiers, computeWeapon, theoreticalTtk } from "./sim/stats";
import type { Actor, AiState, Hold, World } from "./sim/world";

/** 遊んでいる間に右の欄を書き直す間隔。ポーズ中は中身が変わったときだけ書く */
const PANEL_INTERVAL = 0.15;
/** 画面の上でこの距離（px）以内にいる人を、クリックで選ぶ */
const PICK_RADIUS = 48;

const STATE_NAMES: Record<AiState, string> = {
  patrol: "巡回", engage: "交戦", retreat: "後退", push: "詰める",
  follow: "付いていく", fight: "撃ち合い", heal: "回復へ引く", return: "戻る",
};

const STAT_NAMES: Record<WeaponStat | ActorStat, string> = {
  damage: "ダメージ", rate: "連射（発/秒）", mag: "マガジン", reload: "リロード（秒）", pellets: "粒の数", pelletSpread: "散弾の広がり",
  spreadBase: "基本の拡散（度）", spreadPerShot: "1発ごとの拡散", spreadMax: "拡散の上限", spreadRecover: "拡散の戻り", spreadMoving: "移動中の拡散",
  bulletSpeed: "弾速（m/秒）", range: "射程（m）",
  moveMul: "移動速度の倍率", shieldMax: "シールド上限", dashCharges: "ダッシュ回数", killShield: "倒したときのシールド回復",
  skillCd: "スキルのクールダウン倍率", dashCd: "ダッシュのクールダウン倍率",
};

const WEAPON_ROWS: WeaponStat[] = ["damage", "pellets", "rate", "mag", "reload", "bulletSpeed", "range", "spreadBase", "spreadPerShot", "spreadMoving"];
const ACTOR_ROWS: ActorStat[] = ["moveMul", "shieldMax", "dashCharges", "killShield", "skillCd", "dashCd"];

type Source = { label: string; mods: readonly Modifier<string>[]; until: number | null };

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

function num(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return "∞";
  return Number.isInteger(v) ? String(v) : v.toFixed(digits).replace(/\.?0+$/, "");
}

function modLabel(source: string): string {
  const [kind, id] = source.split(":");
  if (kind === "partner") return "パートナーの補正";
  if (kind === "passive") return `パッシブ「${PASSIVES[id as PassiveId]?.name ?? id}」`;
  if (kind === "skill") return `スキル「${SKILLS[id as SkillId]?.name ?? id}」`;
  if (kind === "buff") return `強化パーツ「${BUFFS[id as BuffId]?.name ?? id}」`;
  return source;
}

function modText(m: Modifier<string>): string {
  const parts: string[] = [];
  if (m.add) parts.push(`${m.add > 0 ? "+" : ""}${num(m.add)}`);
  if (m.mul) parts.push(`${m.mul > 0 ? "+" : ""}${num(m.mul * 100, 1)}%`);
  return parts.join(" ");
}

export function actorName(a: Actor): string {
  if (a.team === "player") return "自分";
  if (a.team === "partner") return `パートナー${a.partner!.index + 1}`;
  if (a.kind === "turret") return "タレット";
  return ENEMY[a.kind as keyof typeof ENEMY]?.name ?? a.kind;
}

function holdText(a: Actor, d: number): string {
  const ai = a.ai;
  if (!ai) return "";
  if (!a.alive) return "倒れている";
  if (a.heal) return `回復中 ${num(a.heal.t, 1)}秒`;
  if (a.reloadT > 0) return `リロード中 ${num(a.reloadT, 1)}秒`;
  const h: Hold = ai.hold;
  switch (h) {
    case "fire": return "撃っている";
    case "noTarget": return "狙う相手がいない";
    case "unseen": return "相手が見えていない";
    case "react": return `反応待ち あと${num(ai.reactT)}秒`;
    case "range": return `射程の外 ${num(d, 1)}m / ${num(weapon(a).def.range)}m`;
    case "aim": return "向きを合わせている";
    case "rest": return `連射の合間 あと${num(ai.restT)}秒`;
    case "move": return "動くほうを優先して撃たない";
  }
}

/** 狙っている相手。タレットは設置物の側が持っている */
function targetOf(w: World, a: Actor): Actor | undefined {
  let id: number | null = a.ai?.target ?? null;
  if (a.kind === "turret") id = w.devices.find((d) => d.actor === a.id)?.target ?? null;
  return id === null ? undefined : w.actors.find((o) => o.id === id);
}

/** 武器を作るときに、アタッチメントの後にかける修正と、最後に掛ける倍率 */
function weaponSources(a: Actor): { type: WeaponType; attachments: AttachmentId[]; minTtk: number; extras: Source[]; post: { label: string; stat: WeaponStat; mul: number }[] } {
  if (a.build) {
    const b = a.build.weapons[a.cur] ?? a.build.weapons[0];
    return {
      type: b.type, attachments: b.attachments, minTtk: a.build.minTtk,
      extras: a.mods.map((m) => ({ label: modLabel(m.source), mods: m.mods, until: m.until })),
      post: [],
    };
  }
  const e = ENEMY[a.kind as keyof typeof ENEMY];
  if (e) {
    return {
      type: e.weapon.type, attachments: e.weapon.attachments, minTtk: ENEMY_MIN_TTK,
      extras: [{ label: "敵の種類のダメージ倍率", mods: [{ stat: "damage", mul: e.damageMul - 1 }], until: null }],
      post: [{ label: "敵の弾を遅くする", stat: "bulletSpeed", mul: ENEMY_BULLET_SPEED_MUL }],
    };
  }
  return { type: "ar", attachments: [], minTtk: ENEMY_MIN_TTK, extras: [], post: [] };
}

function chip(text: string, cls = "") {
  return `<span class="chip ${cls}">${text}</span>`;
}

function weaponTable(w: World, a: Actor): string {
  const src = weaponSources(a);
  const base = WEAPON_BASES[src.type].stats;
  const attachMods = src.attachments.flatMap((id) => ATTACHMENTS[id].mods);
  const attached = applyModifiers(base, attachMods);
  const clamped = computeWeapon(src.type, src.attachments, [], src.minTtk);
  const def = weapon(a).def;
  const cell = (v: number, prev: number) => `<td class="${Math.abs(v - prev) > 1e-6 ? "changed" : ""}">${num(v)}</td>`;
  let rows = "";
  for (const k of WEAPON_ROWS) {
    if (k === "pellets" && base.pellets <= 1 && def.pellets <= 1) continue;
    const chips: string[] = [];
    for (const id of src.attachments) {
      for (const m of ATTACHMENTS[id].mods) if (m.stat === k) chips.push(chip(`${ATTACHMENTS[id].name} ${modText(m)}`, "att"));
    }
    if (k === "rate" && clamped.rateClamped) chips.push(chip(`TTK下限 ${src.minTtk}秒に合わせて連射を落とした`, "clamp"));
    for (const s of src.extras) {
      for (const m of s.mods) if (m.stat === k) chips.push(chip(`${s.label} ${modText(m)}`, "extra"));
    }
    for (const p of src.post) if (p.stat === k) chips.push(chip(`${p.label} ×${p.mul}`, "extra"));
    rows += `<tr><th>${STAT_NAMES[k]}</th>${cell(base[k], base[k])}${cell(attached[k], base[k])}${cell(clamped[k], attached[k])}${cell(def[k], clamped[k])}<td class="chips">${chips.join("")}</td></tr>`;
  }
  const perShot = def.damage * def.pellets;
  const t = targetOf(w, a);
  const tHp = t ? t.shield + t.health + t.overshield : 0;
  const ttk200 = theoreticalTtk(def, TTK_TARGET_HP);
  const ttkT = t ? theoreticalTtk(def, Math.max(1, tHp)) : null;
  const ttkLine = `理論TTK（全弾当たったとき）: ${TTK_TARGET_HP}の相手に ${num(ttk200.ttk)}秒・${ttk200.shots}発`
    + (ttkT && t ? `　狙っている${actorName(t)}（残り${num(tHp, 0)}）に ${num(ttkT.ttk)}秒・${ttkT.shots}発` : "");
  return `<h3>武器「${def.name}」の数値と補正</h3>
    <table class="wtable"><thead><tr><th></th><th>基本</th><th>アタッチ<br>メント後</th><th>TTK<br>下限</th><th>最終</th><th>かかっている補正</th></tr></thead><tbody>${rows}</tbody></table>
    <p>DPS ${num(perShot * def.rate, 1)}（1発 ${num(perShot, 1)} × ${num(def.rate)}発/秒）　マガジン ${weapon(a).mag}/${def.mag}</p>
    <p>${ttkLine}</p>`;
}

/** 撃ったときの向きのずれ。pullTrigger と同じ足し方 */
function spreadBlock(w: World, a: Actor): string {
  const def = weapon(a).def;
  const extra = a.team === "partner" ? PARTNER.aimError
    : a.kind === "turret" ? DEVICES.turret.aimErrorDeg
    : a.team === "enemy" ? spec(a).aimError : 0;
  const moving = isMoving(a) ? def.spreadMoving : 0;
  const cone = def.spreadBase + a.bloom + moving + extra;
  const parts = [
    `基本 ${num(def.spreadBase)}`,
    `連射で広がった分 ${num(a.bloom)}`,
    `移動中 ${num(moving)}${isMoving(a) ? "" : "（止まっている）"}`,
  ];
  if (a.team !== "player") parts.push(`照準のぶれ（aimError） ${num(extra)}`);
  let hit = "";
  const t = targetOf(w, a);
  if (t) {
    const d = dist(a.pos, t.pos);
    // 中心のずれは (乱数 + 乱数 - 1) × cone / 2 の三角分布。相手の半径に収まる割合を出す
    const half = cone / 2;
    const k = half > 0 ? (Math.atan2(t.radius, d) * 180) / Math.PI / half : Infinity;
    const p = k >= 1 ? 1 : 1 - (1 - k) ** 2;
    hit = `<p>${num(d, 1)}m 先の止まっている${actorName(t)}に当たる割合 <b>${num(p * 100, 0)}%</b>（狙った向きのずれだけで計算${def.pellets > 1 ? "。散弾は中心の1粒" : ""}）　弾が届くまで ${num(d / def.bulletSpeed)}秒</p>`;
  }
  return `<h3>撃つときの向きのずれ</h3><p>合計 <b>${num(cone)}度</b> = ${parts.join(" + ")}</p>${hit}`;
}

function actorStatBlock(a: Actor): string {
  if (!a.build) return "";
  const base = a.build.stats;
  const final: Record<ActorStat, number> = {
    moveMul: a.moveMul, shieldMax: a.shieldMax, dashCharges: a.dashMax, killShield: a.killShield, skillCd: a.skillCdMul, dashCd: a.dashCdMul,
  };
  let rows = "";
  for (const k of ACTOR_ROWS) {
    const chips: string[] = [];
    for (const m of a.mods) for (const x of m.mods) if (x.stat === k) chips.push(chip(`${modLabel(m.source)} ${modText(x)}`, "extra"));
    if (!chips.length && Math.abs(base[k] - final[k]) < 1e-6) continue;
    rows += `<tr><th>${STAT_NAMES[k]}</th><td>${num(base[k])}</td><td class="${Math.abs(base[k] - final[k]) > 1e-6 ? "changed" : ""}">${num(final[k])}</td><td class="chips">${chips.join("")}</td></tr>`;
  }
  if (!rows) return "";
  return `<h3>武器以外の補正</h3><table class="wtable"><thead><tr><th></th><th>基本</th><th>最終</th><th>かかっている補正</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function modsBlock(w: World, a: Actor): string {
  if (!a.mods.length) return "";
  const li = a.mods.map((m) => {
    const left = m.until === null ? "外すまで" : `あと${num(Math.max(0, m.until - w.time), 1)}秒`;
    return `<li><b>${modLabel(m.source)}</b>（${left}）: ${m.mods.map((x) => `${STAT_NAMES[x.stat]} ${modText(x)}`).join("・")}</li>`;
  }).join("");
  return `<h3>効いている補正</h3><ul>${li}</ul>`;
}

function aiBlock(w: World, a: Actor): string {
  const ai = a.ai;
  if (!ai) return "";
  const t = targetOf(w, a);
  const d = t ? dist(a.pos, t.pos) : Infinity;
  const sp = spec(a);
  const rows: [string, string][] = [];
  rows.push(["状態", `${STATE_NAMES[ai.state]}${ai.stateT > 0 && (ai.state === "retreat" || ai.state === "push" || ai.state === "heal") ? `（あと${num(ai.stateT, 1)}秒）` : ""}`]);
  rows.push(["していること", ai.why || "—"]);
  rows.push(["引き金", holdText(a, d)]);
  if (t) {
    const seen = ai.canSee ? "見えている" : `最後に見たのは${num(w.time - ai.lastSeenT, 1)}秒前（${a.partner ? PARTNER_FORGET_AFTER : FORGET_AFTER}秒で忘れる）`;
    rows.push(["狙っている相手", `#${t.id} ${actorName(t)}・${factionDef(t.faction).name}　${num(d, 1)}m　${seen}`]);
  }
  rows.push(["反応", `あと${num(Math.max(0, ai.reactT))}秒（反応時間 ${num(sp.reaction)}秒。${a.partner ? "狙う相手を替えたときは ×1〜1.6" : "見つけたときは ×1〜2.2 + 0.2秒"}。見えなくなると反応時間の半分まで戻る）`]);
  rows.push(["連射", `${num(ai.burstT, 2)} / ${num(ai.burstLen, 2)}秒撃ったら ${num(sp.rest[0])}〜${num(sp.rest[1])}秒休む${ai.restT > 0 ? `（休みの残り ${num(ai.restT)}秒）` : ""}`]);
  if (a.team === "enemy") {
    const ob = ai.outmatchedBy !== null ? w.actors.find((o) => o.id === ai.outmatchedBy) : undefined;
    rows.push(["ほかの勢力に押されている", ob ? `#${ob.id} ${actorName(ob)}・${factionDef(ob.faction).name}` : "いいえ"]);
    const sinceHit = w.time - ai.playerHitT;
    rows.push(["プレイヤーを後回し", ignoresPlayer(w, a) ? "している" : ob && sinceHit <= PROVOKED_FOR ? `しない（撃たれてから${num(sinceHit, 1)}秒。${PROVOKED_FOR}秒で後回しに戻る）` : "しない"]);
    rows.push(["回復の残り回数", String(ai.heals)]);
    rows.push(["グループ", `${ai.group}${ai.roam ? "（漁り歩く）" : ""}${ai.rival ? "（脱出地点に寄せた）" : ""}`]);
  }
  if (a.partner) {
    const ps = a.partner;
    const hp = a.shield + a.health;
    rows.push(["遮蔽", ps.cover ? `${ps.phase === "peek" ? "出て撃っている" : "隠れている"}・出てから受けたダメージ ${ps.phase === "peek" ? num(Math.max(0, ps.peekHp - hp), 0) : 0} / ${PARTNER_COVER.peekDamage}` : "使っていない"]);
    if (t) {
      const margin = hp - (t.shield + t.health);
      rows.push(["撃ち合いの形勢", `自分 ${num(hp, 0)} − 相手 ${num(t.shield + t.health, 0)} = ${num(margin, 0)}（${PARTNER_WIN_MARGIN}以上で勝っているとして隠れない）`]);
    }
    rows.push(["隠れている間に巻いた", ps.hideHealed ? "はい" : "いいえ"]);
  }
  const conf = [
    `見える距離 ${sp.sight}m`,
    a.team === "enemy" ? `保つ間合い ${sp.keepDistance}m` : "",
    `照準のぶれ ${sp.aimError}度`,
    `反応 ${num(sp.reaction)}秒`,
    `連射 ${sp.burst[0]}〜${sp.burst[1]}秒`,
    a.team === "enemy" ? `速さ 巡回${ENEMY_SPEED.patrol}・移動${ENEMY_SPEED.move}・詰める${ENEMY_SPEED.push}m/秒` : "",
  ].filter(Boolean).join("　");
  return `<h3>判断</h3><table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>
    <p class="conf">種類の設定: ${conf}</p>`;
}

function vitalsBlock(a: Actor): string {
  const flags: string[] = [];
  if (!a.alive) flags.push("倒れている");
  if (a.heal) flags.push(`${HEALS[a.heal.kind].name} あと${num(a.heal.t, 1)}秒`);
  if (a.reloadT > 0) flags.push(`リロード あと${num(a.reloadT, 1)}秒`);
  if (a.swapT > 0) flags.push("持ち替え中");
  if (a.burnT > 0) flags.push(`燃えて遅い あと${num(a.burnT, 1)}秒`);
  if (a.invulnT > 0) flags.push("ダメージを受けない");
  const over = a.overshield > 0 ? `　追加シールド ${num(a.overshield, 0)}` : "";
  return `<p class="vitals">シールド ${num(a.shield, 0)}/${a.shieldMax}　ヘルス ${num(a.health, 0)}${over}${flags.length ? `　${flags.join("・")}` : ""}</p>`;
}

export class Inspector {
  enabled: boolean;
  /** 選んだ人の番号。ポーズ中のクリックか、一覧のクリックで選ぶ */
  selected: number | null = null;
  private hover: number | null = null;
  private paused = false;
  private root: HTMLDivElement;
  private panel: HTMLDivElement;
  private tagLayer: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private banner: HTMLDivElement;
  private tags: HTMLDivElement[] = [];
  private shownPanel = "";
  private panelT = 0;

  constructor() {
    this.enabled = new URLSearchParams(location.search).has("inspect");
    this.root = document.createElement("div");
    this.root.id = "inspect";
    this.root.innerHTML = `<canvas class="lines"></canvas><div class="itags"></div><div class="ibanner"></div><div class="ipanel"></div>`;
    document.body.appendChild(this.root);
    this.canvas = this.root.querySelector("canvas")!;
    this.tagLayer = this.root.querySelector(".itags")!;
    this.banner = this.root.querySelector(".ibanner")!;
    this.banner.textContent = "ポーズ中　Esc / P で再開　キャラをクリックして選ぶ　I で確かめる画面を閉じる";
    this.panel = this.root.querySelector(".ipanel")!;
    this.panel.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-pick]");
      if (row) {
        const id = Number(row.dataset.pick);
        this.selected = this.selected === id ? null : id;
        this.shownPanel = "";
      }
    });
    this.apply();
  }

  toggle() {
    this.enabled = !this.enabled;
    this.apply();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.apply();
  }

  private apply() {
    this.root.style.display = this.enabled ? "block" : "none";
    this.banner.style.display = this.paused ? "block" : "none";
    document.body.classList.toggle("inspect-paused", this.enabled && this.paused);
    this.shownPanel = "";
  }

  /** ポーズ中のクリック。近くの人を選び、いなければ選ぶのをやめる */
  pickAt(w: World, r: Renderer, mouse: { x: number; y: number }) {
    this.selected = this.nearest(w, r, mouse);
    this.shownPanel = "";
  }

  private nearest(w: World, r: Renderer, mouse: { x: number; y: number }): number | null {
    let best: number | null = null;
    let bd = PICK_RADIUS;
    for (const a of w.actors) {
      const s = r.worldToScreen(a.pos.x, a.pos.y, 1);
      if (!s.visible) continue;
      const d = Math.hypot(s.x - mouse.x, s.y - mouse.y);
      if (d < bd) {
        bd = d;
        best = a.id;
      }
    }
    return best;
  }

  update(w: World, r: Renderer, mouse: { x: number; y: number }, dt: number) {
    if (!this.enabled) return;
    if (this.selected !== null && !w.actors.some((a) => a.id === this.selected)) this.selected = null;
    // 欄の上にカーソルがあるときは、欄の下に隠れている人を拾わない
    this.hover = this.paused && !this.panel.matches(":hover") ? this.nearest(w, r, mouse) : null;
    const onScreen = w.actors.filter((a) => (a.alive || a.team === "partner") && r.worldToScreen(a.pos.x, a.pos.y, 1).visible);
    this.drawLines(w, r, onScreen);
    this.updateTags(w, r, onScreen);
    this.panelT -= dt;
    if (this.paused || this.panelT <= 0) {
      this.panelT = PANEL_INTERVAL;
      const html = this.panelHtml(w, onScreen);
      if (html !== this.shownPanel) {
        this.panel.innerHTML = html;
        this.shownPanel = html;
      }
    }
  }

  private focusId() {
    return this.hover ?? this.selected;
  }

  private drawLines(w: World, r: Renderer, onScreen: Actor[]) {
    const c = this.canvas;
    const W = window.innerWidth, H = window.innerHeight;
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    const at = (p: Vec) => r.worldToScreen(p.x, p.y, 1);
    const focus = this.focusId();
    for (const a of onScreen) {
      const t = a.alive ? targetOf(w, a) : undefined;
      if (!t) continue;
      const sees = a.kind === "turret" || !!a.ai?.canSee;
      const from = at(a.pos);
      const to = sees || !a.ai?.lastSeen ? at(t.pos) : at(a.ai.lastSeen);
      ctx.strokeStyle = hex(a.team === "partner" ? 0x8fd8ff : factionDef(a.faction).color);
      ctx.globalAlpha = a.id === focus ? 1 : 0.55;
      ctx.lineWidth = a.id === focus ? 2.5 : 1.5;
      ctx.setLineDash(sees ? [] : [6, 5]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      if (!sees) {
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(to.x - 5, to.y - 5);
        ctx.lineTo(to.x + 5, to.y + 5);
        ctx.moveTo(to.x + 5, to.y - 5);
        ctx.lineTo(to.x - 5, to.y + 5);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const f = w.actors.find((a) => a.id === focus);
    if (!f || !f.alive) return;
    const ring = (radius: number, color: string, label: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const ang = (i / 64) * Math.PI * 2;
        const s = r.worldToScreen(f.pos.x + Math.cos(ang) * radius, f.pos.y + Math.sin(ang) * radius, 0.05);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
      const s = r.worldToScreen(f.pos.x, f.pos.y - radius, 0.05);
      ctx.fillStyle = color;
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText(label, s.x + 4, s.y - 4);
    };
    ring(weapon(f).def.range, "rgba(255, 120, 90, 0.8)", `射程 ${num(weapon(f).def.range)}m`);
    if (f.ai) {
      const sp = spec(f);
      ring(sp.sight, "rgba(140, 200, 255, 0.7)", `見える距離 ${sp.sight}m`);
      if (f.team === "enemy") ring(sp.keepDistance, "rgba(255, 220, 90, 0.8)", `保つ間合い ${sp.keepDistance}m`);
    }
    if (f.partner) {
      const dot = (p: Vec, color: string, label: string) => {
        const s = at(p);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText(label, s.x + 7, s.y + 4);
      };
      dot(slotPos(w, f), "#8fd8ff", "付く位置");
      if (f.partner.cover) {
        dot(f.partner.cover.hide, "#7cff9a", "隠れる所");
        dot(f.partner.cover.peek, "#ffb070", "出て撃つ所");
      }
    }
  }

  private updateTags(w: World, r: Renderer, onScreen: Actor[]) {
    let n = 0;
    const focus = this.focusId();
    for (const a of onScreen) {
      if (a.team === "player") continue;
      const s = r.worldToScreen(a.pos.x, a.pos.y, 0);
      let tag = this.tags[n];
      if (!tag) {
        tag = document.createElement("div");
        tag.className = "itag";
        this.tagLayer.appendChild(tag);
        this.tags.push(tag);
      }
      n++;
      const t = targetOf(w, a);
      const d = t ? dist(a.pos, t.pos) : Infinity;
      const color = a.team === "partner" ? "#8fd8ff" : hex(factionDef(a.faction).color);
      const lines = [`<b style="color:${color}">#${a.id} ${actorName(a)}</b> ${num(a.shield, 0)}/${num(a.health, 0)}`];
      if (a.ai) {
        lines.push(`${STATE_NAMES[a.ai.state]}・${a.ai.why || "—"}`);
        lines.push(`<span class="hold ${a.ai.hold}">${holdText(a, d)}</span>`);
      }
      const html = lines.join("<br>");
      if (tag.dataset.html !== html) {
        tag.innerHTML = html;
        tag.dataset.html = html;
      }
      tag.style.display = "block";
      tag.classList.toggle("focus", a.id === focus);
      tag.style.transform = `translate(${s.x}px, ${s.y + 14}px) translateX(-50%)`;
    }
    for (let i = n; i < this.tags.length; i++) this.tags[i].style.display = "none";
  }

  private panelHtml(w: World, onScreen: Actor[]): string {
    const focus = this.focusId();
    const list = onScreen.map((a) => {
      const t = targetOf(w, a);
      const st = a.ai ? STATE_NAMES[a.ai.state] : a.team === "player" ? "" : "—";
      const hold = a.ai ? holdText(a, t ? dist(a.pos, t.pos) : Infinity) : "";
      const color = a.team === "partner" ? "#8fd8ff" : hex(factionDef(a.faction).color);
      return `<tr data-pick="${a.id}" class="${a.id === focus ? "sel" : ""}"><td style="color:${color}">#${a.id} ${actorName(a)}</td><td>${num(a.shield, 0)}/${num(a.health, 0)}</td><td>${st}</td><td>${hold}</td></tr>`;
    }).join("");
    let body = `<p class="hint">${this.paused ? "キャラをクリックするか、一覧から選ぶ" : "一覧から選ぶ。P でポーズするとキャラを直接クリックして選べる"}</p>`;
    const f = w.actors.find((a) => a.id === focus);
    if (f) {
      body = `<h2>#${f.id} ${actorName(f)}・${factionDef(f.faction).name}${this.hover !== null && this.hover !== this.selected ? "<small>（カーソルの下）</small>" : ""}</h2>`
        + vitalsBlock(f) + aiBlock(w, f) + spreadBlock(w, f) + weaponTable(w, f) + actorStatBlock(f) + modsBlock(w, f);
    }
    return `<table class="ilist"><tbody>${list}</tbody></table>${body}`;
  }
}
