// 街並みの描画：地面の表示、建物の種類ごとの部品、標識
import * as THREE from "three";
import type { BuildingType } from "../data/buildings";
import { Ground, type GameMap, type MapJson } from "../sim/map";

type V3 = [number, number, number];

export const GROUND_COLORS: Record<number, [number, number, number]> = {
  [Ground.lot]: [138, 136, 128],
  [Ground.road]: [58, 60, 66],
  [Ground.sidewalk]: [170, 165, 155],
  [Ground.green]: [86, 128, 74],
  [Ground.viaduct]: [92, 84, 76],
  [Ground.dirt]: [150, 124, 92],
};

export function hash(n: number) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/** 建物用のシェーダーに渡す頂点を積む。面の向きは hint（外側の向き）に合わせて揃える */
export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];

  poly(vs: V3[], hint: V3, c: THREE.Color) {
    const [a, b, d] = vs;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    let list = vs;
    if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) {
      list = [...vs].reverse();
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    const base = this.pos.length / 3;
    for (const v of list) {
      this.pos.push(v[0], v[1], v[2]);
      this.nor.push(nx / l, ny / l, nz / l);
      this.col.push(c.r, c.g, c.b);
    }
    for (let i = 1; i < list.length - 1; i++) this.idx.push(base, base + i, base + i + 1);
  }

  /** 底面のない箱。x・z は左上の角、y0〜y1 の高さ */
  box(x: number, z: number, w: number, d: number, y0: number, y1: number, wall: THREE.Color, top: THREE.Color = wall) {
    const x1 = x + w, z1 = z + d;
    this.poly([[x, y1, z], [x1, y1, z], [x1, y1, z1], [x, y1, z1]], [0, 1, 0], top);
    this.poly([[x, y0, z1], [x1, y0, z1], [x1, y1, z1], [x, y1, z1]], [0, 0, 1], wall);
    this.poly([[x, y0, z], [x1, y0, z], [x1, y1, z], [x, y1, z]], [0, 0, -1], wall);
    this.poly([[x1, y0, z], [x1, y0, z1], [x1, y1, z1], [x1, y1, z]], [1, 0, 0], wall);
    this.poly([[x, y0, z], [x, y0, z1], [x, y1, z1], [x, y1, z]], [-1, 0, 0], wall);
  }

  /** 切妻屋根。棟は長いほうの辺に沿わせる */
  gable(x: number, z: number, w: number, d: number, y0: number, rise: number, o: number, roof: THREE.Color, gableC: THREE.Color) {
    const x0 = x - o, x1 = x + w + o, z0 = z - o, z1 = z + d + o, yr = y0 + rise;
    if (w >= d) {
      const zm = z + d / 2;
      this.poly([[x0, y0, z0], [x1, y0, z0], [x1, yr, zm], [x0, yr, zm]], [0, 1, -1], roof);
      this.poly([[x0, y0, z1], [x1, y0, z1], [x1, yr, zm], [x0, yr, zm]], [0, 1, 1], roof.clone().multiplyScalar(1.12));
      this.poly([[x, y0, z], [x, y0, z + d], [x, yr, zm]], [-1, 0, 0], gableC);
      this.poly([[x + w, y0, z], [x + w, y0, z + d], [x + w, yr, zm]], [1, 0, 0], gableC);
    } else {
      const xm = x + w / 2;
      this.poly([[x0, y0, z0], [x0, y0, z1], [xm, yr, z1], [xm, yr, z0]], [-1, 1, 0], roof);
      this.poly([[x1, y0, z0], [x1, y0, z1], [xm, yr, z1], [xm, yr, z0]], [1, 1, 0], roof.clone().multiplyScalar(1.08));
      this.poly([[x, y0, z], [x + w, y0, z], [xm, yr, z]], [0, 0, -1], gableC);
      this.poly([[x, y0, z + d], [x + w, y0, z + d], [xm, yr, z + d]], [0, 0, 1], gableC);
    }
  }

  /** 寄棟屋根 */
  hip(x: number, z: number, w: number, d: number, y0: number, rise: number, o: number, roof: THREE.Color) {
    const x0 = x - o, x1 = x + w + o, z0 = z - o, z1 = z + d + o, yr = y0 + rise;
    const lit = roof.clone().multiplyScalar(1.12);
    if (w >= d) {
      const zm = (z0 + z1) / 2, inset = (z1 - z0) / 2;
      const ra: V3 = [x0 + inset, yr, zm], rb: V3 = [x1 - inset, yr, zm];
      this.poly([[x0, y0, z0], [x1, y0, z0], rb, ra], [0, 1, -1], roof);
      this.poly([[x0, y0, z1], [x1, y0, z1], rb, ra], [0, 1, 1], lit);
      this.poly([[x0, y0, z0], [x0, y0, z1], ra], [-1, 1, 0], roof);
      this.poly([[x1, y0, z0], [x1, y0, z1], rb], [1, 1, 0], lit);
    } else {
      const xm = (x0 + x1) / 2, inset = (x1 - x0) / 2;
      const ra: V3 = [xm, yr, z0 + inset], rb: V3 = [xm, yr, z1 - inset];
      this.poly([[x0, y0, z0], [x0, y0, z1], rb, ra], [-1, 1, 0], roof);
      this.poly([[x1, y0, z0], [x1, y0, z1], rb, ra], [1, 1, 0], lit);
      this.poly([[x0, y0, z0], [x1, y0, z0], ra], [0, 1, -1], roof);
      this.poly([[x0, y0, z1], [x1, y0, z1], rb], [0, 1, 1], lit);
    }
  }

  geometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute("aColor", new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    return geo;
  }
}

