import { ATTACHMENTS, SLOTS } from "../../data/attachments";
import { ARMORS, BAGS, BIKES, SECURE_BAGS, SHOES } from "../../data/gear";
import { ITEMS, MATERIALS } from "../../data/items";
import { RECIPES, type Recipe, type RecipeCategory } from "../../data/recipes";
import { WEAPON_BASES } from "../../data/weapons";
import { PARTNER, PARTNER_MODELS } from "../../data/partners";
import { attachmentsInUse, craft, craftBlocker, type Profile } from "../../meta/profile";
import { formatMoney, formatBike, formatMoveMul, rarityColor } from "./format";
import { Icon, ModList } from "./parts";

const CATEGORIES: { id: RecipeCategory; name: string }[] = [
  { id: "material", name: "素材" },
  { id: "attachment", name: "アタッチメント" },
  { id: "weapon", name: "武器" },
  { id: "gear", name: "防具・カバン・靴・自転車" },
  { id: "partner", name: "パートナー" },
];

type Props = { profile: Profile; onChange: (next: Profile) => void };

export function Craft({ profile, onChange }: Props) {
  const make = (id: string) => {
    const next = structuredClone(profile);
    if (craft(next, id)) onChange(next);
  };
  return (
    <div class="hub-craft">
      {CATEGORIES.map((c) => (
        <section class="hub-panel">
          <h2>{c.name}</h2>
          <div class="hub-recipes">
            {RECIPES.filter((r) => r.category === c.id).map((r) => (
              <RecipeCard profile={profile} recipe={r} onMake={() => make(r.id)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function RecipeCard({ profile, recipe, onMake }: { profile: Profile; recipe: Recipe; onMake: () => void }) {
  const blocker = craftBlocker(profile, recipe);
  return (
    <div class="hub-recipe">
      <div class="hub-recipe-head">
        <Output recipe={recipe} />
        <Owned profile={profile} recipe={recipe} />
      </div>
      <Detail recipe={recipe} />
      <div class="hub-cost">
        {recipe.money > 0 && (
          <span class={`hub-amount${profile.money < recipe.money ? " short" : ""}`}>
            <Icon id="money" />
            {formatMoney(recipe.money)}
          </span>
        )}
        {MATERIALS.filter((m) => (recipe.materials[m] ?? 0) > 0).map((m) => {
          const need = recipe.materials[m] ?? 0;
          const have = profile.materials[m] ?? 0;
          return (
            <span class={`hub-amount${have < need ? " short" : ""}`}>
              <Icon id={m} />
              {ITEMS[m].name} {have}/{need}
            </span>
          );
        })}
      </div>
      <button class="hub-button" disabled={!!blocker} onClick={onMake}>
        {blocker ?? "作る"}
      </button>
    </div>
  );
}

function Output({ recipe }: { recipe: Recipe }) {
  const o = recipe.output;
  switch (o.kind) {
    case "material":
      return (
        <span class="hub-recipe-name">
          <Icon id={o.id} />
          {ITEMS[o.id].name} ×{o.count}
        </span>
      );
    case "attachment":
      return (
        <span class="hub-recipe-name" style={{ color: rarityColor(ATTACHMENTS[o.id].rarity) }}>
          {ATTACHMENTS[o.id].name}
          <span class="hub-tag">{SLOTS[ATTACHMENTS[o.id].slot].name}</span>
        </span>
      );
    case "weapon":
      return <span class="hub-recipe-name">{WEAPON_BASES[o.id].name}</span>;
    case "armor":
      return <span class="hub-recipe-name">{ARMORS[o.id].name}</span>;
    case "bag":
      return <span class="hub-recipe-name">{BAGS[o.id].name}</span>;
    case "shoes":
      return <span class="hub-recipe-name">{SHOES[o.id].name}</span>;
    case "bike":
      return <span class="hub-recipe-name">{BIKES[o.id].name}</span>;
    case "secureBag":
      return <span class="hub-recipe-name">{SECURE_BAGS[o.id].name}</span>;
    case "partner":
      return (
        <span class="hub-recipe-name">
          {o.index === 0 && o.model === 2 ? `パートナー1を${PARTNER_MODELS[2].name}にする` : `パートナー${o.index + 1}（${PARTNER_MODELS[o.model].name}）`}
        </span>
      );
  }
}

function Detail({ recipe }: { recipe: Recipe }) {
  const o = recipe.output;
  switch (o.kind) {
    case "material":
      return null;
    case "attachment":
      return <ModList id={o.id} />;
    case "weapon":
      return <p class="hub-recipe-text">{WEAPON_BASES[o.id].role}</p>;
    case "armor": {
      const move = formatMoveMul(ARMORS[o.id].moveMul);
      return (
        <p class="hub-recipe-text">
          シールド {ARMORS[o.id].shield}
          {move && `・${move}`}
        </p>
      );
    }
    case "bag":
      return <p class="hub-recipe-text">{BAGS[o.id].slots}枠</p>;
    case "shoes":
      return <p class="hub-recipe-text">{formatMoveMul(SHOES[o.id].moveMul)}</p>;
    case "bike":
      return <p class="hub-recipe-text">{formatBike(BIKES[o.id].speed, BIKES[o.id].mount)}。乗っている間は撃てない。撃たれると降りる</p>;
    case "secureBag":
      return <p class="hub-recipe-text">死んでも持ち帰れる枠 {SECURE_BAGS[o.id].slots}。素材と蘇生アイテムを入れられる</p>;
    case "partner":
      return (
        <p class="hub-recipe-text">
          {o.index === 0 && o.model === 2
            ? `シールド ${PARTNER_MODELS[1].shield} → ${PARTNER_MODELS[2].shield}`
            : `シールド ${PARTNER_MODELS[o.model].shield}・${WEAPON_BASES[PARTNER.weapon.type].name}`}
        </p>
      );
  }
}

function Owned({ profile, recipe }: { profile: Profile; recipe: Recipe }) {
  const o = recipe.output;
  if (o.kind === "attachment") {
    const n = profile.attachments[o.id] ?? 0;
    return (
      <span class="muted hub-owned">
        所持 {n}
        {n > 0 && `（使用中 ${attachmentsInUse(profile, o.id)}）`}
      </span>
    );
  }
  if (o.kind === "material") return <span class="muted hub-owned">所持 {profile.materials[o.id] ?? 0}</span>;
  return null;
}
