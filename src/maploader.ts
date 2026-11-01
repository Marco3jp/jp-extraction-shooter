import type { LoadedChunk, MapIndex } from "./sim/map";

export function mapBase(id: string) {
  return `${import.meta.env.BASE_URL}maps/${id}/`;
}

export async function fetchIndex(id: string): Promise<MapIndex> {
  const res = await fetch(`${mapBase(id)}index.json`);
  if (!res.ok) throw new Error(`${res.url}: ${res.status}`);
  return (await res.json()) as MapIndex;
}

/** 区画のファイルを Web Worker で読む */
export class ChunkLoader {
  private worker = new Worker(new URL("./chunkworker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private waiting = new Map<number, { resolve: (c: LoadedChunk) => void; reject: (e: Error) => void }>();

  constructor(private id: string) {
    this.worker.onmessage = (e: MessageEvent<{ id: number; chunk?: LoadedChunk; error?: string }>) => {
      const w = this.waiting.get(e.data.id);
      if (!w) return;
      this.waiting.delete(e.data.id);
      if (e.data.chunk) w.resolve(e.data.chunk);
      else w.reject(new Error(e.data.error));
    };
  }

  load = (i: number, j: number): Promise<LoadedChunk> => {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, url: new URL(`${mapBase(this.id)}${i}_${j}.json.gz`, location.href).href });
    });
  };
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
