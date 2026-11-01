import "./style.css";
import "./layout.css";
import { Sfx } from "./audio";
import { Hud } from "./hud";
import { InputState } from "./input";
import { Renderer } from "./render/renderer";
import { DT, MATERIALS, type MaterialId } from "./sim/data";
import { bagCount, type Bag } from "./sim/inventory";
import { GameMap } from "./sim/map";
import { ChunkLoader, fetchIndex } from "./maploader";
import { ChunkStreamer } from "./stream";
import { nearestLoot, step } from "./sim/sim";
import { LOOT_PANEL_RANGE } from "./sim/data";
import { createWorld, type Sent, type World } from "./sim/world";
import { applyRunResult, campOn, defaultProfile, makeRunLoadout, mergeHaul, type Haul, type Profile } from "./meta/profile";
import { MapView } from "./mapview";
import { extractAt } from "./sim/sim";
import { exportProfile, importProfile, loadProfile, saveProfile } from "./meta/save";
import { renderHub } from "./ui/hub";
import type { LastRunSummary } from "./ui/hub/types";

type Mode = "hub" | "playing" | "paused" | "ending";

async function main() {
  const map = new GameMap(await fetchIndex("akihabara"));
  const streamer = new ChunkStreamer(map, new ChunkLoader(map.index.id).load);
  const app = document.getElementById("app")!;
  const hubEl = document.getElementById("hub")!;
  const overlay = document.getElementById("overlay")!;
  const renderer = new Renderer(app, map);
  const input = new InputState(app);
  const sfx = new Sfx();
  const mapView = new MapView(map);

  let profile: Profile = (await loadProfile()) ?? defaultProfile();
  let lastResult: LastRunSummary | null = null;
  const startOf = () => campOn(profile, map.index.id) ?? { x: map.index.layout.start[0], y: map.index.layout.start[1] };
  await streamer.loadAround(startOf());
  let world: World = createWorld(map, 1, makeRunLoadout(profile, map.index.id));
  const hud = new Hud(world, mapView);
  hud.onCommand = (c) => input.command(c);
  let mode: Mode = "hub";
  let acc = 0;
  let last = performance.now();

  const persist = () => {
    void saveProfile(profile);
  };

  const showOverlay = (html: string | null) => {
    overlay.style.display = html ? "flex" : "none";
    if (html) overlay.querySelector(".panel")!.innerHTML = html;
  };

  const controls = `
    <table class="controls">
      <tr><td>WASD / Shift</td><td>移動 / 走る（撃つとやめる）</td></tr>
      <tr><td>スペース</td><td>短距離ダッシュ（5秒に1回。回復は止まる）</td></tr>
      <tr><td>Q / F</td><td>スキル / アルティメット（遮蔽物とレールはカーソルの位置・向きに出す）</td></tr>
      <tr><td>G / T</td><td>押している間に落ちる場所を確かめて、離すと投げる（グレネード / テルミット）</td></tr>
      <tr><td>マウス / 左クリック</td><td>カーソルの方向へ撃つ</td></tr>
      <tr><td>R</td><td>リロード</td></tr>
      <tr><td>1 / 2・ホイール</td><td>武器の持ち替え</td></tr>
      <tr><td>3 / 4</td><td>シールド1個（2秒）／まとめて最大4個（5秒）</td></tr>
      <tr><td>5 / 6</td><td>ヘルス小（3.5秒）／ヘルス大（8秒）</td></tr>
      <tr><td>7</td><td>アルティメット加速（2秒。アルティメットのクールダウンが40秒縮む）</td></tr>
      <tr><td>8</td><td>長距離移動（3秒。撃たれたら止まる。使い終えたら全体マップで500m以内の行き先をクリックして飛ぶ。飛んでいる間は撃てないが撃たれる）</td></tr>
      <tr><td>（自動）</td><td>蘇生アイテム：死んだらその場でヘルス50で立ち上がる。拾った分を、持ち込んだ分より先に使う</td></tr>
      <tr><td>X・左クリック</td><td>回復をキャンセル（まとめて回復は何も回復しない）</td></tr>
      <tr><td>C</td><td>自転車に乗る・降りる（持ち込んだときだけ。乗っている間は撃てず、左クリックか撃たれると降りる）</td></tr>
      <tr><td>E</td><td>拾う・箱を開ける・開いた箱から全部取る（空になったら次の箱を開ける）・脱出地点で迎えを呼ぶ・置いた物を回収する・レールに乗る（固定レールは端から。乗るたびに金属くず1個）</td></tr>
      <tr><td>Z / V</td><td>センサー / タレットを足元に置く（拠点で作った物。置いた物は次のランでも残る）</td></tr>
      <tr><td>（道の上）</td><td>黄色い板（ダッシュパッド）を、板の向きに沿って歩いて踏むと 30m 飛ぶ。飛んでいる間も撃てる</td></tr>
      <tr><td>E 長押し</td><td>倒れたパートナーを起こす（4秒。撃たれたら押し直し）</td></tr>
      <tr><td>Tab</td><td>持ち物（右クリックで捨てる）</td></tr>
      <tr><td>M</td><td>地図</td></tr>
      <tr><td>Esc / P</td><td>閉じる / ポーズ</td></tr>
      <tr><td>N / B</td><td>試作用：視線とビーコンで見える情報の段階を切り替え</td></tr>
    </table>`;

  const drawHub = () => {
    renderHub(hubEl, {
      profile,
      lastResult,
      map,
      mapView,
      onChange: (next) => {
        profile = next;
        persist();
        drawHub();
      },
      onDeploy: deploy,
      onDismissResult: () => {
        lastResult = null;
        drawHub();
      },
      onExport: () => {
        const blob = new Blob([exportProfile(profile)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `jp-extraction-shooter-save-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      },
      onImport: (text) => {
        try {
          profile = importProfile(text);
        } catch (e) {
          return e instanceof Error ? e.message : "読み込めなかった";
        }
        persist();
        drawHub();
        return null;
      },
      onReset: () => {
        profile = defaultProfile();
        lastResult = null;
        persist();
        drawHub();
      },
    });
  };

  const showHub = () => {
    mode = "hub";
    input.enabled = false;
    input.clearHeld();
    hud.closePanel();
    hud.bigMap = false;
    showOverlay(null);
    document.body.classList.add("in-hub");
    hubEl.style.display = "block";
    drawHub();
  };

  const resume = () => {
    sfx.unlock();
    input.enabled = true;
    input.clearHeld();
    mode = "playing";
    last = performance.now();
    acc = 0;
    showOverlay(null);
  };

  let deploying = false;
  async function deploy() {
    if (deploying) return;
    deploying = true;
    await streamer.loadAround(startOf());
    deploying = false;
    world = createWorld(map, (Math.random() * 2 ** 31) | 0, makeRunLoadout(profile, map.index.id), campOn(profile, map.index.id) ?? undefined);
    renderer.reset();
    hud.reset(world);
    hubEl.style.display = "none";
    document.body.classList.remove("in-hub");
    resume();
  }

  const pause = () => {
    if (mode !== "playing") return;
    mode = "paused";
    input.clearHeld();
    showOverlay(`<h1>ポーズ</h1>${controls}<p class="hint">Esc / P / クリックで再開</p>
      <button class="retire" data-retire>リタイアして拠点に戻る（死んだときと同じく、拾った物を失う）</button>`);
  };
  const togglePause = () => {
    if (mode === "playing") pause();
    else if (mode === "paused") resume();
  };

  const sentHaul = (s: Sent): Haul => {
    const materials: Partial<Record<MaterialId, number>> = {};
    for (const m of MATERIALS) if (s.items[m]) materials[m] = s.items[m];
    return { money: s.money, materials, revive: s.items.revive ?? 0 };
  };
  const finishRun = () => {
    const outcome = world.outcome === "extracted" ? "extracted" : "dead";
    const haul = (bag: Bag): Haul => {
      const materials: Partial<Record<MaterialId, number>> = {};
      for (const m of MATERIALS) {
        const n = bagCount(bag, m);
        if (n > 0) materials[m] = n;
      }
      return { money: bag.money, materials, revive: bagCount(bag, "revive") };
    };
    const { gained, lost } = applyRunResult(profile, {
      outcome, kills: world.kills, bag: haul(world.bag), secure: mergeHaul(haul(world.secure), sentHaul(world.sent)), usedCarriedRevive: world.usedCarriedRevive,
      devices: {
        map: map.index.id,
        carried: { ...world.carried },
        placed: world.devices.map((d) => ({ kind: d.kind, x: d.pos.x, y: d.pos.y })),
      },
    });
    const ex = outcome === "extracted" ? extractAt(world, world.player.pos) : null;
    lastResult = { outcome, time: world.time, kills: world.kills, gained, lost, extractAt: ex ? { ...ex.pos } : null };
    persist();
    showHub();
  };

  input.onEscape = () => {
    if (mode === "playing" && world.player.evac?.state === "pick") {
      input.command({ type: "evacCancel" });
      return;
    }
    if (mode === "playing" && (hud.panel.open || hud.bigMap)) {
      hud.closePanel();
      hud.bigMap = false;
      return;
    }
    togglePause();
  };
  input.onPauseKey = togglePause;
  input.onInventory = () => {
    if (mode === "playing") hud.toggleInventory();
  };
  // 持ち物の画面は、画面の外をクリックしたら閉じる
  input.onClick = () => {
    if (mode !== "playing" || !hud.panel.open) return false;
    hud.closePanel();
    return true;
  };
  input.onMap = () => {
    if (mode === "playing") hud.bigMap = !hud.bigMap;
  };
  input.onInteract = () => {
    if (mode !== "playing" || !hud.panel.open || hud.panel.lootId === null) return false;
    const cur = world.loot.find((l) => l.id === hud.panel.lootId);
    const near = nearestLoot(world);
    const p = world.player.pos;
    const d = (v: { x: number; y: number }) => Math.hypot(v.x - p.x, v.y - p.y);
    // 開いている箱に中身が残っていて、それが一番近ければ全部取る
    if (cur && cur.items.length > 0 && (!near || near.id === cur.id || d(cur.pos) <= d(near.pos))) {
      input.command({ type: "takeAll", loot: cur.id });
      return true;
    }
    // 空になったら、画面が閉じない距離にある次の箱を開ける。離れて近づき直さなくて済むように
    if (!near) {
      const next = nearestLoot(world, LOOT_PANEL_RANGE, true);
      if (next) {
        input.command({ type: "open", loot: next.id });
        return true;
      }
    }
    return false;
  };
  input.onDebug = (k) => {
    if (mode !== "playing") return;
    if (k === "sight") world.debug.sightLevel = (world.debug.sightLevel % 3) + 1;
    else world.debug.beaconLevel = (world.debug.beaconLevel + 1) % 4;
  };
  overlay.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    if (mode !== "paused") return;
    if ((e.target as HTMLElement).closest("[data-retire]")) {
      world.outcome = "dead";
      mode = "ending";
      showOverlay(null);
      finishRun();
    } else {
      resume();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  window.addEventListener("resize", () => renderer.resize());
  // 誤って Ctrl+W などでタブを閉じかけても、ランの途中なら確認を出す
  window.addEventListener("beforeunload", (e) => {
    if (mode === "playing" || mode === "paused") e.preventDefault();
  });

  showHub();
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __game: { get world() { return world; }, get profile() { return profile; }, start: deploy, renderer, hud },
    });
  }

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (mode === "playing") {
      // 長距離移動で飛んでいる間は、行き先の周りも読む
      const ev = world.player.evac;
      streamer.update(world.player.pos, world.player.vel, ev?.state === "fly" ? ev.to : null);
      acc += dt;
      let steps = 0;
      while (acc >= DT && steps < 5) {
        const aim = renderer.screenToWorld(input.mouse.x, input.mouse.y);
        step(world, input.take(aim, world.player.cur, hud.blocksMouse));
        renderer.handleEvents(world, world.events);
        hud.handleEvents(world, world.events);
        sfx.handle(world, world.events);
        acc -= DT;
        steps++;
        if (world.outcome !== "playing") break;
      }
      if (steps === 5) acc = 0;
      if (world.outcome !== "playing") {
        // 最後の一撃を見せてから拠点に戻る
        window.setTimeout(finishRun, 900);
        mode = "ending";
      }
    }
    if (mode !== "hub") {
      const aim = renderer.screenToWorld(input.mouse.x, input.mouse.y);
      renderer.render(world, mode === "playing" ? acc / DT : 1, aim, dt, mode === "playing" ? input.aimingThrow : null);
      hud.update(world, renderer, input.mouse, dt);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
