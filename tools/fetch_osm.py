"""マップの範囲の OpenStreetMap のデータを Overpass API から取得し、設定の raw に書き出す。

使い方:
  python3 -I tools/fetch_osm.py tools/maps/akihabara.json
"""
import json
import os
import sys
import urllib.parse
import urllib.request

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# 地名の点は範囲のすぐ外にあることが多いので、少し広く取る
PLACE_MARGIN = 0.004


def query(bbox):
    b = f'{bbox["south"]},{bbox["west"]},{bbox["north"]},{bbox["east"]}'
    m = PLACE_MARGIN
    pb = f'{bbox["south"] - m},{bbox["west"] - m},{bbox["north"] + m},{bbox["east"] + m}'
    ways = "".join(f'way["{k}"]({b});' for k in ("building", "highway", "landuse", "leisure", "railway", "amenity", "shop"))
    nodes = "".join(f'node["{k}"]({b});' for k in ("shop", "amenity", "tourism", "office", "healthcare", "craft"))
    nodes += f'node["railway"="station"]({b});node["public_transport"="station"]({b});node["place"]({pb});'
    return f"[out:json][timeout:180];({ways}{nodes});out geom tags;"


def main():
    cfg = json.load(open(sys.argv[1]))
    body = urllib.parse.urlencode({"data": query(cfg["bbox"])}).encode()
    last = None
    for url in ENDPOINTS:
        req = urllib.request.Request(url, data=body, headers={"User-Agent": "jp-extraction-shooter-map/0.1"})
        try:
            with urllib.request.urlopen(req, timeout=240) as r:
                data = r.read()
            json.loads(data)
        except Exception as e:  # 混んでいると 429 / 504 が返るので、次のサーバーを試す
            print(f"{url}: {e}", file=sys.stderr)
            last = e
            continue
        os.makedirs(os.path.dirname(cfg["raw"]), exist_ok=True)
        tmp = cfg["raw"] + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, cfg["raw"])
        print(f"{cfg['raw']} に書き出した（{len(data) // 1024}KB）")
        return
    sys.exit(f"取得できなかった: {last}")


if __name__ == "__main__":
    main()
