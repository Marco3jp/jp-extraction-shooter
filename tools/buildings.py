"""OpenStreetMap のタグから、建物の種類（ゲームでの見た目と箱の中身の寄り方）を決める。

種類の一覧は src/data/buildings.ts の BUILDING_TYPES と揃える。
"""
import re

RESIDENTIAL, COMMERCIAL, INDUSTRIAL, FARM = "residential", "commercial", "industrial", "farm"

ZONE_OF_TYPE = {
    "house": RESIDENTIAL, "apartment": RESIDENTIAL, "mansion": RESIDENTIAL,
    "convenience": COMMERCIAL, "supermarket": COMMERCIAL, "restaurant": COMMERCIAL, "shop": COMMERCIAL,
    "mall": COMMERCIAL, "office": COMMERCIAL, "hotel": COMMERCIAL,
    "industrial": INDUSTRIAL, "farm": FARM,
}

ZONE_OF_LANDUSE = {
    "residential": RESIDENTIAL, "commercial": COMMERCIAL, "retail": COMMERCIAL,
    "industrial": INDUSTRIAL, "railway": INDUSTRIAL, "port": INDUSTRIAL,
    "farmland": FARM, "farmyard": FARM, "orchard": FARM, "meadow": FARM,
}

# 1つの建物に施設が複数あるときは、上にあるものを採る
POI_PRIORITY = [
    "station", "hospital", "school", "civic", "shrine", "temple", "mall", "supermarket", "hotel",
    "convenience", "restaurant", "shop", "office", "parking", "industrial", "farm",
]

BUILDING_TAG = {
    "house": "house", "detached": "house", "semidetached_house": "house", "terrace": "house", "bungalow": "house",
    "hut": "house", "cabin": "house",
    "apartments": "apartment", "dormitory": "apartment", "residential": "apartment",
    "commercial": "office", "office": "office",
    "retail": "shop", "kiosk": "shop", "supermarket": "supermarket",
    "hotel": "hotel",
    "train_station": "station", "transportation": "station",
    "hospital": "hospital",
    "school": "school", "kindergarten": "school", "university": "school", "college": "school",
    "public": "civic", "government": "civic", "civic": "civic", "fire_station": "civic",
    "temple": "temple", "church": "temple", "shrine": "shrine",
    "industrial": "industrial", "warehouse": "industrial", "factory": "industrial", "garage": "industrial",
    "garages": "industrial", "storage_tank": "industrial", "hangar": "industrial", "service": "industrial",
    "farm": "farm", "barn": "farm", "farm_auxiliary": "farm", "greenhouse": "farm", "cowshed": "farm", "stable": "farm",
    "parking": "parking",
}

AMENITY = {
    "hospital": "hospital", "clinic": "hospital", "doctors": "hospital", "dentist": "hospital", "pharmacy": "hospital",
    "school": "school", "kindergarten": "school", "university": "school", "college": "school",
    "townhall": "civic", "police": "civic", "fire_station": "civic", "post_office": "civic",
    "community_centre": "civic", "library": "civic", "courthouse": "civic",
    "restaurant": "restaurant", "cafe": "restaurant", "fast_food": "restaurant", "pub": "restaurant",
    "bar": "restaurant", "food_court": "restaurant", "ice_cream": "restaurant", "izakaya": "restaurant",
    "parking": "parking",
}

SHOP = {
    "convenience": "convenience", "supermarket": "supermarket",
    "department_store": "mall", "mall": "mall",
    "bakery": "restaurant", "confectionery": "restaurant",
}

TOURISM = {"hotel": "hotel", "hostel": "hotel", "guest_house": "hotel", "motel": "hotel"}

# 名前の言葉から決める。上から順に見る（「病院」を「院」で寺にしないよう、医療を先に置く）
NAME_RULES = [
    (re.compile(r"駅$"), "station"),
    (re.compile(r"病院|クリニック|医院|診療所|歯科"), "hospital"),
    (re.compile(r"小学校|中学校|高校|高等学校|学校|大学|幼稚園|保育園|保育所"), "school"),
    (re.compile(r"郵便局|交番|警察|消防|区役所|市役所|町役場|村役場|役場|図書館|公民館|区民館"), "civic"),
    (re.compile(r"神社|稲荷|八幡宮|天満宮"), "shrine"),
    (re.compile(r"寺$|寺院|本堂"), "temple"),
    (re.compile(r"ホテル|HOTEL|Hotel|旅館"), "hotel"),
    (re.compile(r"マンション|レジデンス|タワー|ハイム|パレス|グランド"), "mansion"),
    (re.compile(r"ハイツ|コーポ|荘$|アパート|メゾン|ハウス"), "apartment"),
    (re.compile(r"倉庫|工場|物流"), "industrial"),
    (re.compile(r"ビル|BLDG|Bldg|bldg|Building|会館"), "office"),
]


