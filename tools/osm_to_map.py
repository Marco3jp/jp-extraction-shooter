"""OpenStreetMap の JSON（Overpass の out geom）を、ゲーム用の 1m グリッドのマップに変換する。

使い方:
  python3 -I tools/osm_to_map.py tools/osm-raw/area.json public/maps/akihabara.json [preview.png]
"""
import base64
import json
import math
import random
import struct
import sys
import zlib

BBOX = dict(south=35.6970, west=139.7736, north=35.7015, east=139.7800)
SEED = 20261101

# 地面の種類。src/sim/map.ts の Ground と揃える
LOT, ROAD, SIDEWALK, GREEN, VIADUCT, DIRT = 0, 1, 2, 3, 4, 5
# 塞がっているもの
FREE, BUILDING, COVER = 0, 1, 2

ROAD_WIDTH = {
    "motorway": 0, "trunk": 16, "trunk_link": 8, "primary": 14, "secondary": 11,
    "tertiary": 9, "unclassified": 6, "residential": 6, "service": 4, "living_street": 5,
}
WALK_WIDTH = {"footway": 2, "pedestrian": 5, "path": 2, "steps": 2}
SKIP_BUILDING = {"roof", "construction"}
CAR_ROADS = {"tertiary", "unclassified", "residential", "service", "living_street"}


