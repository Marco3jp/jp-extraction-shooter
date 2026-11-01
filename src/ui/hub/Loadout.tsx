import { useState } from "preact/hooks";
import { ATTACHMENT_IDS, ATTACHMENTS, SLOT_ORDER, SLOTS, type AttachmentId, type SlotId } from "../../data/attachments";
import { PLAYER_MIN_TTK } from "../../data/constants";
import { ARMORS, BAGS, BIKES, SECURE_BAGS, SHOES } from "../../data/gear";
import { DEVICE_KINDS, DEVICES } from "../../data/devices";
import { ITEMS } from "../../data/items";
import {
  PASSIVE_IDS, PASSIVES, SKILL_IDS, SKILLS, ULT_IDS, ULTS, type PassiveId, type SkillId, type UltId,
} from "../../data/skills";
import { kitIcon } from "../icons";
import { PARTNER, PARTNER_MODELS } from "../../data/partners";
import { WEAPON_BASES, type WeaponDef, type WeaponStat, type WeaponType } from "../../data/weapons";
import {
  attachmentsFree,
  campOn,
  profileWeapon,
  setAttachment,
  setLoadoutArmor,
  setLoadoutBag, setLoadoutBike, setLoadoutPassive, setLoadoutRevive, setLoadoutSecureBag, setLoadoutShoes,
  setLoadoutSkill, setLoadoutUlt,
  setLoadoutWeapon,
  setPartnerEnabled,
  type Profile,
} from "../../meta/profile";
import { computeWeapon, theoreticalTtk } from "../../sim/stats";
import { formatBike, formatMoveMul, rarityColor, toneOf, trimNum, type Tone } from "./format";
import { ModList } from "./parts";

type Props = {
  profile: Profile;
  mapId: string;
  onChange: (next: Profile) => void;
  onDeploy: () => void;
};

