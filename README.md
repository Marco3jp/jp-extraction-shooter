# jp-extraction-shooter（仮称）

斜め見下ろしの脱出シューター。オフラインのソロプレイで、Apex の漁りと巻きの撃ち合いを短い時間で遊べるようにする。

配布も販売もしない。ブラウザで開けば遊べる状態を目指す。

## 遊び方

公開版：https://marco3jp.github.io/jp-extraction-shooter/（main に push すると GitHub Actions でデプロイされる）

手元で動かすとき：

```sh
npm install
npm run dev
```

表示された URL をブラウザで開くと拠点の画面になる。装備を整えて出撃する。ラン中の操作は Esc のポーズ画面に出る。

セーブはブラウザの IndexedDB に入る。拠点の「セーブ」から JSON で書き出せる。

地図を取り直すときは、`tools/osm_to_map.py` の冒頭にある範囲を書き換え、Overpass API から `tools/osm-raw/area.json` を取ってから `npm run map` を実行する。

## 資料

- [docs/design.md](docs/design.md)：ゲーム内容。決まっていることと、決めること
- [docs/tech.md](docs/tech.md)：技術の方針と、最初の試作で確かめること
- [docs/roadmap.md](docs/roadmap.md)：拡張の計画
