import {
  EXTRACT_TIME, HEALS, HEALTH_MAX, ITEMS, ITEM_ORDER, LOOT_PANEL_RANGE, PLAYER_FACTION, RARITY_COLORS, SHIELD_PER_CELL,
  DASH, THROWABLES, factionDef, type HealKind, type ItemId, type ThrowableId,
} from "./sim/data";
import { bagCount, bagUsed, type Stack } from "./sim/inventory";
import { nearestLoot, type Command } from "./sim/sim";
import type { GameEvent, Loot, World } from "./sim/world";
import type { Renderer } from "./render/renderer";
import { MapView, type Ping } from "./mapview";
import { itemIcon } from "./ui/icons";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const HEAL_ORDER: [HealKind, string][] = [
  ["cell", "3"],
  ["cellBatch", "4"],
  ["medSmall", "5"],
  ["medLarge", "6"],
];

const THROW_ORDER: [ThrowableId, string][] = [
  ["frag", "G"],
  ["thermite", "T"],
];

const LEVEL_NAMES = ["なし", "影", "影＋型", "影＋型＋体力"];
const PING_RANGE = 160;
const FEED_LIFE = 6;

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

function lootTitle(l: Loot) {
  return l.kind === "deathbox" ? "倒した相手の持ち物" : l.kind === "bin" ? "物資箱" : "落ちている物";
}

export class Hud {
  private tags: HTMLDivElement[] = [];
  private toastTimer = 0;
  private hitTimer = 0;
  private dmgTimer = 0;
  private pings: Ping[] = [];
  private lastPing = new Map<number, number>();
  private feed: { text: string; t: number }[] = [];
  private mapView: MapView;
  private panelSig = "";
  private promptHtml = "";
  /** インベントリ画面。lootId があれば箱の中身も並べる */
  panel = { open: false, lootId: null as number | null, byTab: false };
  bigMap = false;
  onCommand: (c: Command) => void = () => {};

  constructor(world: World) {
    this.mapView = new MapView(world.map);
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
    const dash = document.createElement("div");
    dash.className = "item dash";
    dash.innerHTML = `<span class="key">Ctrl</span><span class="name">ダッシュ</span><span class="count"></span><div class="cd"></div>`;
    items.appendChild(dash);
    const inv = $("#inventory");
    inv.addEventListener("mousedown", (e) => e.stopPropagation());
    inv.addEventListener("contextmenu", (e) => e.preventDefault());
    inv.addEventListener("click", (e) => {
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
    $("#bigmap").addEventListener("mousedown", (e) => {
      e.stopPropagation();
      this.bigMap = false;
    });
  }

  reset(world: World) {
    this.mapView = new MapView(world.map);
    this.pings = [];
    this.lastPing.clear();
    this.feed = [];
    this.closePanel();
    this.bigMap = false;
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
        case "lootOpened":
          this.panel = { open: true, lootId: ev.loot, byTab: false };
          break;
        case "hit":
          if (ev.by === p.id) {
            this.hitTimer = 0.15;
            $("#crosshair").classList.toggle("shield", ev.shield);
          }
          if (ev.actor === p.id) this.dmgTimer = 0.35;
          break;
        case "shieldBreak": {
          const t = byId.get(ev.actor);
          if (t && t !== p && (t.seen || t.info >= 2)) this.toast("シールド破壊");
          break;
        }
        case "shot": {
          if (ev.faction === PLAYER_FACTION) break;
          const d = Math.hypot(ev.pos.x - p.pos.x, ev.pos.y - p.pos.y);
          const last = this.lastPing.get(ev.actor) ?? -10;
          if (d < PING_RANGE && w.time - last > 0.7) {
            this.lastPing.set(ev.actor, w.time);
            this.pings.push({ pos: { ...ev.pos }, t: w.time });
          }
          break;
        }
        case "death": {
          const victim = byId.get(ev.actor);
          const killer = byId.get(ev.by);
          if (!victim || victim === p) break;
          const near = Math.hypot(ev.pos.x - p.pos.x, ev.pos.y - p.pos.y) < 80;
          if (killer === p) this.feedPush(`${factionDef(victim.faction).name}を倒した`, w);
          else if (near || victim.seen) this.feedPush(`${killer ? factionDef(killer.faction).name : "?"} が ${factionDef(victim.faction).name} を倒した`, w);
          break;
        }
      }
    }
    this.pings = this.pings.filter((pg) => w.time - pg.t < 3);
  }

  private feedPush(text: string, w: World) {
    this.feed.push({ text, t: w.time });
    if (this.feed.length > 5) this.feed.shift();
  }