def is_station(t):
    return t.get("railway") == "station" or t.get("public_transport") == "station" or t.get("building") == "train_station"


def poi_type(t):
    """お店・施設のタグから種類を決める。決まらなければ None"""
    if is_station(t):
        return "station"
    a = t.get("amenity")
    if a == "place_of_worship":
        return "shrine" if t.get("religion") == "shinto" else "temple"
    if a in AMENITY:
        return AMENITY[a]
    if t.get("healthcare"):
        return "hospital"
    s = t.get("shop")
    if s:
        return SHOP.get(s, "shop")
    if t.get("tourism") in TOURISM:
        return TOURISM[t["tourism"]]
    if t.get("office"):
        return "office"
    if t.get("craft"):
        return "shop"
    return None


def explicit_type(b):
    """施設の点・建物のタグ・名前で決まる種類。決まらなければ None"""
    found = [x for x in (poi_type(p) for p in b["pois"]) if x]
    if found:
        return min(found, key=POI_PRIORITY.index)
    t = b["tags"]
    own = poi_type(t)
    if own:
        return own
    name = t.get("name", "")
    for pat, typ in NAME_RULES:
        if pat.search(name):
            return typ
    bt = BUILDING_TAG.get(t.get("building", ""))
    if bt == "apartment" and b["levels"] is not None and b["levels"] >= 4:
        return "mansion"
    if bt == "shop" and b["area"] >= 3000:
        return "mall"
    return bt


def fallback_type(b, zone):
    """手がかりが面積・階数・周りの土地の使われ方しか無いときの種類"""
    area, levels = b["area"], b["levels"]
    low = levels is None or levels <= 2
    if zone == INDUSTRIAL:
        return "industrial" if area >= 120 else "house"
    if zone == FARM:
        return "farm" if area >= 150 else "house"
    if zone == COMMERCIAL:
        if area < 150 and low:
            return "shop"
        if levels is not None and levels <= 3 and area < 300:
            return "shop"
        return "office"
    # 住宅地か、周りに手がかりが無いとき
    if area < 130 and low:
        return "house"
    if levels is not None and levels >= 4:
        return "mansion"
    if area < 500:
        return "apartment"
    return "mansion" if zone == RESIDENTIAL else "office"


def classify(buildings, zone_at, radius=80):
    """buildings の各要素に type を入れる。zone_at(x, y) は土地の使われ方（無ければ None）"""
    for b in buildings:
        b["type"] = explicit_type(b)
    known = [b for b in buildings if b["type"] in ZONE_OF_TYPE]
    cell = radius
    buckets = {}
    for b in known:
        buckets.setdefault((int(b["cx"] // cell), int(b["cy"] // cell)), []).append(b)
    for b in buildings:
        if b["type"]:
            continue
        zone = zone_at(b["cx"], b["cy"])
        if zone is None:
            # 近くの種類が分かっている建物の多数決
            votes = {}
            gx, gy = int(b["cx"] // cell), int(b["cy"] // cell)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for o in buckets.get((gx + dx, gy + dy), ()):
                        if (o["cx"] - b["cx"]) ** 2 + (o["cy"] - b["cy"]) ** 2 <= radius * radius:
                            z = ZONE_OF_TYPE[o["type"]]
                            votes[z] = votes.get(z, 0) + 1
            zone = max(votes, key=votes.get) if votes else None
        b["type"] = fallback_type(b, zone)


def clean_road_name(name):
    """「中央通り;万世橋」「昭和通り（進路変更禁止）」のような名前から、通りの名前だけを取り出す"""
    if not name:
        return None
    n = re.sub(r"[（(].*?[)）]", "", name.split(";")[0]).strip()
    return n or None


def clean_station_name(name):
    """駅名標に出す名前。会社名と「駅」を外す"""
    if not name:
        return None
    n = re.sub(r"^(JR|ＪＲ|東京メトロ|都営|京成|京急|東急|小田急|京王|西武|東武|相鉄|つくばエクスプレス)\s*", "", name.split(";")[0])
    n = re.sub(r"駅.*$", "", n).strip()
    return n or None
