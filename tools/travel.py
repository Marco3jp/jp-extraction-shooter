"""移動の設備（固定レールとダッシュパッド）を、道の線から置く。座標は変換の格子のもの"""
import math

# 固定レールを敷く道の幅（m）の下限。ダッシュパッドはこれより細い道に置く
RAIL_ROAD_MIN = 9
# ダッシュパッドを置かない道
PAD_SKIP = {"service"}
# 固定レールの長さ（m）。長い直線は RAIL_MAX 以下に等分し、RAIL_MIN より短い切れ端は捨てる
RAIL_MIN = 50
RAIL_MAX = 240
# レールの端からこの距離までに別のレールと交わるなら、端を交わる所まで動かす。乗り継げるように
RAIL_SNAP = 25
# 上り下りが別の way になっている道を1本にまとめる、2本の間隔（m）の上限
TWIN_GAP = 26
# ダッシュパッドを置く直線の長さの下限、パッドの間隔、飛ぶ距離（src/data/travel.ts の DASH_PAD.distance と揃える）
PAD_RUN_MIN = 60
PAD_SPACING = 40
PAD_JUMP = 30
# パッドどうしをこれより近くに置かない（交わる道のパッド）
PAD_APART = 8

# 直線とみなす、道の線からのずれの上限（m）。way どうしをつなぐときの曲がりの上限（度）
STRAIGHT_TOL = 1.5
CHAIN_DEG = 35
FREE, OUTSIDE = 0, 255


def _rdp(pts, tol):
    if len(pts) < 3:
        return pts
    (ax, ay), (bx, by) = pts[0], pts[-1]
    dx, dy = bx - ax, by - ay
    ll = math.hypot(dx, dy) or 1e-9
    far, fi = -1.0, 0
    for i in range(1, len(pts) - 1):
        d = abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / ll
        if d > far:
            far, fi = d, i
    if far <= tol:
        return [pts[0], pts[-1]]
    return _rdp(pts[:fi + 1], tol)[:-1] + _rdp(pts[fi:], tol)


def _heading(a, b):
    return math.atan2(b[1] - a[1], b[0] - a[0])


def _turn(h1, h2):
    d = (h2 - h1 + math.pi) % (2 * math.pi) - math.pi
    return abs(d)


def _length(r):
    return math.hypot(r[1][0] - r[0][0], r[1][1] - r[0][1])


def _chains(polylines):
    """way の境目で、向きを大きく変えずにつながる線どうしをつなぐ"""
    lim = math.radians(CHAIN_DEG)
    lines = [list(p) for p in polylines if len(p) >= 2]
    merged = True
    while merged:
        merged = False
        for i in range(len(lines)):
            for j in range(len(lines)):
                if i == j:
                    continue
                for a in (lines[i], lines[i][::-1]):
                    for b in (lines[j], lines[j][::-1]):
                        if math.hypot(a[-1][0] - b[0][0], a[-1][1] - b[0][1]) > 2:
                            continue
                        if _turn(_heading(a[-2], a[-1]), _heading(b[0], b[1])) > lim:
                            continue
                        lines[i] = a + b[1:]
                        lines.pop(j)
                        merged = True
                        break
                    if merged:
                        break
                if merged:
                    break
            if merged:
                break
    return lines


def _straight_runs(polylines):
    """道の線をつないでから、線からのずれが STRAIGHT_TOL 以内の直線（始点, 終点）に分ける"""
    runs = []
    for pts in _chains(polylines):
        pts = _rdp(pts, STRAIGHT_TOL)
        runs += [(a, b) for a, b in zip(pts, pts[1:]) if _length((a, b)) > 1]
    return runs


def _project(p, r):
    """r の線の上での位置（始点からの m）と、線からの横のずれ（左が負）"""
    (ax, ay), (bx, by) = r
    ll = _length(r) or 1e-9
    ux, uy = (bx - ax) / ll, (by - ay) / ll
    px, py = p[0] - ax, p[1] - ay
    return px * ux + py * uy, px * uy - py * ux


def _merge_twins(runs):
    """上り下りが別の way になっている道を、長いほうを2本の真ん中へずらした1本にする"""
    runs = sorted(runs, key=lambda r: -_length(r))
    kept = []
    for r in runs:
        twin = None
        for k, (base, shifted) in enumerate(kept):
            # 向きがそろっていない（逆向きは同じとみなす）
            if math.sin(_turn(_heading(*base), _heading(*r))) > 0.17:
                continue
            s0, d0 = _project(r[0], base)
            s1, d1 = _project(r[1], base)
            if abs(d0) > TWIN_GAP or abs(d1) > TWIN_GAP:
                continue
            lo, hi = max(0, min(s0, s1)), min(_length(base), max(s0, s1))
            if hi - lo < 0.5 * _length(r):
                continue
            twin = (k, (d0 + d1) / 2)
            break
        if twin is None:
            kept.append((r, False))
            continue
        k, off = twin
        base, shifted = kept[k]
        if shifted or abs(off) < 2:
            continue
        ll = _length(base)
        nx, ny = (base[1][1] - base[0][1]) / ll, -(base[1][0] - base[0][0]) / ll
        h = off / 2
        kept[k] = (((base[0][0] + nx * h, base[0][1] + ny * h), (base[1][0] + nx * h, base[1][1] + ny * h)), True)
    return [r for r, _ in kept]


