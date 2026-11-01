"""OpenStreetMap の JSON（Overpass の out geom）を、ゲーム用の 1m グリッドのマップに変換する。

細かすぎる模様はならし、似た街並みが続くところは縦横の帯ごと切り詰める。
大通り・鉄道・公園・大きな建物は「残す場所」として、その縦横の比率を変えない。

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
from collections import Counter

BBOX = dict(south=35.6970, west=139.7736, north=35.7015, east=139.7800)
SEED = 20261101

# 地面の種類。src/sim/map.ts の Ground と揃える
LOT, ROAD, SIDEWALK, GREEN, VIADUCT, DIRT = 0, 1, 2, 3, 4, 5
# 塞がっているもの
FREE, BUILDING, COVER = 0, 1, 2
# 道の向き
NONE, HORIZ, VERT = 0, 1, 2

ROAD_WIDTH = {
    "motorway": 0, "trunk": 16, "trunk_link": 8, "primary": 14, "secondary": 11,
    "tertiary": 9, "unclassified": 6, "residential": 6, "service": 4, "living_street": 5,
}
MAJOR_ROADS = {"trunk", "primary", "secondary"}
SKIP_BUILDING = {"roof", "construction"}

# ならし
SMALL_GROUND_PATCH = 30
SMALL_BUILDING = 20
# 道に面していても、この広さ（㎡）より小さい空き地は埋める。面していない空き地はこの上限まで埋める
ENCLOSED_LOT_MIN = 40
# 建物と建物・歩道に挟まれた、この幅（m）以下の空き地は建物を伸ばして埋める
NARROW_STRIP = 4
ENCLOSED_LOT_MAX = 600
# 残す場所
LANDMARK_BUILDING_AREA = 4000
LANDMARK_STATION_AREA = 1000
LANDMARK_GREEN_AREA = 1000
LANDMARK_MARGIN = 4
KEEP_LINE_MIN_LENGTH = 40
# 縦か横から、この角度（度）以内の線だけを残す。斜めの線で広い範囲が守られてしまうため
KEEP_LINE_MAX_ANGLE = 20
# 切り詰め
ROAD_COLUMN_RATIO = 0.1
LONG_BLOCK = 36
SHORT_BLOCK = 28


def grid(w, h, v):
    return [[v] * w for _ in range(h)]


def main():
    src, dst = sys.argv[1], sys.argv[2]
    preview = sys.argv[3] if len(sys.argv) > 3 else None
    data = json.load(open(src))
    elements = data["elements"]

    lat0 = (BBOX["south"] + BBOX["north"]) / 2
    mx = 111320 * math.cos(math.radians(lat0))
    my = 110574
    W = int((BBOX["east"] - BBOX["west"]) * mx)
    H = int((BBOX["north"] - BBOX["south"]) * my)

    def proj(p):
        return ((p["lon"] - BBOX["west"]) * mx, (BBOX["north"] - p["lat"]) * my)

    ground = grid(W, H, LOT)
    bid = grid(W, H, -1)
    road = grid(W, H, 0)          # 0: なし 1: 細い道 2: 大通り
    road_dir = grid(W, H, NONE)
    col_keep = [False] * W
    row_keep = [False] * H
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
                    fn(x, y)

    def stroke_seg(a, b, width, fn):
        (ax, ay), (bx, by) = a, b
        r = width / 2
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
                    fn(x, y)

    def keep_line(pts, width):
        # 長くまっすぐな区間だけ、その幅を残す（縦なら列、横なら行）
        for a, b in zip(pts, pts[1:]):
            dx, dy = b[0] - a[0], b[1] - a[1]
            if math.hypot(dx, dy) < KEEP_LINE_MIN_LENGTH:
                continue
            mx_, my_ = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            if not (0 <= mx_ < W and 0 <= my_ < H):
                continue
            off_axis = math.degrees(math.atan2(min(abs(dx), abs(dy)), max(abs(dx), abs(dy))))
            if off_axis > KEEP_LINE_MAX_ANGLE:
                continue
            if abs(dy) > abs(dx):
                for x in range(max(0, int(min(a[0], b[0]) - width / 2 - 1)), min(W, int(max(a[0], b[0]) + width / 2 + 2))):
                    col_keep[x] = True
            else:
                for y in range(max(0, int(min(a[1], b[1]) - width / 2 - 1)), min(H, int(max(a[1], b[1]) + width / 2 + 2))):
                    row_keep[y] = True

    def keep_box(x0, y0, x1, y1):
        for x in range(max(0, x0 - LANDMARK_MARGIN), min(W, x1 + LANDMARK_MARGIN + 1)):
            col_keep[x] = True
        for y in range(max(0, y0 - LANDMARK_MARGIN), min(H, y1 + LANDMARK_MARGIN + 1)):
            row_keep[y] = True

    # ---- 1. 描き込む ----
    for e in elements:
        t = e.get("tags", {})
        pts = [proj(p) for p in e.get("geometry", [])]
        if len(pts) < 3:
            continue
        if t.get("leisure") in ("park", "playground") or t.get("landuse") in ("grass",):
            def g(x, y):
                ground[y][x] = GREEN
            fill_poly(pts, g)
        elif t.get("landuse") in ("construction", "brownfield"):
            def d(x, y):
                ground[y][x] = DIRT
            fill_poly(pts, d)

    for e in elements:
        t = e.get("tags", {})
        pts = [proj(p) for p in e.get("geometry", [])]
        if len(pts) < 2:
            continue
        layer = t.get("layer", "0")
        elevated = t.get("bridge") or (layer.lstrip("-").isdigit() and int(layer) > 0)
        if t.get("railway") == "rail" and elevated:
            def v(x, y):
                ground[y][x] = VIADUCT
            for a, b in zip(pts, pts[1:]):
                stroke_seg(a, b, 9, v)
            keep_line(pts, 9)

    road_lines = []
    for e in elements:
        t = e.get("tags", {})
        hw = t.get("highway")
        pts = [proj(p) for p in e.get("geometry", [])]
        if not hw or len(pts) < 2 or t.get("tunnel"):
            continue
        # 細い歩道や階段は模様にしかならないので描かない
        if hw in ROAD_WIDTH and ROAD_WIDTH[hw] > 0:
            road_lines.append((hw, ROAD_WIDTH[hw], pts))
        elif hw == "pedestrian":
            def s(x, y):
                ground[y][x] = SIDEWALK
            for a, b in zip(pts, pts[1:]):
                stroke_seg(a, b, 5, s)

    for hw, w, pts in road_lines:
        def side(x, y):
            if ground[y][x] != ROAD:
                ground[y][x] = SIDEWALK
        for a, b in zip(pts, pts[1:]):
            stroke_seg(a, b, w + 3, side)
    for hw, w, pts in road_lines:
        kind = 2 if hw in MAJOR_ROADS else 1
        for a, b in zip(pts, pts[1:]):
            direction = VERT if abs(b[1] - a[1]) > abs(b[0] - a[0]) else HORIZ

            def r(x, y, kind=kind, direction=direction):
                ground[y][x] = ROAD
                if kind >= road[y][x]:
                    road[y][x] = kind
                    road_dir[y][x] = direction
            stroke_seg(a, b, w, r)
        if kind == 2:
            keep_line(pts, w + 3)

    for e in elements:
        t = e.get("tags", {})
        b = t.get("building")
        pts = [proj(p) for p in e.get("geometry", [])]
        if not b or b in SKIP_BUILDING or len(pts) < 4:
            continue
        idx = len(buildings)
        cells = []

        def mark(x, y, idx=idx, cells=cells):
            if ground[y][x] not in (ROAD, SIDEWALK):
                bid[y][x] = idx
                cells.append((x, y))

        fill_poly(pts, mark)
        levels = t.get("building:levels")
        try:
            h = float(levels) * 3.2
        except (TypeError, ValueError):
            h = {"house": 7, "detached": 7, "apartments": 14, "residential": 10,
                 "commercial": 16, "retail": 9, "office": 18, "hotel": 20}.get(b, 9)
        buildings.append(dict(kind=b, h=h))
        if cells and (len(cells) >= LANDMARK_BUILDING_AREA or (b == "train_station" and len(cells) >= LANDMARK_STATION_AREA)):
            xs = [c[0] for c in cells]
            ys = [c[1] for c in cells]
            keep_box(min(xs), min(ys), max(xs), max(ys))

    # ---- 2. ならす ----
    def is_open(x, y):
        return ground[y][x] not in (ROAD, SIDEWALK)

    # 1〜2m の隙間は通れないので埋めて、街区をひとかたまりにする
    for _ in range(2):
        for y in range(H):
            x = 0
            while x < W:
                if bid[y][x] >= 0:
                    x += 1
                    continue
                s = x
                while x < W and bid[y][x] < 0:
                    x += 1
                if 0 < s and x < W and x - s <= 2 and all(is_open(k, y) for k in range(s, x)):
                    for k in range(s, x):
                        bid[y][k] = bid[y][s - 1]
        for x in range(W):
            y = 0
            while y < H:
                if bid[y][x] >= 0:
                    y += 1
                    continue
                s = y
                while y < H and bid[y][x] < 0:
                    y += 1
                if 0 < s and y < H and y - s <= 2 and all(is_open(x, k) for k in range(s, y)):
                    for k in range(s, y):
                        bid[k][x] = bid[s - 1][x]

    # 建物の輪郭の1m単位のギザギザを、周り3×3の多数決でならす
    for _ in range(2):
        nb = [row[:] for row in bid]
        for y in range(1, H - 1):
            for x in range(1, W - 1):
                if not is_open(x, y):
                    continue
                ids = [bid[y + j][x + i] for j in (-1, 0, 1) for i in (-1, 0, 1) if bid[y + j][x + i] >= 0]
                if bid[y][x] >= 0 and len(ids) <= 3:
                    nb[y][x] = -1
                elif bid[y][x] < 0 and len(ids) >= 6:
                    nb[y][x] = Counter(ids).most_common(1)[0][0]
        bid = nb

    # 建物と建物、または建物と歩道に挟まれた細い空き地（前庭や軒下）は、建物を伸ばして埋める
    def lot_like(x, y):
        return bid[y][x] < 0 and ground[y][x] in (LOT, DIRT)

    def fill_strips(get, setb, n, m):
        for i in range(m):
            j = 0
            while j < n:
                if not lot_like(*get(i, j)):
                    j += 1
                    continue
                s0 = j
                while j < n and lot_like(*get(i, j)):
                    j += 1
                if s0 == 0 or j >= n or j - s0 > NARROW_STRIP:
                    continue
                bx, by = get(i, s0 - 1)
                ax, ay = get(i, j)
                left_b, right_b = bid[by][bx], bid[ay][ax]
                left_s = ground[by][bx] == SIDEWALK
                right_s = ground[ay][ax] == SIDEWALK
                fill = left_b if left_b >= 0 else right_b
                if fill >= 0 and (left_b >= 0 or left_s) and (right_b >= 0 or right_s):
                    for k in range(s0, j):
                        setb(*get(i, k), fill)

    def setb(x, y, v):
        bid[y][x] = v

    for _ in range(2):
        fill_strips(lambda i, j: (j, i), setb, W, H)
        fill_strips(lambda i, j: (i, j), setb, H, W)

    # 街区の中に取り残された空き地を建物で埋める。道に面していないか、面していても小さいもの
    seen = grid(W, H, False)
    for y in range(H):
        for x in range(W):
            if seen[y][x] or bid[y][x] >= 0 or not is_open(x, y) or ground[y][x] == GREEN:
                continue
            comp = [(x, y)]
            seen[y][x] = True
            touches_street = False
            k = 0
            while k < len(comp):
                cx, cy = comp[k]
                k += 1
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if not (0 <= nx < W and 0 <= ny < H):
                        touches_street = True
                        continue
                    if not is_open(nx, ny):
                        touches_street = True
                    elif not seen[ny][nx] and bid[ny][nx] < 0 and ground[ny][nx] != GREEN:
                        seen[ny][nx] = True
                        comp.append((nx, ny))
            if touches_street and len(comp) >= ENCLOSED_LOT_MIN:
                continue
            if len(comp) > ENCLOSED_LOT_MAX:
                continue
            for cx, cy in comp:
                around = [bid[ny][nx] for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1))
                          if 0 <= nx < W and 0 <= ny < H and bid[ny][nx] >= 0]
                if around:
                    bid[cy][cx] = around[0]
            # 隣に建物がなかったセルは、もう一周して埋める
            for _ in range(3):
                for cx, cy in comp:
                    if bid[cy][cx] >= 0:
                        continue
                    around = [bid[ny][nx] for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1))
                              if 0 <= nx < W and 0 <= ny < H and bid[ny][nx] >= 0]
                    if around:
                        bid[cy][cx] = around[0]

    # 小さな地面のかけらは、周りに一番多い種類に合わせる
    seen = grid(W, H, False)
    for y in range(H):
        for x in range(W):
            g = ground[y][x]
            if seen[y][x] or g in (ROAD, LOT):
                continue
            comp = [(x, y)]
            seen[y][x] = True
            k = 0
            while k < len(comp):
                cx, cy = comp[k]
                k += 1
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < W and 0 <= ny < H and not seen[ny][nx] and ground[ny][nx] == g:
                        seen[ny][nx] = True
                        comp.append((nx, ny))
            if len(comp) >= SMALL_GROUND_PATCH:
                if g == GREEN and len(comp) >= LANDMARK_GREEN_AREA:
                    xs = [c[0] for c in comp]
                    ys = [c[1] for c in comp]
                    keep_box(min(xs), min(ys), max(xs), max(ys))
                continue
            around = Counter()
            for cx, cy in comp:
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < W and 0 <= ny < H and ground[ny][nx] != g:
                        around[ground[ny][nx]] += 1
            fill = around.most_common(1)[0][0] if around else LOT
            if fill == ROAD:
                fill = SIDEWALK
            for cx, cy in comp:
                ground[cy][cx] = fill

    # ---- 3. 縮める ----
    def plan_cuts(n, keep, road_count, threshold):
        cuts = set()
        i = 0
        while i < n:
            if keep[i]:
                i += 1
                continue
            s = i
            while i < n and not keep[i]:
                i += 1
            e = i
            # この区間にある、帯と同じ向きの細い道（列なら縦の道）
            roads = []
            j = s
            while j < e:
                if road_count[j] >= threshold:
                    rs = j
                    while j < e and road_count[j] >= threshold:
                        j += 1
                    if roads and rs - roads[-1][1] <= 2:
                        roads[-1] = (roads[-1][0], j)
                    else:
                        roads.append((rs, j))
                else:
                    j += 1
            # 同じ向きの道が3本以上並んでいたら、内側の道を1本おきに抜く。
            # 両隣の街区の真ん中から真ん中までを切るので、残った2つの半分が1つの街区になる
            if len(roads) >= 3:
                for k in range(1, len(roads) - 1, 2):
                    left = (roads[k - 1][1] + roads[k][0]) // 2
                    right = (roads[k][1] + roads[k + 1][0]) // 2
                    cuts.update(range(left, right))
            # 残った長い街区は真ん中を切り詰める
            j = s
            while j < e:
                if j in cuts or road_count[j] >= threshold:
                    j += 1
                    continue
                bs = j
                while j < e and j not in cuts and road_count[j] < threshold:
                    j += 1
                length = j - bs
                if length > LONG_BLOCK:
                    remove = length - SHORT_BLOCK
                    mid = bs + length // 2
                    cuts.update(range(mid - remove // 2, mid - remove // 2 + remove))
        return cuts

    col_roads = [sum(1 for y in range(H) if road[y][x] == 1 and road_dir[y][x] == VERT) for x in range(W)]
    row_roads = [sum(1 for x in range(W) if road[y][x] == 1 and road_dir[y][x] == HORIZ) for y in range(H)]
    cut_cols = plan_cuts(W, col_keep, col_roads, H * ROAD_COLUMN_RATIO)
    cut_rows = plan_cuts(H, row_keep, row_roads, W * ROAD_COLUMN_RATIO)
    keep_cols = [x for x in range(W) if x not in cut_cols]
    keep_rows = [y for y in range(H) if y not in cut_rows]

    def shrink(g):
        return [[g[y][x] for x in keep_cols] for y in keep_rows]

    W0, H0 = W, H
    ground, bid, road, road_dir = shrink(ground), shrink(bid), shrink(road), shrink(road_dir)
    W, H = len(keep_cols), len(keep_rows)

    counts = Counter(v for row in bid for v in row if v >= 0)
    for y in range(H):
        for x in range(W):
            if bid[y][x] >= 0 and counts[bid[y][x]] < SMALL_BUILDING:
                bid[y][x] = -1

    solid = grid(W, H, FREE)
    for y in range(H):
        for x in range(W):
            if bid[y][x] >= 0:
                solid[y][x] = BUILDING

    # ---- 4. 遮蔽物 ----
    rng = random.Random(SEED)
    covers = []

    def place(x, y, w, h, kind):
        if x < 1 or y < 1 or x + w >= W - 1 or y + h >= H - 1:
            return False
        for yy in range(y - 1, y + h + 1):
            for xx in range(x - 1, x + w + 1):
                if solid[yy][xx] != FREE:
                    return False
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                solid[yy][xx] = COVER
        covers.append(dict(kind=kind, x=x, y=y, w=w, h=h))
        return True

    # 細い道の路肩に車を停める
    curb = []
    for y in range(2, H - 2):
        for x in range(2, W - 2):
            if road[y][x] != 1:
                continue
            d = road_dir[y][x]
            if d == HORIZ and (ground[y - 1][x] != ROAD or ground[y + 1][x] != ROAD):
                curb.append((x, y, d, -1 if ground[y - 1][x] != ROAD else 1))
            elif d == VERT and (ground[y][x - 1] != ROAD or ground[y][x + 1] != ROAD):
                curb.append((x, y, d, -1 if ground[y][x - 1] != ROAD else 1))
    rng.shuffle(curb)
    cars = []
    for x, y, d, side in curb:
        if any(abs(x - cx) + abs(y - cy) < 26 for cx, cy in cars):
            continue
        if rng.random() < 0.6:
            continue
        if d == HORIZ:
            ok = place(x - 2, y if side < 0 else y - 1, 4, 2, "car")
        else:
            ok = place(x if side < 0 else x - 1, y - 2, 2, 4, "car")
        if ok:
            cars.append((x, y))

    for _ in range(W * H // 900):
        x, y = rng.randrange(2, W - 2), rng.randrange(2, H - 2)
        if solid[y][x] != FREE or ground[y][x] not in (SIDEWALK, LOT):
            continue
        if any(solid[y + j][x + i] == BUILDING for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            place(x, y, 1, 1, "vending")

    for _ in range(W * H // 1400):
        x, y = rng.randrange(2, W - 4), rng.randrange(2, H - 4)
        if ground[y][x] in (LOT, DIRT, GREEN):
            if rng.random() < 0.5:
                place(x, y, 3, 1, "barrier")
            else:
                place(x, y, 1, 3, "barrier")

    # 建物ごとに長方形へまとめる（描画用）
    rects_by_b = {}
    done = grid(W, H, False)
    for y in range(H):
        for x in range(W):
            b = bid[y][x]
            if b < 0 or done[y][x]:
                continue
            w = 1
            while x + w < W and bid[y][x + w] == b and not done[y][x + w]:
                w += 1
            h = 1
            while y + h < H and all(bid[y + h][x + k] == b and not done[y + h][x + k] for k in range(w)):
                h += 1
            for yy in range(y, y + h):
                for xx in range(x, x + w):
                    done[yy][xx] = True
            rects_by_b.setdefault(b, []).append([x, y, w, h])

    out_b = []
    for b, rects in rects_by_b.items():
        bb = buildings[b]
        out_b.append(dict(kind=bb["kind"], h=round(bb["h"], 1), rects=rects))

    flat_ground = bytes(v for row in ground for v in row)
    flat_solid = bytes(v for row in solid for v in row)
    out = dict(
        name="秋葉原・佐久間町",
        width=W, height=H, cell=1,
        attribution="© OpenStreetMap contributors (ODbL)",
        ground=base64.b64encode(flat_ground).decode(),
        solid=base64.b64encode(flat_solid).decode(),
        buildings=out_b,
        covers=covers,
    )
    with open(dst, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{W0}x{H0} → {W}x{H}（列 {len(cut_cols)}・行 {len(cut_rows)} を切り詰め）"
          f" buildings={len(out_b)} rects={sum(len(b['rects']) for b in out_b)} covers={len(covers)}")

    if preview:
        colors = {LOT: (150, 150, 140), ROAD: (60, 60, 65), SIDEWALK: (185, 180, 170),
                  GREEN: (90, 140, 80), VIADUCT: (110, 95, 80), DIRT: (160, 130, 90)}
        raw = bytearray()
        for y in range(H):
            raw.append(0)
            for x in range(W):
                if solid[y][x] == BUILDING:
                    raw += bytes((200, 120, 90))
                elif solid[y][x] == COVER:
                    raw += bytes((240, 220, 60))
                else:
                    raw += bytes(colors[ground[y][x]])

        def chunk(tag, body):
            c = struct.pack(">I", len(body)) + tag + body
            return c + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
        png += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
        open(preview, "wb").write(png)


if __name__ == "__main__":
    main()
