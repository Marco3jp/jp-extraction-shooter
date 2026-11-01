import { ITEM_ORDER, ITEMS, type ItemId } from "./data";

export type Stack = { item: ItemId; count: number };
export type Bag = { slots: (Stack | null)[]; money: number };

export function makeBag(slots: number): Bag {
  return { slots: new Array<Stack | null>(slots).fill(null), money: 0 };
}

/** 同じ物の山をまとめ直し、ITEM_ORDER の順に前から詰める */
export function sortBag(bag: Bag) {
  const totals = new Map<ItemId, number>();
  for (const s of bag.slots) if (s) totals.set(s.item, (totals.get(s.item) ?? 0) + s.count);
  const out: (Stack | null)[] = [];
  for (const item of ITEM_ORDER) {
    let n = totals.get(item) ?? 0;
    const stack = ITEMS[item].stack;
    while (n > 0) {
      const c = Math.min(stack, n);
      out.push({ item, count: c });
      n -= c;
    }
  }
  while (out.length < bag.slots.length) out.push(null);
  bag.slots = out.slice(0, bag.slots.length);
}

export function bagCount(bag: Bag, item: ItemId): number {
  if (item === "money") return bag.money;
  let n = 0;
  for (const s of bag.slots) if (s && s.item === item) n += s.count;
  return n;
}

export function bagUsed(bag: Bag): number {
  return bag.slots.filter((s) => s !== null).length;
}

/** 入りきる分だけ入れて、入った数を返す。今ある山を先に埋めてから空いた枠に入れる */
export function bagAdd(bag: Bag, item: ItemId, count: number): number {
  if (item === "money") {
    bag.money += count;
    return count;
  }
  const stack = ITEMS[item].stack;
  let left = count;
  for (const s of bag.slots) {
    if (left <= 0) break;
    if (s && s.item === item && s.count < stack) {
      const n = Math.min(stack - s.count, left);
      s.count += n;
      left -= n;
    }
  }
  for (let i = 0; i < bag.slots.length && left > 0; i++) {
    if (bag.slots[i]) continue;
    const n = Math.min(stack, left);
    bag.slots[i] = { item, count: n };
    left -= n;
  }
  sortBag(bag);
  return count - left;
}

/** 取り出せた数を返す。端数の山から先に使う */
export function bagRemove(bag: Bag, item: ItemId, count: number): number {
  if (item === "money") {
    const n = Math.min(bag.money, count);
    bag.money -= n;
    return n;
  }
  let left = count;
  const idx = bag.slots
    .map((s, i) => [s, i] as const)
    .filter(([s]) => s && s.item === item)
    .sort((a, b) => a[0]!.count - b[0]!.count)
    .map(([, i]) => i);
  for (const i of idx) {
    if (left <= 0) break;
    const s = bag.slots[i]!;
    const n = Math.min(s.count, left);
    s.count -= n;
    left -= n;
    if (s.count <= 0) bag.slots[i] = null;
  }
  sortBag(bag);
  return count - left;
}
