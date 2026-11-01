import {
  EVAC, FIXED_RAIL, EXTRACT_CALL_TIME, EXTRACT_DEFENSE, EXTRACT_RADIUS, EXTRACT_TIME, HEALS, HEALTH_MAX, ITEMS, ITEM_ORDER, LOOT_PANEL_RANGE, PLAYER_FACTION, RARITY_COLORS, SECURABLE, SHIELD_PER_CELL,
  BIKE_DISMOUNT, BUFFS, DASH, OVERSHIELD, PARTNER_REVIVE, PASSIVES, SKILLS, THROWABLES, ULTS, factionDef,
  DEVICES, SHOT_NOTICE_RANGE, type BuffId, type DeviceKind, type HealKind, type ItemId, type ThrowableId,
} from "./sim/data";
import { deviceNear } from "./sim/devices";
import { buffsOf, canGiveBuff, GIVE_RANGE } from "./sim/buffs";
import { bagCount, bagUsed, type Stack } from "./sim/inventory";
import { downedPartnerNear, extractAt, nearestLoot, type Command } from "./sim/sim";
import { evacBlocker } from "./sim/evac";
import { nearRail } from "./sim/skills";
import type { Actor, Extract, GameEvent, Loot, World } from "./sim/world";
import type { Renderer } from "./render/renderer";
import { MapView, type EvacPick, type Ping } from "./mapview";
import { itemIcon, kitIcon } from "./ui/icons";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const HEAL_ORDER: [HealKind, string][] = [
  ["cell", "3"],
  ["cellBatch", "4"],
  ["medSmall", "5"],
  ["medLarge", "6"],
  ["ultCharge", "7"],
  ["evac", "8"],
];

const THROW_ORDER: [ThrowableId, string][] = [
  ["frag", "G"],
  ["thermite", "T"],
];

const LEVEL_NAMES = ["なし", "影", "影＋型", "影＋型＋体力"];
const EDGE_WAVE_LIFE = 1.1;
const FEED_LIFE = 6;
/** 撃った・撃たれてからこの秒数は戦闘中として、町名の表示を待たせる */
const COMBAT_HOLD = 6;
const AREA_BANNER_TIME = 3;
/** 最後に当ててからこの秒数だけ、同じ相手へのダメージを足し続ける */
const DMG_STACK_LIFE = 1.5;

type DmgStack = { actor: number; total: number; shield: boolean; t: number; pos: { x: number; y: number }; el: HTMLDivElement };

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

