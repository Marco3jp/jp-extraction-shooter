import { useRef, useState } from "preact/hooks";

type Props = {
  onExport: () => void;
  onImport: (text: string) => string | null;
  onReset: () => void;
};

export function SaveTab({ onExport, onImport, onReset }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // 同じファイルを続けて選んでも change が起きるように空にしておく
    input.value = "";
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      setMessage({ text: "ファイルを読めませんでした", error: true });
      return;
    }
    const err = onImport(text);
    setMessage(err ? { text: err, error: true } : { text: "読み込みました", error: false });
  };

  return (
    <div class="hub-save">
      <section class="hub-panel">
        <h2>セーブ</h2>
        <p class="muted">
          セーブはこのブラウザの中にあります。サイトのデータを消すと一緒に消えるので、ときどき書き出しておいてください。
        </p>
        <div class="hub-save-actions">
          <button class="hub-button" onClick={onExport}>
            書き出す
          </button>
          <button class="hub-button" onClick={() => fileRef.current?.click()}>
            読み込む
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onFile} />
        </div>
        {message && <p class={message.error ? "hub-error" : "hub-ok"}>{message.text}</p>}
      </section>

      <section class="hub-panel">
        <h2>最初からやり直す</h2>
        <p class="muted">お金・素材・装備・戦績がすべて消えます。</p>
        {confirming ? (
          <div class="hub-save-actions">
            <button
              class="hub-button danger"
              onClick={() => {
                setConfirming(false);
                setMessage(null);
                onReset();
              }}
            >
              すべて消してやり直す
            </button>
            <button class="hub-button" onClick={() => setConfirming(false)}>
              やめる
            </button>
          </div>
        ) : (
          <button class="hub-button" onClick={() => setConfirming(true)}>
            最初からやり直す
          </button>
        )}
      </section>
    </div>
  );
}