export function Loadout({ profile, mapId, onChange, onDeploy }: Props) {
  const [editing, setEditing] = useState<WeaponType>(profile.loadout.weapons[0]);
  const target = profile.weapons.includes(editing) ? editing : profile.loadout.weapons[0];

  const update = (fn: (p: Profile) => void) => {
    const next = structuredClone(profile);
    fn(next);
    onChange(next);
  };

  return (
    <div class="hub-loadout">
      <section class="hub-panel">
        <h2>持ち込む装備</h2>
        {([0, 1] as const).map((i) => (
          <div class="hub-field">
            <div class="hub-field-label">{i === 0 ? "メイン" : "サブ"}</div>
            <div class="hub-chips">
              {profile.weapons.map((w) => (
                <button
                  class={`hub-chip${profile.loadout.weapons[i] === w ? " selected" : ""}`}
                  onClick={() => update((p) => setLoadoutWeapon(p, i, w))}
                >
                  {WEAPON_BASES[w].name}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div class="hub-field">
          <div class="hub-field-label">防具</div>
          <div class="hub-chips">
            {profile.armors.map((a) => (
              <button
                class={`hub-chip${profile.loadout.armor === a ? " selected" : ""}`}
                onClick={() => update((p) => setLoadoutArmor(p, a))}
              >
                <span>{ARMORS[a].name}</span>
                <span class="hub-chip-sub">
                  シールド {ARMORS[a].shield}
                  {formatMoveMul(ARMORS[a].moveMul) && `・${formatMoveMul(ARMORS[a].moveMul)}`}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div class="hub-field">
          <div class="hub-field-label">カバン</div>
          <div class="hub-chips">
            {profile.bags.map((b) => (
              <button
                class={`hub-chip${profile.loadout.bag === b ? " selected" : ""}`}
                onClick={() => update((p) => setLoadoutBag(p, b))}
              >
                <span>{BAGS[b].name}</span>
                <span class="hub-chip-sub">{BAGS[b].slots}枠</span>
              </button>
            ))}
          </div>
        </div>
        <div class="hub-field">
          <div class="hub-field-label">靴</div>
          <div class="hub-chips">
            {profile.shoes.map((s) => (
              <button
                class={`hub-chip${profile.loadout.shoes === s ? " selected" : ""}`}
                onClick={() => update((p) => setLoadoutShoes(p, s))}
              >
                <span>{SHOES[s].name}</span>
                <span class="hub-chip-sub">{formatMoveMul(SHOES[s].moveMul) ?? "移動速度 そのまま"}</span>
              </button>
            ))}
          </div>
        </div>
        <div class="hub-field">
          <div class="hub-field-label">自転車</div>
          <div class="hub-chips">
            {profile.bikes.map((b) => (
              <button
                class={`hub-chip${profile.loadout.bike === b ? " selected" : ""}`}
                onClick={() => update((p) => setLoadoutBike(p, b))}
              >
                <span>{BIKES[b].name}</span>
                <span class="hub-chip-sub">{formatBike(BIKES[b].speed, BIKES[b].mount) ?? "持ち込まない"}</span>
              </button>
            ))}
          </div>
        </div>
        <div class="hub-field">
          <div class="hub-field-label">特殊カバン</div>
          <div class="hub-chips">
            {profile.secureBags.map((b) => (
              <button
                class={`hub-chip${profile.loadout.secureBag === b ? " selected" : ""}`}
                onClick={() => update((p) => setLoadoutSecureBag(p, b))}
              >
                <span>{SECURE_BAGS[b].name}</span>
                <span class="hub-chip-sub">{SECURE_BAGS[b].slots > 0 ? `死んでも持ち帰れる枠 ${SECURE_BAGS[b].slots}` : "持ち込まない"}</span>
              </button>
            ))}
          </div>
        </div>
        <div class="hub-field">
          <div class="hub-field-label">{ITEMS.revive.name}</div>
          <div class="hub-chips">
            <button
              class={`hub-chip${profile.loadout.revive ? " selected" : ""}`}
              disabled={profile.items.revive <= 0}
              onClick={() => update((p) => setLoadoutRevive(p, !p.loadout.revive))}
            >
              <span>{profile.loadout.revive ? "1個持ち込む" : "持ち込まない"}</span>
              <span class="hub-chip-sub">保管庫に {profile.items.revive}個。死んだら自動で使い、その場で立ち上がる</span>
            </button>
          </div>
        </div>
        <div class="hub-field">
          <div class="hub-field-label">設置物</div>
          <div class="hub-chips">
            {DEVICE_KINDS.map((k) => (
              <div class="hub-chip static">
                <span>{DEVICES[k].name} ×{profile.devices[k]}</span>
                <span class="hub-chip-sub">
                  作った分は全部持ち込む。マップに置いている {profile.placed.filter((d) => d.kind === k).length}/{DEVICES[k].max}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div class="hub-field">
          <div class="hub-field-label">パートナー</div>
          <div class="hub-chips">
            {profile.partners.map((x, i) =>
              x.model === 0 ? (
                <button class="hub-chip" disabled>
                  <span>{i + 1}</span>
                  <span class="hub-chip-sub">まだ作っていない</span>
                </button>
              ) : (
                <button
                  class={`hub-chip${x.enabled ? " selected" : ""}`}
                  onClick={() => update((p) => setPartnerEnabled(p, i, !x.enabled))}
                >
                  <span>
                    {i + 1} {PARTNER_MODELS[x.model].name}
                  </span>
                  <span class="hub-chip-sub">
                    シールド {PARTNER_MODELS[x.model].shield}・{x.enabled ? "連れていく" : "連れていかない"}
                  </span>
                </button>
              ),
            )}
          </div>
          <p class="hub-role">
            {profile.partners.some((x) => x.model > 0)
              ? `${WEAPON_BASES[PARTNER.weapon.type].name}を持ち、左後ろ・右後ろに付いて戦う。倒れたら近くで E を長押しして起こす`
              : "クラフトの画面で作れる"}
          </p>
        </div>
        <div class="hub-field">
          <div class="hub-field-label">出発地点</div>
          <div class="hub-chips">
            <span class="hub-start">{campOn(profile, mapId) ? "キャンプ" : "マップの出発地点"}</span>
            {campOn(profile, mapId) && (
              <button class="hub-button" onClick={() => update((p) => (p.camp = null))}>
                キャンプをたたむ
              </button>
            )}
          </div>
        </div>
        <button class="hub-deploy" onClick={onDeploy}>
          出撃
        </button>
      </section>

      <section class="hub-panel">
        <h2>武器の調整</h2>
        <div class="hub-chips hub-weapon-picker">
          {profile.weapons.map((w) => {
            const idx = profile.loadout.weapons.indexOf(w);
            return (
              <button class={`hub-chip${target === w ? " selected" : ""}`} onClick={() => setEditing(w)}>
                <span>{WEAPON_BASES[w].name}</span>
                {idx >= 0 && <span class="hub-chip-sub">{idx === 0 ? "メイン" : "サブ"}</span>}
              </button>
            );
          })}
        </div>
        <p class="hub-role">{WEAPON_BASES[target].role}</p>
        <div class="hub-editor">
          <div class="hub-slots">
            {SLOT_ORDER.map((s) => (
              <SlotPicker profile={profile} weapon={target} slot={s} onPick={(id) => update((p) => setAttachment(p, target, s, id))} />
            ))}
          </div>
          <StatsTable weapon={target} current={profileWeapon(profile, target)} />
        </div>
      </section>

      <section class="hub-panel hub-kit">
        <h2>スキル</h2>
        <KitPicker
          label="スキル（Q）"
          ids={SKILL_IDS}
          current={profile.loadout.skill}
          describe={(id: SkillId) => ({ name: SKILLS[id].name, style: SKILLS[id].style, text: SKILLS[id].text, cd: SKILLS[id].cooldown })}
          onPick={(id) => update((p) => setLoadoutSkill(p, id))}
        />
        <KitPicker
          label="パッシブ"
          ids={PASSIVE_IDS}
          current={profile.loadout.passive}
          describe={(id: PassiveId) => ({ name: PASSIVES[id].name, style: PASSIVES[id].style, text: PASSIVES[id].text, cd: null })}
          onPick={(id) => update((p) => setLoadoutPassive(p, id))}
        />
        <KitPicker
          label="アルティメット（F）"
          ids={ULT_IDS}
          current={profile.loadout.ult}
          describe={(id: UltId) => ({ name: ULTS[id].name, style: null, text: ULTS[id].text, cd: ULTS[id].cooldown })}
          onPick={(id) => update((p) => setLoadoutUlt(p, id))}
        />
      </section>
    </div>
  );
}

function KitPicker<T extends SkillId | PassiveId | UltId>({
  label,
  ids,
  current,
  describe,
  onPick,
}: {
  label: string;
  ids: T[];
  current: T;
  describe: (id: T) => { name: string; style: string | null; text: string; cd: number | null };
  onPick: (id: T) => void;
}) {
  return (
    <div class="hub-slot">
      <div class="hub-field-label">{label}</div>
      <div class="hub-slot-options hub-kit-options">
        {ids.map((id) => {
          const d = describe(id);
          return (
            <button class={`hub-option${current === id ? " selected" : ""}`} onClick={() => onPick(id)}>
              <span class="hub-kit-head">
                <span class="hub-icon" dangerouslySetInnerHTML={{ __html: kitIcon(id, 22) }} />
                <span class="hub-option-name">{d.name}</span>
              </span>
              <span class="hub-option-count">
                {[d.style, d.cd !== null ? `クールダウン ${d.cd}秒` : null].filter(Boolean).join("・")}
              </span>
              <span class="hub-mods">{d.text}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SlotPicker({
  profile,
  weapon,
  slot,
  onPick,
}: {
  profile: Profile;
  weapon: WeaponType;
  slot: SlotId;
  onPick: (id: AttachmentId | null) => void;
}) {
  const current = profile.weaponConfig[weapon][slot] ?? null;
  const owned = ATTACHMENT_IDS.filter((id) => ATTACHMENTS[id].slot === slot && (profile.attachments[id] ?? 0) > 0);
  return (
    <div class="hub-slot">
      <div class="hub-field-label">{SLOTS[slot].name}</div>
      <div class="hub-slot-options">
        <button class={`hub-option${current === null ? " selected" : ""}`} onClick={() => onPick(null)}>
          <span class="hub-option-name">なし</span>
        </button>
        {owned.map((id) => {
          const free = attachmentsFree(profile, id);
          const usable = current === id || free > 0;
          return (
            <button
              class={`hub-option${current === id ? " selected" : ""}`}
              disabled={!usable}
              onClick={() => onPick(id)}
            >
              <span class="hub-option-name" style={{ color: rarityColor(ATTACHMENTS[id].rarity) }}>
                {ATTACHMENTS[id].name}
              </span>
              <span class="hub-option-count">{usable ? `残り ${free}` : "ほかの武器に付けている"}</span>
              <ModList id={id} />
            </button>
          );
        })}
        {owned.length === 0 && <p class="muted hub-slot-empty">持っていない。クラフトで作れる</p>}
      </div>
    </div>
  );
}

type Row = { label: string; stat: WeaponStat; value: (w: WeaponDef) => number; text: (w: WeaponDef) => string };

const ROWS: Row[] = [
  {
    label: "ダメージ",
    stat: "damage",
    value: (w) => w.damage * w.pellets,
    text: (w) => (w.pellets > 1 ? `${trimNum(w.damage, 1)}×${w.pellets}` : trimNum(w.damage, 1)),
  },
  { label: "連射速度", stat: "rate", value: (w) => w.rate, text: (w) => `${trimNum(w.rate, 1)}発/秒` },
  { label: "マガジン", stat: "mag", value: (w) => w.mag, text: (w) => `${w.mag}発` },
  { label: "リロード時間", stat: "reload", value: (w) => w.reload, text: (w) => `${trimNum(w.reload)}秒` },
  { label: "拡散", stat: "spreadBase", value: (w) => w.spreadBase, text: (w) => `${trimNum(w.spreadBase)}°` },
  { label: "反動", stat: "spreadPerShot", value: (w) => w.spreadPerShot, text: (w) => `${trimNum(w.spreadPerShot)}°` },
  { label: "移動中の拡散", stat: "spreadMoving", value: (w) => w.spreadMoving, text: (w) => `${trimNum(w.spreadMoving)}°` },
  { label: "射程", stat: "range", value: (w) => w.range, text: (w) => `${trimNum(w.range, 1)}m` },
  { label: "弾速", stat: "bulletSpeed", value: (w) => w.bulletSpeed, text: (w) => `${trimNum(w.bulletSpeed, 1)}m/秒` },
];

const PELLET_ROW: Row = {
  label: "散弾の広がり",
  stat: "pelletSpread",
  value: (w) => w.pelletSpread,
  text: (w) => `${trimNum(w.pelletSpread)}°`,
};

function StatsTable({ weapon, current }: { weapon: WeaponType; current: WeaponDef }) {
  const base = computeWeapon(weapon, []);
  const rows = base.pellets > 1 ? [...ROWS, PELLET_ROW] : ROWS;
  const ttkNow = theoreticalTtk(current);
  const ttkBase = theoreticalTtk(base);
  const ttkTone: Tone = Math.abs(ttkNow.ttk - ttkBase.ttk) < 1e-6 ? "same" : ttkNow.ttk < ttkBase.ttk ? "good" : "bad";
  return (
    <div class="hub-stats">
      <div class="hub-ttk">
        <span class="muted">理論TTK</span>
        <span class={`hub-ttk-value tone-${ttkTone}`}>{trimNum(ttkNow.ttk)}秒</span>
        <span class="muted">
          体力200の相手に{ttkNow.shots}発・素の状態は{trimNum(ttkBase.ttk)}秒
        </span>
        {current.style && <span class="hub-style">{current.style}</span>}
      </div>
      {current.rateClamped && (
        <p class="hub-note">理論TTKが{PLAYER_MIN_TTK}秒を下回るため、連射速度を下げています</p>
      )}
      {!ttkNow.fitsMag && <p class="hub-note">マガジン1本では倒しきれません</p>}
      <table>
        <thead>
          <tr>
            <th></th>
            <th>素の状態</th>
            <th>今の状態</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <th>{r.label}</th>
              <td class="muted">{r.text(base)}</td>
              <td class={`tone-${toneOf(r.stat, r.value(current) - r.value(base))}`}>{r.text(current)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