def _free_spans(r, ok, half):
    """r の線に沿って、幅 half*2 が通れる区間を (始点, 終点) で返す"""
    ll = _length(r)
    (ax, ay), (bx, by) = r
    ux, uy = (bx - ax) / ll, (by - ay) / ll
    spans = []
    cur = None
    n = int(ll / 0.5)
    for i in range(n + 1):
        s = min(ll, i * 0.5)
        x, y = ax + ux * s, ay + uy * s
        good = all(ok(x + uy * o, y - ux * o) for o in (-half, 0, half))
        if good and cur is None:
            cur = s
        elif not good and cur is not None:
            spans.append((cur, s - 0.5))
            cur = None
    if cur is not None:
        spans.append((cur, ll))
    return [((ax + ux * s0, ay + uy * s0), (ax + ux * s1, ay + uy * s1)) for s0, s1 in spans]


def _cross(r1, r2):
    """2本の線分が交わる所の、r1 の上での位置（m）。交わらなければ None"""
    (x1, y1), (x2, y2) = r1
    (x3, y3), (x4, y4) = r2
    den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(den) < 1e-9:
        return None
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
    u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den
    if -0.02 <= t <= 1.02 and -0.02 <= u <= 1.02:
        return t * _length(r1)
    return None


def _point(r, s):
    ll = _length(r) or 1e-9
    return (r[0][0] + (r[1][0] - r[0][0]) * s / ll, r[0][1] + (r[1][1] - r[0][1]) * s / ll)


def _split_rails(lines, line_ok):
    """交わる所で切り、長いものは等分する。端の近くで交わるなら端をそこへ動かす"""
    out = []
    for i, r in enumerate(lines):
        ll = _length(r)
        cuts = sorted(s for j, o in enumerate(lines) if j != i for s in [_cross(r, o)] if s is not None)
        start, end = 0.0, ll
        mid = []
        for s in cuts:
            if s < RAIL_SNAP:
                start = max(start, s)
            elif s > ll - RAIL_SNAP:
                end = min(end, s)
            else:
                mid.append(s)
        # 交わる所が端の少し外なら、そこまで伸ばす
        for j, o in enumerate(lines):
            if j == i:
                continue
            for k, e in ((0, r[0]), (1, r[1])):
                s, d = _project(e, o)
                if not (0 <= s <= _length(o)) or abs(d) > RAIL_SNAP:
                    continue
                hit = _point(o, s)
                along, side = _project(hit, r)
                if abs(side) > 1.5 or not line_ok(e, hit):
                    continue
                if k == 0 and -RAIL_SNAP <= along < start + 0.01:
                    start = along
                if k == 1 and end - 0.01 < along <= ll + RAIL_SNAP:
                    end = along
        pts = [start]
        for s in mid:
            if s - pts[-1] >= RAIL_MIN * 0.6 and end - s >= RAIL_MIN * 0.6:
                pts.append(s)
        pts.append(end)
        for a, b in zip(pts, pts[1:]):
            n = max(1, math.ceil((b - a) / RAIL_MAX))
            for k in range(n):
                s0, s1 = a + (b - a) * k / n, a + (b - a) * (k + 1) / n
                if s1 - s0 >= RAIL_MIN:
                    out.append((_point(r, s0), _point(r, s1)))
    return out


def place_travel(W, H, ground, solid, road_lines):
    """road_lines は (道の種類, 幅, 点の列, 名前)。固定レール [[ax, ay, bx, by]] とダッシュパッド [[x, y, 向き]] を返す"""
    def ok(x, y):
        xi, yi = int(x), int(y)
        return 0 <= xi < W and 0 <= yi < H and solid[yi][xi] == FREE and ground[yi][xi] != OUTSIDE

    def line_ok(a, b):
        ll = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(ll / 0.5))
        return all(ok(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(n + 1))

    wide = [pts for hw, w, pts, _ in road_lines if w >= RAIL_ROAD_MIN]
    lines = []
    for r in _merge_twins(_straight_runs(wide)):
        lines += [s for s in _free_spans(r, ok, 0.6) if _length(s) >= RAIL_MIN]
    rails = _split_rails(lines, line_ok)

    narrow = [pts for hw, w, pts, _ in road_lines if w < RAIL_ROAD_MIN and hw not in PAD_SKIP]
    pads = []
    for r in _straight_runs(narrow):
        for s in _free_spans(r, ok, 0.5):
            ll = _length(s)
            if ll < PAD_RUN_MIN:
                continue
            # 両向きに PAD_JUMP 飛んでも直線の中に降りる所だけに置く
            n = int((ll - 2 * (PAD_JUMP - 5)) / PAD_SPACING) + 1
            first = (ll - PAD_SPACING * (n - 1)) / 2
            ang = _heading(*s)
            for k in range(n):
                x, y = _point(s, first + PAD_SPACING * k)
                if any((x - p[0]) ** 2 + (y - p[1]) ** 2 < PAD_APART ** 2 for p in pads):
                    continue
                pads.append([x, y, ang])
    return dict(rails=[[a[0], a[1], b[0], b[1]] for a, b in rails], pads=pads)
