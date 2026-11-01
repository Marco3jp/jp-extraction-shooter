import { useEffect, useRef, useState } from "preact/hooks";
import { CAMP_RADIUS } from "../../data/constants";
import { campOn, type Profile } from "../../meta/profile";
import type { MapView } from "../../mapview";
import type { GameMap, Vec } from "../../sim/map";

const SIZE = 340;
/** 絵に写す範囲（m）。キャンプを置ける円より少し広く */
const VIEW = CAMP_RADIUS * 2 + 40;

type Props = {
  map: GameMap;
  mapView: MapView;
  profile: Profile;
  /** 脱出した地点 */
  center: Vec;
  onChange: (next: Profile) => void;
};

/** 脱出した地点の周りをクリックして、キャンプを置く */
export function CampPicker({ map, mapView, profile, center, onChange }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<Vec | null>(null);
  const [, setLoaded] = useState(0);
  const camp = campOn(profile, map.index.id);
  const ox = center.x - VIEW / 2, oy = center.y - VIEW / 2;
  const scale = SIZE / VIEW;
  const toMap = (e: MouseEvent): Vec => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ox + ((e.clientX - r.left) / r.width) * VIEW, y: oy + ((e.clientY - r.top) / r.height) * VIEW };
  };
  const placeable = (v: Vec) => Math.hypot(v.x - center.x, v.y - center.y) <= CAMP_RADIUS && map.walkable(v.x, v.y);

  useEffect(() => {
    void mapView.loadArea(ox, oy, VIEW).then(() => setLoaded((n) => n + 1));
  }, [mapView, ox, oy]);

  useEffect(() => {
    const ctx = ref.current!.getContext("2d")!;
    ctx.fillStyle = "#15171b";
    ctx.fillRect(0, 0, SIZE, SIZE);
    mapView.drawArea(ctx, ox, oy, VIEW, SIZE);
    const c = SIZE / 2, r = CAMP_RADIUS * scale;
    // 円の外を暗くする
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, SIZE, SIZE);
    ctx.arc(c, c, r, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.strokeStyle = "#50ff9a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#50ff9a";
    ctx.beginPath();
    ctx.arc(c, c, 4, 0, Math.PI * 2);
    ctx.fill();
    const tent = (v: Vec, color: string) => {
      const x = (v.x - ox) * scale, y = (v.y - oy) * scale;
      ctx.fillStyle = color;
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y - 8);
      ctx.lineTo(x + 7, y + 5);
      ctx.lineTo(x - 7, y + 5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    };
    if (camp) tent(camp, "#ffc84a");
    if (hover) tent(hover, placeable(hover) ? "rgba(255, 200, 74, 0.6)" : "rgba(255, 106, 106, 0.6)");
  });

  return (
    <section class="hub-panel hub-camp">
      <h2>キャンプを置く</h2>
      <p class="hub-role">脱出した地点から {CAMP_RADIUS}m 以内の、歩ける所をクリックする。次のランはそこから始まる。</p>
      <canvas
        ref={ref}
        width={SIZE}
        height={SIZE}
        class="hub-camp-map"
        onMouseMove={(e) => setHover(toMap(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const v = toMap(e);
          if (!placeable(v)) return;
          const next = structuredClone(profile);
          next.camp = { map: map.index.id, x: Math.round(v.x * 10) / 10, y: Math.round(v.y * 10) / 10 };
          onChange(next);
        }}
      />
      <p class="hub-role">{camp ? "黄色の印がキャンプ" : "まだキャンプは無い。マップの出発地点から始まる"}</p>
    </section>
  );
}
