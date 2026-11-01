import { ATTACHMENTS, type AttachmentId } from "../../data/attachments";
import { ITEMS, MATERIALS, type ItemId, type MaterialId } from "../../data/items";
import { itemIcon } from "../icons";
import { formatMod, formatMoney } from "./format";

export function Icon({ id, size = 18 }: { id: ItemId; size?: number }) {
  return <span class="hub-icon" dangerouslySetInnerHTML={{ __html: itemIcon(id, size) }} />;
}

export function ModList({ id }: { id: AttachmentId }) {
  const items = ATTACHMENTS[id].mods.flatMap(formatMod);
  return (
    <ul class="hub-mods">
      {items.map((m) => (
        <li class={`tone-${m.tone}`}>{m.text}</li>
      ))}
    </ul>
  );
}

/** お金・素材・蘇生アイテムの量を並べる。0 のものは出さない */
export function Amounts({ money, materials, revive = 0 }: { money: number; materials: Partial<Record<MaterialId, number>>; revive?: number }) {
  const mats = MATERIALS.filter((m) => (materials[m] ?? 0) > 0);
  if (money <= 0 && mats.length === 0 && revive <= 0) return <span class="muted">なし</span>;
  return (
    <span class="hub-amounts">
      {money > 0 && (
        <span class="hub-amount">
          <Icon id="money" />
          {formatMoney(money)}
        </span>
      )}
      {mats.map((m) => (
        <span class="hub-amount">
          <Icon id={m} />
          {ITEMS[m].name} ×{materials[m]}
        </span>
      ))}
      {revive > 0 && (
        <span class="hub-amount">
          <Icon id="revive" />
          {ITEMS.revive.name} ×{revive}
        </span>
      )}
    </span>
  );
}
