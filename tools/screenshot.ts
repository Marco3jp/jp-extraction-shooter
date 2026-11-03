// ヘッドレス Chromium でゲームを開いて 1 枚撮り、WebGL の renderer 名と fps を出す。npm run dev を立てた状態で使う
// 使い方: npm run headless -- [URL] [保存先.png] [--deploy | --range]
//   --deploy で出撃、--range で射撃場に入ってから測る。付けなければ拠点の画面を撮る
import { isSoftwareRenderer, launchHeadless, measureFps, rendererOf } from "./headless";

async function main() {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const enter = process.argv.includes("--deploy") ? "button.hub-deploy" : process.argv.includes("--range") ? "button.hub-range" : null;
  const url = positional[0] ?? "http://localhost:5173/";
  const out = positional[1] ?? "headless.png";

  const browser = await launchHeadless();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[console.error] ${m.text()}`);
    });
    page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
    await page.goto(url);
    await page.waitForSelector(".hub-root");
    // 拠点の画面の間は 3D を描かないので、fps を測るなら出撃か射撃場に入る
    if (enter) {
      await page.click(enter);
      await page.waitForFunction(() => document.getElementById("hub")!.style.display === "none", null, { timeout: 60000 });
    }
    await page.waitForTimeout(2000);
    const renderer = await rendererOf(page);
    const fps = await measureFps(page);
    const t = performance.now();
    await page.screenshot({ path: out });
    console.log(`renderer: ${renderer}`);
    console.log(`fps: ${fps.toFixed(1)}${enter ? "" : "（拠点の画面。描画の速さは --deploy か --range で測る）"}`);
    console.log(`screenshot: ${out}（${((performance.now() - t) / 1000).toFixed(2)}秒）`);
    if (isSoftwareRenderer(renderer)) console.log("警告: CPU で描いている。docs/tech.md の「ヘッドレスでの動作確認」を見る");
  } finally {
    await browser.close();
  }
}

await main();
