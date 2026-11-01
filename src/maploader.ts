import type { ChunkJson, MapIndex } from "./sim/map";

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url}: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // サーバーが Content-Encoding: gzip で返すと、ブラウザが先に展開している
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return JSON.parse(new TextDecoder().decode(buf)) as T;
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as T;
}

export function mapBase(name: string) {
  return `${import.meta.env.BASE_URL}maps/${name}/`;
}

export async function fetchIndex(name: string): Promise<MapIndex> {
  return readJson<MapIndex>(await fetch(`${mapBase(name)}index.json`));
}

export async function fetchChunk(name: string, i: number, j: number): Promise<ChunkJson> {
  return readJson<ChunkJson>(await fetch(`${mapBase(name)}${i}_${j}.json.gz`));
}

const tiles = new Map<string, HTMLImageElement>();

/** 全体マップの絵の1枚。初めて呼んだときに読み始め、読み終わるまでは complete が false */
export function overviewTile(id: string, ti: number, tj: number): HTMLImageElement {
  const key = `${id}/${ti}_${tj}`;
  let img = tiles.get(key);
  if (!img) {
    img = new Image();
    img.src = `${mapBase(id)}overview/${ti}_${tj}.png`;
    tiles.set(key, img);
  }
  return img;
}
