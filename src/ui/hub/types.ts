import type { MaterialId } from "../../data/items";
import type { Profile } from "../../meta/profile";

/** 直前のランの結果。拠点に戻ったときに一度だけ見せる */
export type LastRunSummary = {
  outcome: "extracted" | "dead";
  time: number;
  kills: number;
  /** 実際に保管庫に入った分。死んで失ったときは空 */
  gained: { money: number; materials: Partial<Record<MaterialId, number>> };
  /** 死んで失った分 */
  lost: { money: number; materials: Partial<Record<MaterialId, number>> };
};

export type HubProps = {
  profile: Profile;
  lastResult: LastRunSummary | null;
  /** profile の複製を書き換えてから渡す。呼んだ側で保存して再描画する */
  onChange: (next: Profile) => void;
  onDeploy: () => void;
  onDismissResult: () => void;
  /** セーブを JSON ファイルとして書き出す */
  onExport: () => void;
  /** 読み込みに失敗したらエラーメッセージを返す */
  onImport: (text: string) => string | null;
  onReset: () => void;
};
