import { ATTACHMENT_IDS, ATTACHMENTS, SLOTS } from "../../data/attachments";
import { ARMORS, BAGS } from "../../data/gear";
import { ITEMS, MATERIALS } from "../../data/items";
import { WEAPON_BASES } from "../../data/weapons";
import { attachmentsInUse, weaponAttachments, type Profile } from "../../meta/profile";
import { formatMoney, formatMoveMul, rarityColor } from "./format";
import { Icon } from "./parts";

export function Stash({ profile }: { profile: Profile }) {
  const attachments = ATTACHMENT_IDS.filter((id) => (profile.attachments[id] ?? 0) > 0);
  const s = profile.stats;
  return (
    <div class="hub-stash">
      <section class="hub-panel">
        <h2>お金と素材</h2>
        <ul class="hub-list">
          <li>
            <span class="hub-amount">
              <Icon id="money" />
              お金
            </span>
            <span>{formatMoney(profile.money)}</span>
          </li>
          {MATERIALS.map((m) => (
            <li>
              <span class="hub-amount">
                <Icon id={m} />
                <span style={{ color: rarityColor(ITEMS[m].rarity) }}>{ITEMS[m].name}</span>
              </span>
              <span>{profile.materials[m] ?? 0}</span>
            </li>
          ))}
        </ul>
      </section>

      <section class="hub-panel">
        <h2>武器</h2>
        <ul class="hub-list">
          {profile.weapons.map((w) => {
            const atts = weaponAttachments(profile, w);
            return (
              <li>
                <span>{WEAPON_BASES[w].name}</span>
                <span class="muted">{atts.length ? atts.map((id) => ATTACHMENTS[id].name).join("・") : "アタッチメントなし"}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section class="hub-panel">
        <h2>アタッチメント</h2>
        {attachments.length === 0 ? (
          <p class="muted">まだ持っていません</p>
        ) : (
          <ul class="hub-list">
            {attachments.map((id) => (
              <li>
                <span>
                  <span style={{ color: rarityColor(ATTACHMENTS[id].rarity) }}>{ATTACHMENTS[id].name}</span>
                  <span class="hub-tag">{SLOTS[ATTACHMENTS[id].slot].name}</span>
                </span>
                <span>
                  {profile.attachments[id]}
                  <span class="muted">（使用中 {attachmentsInUse(profile, id)}）</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="hub-panel">
        <h2>防具・カバン</h2>
        <ul class="hub-list">
          {profile.armors.map((a) => {
            const move = formatMoveMul(ARMORS[a].moveMul);
            return (
              <li>
                <span>{ARMORS[a].name}</span>
                <span class="muted">
                  シールド {ARMORS[a].shield}
                  {move && `・${move}`}
                </span>
              </li>
            );
          })}
          {profile.bags.map((b) => (
            <li>
              <span>{BAGS[b].name}</span>
              <span class="muted">{BAGS[b].slots}枠</span>
            </li>
          ))}
        </ul>
      </section>

      <section class="hub-panel">
        <h2>戦績</h2>
        <ul class="hub-list">
          <li>
            <span>出撃</span>
            <span>{s.runs}回</span>
          </li>
          <li>
            <span>脱出</span>
            <span>{s.extractions}回</span>
          </li>
          <li>
            <span>やられた</span>
            <span>{s.deaths}回</span>
          </li>
          <li>
            <span>倒した敵</span>
            <span>{s.kills}体</span>
          </li>
        </ul>
      </section>
    </div>
  );
}
