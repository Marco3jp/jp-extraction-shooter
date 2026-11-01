"""OpenStreetMap の JSON（Overpass の out geom）を、ゲーム用の 1m グリッドのマップに変換する。

細かすぎる模様はならし、似た街並みが続くところは縦横の帯ごと切り詰める。
大通り・鉄道・公園・大きな建物は「残す場所」として、その縦横の比率を変えない。

使い方:
  python3 -I tools/osm_to_map.py tools/maps/akihabara.json [--preview preview.png]
"""
import base64
import json
import math
import os
import random
import re
import struct
import sys
import zlib
from collections import Counter

# -I で起動するとスクリプトの置き場所が import の検索先から外れるので、tools/ だけを足す
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from buildings import ZONE_OF_LANDUSE, classify, clean_road_name, clean_station_name, is_station  # noqa: E402

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
    cfg = json.load(open(sys.argv[1]))
    preview = sys.argv[sys.argv.index("--preview") + 1] if "--preview" in sys.argv else None
    BBOX = cfg["bbox"]
    data = json.load(open(cfg["raw"]))
    elements = [e for e in data["elements"] if e["type"] == "way"]
    nodes = [e for e in data["elements"] if e["type"] == "node"]

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
    zone = grid(W, H, None)
    for e in elements:
        t = e.get("tags", {})
        pts = [proj(p) for p in e.get("geometry", [])]
        if len(pts) < 3:
            continue
        z = ZONE_OF_LANDUSE.get(t.get("landuse", ""))
        if z:
            def zf(x, y, z=z):
                zone[y][x] = z
            fill_poly(pts, zf)
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
            road_lines.append((hw, ROAD_WIDTH[hw], pts, clean_road_name(t.get("name"))))
        elif hw == "pedestrian":
            def s(x, y):
                ground[y][x] = SIDEWALK
            for a, b in zip(pts, pts[1:]):
                stroke_seg(a, b, 5, s)

    for hw, w, pts, _ in road_lines:
        def side(x, y):
            if ground[y][x] != ROAD:
                ground[y][x] = SIDEWALK
        for a, b in zip(pts, pts[1:]):
            stroke_seg(a, b, w + 3, side)
    for hw, w, pts, _ in road_lines:
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
        try:
            levels = float(t.get("building:levels"))
            h = levels * 3.2
        except (TypeError, ValueError):
            levels = None
            h = {"house": 7, "detached": 7, "apartments": 14, "residential": 10,
                 "commercial": 16, "retail": 9, "office": 18, "hotel": 20}.get(b, 9)
        buildings.append(dict(
            kind=b, h=h, tags=t, levels=levels, area=len(cells), pois=[],
            cx=sum(p[0] for p in pts) / len(pts), cy=sum(p[1] for p in pts) / len(pts),
        ))
        if cells and (len(cells) >= LANDMARK_BUILDING_AREA or (b == "train_station" and len(cells) >= LANDMARK_STATION_AREA)):
            xs = [c[0] for c in cells]
            ys = [c[1] for c in cells]
            keep_box(min(xs), min(ys), max(xs), max(ys))

    # お店・施設の点を、その点がある建物に結び付ける。歩道に食い込んで建物から外れた点は近くの建物へ
    for n in nodes:
        x, y = proj(n)
        found = -1
        for r in range(4):
            for j in range(-r, r + 1):
                for i in range(-r, r + 1):
                    xx, yy = int(x) + i, int(y) + j
                    if found < 0 and 0 <= xx < W and 0 <= yy < H and bid[yy][xx] >= 0:
                        found = bid[yy][xx]
            if found >= 0:
                break
        if found >= 0:
            buildings[found]["pois"].append(n.get("tags", {}))

    def zone_at(x, y):
        xi, yi = int(x), int(y)
        return zone[yi][xi] if 0 <= xi < W and 0 <= yi < H else None

    classify(buildings, zone_at)

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
    rng = random.Random(cfg["seed"])
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

    # 道に面した側。0:北 1:東 2:南 3:西
    def front_of(b):
        sides = [0, 0, 0, 0]
        for x, y, w, h in rects_by_b[b]:
            for yy in range(y, y + h):
                for xx in range(x, x + w):
                    for s, (dx, dy) in enumerate(((0, -1), (1, 0), (0, 1), (-1, 0))):
                        nx, ny = xx + dx, yy + dy
                        if 0 <= nx < W and 0 <= ny < H and bid[ny][nx] != b and ground[ny][nx] in (ROAD, SIDEWALK):
                            sides[s] += 1
        return max(range(4), key=lambda s: (sides[s], s == 2))

    out_b = []
    for b, rects in rects_by_b.items():
        bb = buildings[b]
        out_b.append(dict(kind=bb["kind"], type=bb["type"], h=round(bb["h"], 1), front=front_of(b), rects=rects))

    features = place_features(
        cfg, W0, H0, W, H, keep_cols, keep_rows, ground, solid, road_lines, buildings, rects_by_b, nodes, proj,
    )

    flat_ground = bytes(v for row in ground for v in row)
    flat_solid = bytes(v for row in solid for v in row)
    out = dict(
        name=cfg["name"],
        width=W, height=H, cell=1,
        attribution="© OpenStreetMap contributors (ODbL)",
        layout=cfg["layout"],
        ground=base64.b64encode(flat_ground).decode(),
        solid=base64.b64encode(flat_solid).decode(),
        buildings=out_b,
        covers=covers,
        **features,
    )
    with open(cfg["out"], "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    types = Counter(b["type"] for b in out_b)
    m = features["markings"]
    print(f"{W0}x{H0} → {W}x{H}（列 {len(cut_cols)}・行 {len(cut_rows)} を切り詰め）"
          f" buildings={len(out_b)} rects={sum(len(b['rects']) for b in out_b)} covers={len(covers)}")
    print("建物の種類:", dict(types.most_common()))
    print(f"横断歩道 {len(m['crosswalks'])} 停止線 {len(m['stops'])} 中央線 {len(m['lines'])} マンホール {len(m['manholes'])}"
          f" 標識 {len(features['signs'])} 町名 {[a['name'] for a in features['areas']]}")

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



# 交差点の外側に横断歩道を描く道の幅（m）。これより細い道どうしの交差点には描かない
CROSSWALK_ROAD = 9
# 中央線を描く道の幅。SOLID_CENTER 以上は実線、それ未満は破線
CENTER_LINE_ROAD = 9
SOLID_CENTER = 14
# 停止線と「止まれ」は、この幅以下の道が CROSSWALK_ROAD 以上の道に出る所に描く
STOP_ROAD = 6
MANHOLE_RATE = 1 / 220
# 同じ通りの名前の標識どうしを、少なくともこれだけ離す（m）
SIGN_SPACING = 70
PLACE_KINDS = ("quarter", "neighbourhood", "suburb")
# マップの外で町名の中心として採る距離（m）
PLACE_MARGIN_M = 150
# 私道や駐車場の通路に付いた名前は標識に出さない
UNSIGNED_ROADS = {"service", "living_street"}


def place_features(cfg, W0, H0, W, H, keep_cols, keep_rows, ground, solid, road_lines, buildings, rects_by_b, nodes, proj):
    """地面の表示・標識・町名を、縮めた後の座標で返す"""
    rng = random.Random(cfg["seed"] + 1)

    def axis_map(keep, n0):
        kept = set(keep)
        before = [0] * (n0 + 1)
        for i in range(n0):
            before[i + 1] = before[i] + (1 if i in kept else 0)

        def f(v):
            i = min(n0 - 1, max(0, int(math.floor(v))))
            return before[i] + ((v - i) if i in kept else 0.0)
        return f

    mx_, my_ = axis_map(keep_cols, W0), axis_map(keep_rows, H0)

    def mp(p):
        return (mx_(p[0]), my_(p[1]))

    def ground_at(p):
        x, y = int(p[0]), int(p[1])
        return ground[y][x] if 0 <= x < W and 0 <= y < H else None

    def free_walk(p):
        x, y = int(p[0]), int(p[1])
        return 0 <= x < W and 0 <= y < H and solid[y][x] == FREE and ground[y][x] in (SIDEWALK, LOT)

    def mapped_angle(p, u):
        a = mp(p)
        b = mp((p[0] + u[0], p[1] + u[1]))
        dx, dy = b[0] - a[0], b[1] - a[1]
        return math.atan2(dy, dx) if dx * dx + dy * dy > 0.04 else math.atan2(u[1], u[0])

    # 交差点：2本以上の道が同じ点を通る所
    at = {}
    for ri, (_, _, pts, _) in enumerate(road_lines):
        for k, p in enumerate(pts):
            at.setdefault((round(p[0], 1), round(p[1], 1)), []).append((ri, k))
    junctions = []
    for key, refs in at.items():
        if len({ri for ri, _ in refs}) < 2:
            continue
        arms = []
        for ri, k in refs:
            hw, w, pts, name = road_lines[ri]
            for step in (-1, 1):
                # 交差点の近くで点が細かく区切られていることが多いので、道の終わりまでの長さを測る
                ln, nb = 0.0, k
                while 0 <= nb + step < len(pts):
                    ln += math.hypot(pts[nb + step][0] - pts[nb][0], pts[nb + step][1] - pts[nb][1])
                    nb += step
                if ln < 1:
                    continue
                far = pts[k + step]
                i = k + step
                while math.hypot(far[0] - pts[k][0], far[1] - pts[k][1]) < 4 and 0 <= i + step < len(pts):
                    i += step
                    far = pts[i]
                dx, dy = far[0] - pts[k][0], far[1] - pts[k][1]
                dl = math.hypot(dx, dy) or 1
                arms.append(dict(u=(dx / dl, dy / dl), w=w, len=ln, name=name if hw not in UNSIGNED_ROADS else None, road=ri))
        if len(arms) >= 3:
            junctions.append(dict(p=key, arms=arms, r=max(a["w"] for a in arms) / 2))

    crosswalks, stops = [], []
    for j in junctions:
        widest = max(a["w"] for a in j["arms"])
        P, r = j["p"], j["r"]
        for a in j["arms"]:
            u = a["u"]
            crossed = False
            if widest >= CROSSWALK_ROAD and a["w"] >= STOP_ROAD and a["len"] > r + 5:
                c = (P[0] + u[0] * (r + 2.5), P[1] + u[1] * (r + 2.5))
                mc = mp(c)
                ang = mapped_angle(c, u)
                # 中央分離帯のある道は上下線が別の道なので、同じ所に2本重なる。近くて向きが同じものは1本にする
                dup = any((o["x"] - mc[0]) ** 2 + (o["y"] - mc[1]) ** 2 < 4.5 ** 2
                          and abs(math.sin(o["angle"] - ang)) < 0.35 for o in crosswalks)
                if ground_at(mc) == ROAD and not dup:
                    crosswalks.append(dict(x=round(mc[0], 2), y=round(mc[1], 2), angle=round(ang, 3), len=a["w"]))
                crossed = ground_at(mc) == ROAD
            others = max((o["w"] for o in j["arms"] if o["road"] != a["road"]), default=0)
            # 横断歩道があれば、停止線はその手前に引く
            sd = r + (4.8 if crossed else 1.2)
            if a["w"] <= STOP_ROAD and others >= CROSSWALK_ROAD and a["len"] > sd + 5:
                c = (P[0] + u[0] * sd, P[1] + u[1] * sd)
                mc = mp(c)
                if ground_at(mc) == ROAD:
                    stops.append(dict(x=round(mc[0], 2), y=round(mc[1], 2), angle=round(mapped_angle(c, u), 3), len=a["w"]))

    # 中央線：交差点の中と、その手前の横断歩道の所は描かない
    jr = [(j["p"], j["r"] + 5) for j in junctions]
    lines = []
    for hw, w, pts, _ in road_lines:
        if w < CENTER_LINE_ROAD:
            continue
        run = []

        def flush():
            if len(run) >= 3:
                lines.append(dict(pts=[[round(q[0], 2), round(q[1], 2)] for q in run], dash=w < SOLID_CENTER))
            run.clear()

        for a, b in zip(pts, pts[1:]):
            ln = math.hypot(b[0] - a[0], b[1] - a[1])
            n = max(1, int(ln))
            for i in range(n + 1):
                q = (a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n)
                near = any((q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2 < rr * rr for c, rr in jr)
                mq = mp(q)
                if near or ground_at(mq) != ROAD:
                    flush()
                elif not run or (mq[0] - run[-1][0]) ** 2 + (mq[1] - run[-1][1]) ** 2 > 0.25:
                    run.append(mq)
        flush()

    manholes = []
    for y in range(2, H - 2):
        for x in range(2, W - 2):
            if ground[y][x] == ROAD and solid[y][x] == FREE and rng.random() < MANHOLE_RATE:
                manholes.append([x + 0.5, y + 0.5])

    signs = []
    placed = {}
    for j in junctions:
        names = []
        for a in sorted(j["arms"], key=lambda a: -a["w"]):
            if a["name"] and a["name"] not in names:
                names.append(a["name"])
        names = [n for n in names if all((j["p"][0] - q[0]) ** 2 + (j["p"][1] - q[1]) ** 2 > SIGN_SPACING ** 2 for q in placed.get(n, []))]
        if not names:
            continue
        P, d = j["p"], j["r"] + 1.8
        # 手前（南）の角から探す。カメラから見えやすいので
        for sx, sy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
            mpos = mp((P[0] + sx * d, P[1] + sy * d))
            if free_walk(mpos):
                signs.append(dict(kind="street", x=round(mpos[0], 2), y=round(mpos[1], 2), text=names[:2]))
                for n in names[:2]:
                    placed.setdefault(n, []).append(P)
                break

    # 駅名標：駅の建物の、道に面した側の外
    stations = []
    for b, rects in rects_by_b.items():
        bb = buildings[b]
        if bb["type"] != "station":
            continue
        name = clean_station_name(bb["tags"].get("name"))
        for p in bb["pois"]:
            if not name and is_station(p):
                name = clean_station_name(p.get("name"))
        if not name:
            continue
        xs = [r[0] for r in rects] + [r[0] + r[2] for r in rects]
        ys = [r[1] for r in rects] + [r[1] + r[3] for r in rects]
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        cands = [(cx, max(ys) + 1.5), (cx, min(ys) - 1.5), (max(xs) + 1.5, cy), (min(xs) - 1.5, cy)]
        for c in cands:
            if free_walk(c) and not any(s["text"] == [name] and (s["x"] - c[0]) ** 2 + (s["y"] - c[1]) ** 2 < 60 ** 2 for s in stations):
                stations.append(dict(kind="station", x=round(c[0], 2), y=round(c[1], 2), text=[name]))
                break

    # 町名：「外神田三丁目」は「外神田」にまとめる
    by_name = {}
    for n in nodes:
        t = n.get("tags", {})
        if t.get("place") not in PLACE_KINDS or not t.get("name"):
            continue
        name = re.sub(r"[一二三四五六七八九十0-9０-９]+丁目$", "", t["name"]).strip()
        px, py = proj(n)
        # 遠くの町の中心は、マップの端で一番近い町名になってしまうので入れない
        if not (-PLACE_MARGIN_M <= px <= W0 + PLACE_MARGIN_M and -PLACE_MARGIN_M <= py <= H0 + PLACE_MARGIN_M):
            continue
        x, y = mp((px, py))
        by_name.setdefault(name, []).append((x, y))
    areas = [dict(name=k, x=round(sum(p[0] for p in v) / len(v), 1), y=round(sum(p[1] for p in v) / len(v), 1)) for k, v in by_name.items()]

    return dict(
        markings=dict(crosswalks=crosswalks, stops=stops, lines=lines, manholes=manholes),
        signs=signs + stations,
        areas=areas,
    )

if __name__ == "__main__":
    main()
