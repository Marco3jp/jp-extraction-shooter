import { useState } from "preact/hooks";
import { ITEMS, MATERIALS } from "../../data/items";
import { CampPicker } from "./CampPicker";
import { Craft } from "./Craft";
import { formatMoney, formatTime } from "./format";
import { Loadout } from "./Loadout";
import { Amounts, Icon } from "./parts";
import { SaveTab } from "./SaveTab";
import { Stash } from "./Stash";
import type { HubProps, LastRunSummary } from "./types";
import type { Haul } from "../../meta/profile";

type Tab = "loadout" | "craft" | "stash" | "save";

const TABS: { id: Tab; name: string }[] = [
  { id: "loadout", name: "出撃準備" },
  { id: "craft", name: "クラフト" },
  { id: "stash", name: "保管庫" },
  { id: "save", name: "セーブ" },
];

export function Hub(props: HubProps) {
  const [tab, setTab] = useState<Tab>("loadout");
  const { profile } = props;
  return (
    <div class="hub-root">
      <header class="hub-header">
        <h1>拠点</h1>
        <nav class="hub-tabs">
          {TABS.map((t) => (
            <button class={`hub-tab${tab === t.id ? " selected" : ""}`} onClick={() => setTab(t.id)}>
              {t.name}
            </button>
          ))}
        </nav>
        <div class="hub-wallet">
          <span class="hub-amount">
            <Icon id="money" />
            {formatMoney(profile.money)}
          </span>
          {MATERIALS.map((m) => (
            <span class="hub-amount" title={ITEMS[m].name}>
              <Icon id={m} />
              {profile.materials[m] ?? 0}
            </span>
          ))}
        </div>
      </header>
      <main class="hub-main">
        {props.lastResult && <ResultBanner result={props.lastResult} onDismiss={props.onDismissResult} />}
        {props.lastResult?.extractAt && (
          <CampPicker
            map={props.map}
            mapView={props.mapView}
            profile={profile}
            center={props.lastResult.extractAt}
            onChange={props.onChange}
          />
        )}
        {tab === "loadout" && <Loadout profile={profile} mapId={props.map.index.id} onChange={props.onChange} onDeploy={props.onDeploy} />}
        {tab === "craft" && <Craft profile={profile} onChange={props.onChange} />}
        {tab === "stash" && <Stash profile={profile} />}
        {tab === "save" && <SaveTab onExport={props.onExport} onImport={props.onImport} onReset={props.onReset} />}
      </main>
    </div>
  );
}

const hasAny = (a: Haul) => a.money > 0 || a.revive > 0 || MATERIALS.some((m) => (a.materials[m] ?? 0) > 0);

function ResultBanner({ result, onDismiss }: { result: LastRunSummary; onDismiss: () => void }) {
  const ok = result.outcome === "extracted";
  return (
    <div class={`hub-result ${ok ? "ok" : "dead"}`}>
      <div class="hub-result-title">{ok ? "脱出成功" : "やられた"}</div>
      <div class="hub-result-body">
        <span>時間 {formatTime(result.time)}</span>
        <span>倒した敵 {result.kills}体</span>
        <span class="hub-result-row">
          持ち帰った物 <Amounts {...result.gained} />
        </span>
        {hasAny(result.lost) && (
          <span class="hub-result-row lost">
            失った物 <Amounts {...result.lost} />
          </span>
        )}
      </div>
      <button class="hub-button" onClick={onDismiss}>
        閉じる
      </button>
    </div>
  );
}
