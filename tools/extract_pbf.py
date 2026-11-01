"""Geofabrik の地域ファイル（.osm.pbf）から、マップの範囲を切り出す。

出力は fetch_osm.py（Overpass API）と同じ形の JSON で、osm_to_map.py がそのまま読める。
osmium-tool を使う。

使い方:
  python3 -I tools/extract_pbf.py tools/maps/akihabara.json tools/osm-raw/kanto-261031.osm.pbf [--out 出力先]
"""
import json
import os
import subprocess
import sys
import tempfile

# fetch_osm.py の取得条件と揃える
WAY_KEYS = ("building", "highway", "landuse", "leisure", "railway", "amenity", "shop")
NODE_KEYS = ("shop", "amenity", "tourism", "office", "healthcare", "craft", "place")
# 地名の点は範囲のすぐ外にあることが多いので、少し広く取る
PLACE_MARGIN = 0.004


def node_wanted(t):
    return any(k in t for k in NODE_KEYS) or t.get("railway") == "station" or t.get("public_transport") == "station"


def seg_hits_box(a, b, box):
    """線分 a-b が範囲に掛かるか。a・b は (lon, lat)"""
    w, s, e, n = box
    if w <= a[0] <= e and s <= a[1] <= n:
        return True
    # 線分を少しずつ進めて調べる。範囲の幅に比べて十分細かければ取りこぼさない
    steps = max(1, int(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / 0.0002))
    for i in range(1, steps + 1):
        x = a[0] + (b[0] - a[0]) * i / steps
        y = a[1] + (b[1] - a[1]) * i / steps
        if w <= x <= e and s <= y <= n:
            return True
    return False


def line_hits_box(coords, box):
    return any(seg_hits_box(a, b, box) for a, b in zip(coords, coords[1:])) or (len(coords) == 1 and seg_hits_box(coords[0], coords[0], box))


def run(cmd):
    subprocess.run(cmd, check=True)


def main():
    cfg = json.load(open(sys.argv[1]))
    pbf = sys.argv[2]
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else cfg["raw"]
    b = cfg["bbox"]
    box = (b["west"], b["south"], b["east"], b["north"])
    m = PLACE_MARGIN
    wide = (box[0] - m, box[1] - m, box[2] + m, box[3] + m)

    with tempfile.TemporaryDirectory() as tmp:
        cut = os.path.join(tmp, "cut.pbf")
        filtered = os.path.join(tmp, "filtered.pbf")
        seq = os.path.join(tmp, "out.geojsonseq")
        # smart は、範囲に掛かる way と multipolygon を、範囲の外の部分まで含めて丸ごと取る
        run(["osmium", "extract", "-b", ",".join(map(str, wide)), "-s", "smart", "-O", "-o", cut, pbf])
        run(["osmium", "tags-filter", "-O", "-o", filtered, cut,
             "w/" + ",".join(WAY_KEYS), "r/" + ",".join(WAY_KEYS),
             "n/" + ",".join(NODE_KEYS), "n/railway=station", "n/public_transport=station"])
        run(["osmium", "export", "-O", "--add-unique-id=type_id", "-f", "geojsonseq", "-o", seq, filtered])

        lines, areas, nodes = {}, [], []
        with open(seq) as f:
            for raw in f:
                feat = json.loads(raw.strip().lstrip("\x1e"))
                fid, geom, tags = feat["id"], feat["geometry"], feat.get("properties") or {}
                kind, num = fid[0], int(fid[1:])
                if kind == "n":
                    lon, lat = geom["coordinates"]
                    area = wide if "place" in tags else box
                    if node_wanted(tags) and area[0] <= lon <= area[2] and area[1] <= lat <= area[3]:
                        nodes.append(dict(type="node", id=num, lat=lat, lon=lon, tags=tags))
                elif kind == "w" and geom["type"] == "LineString":
                    if any(k in tags for k in WAY_KEYS) and line_hits_box(geom["coordinates"], box):
                        lines[num] = dict(type="way", id=num, tags=tags, coords=geom["coordinates"])
                elif kind == "a":
                    # osmium の面の番号は、way から作ったものが way の番号の2倍、relation からのものが2倍＋1
                    src, oid = ("way", num // 2) if num % 2 == 0 else ("relation", num // 2)
                    if any(k in tags for k in WAY_KEYS):
                        areas.append((src, oid, tags, geom))

    elements = []
    for w in lines.values():
        elements.append(dict(type="way", id=w["id"], tags=w["tags"],
                             geometry=[dict(lat=c[1], lon=c[0]) for c in w["coords"]]))
    for src, oid, tags, geom in areas:
        if src == "way" and oid in lines:
            continue
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        # 穴（内側の輪）は使わない。変換は輪1つを塗りつぶすだけなので
        for k, poly in enumerate(polys):
            ring = poly[0]
            if not line_hits_box(ring, box):
                continue
            eid = oid if src == "way" else f"r{oid}-{k}"
            elements.append(dict(type="way", id=eid, tags=tags, geometry=[dict(lat=c[1], lon=c[0]) for c in ring]))
    elements += nodes

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w") as f:
        json.dump(dict(generator=f"extract_pbf.py from {os.path.basename(pbf)}", elements=elements), f, ensure_ascii=False)
    ways = sum(1 for e in elements if e["type"] == "way")
    rel = sum(1 for e in elements if e["type"] == "way" and str(e["id"]).startswith("r"))
    print(f"{out} に書き出した（way {ways}、うち relation の外周 {rel}、点 {len(nodes)}）")


if __name__ == "__main__":
    main()
