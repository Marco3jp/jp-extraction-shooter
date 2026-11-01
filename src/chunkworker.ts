// 区画のファイルの取得・展開・格子のデコードを、メインスレッドの外でする
import { decodeChunk, type ChunkJson } from "./sim/map";

export type ChunkRequest = { id: number; url: string };

self.onmessage = async (e: MessageEvent<ChunkRequest>) => {
  const { id, url } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // サーバーが Content-Encoding: gzip で返すと、先に展開されている
    const text = buf[0] === 0x1f && buf[1] === 0x8b
      ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
      : new TextDecoder().decode(buf);
    const chunk = decodeChunk(JSON.parse(text) as ChunkJson);
    postMessage({ id, chunk }, { transfer: [chunk.ground.buffer, chunk.solid.buffer, chunk.btype.buffer] });
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
};