def main():
    src, dst = sys.argv[1], sys.argv[2]
    preview = sys.argv[3] if len(sys.argv) > 3 else None
    data = json.load(open(src))

    lat0 = (BBOX["south"] + BBOX["north"]) / 2
    mx = 111320 * math.cos(math.radians(lat0))
    my = 110574
    W = int((BBOX["east"] - BBOX["west"]) * mx)
    H = int((BBOX["north"] - BBOX["south"]) * my)

    def proj(p):
        return ((p["lon"] - BBOX["west"]) * mx, (BBOX["north"] - p["lat"]) * my)

    ground = bytearray([LOT]) * (W * H)
    bid = [-1] * (W * H)
    road_mask = bytearray(W * H)
    buildings = []

    def fill_poly(pts, fn):
        ys = [p[1] for p in pts]
        y0, y1 = max(0, int(min(ys))), min(H - 1, int(max(ys)) + 1)
        n = len(pts)
        for y in range(y0, y1 + 1):
            cy = y + 0.5
            xs = []
            for i in range(n):
                ax, ay = pts[i]
                bx, by = pts[(i + 1) % n]
                if (ay <= cy < by) or (by <= cy < ay):
                    xs.append(ax + (cy - ay) * (bx - ax) / (by - ay))
            xs.sort()
            for i in range(0, len(xs) - 1, 2):
                xa = max(0, int(math.ceil(xs[i] - 0.5)))
                xb = min(W - 1, int(math.floor(xs[i + 1] - 0.5)))
                for x in range(xa, xb + 1):
                    fn(x + y * W)

    def stroke(pts, width, fn):
        r = width / 2
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            x0 = max(0, int(min(ax, bx) - r - 1))
            x1 = min(W - 1, int(max(ax, bx) + r + 1))
            y0 = max(0, int(min(ay, by) - r - 1))
            y1 = min(H - 1, int(max(ay, by) + r + 1))
            dx, dy = bx - ax, by - ay
            ll = dx * dx + dy * dy or 1e-9
            for y in range(y0, y1 + 1):
                for x in range(x0, x1 + 1):
                    px, py = x + 0.5, y + 0.5
                    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / ll))
                    qx, qy = ax + t * dx - px, ay + t * dy - py
                    if qx * qx + qy * qy <= r * r:
                        fn(x + y * W)

    def setter(arr, v):
        def f(i):
            arr[i] = v
        return f

    elements = data["elements"]

    for e in elements:
        t = e.get("tags", {})
        pts = [proj(p) for p in e.get("geometry", [])]
        if len(pts) < 3:
            continue
        if t.get("leisure") in ("park", "playground") or t.get("landuse") in ("grass",):
            fill_poly(pts, setter(ground, GREEN))
        elif t.get("landuse") in ("construction", "brownfield"):
            fill_poly(pts, setter(ground, DIRT))

    for e in elements:
        t = e.get("tags", {})
        pts = [proj(p) for p in e.get("geometry", [])]
        if len(pts) < 2:
            continue
        if t.get("railway") == "rail" and (t.get("bridge") or t.get("layer", "0") not in ("0", "") and int(t.get("layer", "0")) > 0):
            stroke(pts, 9, setter(ground, VIADUCT))

    road_lines = []
    for e in elements:
        t = e.get("tags", {})
        hw = t.get("highway")
        pts = [proj(p) for p in e.get("geometry", [])]
        if not hw or len(pts) < 2 or t.get("tunnel"):
            continue
        if hw in ROAD_WIDTH and ROAD_WIDTH[hw] > 0:
            w = ROAD_WIDTH[hw]
            stroke(pts, w + 3, setter(ground, SIDEWALK))
            road_lines.append((hw, w, pts))
        elif hw in WALK_WIDTH:
            stroke(pts, WALK_WIDTH[hw], setter(ground, SIDEWALK))
            stroke(pts, WALK_WIDTH[hw], setter(road_mask, 1))
    for hw, w, pts in road_lines:
        stroke(pts, w, setter(ground, ROAD))
        stroke(pts, w + 2, setter(road_mask, 1))

    for e in elements:
        t = e.get("tags", {})
        b = t.get("building")
        pts = [proj(p) for p in e.get("geometry", [])]
        if not b or b in SKIP_BUILDING or len(pts) < 4:
            continue
        idx = len(buildings)
        cells = []

        def mark(i, idx=idx, cells=cells):
            if not road_mask[i]:
                bid[i] = idx
                cells.append(i)

        fill_poly(pts, mark)
        levels = t.get("building:levels")
        try:
            h = float(levels) * 3.2
        except (TypeError, ValueError):
            h = {"house": 7, "detached": 7, "apartments": 14, "residential": 10,
                 "commercial": 16, "retail": 9, "office": 18, "hotel": 20}.get(b, 9)
        buildings.append(dict(kind=b, h=h, cells=cells))

    # 1〜2m の隙間は通れないので埋めて、街区をひとかたまりにする
    for _ in range(2):
        for y in range(H):
            row = y * W
            x = 0
            while x < W:
                if bid[row + x] >= 0:
                    x += 1
                    continue
                s = x
                while x < W and bid[row + x] < 0:
                    x += 1
                if 0 < s and x < W and x - s <= 2 and not any(road_mask[row + k] for k in range(s, x)):
                    for k in range(s, x):
                        bid[row + k] = bid[row + s - 1]
        for x in range(W):
            y = 0
            while y < H:
                if bid[x + y * W] >= 0:
                    y += 1
                    continue
                s = y
                while y < H and bid[x + y * W] < 0:
                    y += 1
                if 0 < s and y < H and y - s <= 2 and not any(road_mask[x + k * W] for k in range(s, y)):
                    for k in range(s, y):
                        bid[x + k * W] = bid[x + (s - 1) * W]

    counts = {}
    for v in bid:
        if v >= 0:
            counts[v] = counts.get(v, 0) + 1
    for i, v in enumerate(bid):
        if v >= 0 and counts[v] < 12:
            bid[i] = -1

    solid = bytearray(W * H)
    for i, v in enumerate(bid):
        if v >= 0:
            solid[i] = BUILDING

    rng = random.Random(SEED)
    covers = []

    def place(x, y, w, h, kind):
        if x < 1 or y < 1 or x + w >= W - 1 or y + h >= H - 1:
            return False
        for yy in range(y - 1, y + h + 1):
            for xx in range(x - 1, x + w + 1):
                if solid[xx + yy * W] != FREE:
                    return False
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                solid[xx + yy * W] = COVER
        covers.append(dict(kind=kind, x=x, y=y, w=w, h=h))
        return True

    for hw, w, pts in road_lines:
        if hw not in CAR_ROADS:
            continue
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            dx, dy = bx - ax, by - ay
            seg = math.hypot(dx, dy)
            if seg < 6:
                continue
            ux, uy = dx / seg, dy / seg
            nx, ny = -uy, ux
            d = rng.uniform(2, 10)
            while d < seg - 3:
                side = rng.choice((-1, 1))
                off = w / 2 - 1.0
                cx, cy = ax + ux * d + nx * off * side, ay + uy * d + ny * off * side
                if abs(dx) > abs(dy):
                    place(int(cx - 2), int(cy - 1), 4, 2, "car")
                else:
                    place(int(cx - 1), int(cy - 2), 2, 4, "car")
                d += rng.uniform(12, 30)

    for _ in range(W * H // 900):
        x, y = rng.randrange(2, W - 2), rng.randrange(2, H - 2)
        i = x + y * W
        if solid[i] != FREE or ground[i] not in (SIDEWALK, LOT):
            continue
        if any(solid[i + o] == BUILDING for o in (1, -1, W, -W)):
            place(x, y, 1, 1, "vending")

    for _ in range(W * H // 1400):
        x, y = rng.randrange(2, W - 4), rng.randrange(2, H - 4)
        if ground[x + y * W] in (LOT, DIRT, GREEN):
            if rng.random() < 0.5:
                place(x, y, 3, 1, "barrier")
            else:
                place(x, y, 1, 3, "barrier")

    # 建物ごとに長方形へまとめる（描画用）
    rects_by_b = {}
    seen = bytearray(W * H)
    for y in range(H):
        for x in range(W):
            i = x + y * W
            b = bid[i]
            if b < 0 or seen[i]:
                continue
            w = 1
            while x + w < W and bid[i + w] == b and not seen[i + w]:
                w += 1
            h = 1
            while y + h < H and all(bid[x + k + (y + h) * W] == b and not seen[x + k + (y + h) * W] for k in range(w)):
                h += 1
            for yy in range(y, y + h):
                for xx in range(x, x + w):
                    seen[xx + yy * W] = 1
            rects_by_b.setdefault(b, []).append([x, y, w, h])

    out_b = []
    for b, rects in rects_by_b.items():
        bb = buildings[b]
        out_b.append(dict(kind=bb["kind"], h=round(bb["h"], 1), rects=rects))

    out = dict(
        name="秋葉原・佐久間町",
        width=W, height=H, cell=1,
        attribution="© OpenStreetMap contributors (ODbL)",
        ground=base64.b64encode(bytes(ground)).decode(),
        solid=base64.b64encode(bytes(solid)).decode(),
        buildings=out_b,
        covers=covers,
    )
    with open(dst, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{W}x{H} buildings={len(out_b)} rects={sum(len(b['rects']) for b in out_b)} covers={len(covers)}")

    if preview:
        colors = {LOT: (150, 150, 140), ROAD: (60, 60, 65), SIDEWALK: (185, 180, 170),
                  GREEN: (90, 140, 80), VIADUCT: (110, 95, 80), DIRT: (160, 130, 90)}
        raw = bytearray()
        for y in range(H):
            raw.append(0)
            for x in range(W):
                i = x + y * W
                if solid[i] == BUILDING:
                    raw += bytes((200, 120, 90))
                elif solid[i] == COVER:
                    raw += bytes((240, 220, 60))
                else:
                    raw += bytes(colors[ground[i]])

        def chunk(tag, body):
            c = struct.pack(">I", len(body)) + tag + body
            return c + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
        png += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
        open(preview, "wb").write(png)


if __name__ == "__main__":
    main()