  update(w: World, r: Renderer, mouse: { x: number; y: number }, dt: number) {
    const p = w.player;
    const alive = w.actors.filter((a) => a.team === "enemy" && a.alive).length;
    $("#info").innerHTML =
      `<div class="map">${w.map.name}</div>` +
      `<div>${fmtTime(w.time)}　撃破 ${w.kills}　残り ${alive}</div>` +
      `<div class="debug">視線 [N]: ${LEVEL_NAMES[w.debug.sightLevel]}<br>ビーコン [B]: ${LEVEL_NAMES[w.debug.beaconLevel]}</div>`;

    const shieldEl = $("#shield");
    const cellCount = Math.ceil(p.shieldMax / SHIELD_PER_CELL);
    while (shieldEl.children.length < cellCount) shieldEl.appendChild(document.createElement("div"));
    while (shieldEl.children.length > cellCount) shieldEl.lastElementChild!.remove();
    shieldEl.style.gridTemplateColumns = `repeat(${cellCount}, 1fr)`;
    for (let i = 0; i < cellCount; i++) {
      const v = Math.max(0, Math.min(1, (p.shield - i * SHIELD_PER_CELL) / SHIELD_PER_CELL));
      (shieldEl.children[i] as HTMLElement).style.setProperty("--fill", `${v * 100}%`);
    }
    $("#health").style.setProperty("--fill", `${(p.health / HEALTH_MAX) * 100}%`);
    $("#vitals-text").textContent = `${Math.ceil(p.shield)} / ${p.shieldMax}　${Math.ceil(p.health)} / ${HEALTH_MAX}`;

    $("#weapons").innerHTML = p.weapons
      .map((ws, i) => {
        const res = bagCount(w.bag, ws.def.ammo);
        const cls = i === p.cur ? "weapon active" : "weapon";
        const reload = i === p.cur && p.reloadT > 0 ? `<div class="bar"><div style="width:${(1 - p.reloadT / ws.def.reload) * 100}%"></div></div>` : "";
        return `<div class="${cls}"><span class="key">${i + 1}</span><span class="name">${ws.def.name}</span><span class="ammo"><b>${ws.mag}</b> / ${res}</span>${reload}</div>`;
      })
      .join("");

    for (const el of Array.from($("#items").children) as HTMLElement[]) {
      if (el.classList.contains("dash")) {
        const ready = p.dashCd <= 0;
        el.classList.toggle("empty", !ready);
        el.querySelector(".count")!.textContent = ready ? "使える" : `${p.dashCd.toFixed(1)}`;
        (el.querySelector(".cd") as HTMLElement).style.width = `${(1 - p.dashCd / DASH.cooldown) * 100}%`;
        continue;
      }
      const n = bagCount(w.bag, el.dataset.item as ItemId);
      el.classList.toggle("empty", n <= 0);
      el.classList.toggle("active", !!el.dataset.kind && p.heal?.kind === el.dataset.kind);
      el.querySelector(".count")!.textContent = `${n}`;
    }
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

    const prompt = $("#prompt");
    const loot = p.alive ? nearestLoot(w) : null;
    let promptHtml = "";
    if (w.extract.progress > 0) {
      promptHtml = `脱出中… ${(EXTRACT_TIME - w.extract.progress).toFixed(1)}秒`;
    } else if (loot && !this.panel.open) {
      if (loot.kind === "ground") {
        const s = loot.items[0];
        promptHtml = `[F] 拾う：${itemIcon(s.item, 18)}<span style="color:${stackColor(s)}">${ITEMS[s.item].name} ${countText(s)}</span>`;
      } else {
        promptHtml = loot.items.length
          ? `[F] ${lootTitle(loot)}を開ける（${loot.items.length}個）`
          : `[F] ${lootTitle(loot)}を開ける（空っぽ）`;
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
    ch.style.display = this.blocksMouse ? "none" : "block";
    this.hitTimer -= dt;
    ch.classList.toggle("hit", this.hitTimer > 0);

    this.dmgTimer -= dt;
    $("#damage").style.opacity = String(Math.max(0, this.dmgTimer / 0.35) * 0.6 + (p.health < 40 && p.alive ? 0.25 : 0));

    const ex = r.worldToScreen(w.extract.pos.x, w.extract.pos.y, 2);
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
    arrow.querySelector(".dist")!.textContent = `脱出 ${Math.round(Math.hypot(w.extract.pos.x - p.pos.x, w.extract.pos.y - p.pos.y))}m`;

    this.feed = this.feed.filter((f) => w.time - f.t < FEED_LIFE);
    $("#feed").innerHTML = this.feed.map((f) => `<div>${f.text}</div>`).join("");

    this.mapView.drawMini($<HTMLCanvasElement>("#minimap"), w, this.pings);
    const big = $("#bigmap");
    big.style.display = this.bigMap ? "flex" : "none";
    if (this.bigMap) {
      const c = $<HTMLCanvasElement>("#bigmap canvas");
      const W = Math.floor(window.innerWidth * 0.86), H = Math.floor(window.innerHeight * 0.86);
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
      this.mapView.drawFull(c, w, this.pings);
    }

    this.updatePanel(w);
    this.updateTags(w, r);
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
    const sig = JSON.stringify([w.bag, loot?.items, loot?.id, w.player.weapons.map((x) => x.mag)]);
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
        ${loot.items.length ? `<button class="takeall" data-takeall>全部取る [F]</button>` : ""}</section>`;
    }
    const slots = w.bag.slots
      .map((s, i) => s
        ? `<div class="slot" data-slot="${i}" style="--c:${stackColor(s)}" title="${ITEMS[s.item].name}（右クリックで捨てる）"><span class="ic">${itemIcon(s.item, 26)}</span><span class="nm">${ITEMS[s.item].short}</span><span class="ct">${s.count}<small>/${ITEMS[s.item].stack}</small></span></div>`
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
        <p class="hint">クリックで取る・右クリックで捨てる・Tab / Esc で閉じる</p>
      </section>`;
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
  }

  private makeTag(layer: HTMLElement) {
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.innerHTML = `<div class="state"></div><div class="fac"></div><div class="tbar shield"><div></div></div><div class="tbar health"><div></div></div>`;
    layer.appendChild(tag);
    this.tags.push(tag);
    return tag;
  }
}