function fmtTime(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function stackColor(s: Stack) {
  const def = ITEMS[s.item];
  return def.category === "money" ? "#ffc030" : hex(RARITY_COLORS[def.rarity]);
}

function countText(s: Stack) {
  return s.item === "money" ? yen(s.count) : `×${s.count}`;
}

const partnerName = (a: Actor) => `パートナー${a.partner!.index + 1}`;

function buffChip(id: BuffId) {
  return `<span class="buff" style="--c:${hex(RARITY_COLORS[BUFFS[id].rarity])}" title="${BUFFS[id].text}"><span class="ic">${itemIcon(id, 18)}</span>${BUFFS[id].name}</span>`;
}

function lootTitle(l: Loot) {
  return l.kind === "deathbox" ? "倒した相手の持ち物" : l.kind === "bin" ? "物資箱" : "落ちている物";
}

export class Hud {
  private tags: HTMLDivElement[] = [];
  private partnerTags: HTMLDivElement[] = [];
  private toastTimer = 0;
  private hitTimer = 0;
  private dmgTimer = 0;
  private pings: Ping[] = [];
  private lastPing = new Map<number, number>();
  private feed: { text: string; t: number }[] = [];
  private dmgStacks: DmgStack[] = [];
  private lastCombatT = -Infinity;
  /** 最後に「〜エリア」と出した町名 */
  private shownArea: string | null = null;
  private areaBannerT = 0;
  private mapView: MapView;
  private panelSig = "";
  private promptHtml = "";
  /** 毎フレーム組み立て直す欄は、前と同じ中身なら DOM に書かない */
  private shown = new Map<HTMLElement, string>();
  /** インベントリ画面。lootId があれば箱の中身も並べる */
  panel = { open: false, lootId: null as number | null, byTab: false };
  bigMap = false;
  /** 長距離移動の行き先を選ぶために、全体マップを開いたか */
  private pickOpened = false;
  private pick: EvacPick | null = null;
  /** 死んでも持ち帰れる枠があるか。無ければカバンの物をクリックしても何もしない */
  private hasSecure = false;
  onCommand: (c: Command) => void = () => {};

  constructor(world: World, mapView: MapView) {
    this.mapView = mapView;
    const items = $("#items");
    for (const [kind, key] of HEAL_ORDER) {
      const d = document.createElement("div");
      d.className = "item";
      d.dataset.kind = kind;
      d.style.setProperty("--c", stackColor({ item: HEALS[kind].item, count: 1 }));
      d.dataset.item = HEALS[kind].item;
      d.innerHTML = `<span class="key">${key}</span><span class="ic">${itemIcon(HEALS[kind].item, 26)}</span><span class="name">${HEALS[kind].name}</span><span class="count"></span>`;
      items.appendChild(d);
    }
    for (const [id, key] of THROW_ORDER) {
      const d = document.createElement("div");
      d.className = "item throw";
      d.dataset.item = id;
      d.style.setProperty("--c", stackColor({ item: id, count: 1 }));
      d.innerHTML = `<span class="key">${key}</span><span class="ic">${itemIcon(id, 26)}</span><span class="name">${THROWABLES[id].name}</span><span class="count"></span>`;
      items.appendChild(d);
    }
    const revive = document.createElement("div");
    revive.className = "item revive";
    revive.dataset.item = "revive";
    revive.title = "死んだら自動で使い、その場で立ち上がる。拾った分を先に使う";
    revive.style.setProperty("--c", stackColor({ item: "revive", count: 1 }));
    revive.innerHTML = `<span class="key">自動</span><span class="ic">${itemIcon("revive", 26)}</span><span class="name">蘇生</span><span class="count"></span>`;
    items.appendChild(revive);
    for (const [kind, key] of [["sensor", "Z"], ["turret", "V"]] as const) {
      const d = document.createElement("div");
      d.className = "item device";
      d.dataset.device = kind;
      d.title = kind === "sensor"
        ? `足元に置く。${DEVICES.sensor.radius}m 以内の敵の型が、壁越しに分かる`
        : `足元に置く。${DEVICES.turret.range}m 以内の敵を撃つ。壊されたらなくなる`;
      d.innerHTML = `<span class="key">${key}</span><span class="name">${DEVICES[kind].name}</span><span class="count"></span>`;
      $("#devices").appendChild(d);
    }
    const dash = document.createElement("div");
    dash.className = "item dash";
    dash.innerHTML = `<span class="key">Space</span><span class="name">ダッシュ</span><span class="count"></span><div class="cd"></div>`;
    items.appendChild(dash);
    this.buildKit(world);
    const inv = $("#inventory");
    inv.addEventListener("mousedown", (e) => e.stopPropagation());
    inv.addEventListener("contextmenu", (e) => e.preventDefault());
    inv.addEventListener("click", (e) => {
      const give = (e.target as HTMLElement).closest<HTMLElement>("[data-give]");
      if (give) {
        this.onCommand({ type: "giveBuff", buff: give.dataset.give as BuffId, partner: Number(give.dataset.partner) });
        return;
      }
      const slot = (e.target as HTMLElement).closest<HTMLElement>("[data-slot],[data-secure]");
      if (slot) {
        if (slot.dataset.secure !== undefined) this.onCommand({ type: "unsecure", slot: Number(slot.dataset.secure) });
        else if (this.hasSecure) this.onCommand({ type: "secure", slot: Number(slot.dataset.slot) });
        return;
      }
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-take],[data-takeall]");
      if (!el || this.panel.lootId === null) return;
      if (el.dataset.takeall !== undefined) this.onCommand({ type: "takeAll", loot: this.panel.lootId });
      else this.onCommand({ type: "take", loot: this.panel.lootId, index: Number(el.dataset.take) });
    });
    inv.addEventListener("mouseup", (e) => {
      if (e.button !== 2) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-slot]");
      if (el) this.onCommand({ type: "drop", slot: Number(el.dataset.slot) });
    });
    const pickHint = document.createElement("div");
    pickHint.className = "pick";
    pickHint.textContent = `長距離移動：${EVAC.range}m 以内の行き先をクリック　Esc でやめる（アイテムは減らない）`;
    $("#bigmap").prepend(pickHint);
    $("#bigmap").addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (this.pickOpened) {
        if (e.button === 0 && this.pick?.hover) this.onCommand({ type: "evacTo", to: this.pick.hover });
        return;
      }
      this.bigMap = false;
    });
  }

  /** スキル・アルティメット・パッシブの表示。ランごとに持ち込むものが変わるので作り直す */
  private buildKit(w: World) {
    const items = $("#kit");
    items.innerHTML = "";
    const k = w.player.kit;
    if (!k) return;
    const tile = (cls: string, key: string, id: Parameters<typeof kitIcon>[0], name: string, title: string) => {
      const d = document.createElement("div");
      d.className = `item kit ${cls}`;
      d.title = title;
      d.innerHTML = `<span class="key">${key}</span><span class="ic">${kitIcon(id, 24)}</span><span class="name">${name}</span><span class="count"></span><div class="cd"></div>`;
      items.appendChild(d);
    };
    tile("skill", "Q", k.skill, SKILLS[k.skill].name, SKILLS[k.skill].text);
    tile("ult", "F", k.ult, ULTS[k.ult].name, ULTS[k.ult].text);
    const pd = document.createElement("div");
    pd.className = "item kit passive";
    pd.title = `${PASSIVES[k.passive].name}：${PASSIVES[k.passive].text}`;
    pd.innerHTML = `<span class="ic">${kitIcon(k.passive, 20)}</span>`;
    items.appendChild(pd);
    if (w.player.bike) {
      const d = document.createElement("div");
      d.className = "item kit bike";
      d.title = "乗っている間は撃てない。撃とうとするか撃たれると降りる";
      d.innerHTML = `<span class="key">C</span><span class="name">自転車</span><span class="count"></span><div class="cd"></div>`;
      items.appendChild(d);
    }
  }

  reset(world: World) {
    this.buildKit(world);
    this.pings = [];
    this.lastPing.clear();
    this.feed = [];
    this.lastCombatT = -Infinity;
    this.shownArea = null;
    this.areaBannerT = 0;
    this.closePanel();
    this.bigMap = false;
    this.pickOpened = false;
    this.pick = null;
  }

  get blocksMouse() {
    return this.panel.open || this.bigMap;
  }

  toggleInventory() {
    if (this.panel.open) this.closePanel();
    else this.panel = { open: true, lootId: null, byTab: true };
  }

  closePanel() {
    this.panel = { open: false, lootId: null, byTab: false };
    this.panelSig = "";
  }

  private toast(text: string) {
    const t = $("#toast");
    t.textContent = text;
    t.classList.add("show");
    this.toastTimer = 2.2;
  }

  handleEvents(w: World, events: GameEvent[]) {
    const byId = new Map(w.actors.map((a) => [a.id, a]));
    const p = w.player;
    for (const ev of events) {
      switch (ev.type) {
        case "pickup":
        case "notice":
          this.toast(ev.text);
          break;
        case "killShield":
          if (ev.actor === p.id) this.toast(`シールド +${Math.round(ev.amount)}`);
          break;
        case "barrierBreak":
          this.toast("壁が壊れた");
          break;
        case "lootOpened":
          this.panel = { open: true, lootId: ev.loot, byTab: false };
          break;
        case "hit":
          if (ev.by === p.id || ev.actor === p.id) this.lastCombatT = w.time;
          if (ev.by === p.id) {
            this.hitTimer = 0.15;
            $("#crosshair").classList.toggle("shield", ev.shield);
          }
          if (ev.actor === p.id) this.dmgTimer = 0.35;
          else if (ev.by === p.id) {
            const t = byId.get(ev.actor);
            if (t && (t.seen || t.info >= 1)) this.stackDamage(w, t, ev.amount, ev.shield);
          }
          break;
        case "shieldBreak": {
          const t = byId.get(ev.actor);
          if (t && t !== p && (t.seen || t.info >= 2)) this.toast("シールド破壊");
          break;
        }
        case "shot": {
          const ours = byId.get(ev.actor)?.team === "device";
          if (ev.faction === PLAYER_FACTION && !ours) {
            this.lastCombatT = w.time;
            break;
          }
          const d = Math.hypot(ev.pos.x - p.pos.x, ev.pos.y - p.pos.y);
          const last = this.lastPing.get(ev.actor) ?? -10;
          if (d < SHOT_NOTICE_RANGE && w.time - last > 0.7) {
            this.lastPing.set(ev.actor, w.time);
            this.pings.push({ pos: { ...ev.pos }, t: w.time, k: 1 - d / SHOT_NOTICE_RANGE, ours });
          }
          break;
        }
        case "death": {
          const victim = byId.get(ev.actor);
          const killer = byId.get(ev.by);
          if (!victim || victim === p || victim.team === "device") break;
          if (victim.team === "partner") {
            this.feedPush(`${partnerName(victim)}が倒れた（近くで E 長押しで起こす）`, w);
            break;
          }
          const near = Math.hypot(ev.pos.x - p.pos.x, ev.pos.y - p.pos.y) < 80;
          if (killer === p) this.feedPush(`${factionDef(victim.faction).name}を倒した`, w);
          else if (near || victim.seen) this.feedPush(`${killer?.team === "device" ? DEVICES.turret.name : killer ? factionDef(killer.faction).name : "?"} が ${factionDef(victim.faction).name} を倒した`, w);
          break;
        }
      }
    }
    this.pings = this.pings.filter((pg) => w.time - pg.t < 3);
  }

  private stackDamage(w: World, target: Actor, amount: number, shield: boolean) {
    let s = this.dmgStacks.find((d) => d.actor === target.id && w.time - d.t < DMG_STACK_LIFE);
    if (!s) {
      const el = document.createElement("div");
      el.className = "dmgnum";
      el.innerHTML = "<span></span>";
      $("#dmgnums").appendChild(el);
      s = { actor: target.id, total: 0, shield, t: w.time, pos: { ...target.pos }, el };
      this.dmgStacks.push(s);
    }
    s.total += amount;
    s.shield = shield;
    s.t = w.time;
    s.el.firstElementChild!.textContent = `${Math.round(s.total)}`;
    s.el.classList.toggle("shield", shield);
    // アニメーションを最初からやり直す
    s.el.classList.remove("bump");
    void s.el.offsetWidth;
    s.el.classList.add("bump");
  }

  private updateDmgStacks(w: World, r: Renderer) {
    const byId = new Map(w.actors.map((a) => [a.id, a]));
    this.dmgStacks = this.dmgStacks.filter((s) => {
      const age = w.time - s.t;
      // 新しいランで時間が 0 に戻ったときも消す
      if (age >= DMG_STACK_LIFE || age < 0) {
        s.el.remove();
        return false;
      }
      const a = byId.get(s.actor);
      if (a?.alive) s.pos = { ...a.pos };
      const sc = r.worldToScreen(s.pos.x, s.pos.y, 3);
      s.el.style.display = sc.visible ? "block" : "none";
      s.el.style.transform = `translate(${sc.x + 18}px, ${sc.y - 10}px)`;
      s.el.style.opacity = age > DMG_STACK_LIFE - 0.3 ? "0" : "1";
      return true;
    });
  }

  private updateAreaBanner(w: World, dt: number) {
    const el = $("#area-banner");
    const area = w.map.areaAt(w.player.pos.x, w.player.pos.y);
    if (area && area !== this.shownArea && w.time - this.lastCombatT > COMBAT_HOLD && w.player.alive) {
      this.shownArea = area;
      this.areaBannerT = AREA_BANNER_TIME;
      el.textContent = `${area}エリア`;
    }
    this.areaBannerT -= dt;
    el.classList.toggle("show", this.areaBannerT > 0);
  }

  private setHtml(el: HTMLElement, html: string) {
    if (this.shown.get(el) === html) return;
    this.shown.set(el, html);
    el.innerHTML = html;
  }

  private feedPush(text: string, w: World) {
    this.feed.push({ text, t: w.time });
    if (this.feed.length > 5) this.feed.shift();
  }

  update(w: World, r: Renderer, mouse: { x: number; y: number }, dt: number) {
    const p = w.player;
    const alive = w.actors.filter((a) => a.team === "enemy" && a.alive).length;
    this.setHtml($("#info"),
      `<div class="map">${w.map.name}</div>` +
      `<div>${fmtTime(w.time)}　撃破 ${w.kills}　残り ${alive}</div>` +
      `<div class="debug">視線 [N]: ${LEVEL_NAMES[w.debug.sightLevel]}<br>ビーコン [B]: ${LEVEL_NAMES[w.debug.beaconLevel]}</div>`);

    const shieldEl = $("#shield");
    const cellCount = Math.ceil(p.shieldMax / SHIELD_PER_CELL);
    // 追加シールドは、ふだんのシールドの右に色を変えて足す
    const overCount = p.overshield > 0 ? Math.ceil(OVERSHIELD.amount / SHIELD_PER_CELL) : 0;
    const total = cellCount + overCount;
    while (shieldEl.children.length < total) shieldEl.appendChild(document.createElement("div"));
    while (shieldEl.children.length > total) shieldEl.lastElementChild!.remove();
    shieldEl.style.gridTemplateColumns = `repeat(${total}, 1fr)`;
    for (let i = 0; i < total; i++) {
      const over = i >= cellCount;
      const have = over ? p.overshield : p.shield;
      const j = over ? i - cellCount : i;
      const v = Math.max(0, Math.min(1, (have - j * SHIELD_PER_CELL) / SHIELD_PER_CELL));
      const el = shieldEl.children[i] as HTMLElement;
      el.classList.toggle("over", over);
      el.style.setProperty("--fill", `${v * 100}%`);
    }
    $("#health").style.setProperty("--fill", `${(p.health / HEALTH_MAX) * 100}%`);
    const overText = p.overshield > 0 ? `＋${Math.ceil(p.overshield)}` : "";
    $("#vitals-text").textContent = `${Math.ceil(p.shield)}${overText} / ${p.shieldMax}　${Math.ceil(p.health)} / ${HEALTH_MAX}`;

    this.setHtml($("#weapons"), p.weapons
      .map((ws, i) => {
        const res = bagCount(w.bag, ws.def.ammo);
        const cls = i === p.cur ? "weapon active" : "weapon";
        const reload = i === p.cur && p.reloadT > 0 ? `<div class="bar"><div style="width:${(1 - p.reloadT / ws.def.reload) * 100}%"></div></div>` : "";
        return `<div class="${cls}"><span class="key">${i + 1}</span><span class="name">${ws.def.name}</span><span class="ammo"><b>${ws.mag}</b> / ${res}</span>${reload}</div>`;
      })
      .join(""));

    for (const el of [...Array.from($("#items").children), ...Array.from($("#devices").children)] as HTMLElement[]) {
      if (el.classList.contains("dash")) {
        const ready = p.dashCharges > 0;
        const full = p.dashCharges >= p.dashMax;
        el.classList.toggle("empty", !ready);
        const charges = p.dashMax > 1 ? ` ×${p.dashCharges}` : "";
        el.querySelector(".count")!.textContent = ready && (full || p.dashMax > 1) ? `使える${charges}` : `${p.dashCd.toFixed(1)}`;
        (el.querySelector(".cd") as HTMLElement).style.width = `${full ? 100 : (1 - p.dashCd / (DASH.cooldown * p.dashCdMul)) * 100}%`;
        continue;
      }
      const dev = el.dataset.device as DeviceKind | undefined;
      if (dev) {
        const placed = w.devices.filter((d) => d.kind === dev).length;
        el.classList.toggle("empty", w.carried[dev] <= 0 || placed >= DEVICES[dev].max);
        el.querySelector(".count")!.textContent = `${w.carried[dev]}　置 ${placed}/${DEVICES[dev].max}`;
        continue;
      }
      const n = bagCount(w.bag, el.dataset.item as ItemId) + (el.classList.contains("revive") ? w.carriedRevive : 0);
      el.classList.toggle("empty", n <= 0);
      el.classList.toggle("active", !!el.dataset.kind && p.heal?.kind === el.dataset.kind);
      el.querySelector(".count")!.textContent = `${n}`;
    }
    for (const el of Array.from($("#kit").children) as HTMLElement[]) this.updateKitTile(el, w);
    $("#bag").textContent = `カバン ${bagUsed(w.bag)}/${w.bag.slots.length}　${yen(w.bag.money)}　[Tab] 持ち物　[M] 地図`;

    const heal = $("#heal");
    if (p.heal) {
      heal.style.display = "block";
      const def = HEALS[p.heal.kind];
      const label = def.shieldPerItem > 0 ? `${def.name}（${p.heal.items}個）` : def.name;
      heal.querySelector(".label")!.textContent = `${label}　${p.heal.t.toFixed(1)}秒　[X]/クリックでキャンセル`;
      (heal.querySelector(".fill") as HTMLElement).style.width = `${(1 - p.heal.t / p.heal.total) * 100}%`;
    } else {
      heal.style.display = "none";
    }

    this.updatePartners(w);

    const prompt = $("#prompt");
    const loot = p.alive ? nearestLoot(w) : null;
    let promptHtml = "";
    const inExtract = p.alive ? extractAt(w, p.pos) : null;
    const down = p.alive ? downedPartnerNear(w) : null;
    const board = p.alive && !p.ride ? nearRail(w, p) : null;
    if (down) {
      const t = down.partner!.reviveT;
      promptHtml = t > 0
        ? `${partnerName(down)}を起こしている… ${(PARTNER_REVIVE.time - t).toFixed(1)}秒`
        : `[E 長押し] ${partnerName(down)}を起こす（${PARTNER_REVIVE.time}秒。撃たれたら押し直し）`;
    } else if (inExtract && inExtract.progress > 0) {
      promptHtml = `脱出中… ${(EXTRACT_TIME - inExtract.progress).toFixed(1)}秒`;
    } else if (!loot && !(inExtract && inExtract.readyAt === null) && deviceNear(w)) {
      promptHtml = `[E] ${DEVICES[deviceNear(w)!.kind].name}を回収する`;
    } else if (inExtract && !loot && inExtract.readyAt === null) {
      promptHtml = `[E] 脱出の迎えを呼ぶ（${EXTRACT_CALL_TIME}秒耐える。周りの勢力が寄ってくる）`;
    } else if (!loot && p.alive && !p.ride && board) {
      promptHtml = board.rail.owner === null
        ? `[E] 固定レールに乗る（${ITEMS.junk.name} ${FIXED_RAIL.fare}個。手持ち ${bagCount(w.bag, "junk")}個）`
        : "[E] レールに乗る";
    } else if (loot && !this.panel.open) {
      if (loot.kind === "ground") {
        const s = loot.items[0];
        promptHtml = `[E] 拾う：${itemIcon(s.item, 18)}<span style="color:${stackColor(s)}">${ITEMS[s.item].name} ${countText(s)}</span>`;
      } else {
        promptHtml = loot.items.length
          ? `[E] ${lootTitle(loot)}を開ける（${loot.items.length}個）`
          : `[E] ${lootTitle(loot)}を開ける（空っぽ）`;
      }
    }
    if (promptHtml !== this.promptHtml) {
      this.promptHtml = promptHtml;
      prompt.innerHTML = promptHtml;
      prompt.style.display = promptHtml ? "flex" : "none";
    }

    this.toastTimer -= dt;
    if (this.toastTimer <= 0) $("#toast").classList.remove("show");

    const ch = $("#crosshair");
    ch.style.transform = `translate(${mouse.x}px, ${mouse.y}px)`;
    // 持ち物の画面を開いていても、画面の外にカーソルがあるうちは照準を出す。撃てないので薄くする
    const overUi = !!document.elementFromPoint(mouse.x, mouse.y)?.closest("#inventory, #bigmap");
    ch.style.display = overUi ? "none" : "block";
    ch.classList.toggle("idle", this.blocksMouse);
    this.hitTimer -= dt;
    ch.classList.toggle("hit", this.hitTimer > 0);

    this.dmgTimer -= dt;
    $("#damage").style.opacity = String(Math.max(0, this.dmgTimer / 0.35) * 0.6 + (p.health < 40 && p.alive ? 0.25 : 0));

    const target = arrowTarget(w);
    const ex = r.worldToScreen(target.pos.x, target.pos.y, 2);
    const arrow = $("#extract-arrow");
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const onScreen = ex.visible && ex.x > 40 && ex.x < window.innerWidth - 40 && ex.y > 40 && ex.y < window.innerHeight - 40;
    let ax = ex.x, ay = ex.y;
    if (!onScreen) {
      const dx = ex.x - cx, dy = ex.y - cy;
      const s = Math.min((cx - 60) / Math.abs(dx || 1), (cy - 60) / Math.abs(dy || 1));
      ax = Math.max(60, Math.min(window.innerWidth - 260, cx + dx * s));
      ay = Math.max(150, Math.min(window.innerHeight - 140, cy + dy * s));
    }
    arrow.style.transform = `translate(${ax}px, ${ay}px)`;
    const meters = Math.round(Math.hypot(target.pos.x - p.pos.x, target.pos.y - p.pos.y));
    const wait = target.ready ? "　来ている" : target.readyAt !== null ? `　あと${Math.ceil(target.readyAt - w.time)}秒` : "";
    arrow.querySelector(".dist")!.textContent = `脱出 ${meters}m${wait}`;

    this.updateDefense(w);

    this.feed = this.feed.filter((f) => w.time - f.t < FEED_LIFE);
    this.setHtml($("#feed"), this.feed.map((f) => `<div>${f.text}</div>`).join(""));

    this.mapView.drawMini($<HTMLCanvasElement>("#minimap"), w, this.pings);
    this.drawEdgeWaves(w, r);
    this.updatePick(w, mouse);
    const big = $("#bigmap");
    big.style.display = this.bigMap ? "flex" : "none";
    if (this.bigMap) {
      const c = $<HTMLCanvasElement>("#bigmap canvas");
      const W = Math.floor(window.innerWidth * 0.86), H = Math.floor(window.innerHeight * 0.86);
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
      this.mapView.drawFull(c, w, this.pings, this.pick);
    }

    this.updatePanel(w);
    this.updateTags(w, r);
    this.updateDmgStacks(w, r);
    this.updateAreaBanner(w, dt);
  }

  /** 長距離移動の行き先を選んでいる間は、全体マップを開いたままにする */
  private updatePick(w: World, mouse: { x: number; y: number }) {
    const picking = w.player.alive && w.player.evac?.state === "pick";
    $("#bigmap").classList.toggle("picking", picking);
    if (!picking) {
      if (this.pickOpened) this.bigMap = false;
      this.pickOpened = false;
      this.pick = null;
      return;
    }
    if (!this.pickOpened) this.closePanel();
    this.pickOpened = true;
    this.bigMap = true;
    const c = $<HTMLCanvasElement>("#bigmap canvas");
    const rect = c.getBoundingClientRect();
    const inside = mouse.x >= rect.left && mouse.x <= rect.right && mouse.y >= rect.top && mouse.y <= rect.bottom;
    const hover = inside && rect.width > 0
      ? this.mapView.fullToMap((mouse.x - rect.left) * (c.width / rect.width), (mouse.y - rect.top) * (c.height / rect.height))
      : null;
    this.pick = { hover, ok: !!hover && !evacBlocker(w, w.player, hover) };
  }

  private updateKitTile(el: HTMLElement, w: World) {
    const b = w.player.bike;
    if (b && el.classList.contains("bike")) {
      const moving = b.state === "mounting" || b.state === "dismounting";
      el.classList.toggle("on", b.state === "on");
      el.querySelector(".count")!.textContent = { off: "乗る", mounting: "乗っている…", on: "乗っている", dismounting: "降りている…" }[b.state];
      (el.querySelector(".cd") as HTMLElement).style.width = `${moving ? (1 - b.t / (b.state === "mounting" ? b.mount : BIKE_DISMOUNT)) * 100 : 100}%`;
      return;
    }
    const k = w.player.kit;
    if (!k || el.classList.contains("passive")) return;
    const ult = el.classList.contains("ult");
    const cd = ult ? k.ultCd : k.skillCd;
    const active = ult ? k.ultT : k.skillT;
    const max = ult ? ULTS[k.ult].cooldown : SKILLS[k.skill].cooldown * w.player.skillCdMul;
    el.classList.toggle("on", active > 0);
    el.classList.toggle("empty", cd > 0 && active <= 0);
    el.querySelector(".count")!.textContent = active > 0 ? `残り${active.toFixed(1)}` : cd > 0 ? `${Math.ceil(cd)}` : "使える";
    (el.querySelector(".cd") as HTMLElement).style.width = `${(1 - cd / max) * 100}%`;
  }

  private updatePanel(w: World) {
    const inv = $("#inventory");
    let loot: Loot | undefined;
    if (this.panel.lootId !== null) {
      loot = w.loot.find((l) => l.id === this.panel.lootId);
      const far = !loot || Math.hypot(loot.pos.x - w.player.pos.x, loot.pos.y - w.player.pos.y) > LOOT_PANEL_RANGE;
      if (far) {
        if (this.panel.byTab) this.panel.lootId = null;
        else this.closePanel();
        loot = undefined;
      }
    }
    if (!this.panel.open || !w.player.alive) {
      inv.style.display = "none";
      this.panelSig = "";
      return;
    }
    inv.style.display = "flex";
    const near = w.actors.filter((a) => a.team === "partner" && Math.hypot(a.pos.x - w.player.pos.x, a.pos.y - w.player.pos.y) <= GIVE_RANGE);
    const sig = JSON.stringify([
      w.bag, w.secure, loot?.items, loot?.id, w.player.weapons.map((x) => x.mag),
      buffsOf(w.player), w.spareBuffs, near.map((a) => [a.id, buffsOf(a)]),
    ]);
    if (sig === this.panelSig) return;
    this.panelSig = sig;

    const p = w.player;
    let lootHtml = "";
    if (loot) {
      // data-take は sim 側の並びの添字なので、並べ替える前の添字を持ち回る
      const rows = loot.items
        .map((s, i) => ({ s, i }))
        .sort((a, b) => ITEM_ORDER.indexOf(a.s.item) - ITEM_ORDER.indexOf(b.s.item) || a.i - b.i)
        .map(({ s, i }) => `<button class="row" data-take="${i}" style="--c:${stackColor(s)}"><span class="ic">${itemIcon(s.item, 22)}</span><span class="nm">${ITEMS[s.item].name}</span><span class="ct">${countText(s)}</span></button>`)
        .join("");
      lootHtml = `<section class="loot"><h2>${lootTitle(loot)}</h2>${rows || `<p class="hint">空っぽ</p>`}
        ${loot.items.length ? `<button class="takeall" data-takeall>全部取る [E]</button>` : ""}</section>`;
    }
    const slots = w.bag.slots
      .map((s, i) => s
        ? `<div class="slot" data-slot="${i}" style="--c:${stackColor(s)}" title="${ITEMS[s.item].name}（${w.secure.slots.length && SECURABLE.includes(ITEMS[s.item].category) ? "クリックで持ち帰れる枠へ・" : ""}右クリックで捨てる）"><span class="ic">${itemIcon(s.item, 26)}</span><span class="nm">${ITEMS[s.item].short}</span><span class="ct">${s.count}<small>/${ITEMS[s.item].stack}</small></span></div>`
        : `<div class="slot empty"></div>`)
      .join("");
    const weapons = p.weapons
      .map((ws) => `<div class="wrow"><span>${ws.def.name}</span><span>${ws.mag} / ${ws.def.mag}　予備 ${bagCount(w.bag, ws.def.ammo)}</span></div>`)
      .join("");
    $("#inventory").innerHTML = `${lootHtml}
      <section class="bagview">
        <h2>持ち物 <small>${bagUsed(w.bag)}/${w.bag.slots.length}枠　${yen(w.bag.money)}</small></h2>
        <div class="weapons">${weapons}</div>
        <div class="grid">${slots}</div>
        ${this.secureHtml(w)}
        ${this.buffsHtml(w, near)}
        <p class="hint">クリックで取る・右クリックで捨てる・Tab / Esc で閉じる</p>
      </section>`;
  }

  /** 死んでも持ち帰れる枠。特殊カバンを持ち込んだときだけ出す */
  private secureHtml(w: World) {
    this.hasSecure = w.secure.slots.length > 0;
    if (!this.hasSecure) return "";
    const slots = w.secure.slots
      .map((s, i) => s
        ? `<div class="slot" data-secure="${i}" style="--c:${stackColor(s)}" title="${ITEMS[s.item].name}（クリックでカバンへ戻す）"><span class="ic">${itemIcon(s.item, 26)}</span><span class="nm">${ITEMS[s.item].short}</span><span class="ct">${s.count}<small>/${ITEMS[s.item].stack}</small></span></div>`
        : `<div class="slot empty"></div>`)
      .join("");
    return `<h3>死んでも持ち帰れる枠 <small>素材と蘇生アイテム。カバンの物をクリックで入れる</small></h3><div class="grid secure">${slots}</div>`;
  }

  /** 効いている強化パーツと、予備の受け渡し。予備はパートナーの近くにいるときだけ渡せる */
  private buffsHtml(w: World, near: Actor[]) {
    const mine = buffsOf(w.player);
    let html = `<h3>強化パーツ <small>このランの間だけ効く</small></h3>`;
    html += `<div class="buffs">${mine.length ? mine.map(buffChip).join("") : `<span class="hint">まだない</span>`}</div>`;
    const partners = w.actors.filter((a) => a.team === "partner");
    if (w.spareBuffs.length) {
      const rows = [...new Set(w.spareBuffs)].map((id) => {
        const n = w.spareBuffs.filter((x) => x === id).length;
        const buttons = partners.map((a) => {
          const ok = near.includes(a) && canGiveBuff(a, id);
          return `<button class="give" data-give="${id}" data-partner="${a.id}"${ok ? "" : " disabled"}>${a.partner!.index + 1}に渡す</button>`;
        }).join("");
        return `<div class="spare">${buffChip(id)}${n > 1 ? `<span class="ct">×${n}</span>` : ""}<span class="gives">${buttons}</span></div>`;
      }).join("");
      html += `<h3>予備 <small>${near.length ? "近くのパートナーに渡せる" : `パートナーの ${GIVE_RANGE}m 以内で渡せる`}</small></h3>${rows}`;
    }
    for (const a of near) {
      const list = buffsOf(a);
      html += `<div class="pbuffs"><span class="pn">${partnerName(a)}</span>${list.length ? list.map(buffChip).join("") : `<span class="hint">なし</span>`}</div>`;
    }
    return html;
  }

  /** 左下のパートナーのシールドとヘルス */
  private updatePartners(w: World) {
    const el = $("#partners");
    const partners = w.actors.filter((a) => a.team === "partner");
    el.style.display = partners.length ? "flex" : "none";
    while (el.children.length < partners.length) {
      const row = document.createElement("div");
      row.className = "prow";
      row.innerHTML = `<span class="pn"></span><div class="pbars"><div class="tbar shield"><div></div></div><div class="tbar health"><div></div></div></div><span class="pst"></span>`;
      el.appendChild(row);
    }
    while (el.children.length > partners.length) el.lastElementChild!.remove();
    partners.forEach((a, i) => {
      const row = el.children[i] as HTMLElement;
      row.classList.toggle("down", !a.alive);
      row.querySelector(".pn")!.textContent = `${a.partner!.index + 1}`;
      const bars = row.querySelectorAll<HTMLElement>(".tbar div");
      bars[0].style.width = `${(a.shield / a.shieldMax) * 100}%`;
      bars[1].style.width = `${(a.health / HEALTH_MAX) * 100}%`;
      const st = !a.alive ? "倒れている" : a.heal ? "回復中" : a.reloadT > 0 ? "リロード" : a.ai?.state === "return" ? "戻っている" : "";
      row.querySelector(".pst")!.textContent = st;
    });
  }

  private updateTags(w: World, r: Renderer) {
    const layer = $("#tags");
    let n = 0;
    for (const a of w.actors) {
      if (a.team !== "enemy" || !a.alive) continue;
      const showBars = a.info >= 3;
      const showState = a.seen || a.info >= 2;
      if (!showBars && !(showState && (a.heal || a.reloadT > 0))) continue;
      const s = r.worldToScreen(a.pos.x, a.pos.y, 2.4);
      if (!s.visible) continue;
      const tag = this.tags[n] ?? this.makeTag(layer);
      n++;
      tag.style.display = "block";
      tag.style.transform = `translate(${s.x}px, ${s.y}px)`;
      const state = a.heal ? (HEALS[a.heal.kind].shieldPerItem > 0 ? "シールド回復中" : "ヘルス回復中") : a.reloadT > 0 ? "リロード中" : "";
      const st = tag.querySelector(".state") as HTMLElement;
      st.textContent = showState ? state : "";
      st.className = `state ${a.heal ? "heal" : "reload"}`;
      const bars = tag.querySelectorAll<HTMLElement>(".tbar");
      bars.forEach((b) => (b.style.display = showBars ? "block" : "none"));
      (bars[0].firstElementChild as HTMLElement).style.width = `${(a.shield / a.shieldMax) * 100}%`;
      (bars[1].firstElementChild as HTMLElement).style.width = `${(a.health / HEALTH_MAX) * 100}%`;
      (tag.querySelector(".fac") as HTMLElement).textContent = a.seen ? factionDef(a.faction).name : "";
    }
    for (let i = n; i < this.tags.length; i++) this.tags[i].style.display = "none";

    // パートナーの頭の上に番号を出す。倒れていたら起こしている進み具合も出す
    let m = 0;
    for (const a of w.actors) {
      if (a.team !== "partner") continue;
      const s = r.worldToScreen(a.pos.x, a.pos.y, a.alive ? 2.4 : 1.2);
      if (!s.visible) continue;
      let tag = this.partnerTags[m];
      if (!tag) {
        tag = document.createElement("div");
        tag.className = "ptag";
        tag.innerHTML = `<div class="pn"></div><div class="pst"></div><div class="tbar revive"><div></div></div>`;
        layer.appendChild(tag);
        this.partnerTags.push(tag);
      }
      m++;
      tag.style.display = "block";
      tag.style.transform = `translate(${s.x}px, ${s.y}px)`;
      tag.querySelector(".pn")!.textContent = `${a.partner!.index + 1}`;
      tag.querySelector(".pst")!.textContent = a.alive ? "" : "倒れている";
      const rv = tag.querySelector<HTMLElement>(".tbar.revive")!;
      rv.style.display = !a.alive && a.partner!.reviveT > 0 ? "block" : "none";
      (rv.firstElementChild as HTMLElement).style.width = `${(a.partner!.reviveT / PARTNER_REVIVE.time) * 100}%`;
    }
    for (let i = m; i < this.partnerTags.length; i++) this.partnerTags[i].style.display = "none";
  }

  private makeTag(layer: HTMLElement) {
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.innerHTML = `<div class="state"></div><div class="fac"></div><div class="tbar shield"><div></div></div><div class="tbar health"><div></div></div>`;
    layer.appendChild(tag);
    this.tags.push(tag);
    return tag;
  }

  /** 画面に映っていない所の銃声を、その方向の画面の端に波で出す。近いほど濃く大きい */
  private drawEdgeWaves(w: World, r: Renderer) {
    const c = $<HTMLCanvasElement>("#edge-sound");
    const W = window.innerWidth, H = window.innerHeight;
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    for (const pg of this.pings) {
      const age = w.time - pg.t;
      if (age < 0 || age > EDGE_WAVE_LIFE) continue;
      const s = r.worldToScreen(pg.pos.x, pg.pos.y, 1);
      if (s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H) continue;
      const dx = s.x - cx, dy = s.y - cy;
      const t = Math.min(cx / Math.abs(dx || 1e-6), cy / Math.abs(dy || 1e-6));
      const ex = cx + dx * t, ey = cy + dy * t;
      const fade = 1 - age / EDGE_WAVE_LIFE;
      const a = (0.2 + 0.8 * pg.k) * fade;
      const rgb = pg.ours ? "90, 170, 255" : "255, 80, 55";
      const glow = 50 + 130 * pg.k;
      const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, glow);
      g.addColorStop(0, `rgba(${rgb}, ${a * 0.55})`);
      g.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ex, ey, glow, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2 + 4 * pg.k;
      for (let i = 0; i < 3; i++) {
        const rr = (age / EDGE_WAVE_LIFE) * (70 + 150 * pg.k) - i * 22;
        if (rr <= 0) continue;
        ctx.strokeStyle = `rgba(${rgb}, ${a * (1 - i * 0.3)})`;
        ctx.beginPath();
        ctx.arc(ex, ey, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  /** 迎えを待つ間の残り時間と、送った割合。バーは送れる上限（secureShare）を端にする */
  private updateDefense(w: World) {
    const el = $("#defense");
    const d = w.defense;
    const p = w.player;
    if (!d || !p.alive || w.outcome !== "playing") {
      el.style.display = "none";
      return;
    }
    const ex = d.extract;
    const inside = Math.hypot(p.pos.x - ex.pos.x, p.pos.y - ex.pos.y) <= EXTRACT_RADIUS;
    const sent = Math.round(d.share * 100);
    const max = Math.round(EXTRACT_DEFENSE.secureShare * 100);
    let line: string;
    if (ex.ready) line = `迎えが来た。円の中に${EXTRACT_TIME}秒いれば残りも持ち帰れる（送った分 ${sent}%）`;
    else if (inside) line = `迎えまで ${Math.ceil(ex.readyAt! - w.time)}秒　持ち物を送っている ${sent}% / ${max}%`;
    else line = `迎えまで ${Math.ceil(ex.readyAt! - w.time)}秒　円の外にいるので送るのが止まっている ${sent}% / ${max}%`;
    el.style.display = "block";
    el.classList.toggle("out", !inside && !ex.ready);
    el.querySelector(".line")!.textContent = line;
    (el.querySelector(".fill") as HTMLElement).style.width = `${(d.share / EXTRACT_DEFENSE.secureShare) * 100}%`;
  }
}

/** 矢印で指す脱出地点。呼んでいる所があればそこ、無ければ一番近い所 */
function arrowTarget(w: World): Extract {
  const called = w.extracts.find((e) => e.readyAt !== null);
  if (called) return called;
  const p = w.player.pos;
  let best = w.extracts[0];
  for (const e of w.extracts) {
    if (Math.hypot(e.pos.x - p.x, e.pos.y - p.y) < Math.hypot(best.pos.x - p.x, best.pos.y - p.y)) best = e;
  }
  return best;
}