/** 地面の模様と表示を描いたテクスチャを貼った板 */
export function buildGround(map: GameMap, anisotropy: number): THREE.Mesh {
  const S = 4;
  const W = map.w * S, H = map.h * S;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const data = img.data;
  for (let ty = 0; ty < H; ty++) {
    const my = Math.floor(ty / S);
    for (let tx = 0; tx < W; tx++) {
      const mx = Math.floor(tx / S);
      const i0 = mx + my * map.w;
      const g = map.ground[i0];
      const c = GROUND_COLORS[g] ?? GROUND_COLORS[0];
      let edge = 0;
      if (g === Ground.road) {
        const nb = [map.ground[i0 + 1], map.ground[i0 - 1], map.ground[i0 + map.w], map.ground[i0 - map.w]];
        if (nb.some((v) => v !== undefined && v !== Ground.road)) edge = -8;
      }
      const i = (tx + ty * W) * 4;
      data[i] = Math.max(0, Math.min(255, c[0] + edge));
      data[i + 1] = Math.max(0, Math.min(255, c[1] + edge));
      data[i + 2] = Math.max(0, Math.min(255, c[2] + edge));
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.scale(S, S);
  paintMarkings(ctx, map.json.markings);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(map.w, map.h), new THREE.MeshBasicMaterial({ map: tex }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(map.w / 2, 0, map.h / 2);
  return ground;
}

const PAINT = "rgba(232, 232, 226, 0.85)";

function paintMarkings(ctx: CanvasRenderingContext2D, m: MapJson["markings"]) {
  ctx.lineCap = "butt";
  ctx.strokeStyle = PAINT;
  ctx.lineWidth = 0.22;
  for (const l of m.lines) {
    ctx.setLineDash(l.dash ? [3, 3] : []);
    ctx.beginPath();
    l.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.fillStyle = PAINT;
  for (const c of m.crosswalks) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    // 道に沿った向きに長い縞を、道の幅いっぱいに並べる
    for (let y = -c.len / 2 + 0.3; y < c.len / 2 - 0.3; y += 0.9) ctx.fillRect(-1.5, y, 3, 0.45);
    ctx.restore();
  }

  for (const s of m.stops) {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle);
    ctx.fillRect(-0.2, -s.len / 2 + 0.3, 0.4, s.len - 0.6);
    ctx.restore();
  }

  for (const [x, y] of m.manholes) {
    ctx.fillStyle = "rgba(40, 40, 44, 0.9)";
    ctx.beginPath();
    ctx.arc(x, y, 0.38, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(120, 118, 112, 0.8)";
    ctx.lineWidth = 0.07;
    ctx.stroke();
  }
}

type Style = { wall: number; roof: number; h?: (base: number) => number };

const STYLES: Record<BuildingType, Style> = {
  house: { wall: 0xe0d4b8, roof: 0x5a5e66, h: () => 2.8 },
  apartment: { wall: 0xd8d2c6, roof: 0xaaa8a2, h: (b) => Math.min(b, 4.2) },
  mansion: { wall: 0xd2d2ce, roof: 0xb2b2ae, h: (b) => Math.max(b, 6.5) },
  convenience: { wall: 0xe8e8e4, roof: 0xb8b8b4, h: () => 3 },
  supermarket: { wall: 0xdedad2, roof: 0xb0aca4, h: () => 3.6 },
  restaurant: { wall: 0xccb89e, roof: 0xb0a08a },
  shop: { wall: 0xc8b8a4, roof: 0xb4a894 },
  mall: { wall: 0xc4c0b8, roof: 0xaeaaa2, h: (b) => Math.max(b, 6) },
  office: { wall: 0xbcb8b0, roof: 0xaeaaa2 },
  hotel: { wall: 0xc4b6ae, roof: 0xaa9e96, h: (b) => Math.max(b, 6) },
  station: { wall: 0xb0a490, roof: 0x8a8070, h: (b) => Math.min(Math.max(b, 4.5), 6) },
  hospital: { wall: 0xf0f0ec, roof: 0xc8ccc8, h: (b) => Math.max(b, 5) },
  school: { wall: 0xe4dcc8, roof: 0xb8b0a0, h: () => 5.5 },
  civic: { wall: 0xc8c4b8, roof: 0x8c8a84, h: (b) => Math.min(b, 4.5) },
  temple: { wall: 0x7a5a44, roof: 0x3c3e44, h: () => 2.6 },
  shrine: { wall: 0x8a6a50, roof: 0x4a5048, h: () => 2.4 },
  industrial: { wall: 0xaab2b4, roof: 0x98a4a6, h: (b) => Math.min(Math.max(b, 4), 5.5) },
  farm: { wall: 0xa08a6c, roof: 0x6a5240, h: () => 3 },
  parking: { wall: 0xaaaaa6, roof: 0x989894 },
};

const ACCENTS = [0x2f6fb0, 0x2f9a5a, 0xd07a2a, 0xb03a3a, 0x7a4aa0];
const AWNINGS = [0xb03a3a, 0x2f7a4a, 0xc08a2a, 0x3a5a9a, 0x6a4a3a];
const GLASS = 0x5a7490;
const DARK = 0x2c2e32;

const col = (n: number) => new THREE.Color(n);

/** 建物の外周のうち、front の側の辺。along は辺の向き、out は外向き */
function frontEdge(r: [number, number, number, number], front: number) {
  const [x, z, w, d] = r;
  switch (front) {
    case 0: return { a: [x, z], len: w, along: [1, 0], out: [0, -1] };
    case 1: return { a: [x + w, z], len: d, along: [0, 1], out: [1, 0] };
    case 2: return { a: [x, z + d], len: w, along: [1, 0], out: [0, 1] };
    default: return { a: [x, z], len: d, along: [0, 1], out: [-1, 0] };
  }
}

/** 正面の辺に沿った板。t0〜t1 は辺の上の位置、o0〜o1 は壁からの出っ張り、y0〜y1 は高さ */
function frontSlab(mb: MeshBuilder, r: [number, number, number, number], front: number, t0: number, t1: number, o0: number, o1: number, y0: number, y1: number, c: THREE.Color) {
  const e = frontEdge(r, front);
  const px = (t: number, o: number) => e.a[0] + e.along[0] * t + e.out[0] * o;
  const pz = (t: number, o: number) => e.a[1] + e.along[1] * t + e.out[1] * o;
  const xs = [px(t0, o0), px(t1, o1)], zs = [pz(t0, o0), pz(t1, o1)];
  const x = Math.min(...xs), z = Math.min(...zs);
  mb.box(x, z, Math.max(0.05, Math.abs(xs[1] - xs[0])), Math.max(0.05, Math.abs(zs[1] - zs[0])), y0, y1, c);
}

/** 正面の壁に貼る面（窓・シャッター・看板）。壁から少しだけ浮かせる */
function frontFace(mb: MeshBuilder, r: [number, number, number, number], front: number, t0: number, t1: number, y0: number, y1: number, c: THREE.Color) {
  const e = frontEdge(r, front);
  const o = 0.03;
  const p = (t: number, y: number): V3 => [e.a[0] + e.along[0] * t + e.out[0] * o, y, e.a[1] + e.along[1] * t + e.out[1] * o];
  mb.poly([p(t0, y0), p(t1, y0), p(t1, y1), p(t0, y1)], [e.out[0], 0, e.out[1]], c);
}

function largest(rects: [number, number, number, number][]) {
  return rects.reduce((a, b) => (b[2] * b[3] > a[2] * a[3] ? b : a));
}

export function addBuilding(mb: MeshBuilder, b: MapJson["buildings"][number], bi: number) {
  const st = STYLES[b.type] ?? STYLES.office;
  const base = Math.max(3, Math.min(8, b.h * 0.4));
  const h = st.h ? st.h(base) : base;
  const rnd = (k: number) => hash(bi * 7.31 + k);
  const wall = col(st.wall).offsetHSL(0, 0, (rnd(1) - 0.5) * 0.1);
  const wallSide = wall.clone().multiplyScalar(0.82);
  const roof = col(st.roof).offsetHSL(0, 0, (rnd(2) - 0.5) * 0.08);
  const sloped = b.type === "house" || b.type === "temple" || b.type === "shrine" || b.type === "farm";
  for (const [x, z, w, d] of b.rects) mb.box(x, z, w, d, 0, h, wallSide, sloped ? wallSide : roof);

  const r = largest(b.rects);
  const [rx, rz, rw, rd] = r;
  const f = b.front;
  const fl = frontEdge(r, f).len;

  switch (b.type) {
    case "house": {
      const roofs = [0x6a6e76, 0x8a6a5a, 0x5e7a8a, 0x7a7a70];
      mb.gable(rx, rz, rw, rd, h, Math.min(1.8, Math.min(rw, rd) * 0.35), 0.35, col(roofs[Math.floor(rnd(3) * roofs.length)]), wall);
      break;
    }
    case "farm":
      mb.gable(rx, rz, rw, rd, h, Math.min(2.2, Math.min(rw, rd) * 0.4), 0.4, roof, wall);
      break;
    case "temple":
      mb.hip(rx, rz, rw, rd, h, Math.min(2.6, Math.min(rw, rd) * 0.45), 0.9, roof);
      break;
    case "shrine": {
      mb.hip(rx, rz, rw, rd, h, Math.min(2.2, Math.min(rw, rd) * 0.45), 0.7, roof);
      // 正面の少し先に鳥居。柱2本と、上の黒い笠木・その下の貫
      const red = col(0xc8402a);
      const mid = fl / 2;
      for (const s of [-1, 1]) frontSlab(mb, r, f, mid + s * 1.2 - 0.15, mid + s * 1.2 + 0.15, 3.35, 3.65, 0, 3, red);
      frontSlab(mb, r, f, mid - 1.9, mid + 1.9, 3.3, 3.7, 3, 3.3, col(0x2c2a28));
      frontSlab(mb, r, f, mid - 1.5, mid + 1.5, 3.4, 3.6, 2.4, 2.6, red);
      break;
    }
    case "apartment": {
      const metal = col(0x8a8e94);
      const floors = Math.max(2, Math.round(h / 1.6));
      for (let k = 1; k < floors; k++) {
        const y = (h / floors) * k;
        frontSlab(mb, r, f, 0.2, fl - 1.6, 0, 1.0, y - 0.12, y, metal);
        frontSlab(mb, r, f, 0.2, fl - 1.6, 0.92, 1.0, y, y + 0.5, metal);
      }
      frontSlab(mb, r, f, fl - 1.5, fl - 0.2, 0, 1.2, 0, h - 0.2, col(0x6e7278));
      break;
    }
    case "mansion": {
      const rail = col(0xe6e6e2);
      for (let y = 1.2; y < h - 0.4; y += 1.1) frontSlab(mb, r, f, 0.3, fl - 0.3, 0, 0.6, y - 0.1, y + 0.3, rail);
      mb.box(rx + rw / 2 - 1.2, rz + rd / 2 - 1.2, 2.4, 2.4, h, h + 1.3, wallSide, roof);
      break;
    }
    case "convenience":
    case "supermarket": {
      const band = col(ACCENTS[Math.floor(rnd(4) * ACCENTS.length)]);
      const by = b.type === "convenience" ? 2.3 : 2.6;
      mb.box(rx - 0.06, rz - 0.06, rw + 0.12, rd + 0.12, by, by + 0.45, band);
      frontFace(mb, r, f, 0.6, fl - 0.6, 0.15, by - 0.15, col(GLASS));
      break;
    }
    case "restaurant": {
      const aw = col(AWNINGS[Math.floor(rnd(5) * AWNINGS.length)]);
      frontSlab(mb, r, f, 0.3, fl - 0.3, 0, 1.1, 2.0, 2.25, aw);
      frontSlab(mb, r, f, fl - 0.5, fl - 0.35, 0, 0.9, h - 2.6 > 2.4 ? h - 2.6 : 2.4, Math.max(h - 0.4, 3.6), col(0xe8d070));
      break;
    }
    case "shop": {
      if (rnd(6) < 0.5) {
        const aw = col(AWNINGS[Math.floor(rnd(7) * AWNINGS.length)]).offsetHSL(0, -0.15, 0.05);
        frontSlab(mb, r, f, 0.3, fl - 0.3, 0, 0.9, 2.0, 2.2, aw);
      } else {
        frontFace(mb, r, f, 0.4, fl - 0.4, 0.05, 2.2, col(0x9ca0a4));
      }
      break;
    }
    case "mall":
      frontFace(mb, r, f, fl * 0.15, fl * 0.85, h - 2.4, h - 0.5, col(ACCENTS[Math.floor(rnd(8) * ACCENTS.length)]));
      break;
    case "office":
    case "hotel": {
      const glass = col(GLASS).offsetHSL(0, 0, (rnd(9) - 0.5) * 0.06);
      for (let t = 0.8; t < fl - 0.6; t += 1.7) frontFace(mb, r, f, t, t + 0.6, 0.9, h - 0.4, glass);
      if (b.type === "office") {
        const n = 1 + Math.floor(rnd(10) * 3);
        for (let k = 0; k < n; k++) {
          const ux = rx + 0.6 + rnd(11 + k) * Math.max(0.1, rw - 2.2), uz = rz + 0.6 + rnd(21 + k) * Math.max(0.1, rd - 2.2);
          mb.box(ux, uz, 1.0, 0.8, h, h + 0.6, col(0xb4b8bc), col(0xc8ccd0));
        }
      } else {
        frontSlab(mb, r, f, fl * 0.25, fl * 0.75, -0.6, -0.4, h, h + 1.2, col(ACCENTS[Math.floor(rnd(12) * ACCENTS.length)]));
      }
      break;
    }
    case "station":
      frontSlab(mb, r, f, 0, fl, 0, 2.6, 3.0, 3.2, col(0x6c6e72));
      break;
    case "hospital": {
      const green = col(0x2a9a5a);
      const t = Math.min(fl - 1, 1.6);
      frontFace(mb, r, f, t - 0.25, t + 0.25, h - 1.9, h - 0.5, green);
      frontFace(mb, r, f, t - 0.7, t + 0.7, h - 1.45, h - 0.95, green);
      break;
    }
    case "school": {
      const fence = col(0xd8dcd0);
      mb.box(rx, rz, rw, 0.06, h, h + 0.7, fence);
      mb.box(rx, rz + rd - 0.06, rw, 0.06, h, h + 0.7, fence);
      mb.box(rx, rz, 0.06, rd, h, h + 0.7, fence);
      mb.box(rx + rw - 0.06, rz, 0.06, rd, h, h + 0.7, fence);
      break;
    }
    case "civic": {
      const t0 = Math.max(0.2, fl / 2 - 1.6), t1 = Math.min(fl - 0.2, fl / 2 + 1.6);
      frontSlab(mb, r, f, t0, t1, 0, 1.6, 2.6, 2.85, col(0x7a7c80));
      break;
    }
    case "industrial": {
      const strip = roof.clone().multiplyScalar(0.86);
      if (rw >= rd) for (let x = rx + 0.4; x < rx + rw - 0.4; x += 1.2) mb.box(x, rz + 0.1, 0.5, rd - 0.2, h, h + 0.04, strip);
      else for (let z = rz + 0.4; z < rz + rd - 0.4; z += 1.2) mb.box(rx + 0.1, z, rw - 0.2, 0.5, h, h + 0.04, strip);
      frontFace(mb, r, f, Math.max(0.4, fl / 2 - 1.8), Math.min(fl - 0.4, fl / 2 + 1.8), 0.05, 2.8, col(0xa4a8ac));
      break;
    }
    case "parking": {
      const dark = col(DARK);
      for (let y = 1.0; y + 0.45 < h - 0.2; y += 1.3) {
        for (const [x, z, w, d] of b.rects) mb.box(x - 0.02, z - 0.02, w + 0.04, d + 0.04, y, y + 0.45, dark);
      }
      break;
    }
  }
}

/** 地面の「止まれ」。地面のテクスチャでは字が潰れるので、別の板に描いて貼る */
export function buildRoadText(map: GameMap): THREE.Group {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(240, 240, 234, 0.9)";
  g.font = `bold 84px "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("止まれ", 128, 52);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const group = new THREE.Group();
  for (const s of map.json.markings.stops) {
    const m = new THREE.Mesh(geo, mat);
    // 交差点へ向かう人が読める向き。字の上を交差点の側に向け、進む向きに長く伸ばす
    const width = Math.min(3.4, s.len * 0.62);
    m.scale.set(width, 1, width * 0.9);
    m.position.set(s.x + Math.cos(s.angle) * 2.6, 0.02, s.y + Math.sin(s.angle) * 2.6);
    m.rotation.y = -(s.angle - Math.PI / 2);
    group.add(m);
  }
  return group;
}

function signTexture(lines: string[], kind: "street" | "station") {
  const c = document.createElement("canvas");
  const lh = 56;
  const pad = 14;
  const g = c.getContext("2d")!;
  g.font = `bold ${lh - 14}px "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", sans-serif`;
  const w = Math.max(...lines.map((t) => g.measureText(t).width)) + pad * 2;
  c.width = Math.ceil(w);
  c.height = lines.length * lh + pad;
  g.fillStyle = kind === "street" ? "#1f5aa8" : "#f4f4f0";
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = kind === "street" ? "#e8eef8" : "#2a6a3a";
  g.lineWidth = 4;
  g.strokeRect(4, 4, c.width - 8, c.height - 8);
  g.font = `bold ${lh - 14}px "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", sans-serif`;
  g.fillStyle = kind === "street" ? "#ffffff" : "#1c1c1c";
  g.textAlign = "center";
  g.textBaseline = "middle";
  lines.forEach((t, i) => g.fillText(t, c.width / 2, pad / 2 + lh * (i + 0.5)));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, aspect: c.width / c.height };
}

/** 通りの名前の案内標識と駅名標。板はカメラのほうへ傾けて、読めるようにする */
export function buildSigns(map: GameMap, toCamera: THREE.Vector3): THREE.Group {
  const group = new THREE.Group();
  const postMat = new THREE.MeshLambertMaterial({ color: 0x8a8e94 });
  const tilt = Math.atan2(toCamera.y, toCamera.z);
  for (const s of map.json.signs) {
    const { tex, aspect } = signTexture(s.text, s.kind);
    const hgt = s.kind === "street" ? 0.75 * s.text.length + 0.15 : 1.0;
    const wid = hgt * aspect;
    const top = s.kind === "street" ? 4.2 : 2.6;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(wid, hgt), new THREE.MeshBasicMaterial({ map: tex }));
    board.position.set(s.x, top - hgt / 2, s.y);
    board.rotation.x = -(Math.PI / 2 - tilt);
    group.add(board);
    const posts = s.kind === "street" ? [0] : [-wid / 2 + 0.2, wid / 2 - 0.2];
    for (const dx of posts) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, top - (s.kind === "street" ? 0 : hgt)), postMat);
      post.position.set(s.x + dx, (top - (s.kind === "street" ? 0 : hgt)) / 2, s.y + 0.05);
      group.add(post);
    }
  }
  return group;
}
