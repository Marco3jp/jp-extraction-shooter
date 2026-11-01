"""脱出地点を、公園・駅前・大きな交差点のうち開けた場所から、町ごとに1〜2か所選ぶ。座標は変換の格子のもの"""
FREE, OUTSIDE = 0, 255
GREEN = 3
STATION_SIGN = "station"

# 大きな交差点とみなす、交わる道の幅（m）の下限
JUNCTION_ROAD = 11
# この広さ（㎡）より小さい公園は候補にしない
PARK_MIN = 150
# 候補の点からこの距離（m）までの中で、一番開けたマスに置く
SEARCH = 16
# 開け具合は、この半径（m）の四角の中の空いているマスの割合で測る。下限に満たない候補は捨てる
OPEN_R = 8
OPEN_MIN = 0.7
# 候補の種類ごとに開け具合へ足す点。駅前を一番に選ぶ
KIND_BONUS = {"station": 0.2, "park": 0.1, "junction": 0.0}
# 脱出地点どうしの間隔と、出発地点からの距離（m）の下限
GAP = 180
START_GAP = 120
PER_AREA = 2
# 固定レールの端・ダッシュパッドからこの距離（m）以内には置かない。
# 脱出地点の上で E を押すとレールより迎えを呼ぶほうが先に決まり、乗れなくなるので
RAIL_END_CLEAR = 10
PAD_CLEAR = 6


def place_extracts(W, H, ground, solid, road_lines, features, travel, start):
    """[(x, y, 種類, 町名)] を返す"""
    stride = W + 1
    pre = [0] * (stride * (H + 1))
    for y in range(H):
        row_s, row_g = solid[y], ground[y]
        acc = 0
        base, up = (y + 1) * stride, y * stride
        for x in range(W):
            acc += row_s[x] == FREE and row_g[x] != OUTSIDE
            pre[base + x + 1] = pre[up + x + 1] + acc

    def openness(x, y):
        x0, y0, x1, y1 = max(0, x - OPEN_R), max(0, y - OPEN_R), min(W, x + OPEN_R + 1), min(H, y + OPEN_R + 1)
        s = pre[y1 * stride + x1] - pre[y0 * stride + x1] - pre[y1 * stride + x0] + pre[y0 * stride + x0]
        return s / (2 * OPEN_R + 1) ** 2

    blockers = [((r[0], r[1]), RAIL_END_CLEAR) for r in travel["rails"]]
    blockers += [((r[2], r[3]), RAIL_END_CLEAR) for r in travel["rails"]]
    blockers += [((p[0], p[1]), PAD_CLEAR) for p in travel["pads"]]

    def usable(x, y):
        if not (0 <= x < W and 0 <= y < H) or solid[y][x] != FREE or ground[y][x] == OUTSIDE:
            return False
        return all((x + 0.5 - b[0]) ** 2 + (y + 0.5 - b[1]) ** 2 > r * r for b, r in blockers)

    def settle(px, py):
        """候補の点の近くで、一番開けたマスと開け具合を返す"""
        best = None
        cx, cy = int(px), int(py)
        for y in range(cy - SEARCH, cy + SEARCH + 1, 2):
            for x in range(cx - SEARCH, cx + SEARCH + 1, 2):
                if (x - cx) ** 2 + (y - cy) ** 2 > SEARCH * SEARCH or not usable(x, y):
                    continue
                o = openness(x, y)
                if best is None or o > best[2]:
                    best = (x + 0.5, y + 0.5, o)
        return best

    seeds = []
    for s in features["signs"]:
        if s["kind"] == STATION_SIGN:
            seeds.append((s["x"], s["y"], "station"))

    seen = [[False] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            if seen[y][x] or ground[y][x] != GREEN:
                continue
            comp, stack = [], [(x, y)]
            seen[y][x] = True
            while stack:
                cx, cy = stack.pop()
                comp.append((cx, cy))
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < W and 0 <= ny < H and not seen[ny][nx] and ground[ny][nx] == GREEN:
                        seen[ny][nx] = True
                        stack.append((nx, ny))
            if len(comp) >= PARK_MIN:
                sx = sum(c[0] for c in comp) / len(comp)
                sy = sum(c[1] for c in comp) / len(comp)
                seeds.append((sx, sy, "park"))

    at = {}
    for ri, (_, w, pts, _) in enumerate(road_lines):
        if w < JUNCTION_ROAD:
            continue
        for p in pts:
            at.setdefault((round(p[0], 1), round(p[1], 1)), set()).add(ri)
    for (x, y), roads in at.items():
        if len(roads) >= 2:
            seeds.append((x, y, "junction"))

    areas = features["areas"]

    def area_of(x, y):
        if not areas:
            return None
        return min(areas, key=lambda a: (a["x"] - x) ** 2 + (a["y"] - y) ** 2)["name"]

    cands = []
    for sx, sy, kind in seeds:
        p = settle(sx, sy)
        if p and p[2] >= OPEN_MIN:
            cands.append((p[2] + KIND_BONUS[kind], p[0], p[1], kind, area_of(p[0], p[1])))
    cands.sort(key=lambda c: (-c[0], c[1], c[2]))

    picked = []
    count = {}

    def take(c):
        _, x, y, kind, area = c
        if (x - start[0]) ** 2 + (y - start[1]) ** 2 < START_GAP ** 2:
            return False
        if any((x - q[0]) ** 2 + (y - q[1]) ** 2 < GAP ** 2 for q in picked):
            return False
        picked.append((x, y, kind, area))
        count[area] = count.get(area, 0) + 1
        return True

    # 先に町ごとに1か所ずつ置いてから、2か所目を足す。点の高い町から置くと、隣の町の候補を潰してしまうので
    for c in cands:
        if count.get(c[4], 0) == 0:
            take(c)
    for c in cands:
        if count.get(c[4], 0) < PER_AREA:
            take(c)
    return picked
