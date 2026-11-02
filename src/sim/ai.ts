import { DT, ENEMY, ENEMY_SPEED, FRAG, HEAL_MOVE_SPEED, PARTNER, PLAYER_FACTION, ROAM_CHANCE, ROAM_DISTANCE, THERMITE } from "./data";
import { burnMul, cancelHeal, pullTrigger, releaseTrigger, startHeal, startReload, weapon } from "./combat";
import type { PathAvoid, Vec } from "./map";
import type { Actor, World } from "./world";

const SCAN_INTERVAL = 0.2;
/** 見失ってから巡回に戻るまで */
export const FORGET_AFTER = 8;
/** ほかの勢力と撃ち合っているとき、両方の強さを比べるために仲間を数える範囲（m） */
const SIDE_RADIUS = 40;
/** プレイヤーの側に撃たれたら、この秒数はほかの勢力に押されていてもプレイヤーの側を狙う */
export const PROVOKED_FOR = 6;

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

export function hostile(a: Actor, b: Actor) {
  return a.faction !== b.faction;
}

export function angleDiff(a: number, b: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function turnTo(e: Actor, target: number, rate: number) {
  const d = angleDiff(e.facing, target);
  const step = rate * DT;
  e.facing += Math.abs(d) <= step ? d : Math.sign(d) * step;
}

export function spec(e: Actor) {
  return e.kind === "partner" ? PARTNER : ENEMY[e.kind as keyof typeof ENEMY];
}

function sideHp(w: World, faction: number, at: Vec) {
  let hp = 0;
  for (const o of w.actors) {
    if (o.alive && o.faction === faction && dist(o.pos, at) < SIDE_RADIUS) hp += o.shield + o.health + o.overshield;
  }
  return hp;
}

/** 撃ち合っているほかの勢力（プレイヤーの側を除く）の相手を探し、その勢力のほうが強ければ返す */
function strongerRival(w: World, e: Actor, byId: Map<number, Actor>): Actor | null {
  const ai = e.ai!;
  const sight = spec(e).sight;
  const cur = ai.target !== null ? byId.get(ai.target) : undefined;
  let rival: Actor | null = null;
  if (cur?.alive && cur.faction !== PLAYER_FACTION && dist(e.pos, cur.pos) < sight * 1.15) {
    rival = cur;
  } else {
    let best = Infinity;
    for (const o of w.actors) {
      if (!o.alive || o.faction === PLAYER_FACTION || !hostile(e, o)) continue;
      const d = dist(e.pos, o.pos);
      if (d > sight || d >= best || !w.map.los(e.pos, o.pos)) continue;
      rival = o;
      best = d;
    }
  }
  if (!rival) return null;
  return sideHp(w, e.faction, e.pos) < sideHp(w, rival.faction, rival.pos) ? rival : null;
}

/**
 * ほかの勢力に押されている間は、手を出してこないプレイヤーの側を後回しにする。
 * 押している勢力を先に片付けたほうが、残ったプレイヤーと撃ち合うときに有利なので
 */
export function ignoresPlayer(w: World, e: Actor) {
  const ai = e.ai!;
  return e.team === "enemy" && ai.outmatchedBy !== null && w.time - ai.playerHitT > PROVOKED_FOR;
}

/** 狙う相手へ撃てる向き・距離・反応時間になっているか。撃たないときは理由を ai.hold に残す */
export function aimReady(e: Actor, d: number, toT: number, tolerance: number): boolean {
  const ai = e.ai!;
  if (!ai.canSee) ai.hold = "unseen";
  else if (ai.reactT > 0) ai.hold = "react";
  else if (d > weapon(e).def.range) ai.hold = "range";
  else if (Math.abs(angleDiff(e.facing, toT)) >= tolerance) ai.hold = "aim";
  else {
    ai.hold = "fire";
    return true;
  }
  return false;
}

/** at に敵がいると知らせる。source が分かっていれば狙う相手にする */
export function alert(w: World, e: Actor, at: Vec, source: Actor | null, spread = true) {
  const ai = e.ai;
  if (!ai || !e.alive) return;
  if (source && !hostile(e, source)) return;
  if (source?.faction === PLAYER_FACTION && ignoresPlayer(w, e)) source = null;
  // パートナーは狙う相手を覚えるだけで、動き方はプレイヤーに合わせて partner.ts で決める
  if (e.team === "partner") {
    if (!ai.canSee) {
      ai.lastSeen = { ...at };
      ai.lastSeenT = w.time;
      if (source && ai.target === null) ai.target = source.id;
    }
    return;
  }
  if (!ai.canSee) {
    ai.lastSeen = { ...at };
    ai.lastSeenT = w.time;
    if (source) ai.target = source.id;
  } else if (source && source.id !== ai.target) {
    // 見えている相手より近くから撃たれたら、撃ってきたほうへ向き直る。脱出地点に寄ってきた勢力どうしが撃ち合うように
    const cur = w.actors.find((o) => o.id === ai.target);
    if (!cur || !cur.alive || dist(e.pos, source.pos) < dist(e.pos, cur.pos)) {
      ai.target = source.id;
      ai.lastSeen = { ...source.pos };
      ai.lastSeenT = w.time;
    }
  }
  if (ai.state === "patrol") {
    ai.state = "engage";
    ai.reactT = spec(e).reaction * w.rng.range(1, 2.2) + 0.2;
    ai.path = [];
    ai.pathTarget = null;
  }
  if (!spread) return;
  for (const o of w.actors) {
    if (o === e || !o.ai || !o.alive || o.ai.group !== ai.group) continue;
    if (dist(o.pos, e.pos) < 60) alert(w, o, at, source, false);
  }
}

/** 炎のセルに入るときに1歩あたりへ足す重み。炎を突っ切るより、この倍率までの回り道を選ぶ */
const FIRE_PATH_COST = 12;

/** 燃えている炎を避ける。炎が無ければ undefined */
function fireAvoid(w: World): PathAvoid | undefined {
  if (!w.fires.length) return undefined;
  const reach = THERMITE.width / 2 + 0.5;
  const near = (p: Vec) => w.fires.some((f) => dist(p, closestOnSeg(p, f.a, f.b)) <= reach);
  return {
    cellCost: (cx, cy) => (near({ x: cx + 0.5, y: cy + 0.5 }) ? FIRE_PATH_COST : 0),
    lineOk: (a, b) => {
      const n = Math.ceil(dist(a, b) / 0.5);
      for (let i = 0; i <= n; i++) {
        const k = i / Math.max(n, 1);
        if (near({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k })) return false;
      }
      return true;
    },
  };
}

/** target へ向かう速度ベクトルを返す。経路は必要なときだけ引き直す */
export function seek(w: World, e: Actor, target: Vec, speed: number): Vec {
  const ai = e.ai!;
  ai.repathT -= DT;
  const moved = !ai.pathTarget || dist(ai.pathTarget, target) > 2.5;
  if (moved || ai.repathT <= 0) {
    const avoid = fireAvoid(w);
    if (w.map.walkLine(e.pos, target, 0.45) && (!avoid || avoid.lineOk(e.pos, target))) {
      ai.path = [{ ...target }];
    } else {
      ai.path = w.map.findPath(e.pos, target, 12000, avoid) ?? [];
    }
    ai.pathTarget = { ...target };
    ai.repathT = ai.state === "patrol" ? 4 : ai.state === "follow" ? 0.4 : 0.8 + w.rng.next() * 0.4;
  }
  while (ai.path.length && dist(ai.path[0], e.pos) < 0.6) ai.path.shift();
  const next = ai.path[0];
  if (!next) return { x: 0, y: 0 };
  const dx = next.x - e.pos.x, dy = next.y - e.pos.y;
  const l = Math.hypot(dx, dy) || 1;
  return { x: (dx / l) * speed, y: (dy / l) * speed };
}

/** グループの先頭（生きている中で番号が一番小さい者）だけが行き先を決める */
function isLeader(w: World, e: Actor) {
  for (const o of w.actors) {
    if (o.ai && o.alive && o.ai.group === e.ai!.group) return o === e;
  }
  return false;
}

function roamTo(w: World, e: Actor): boolean {
  for (let k = 0; k < 20; k++) {
    const ang = w.rng.range(0, Math.PI * 2);
    const r = w.rng.range(ROAM_DISTANCE[0], ROAM_DISTANCE[1]);
    const q = { x: e.pos.x + Math.cos(ang) * r, y: e.pos.y + Math.sin(ang) * r };
    if (!w.map.walkable(q.x, q.y)) continue;
    for (const o of w.actors) {
      if (!o.ai || !o.alive || o.ai.group !== e.ai!.group || o.ai.state !== "patrol") continue;
      o.ai.home = { ...q };
      o.ai.pathTarget = null;
      o.ai.path = [];
      o.ai.waitT = 0;
    }
    return true;
  }
  return false;
}

export function findCover(w: World, e: Actor, threat: Vec): Vec | null {
  let best: Vec | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 28; i++) {
    const ang = (i / 28) * Math.PI * 2 + w.rng.next() * 0.2;
    const r = 4 + (i % 4) * 3;
    const p = { x: e.pos.x + Math.cos(ang) * r, y: e.pos.y + Math.sin(ang) * r };
    if (!w.map.walkable(p.x, p.y)) continue;
    if (w.map.los(p, threat)) continue;
    const score = dist(p, threat) * 0.5 - dist(p, e.pos);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** 逃げ先の候補を比べるとき、狙っている相手から見える場所に足す距離（m） */
const EXPOSED_PENALTY = 4;
/** グレネードが着地してから、反応時間に加えて気づくまでにかかる秒数 */
const GRENADE_NOTICE_DELAY = 0.25;
/** 相手の残りがこれ以下で、自分にこれ以上残っていれば、炎の中に留まって撃ち合う */
const STAY_IN_FIRE_TARGET_HP = 50;
const STAY_IN_FIRE_SELF_HP = 110;

function closestOnSeg(p: Vec, a: Vec, b: Vec): Vec {
  const dx = b.x - a.x, dy = b.y - a.y;
  const ll = dx * dx + dy * dy || 1e-9;
  const k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / ll));
  return { x: a.x + dx * k, y: a.y + dy * k };
}

/** 候補のうち、まっすぐ歩いて行けて一番近いもの。相手から見える場所は遠いものとして扱う */
function bestEscape(w: World, e: Actor, cands: Vec[], t: Actor | undefined): Vec | null {
  let best: Vec | null = null;
  let bestScore = Infinity;
  for (const c of cands) {
    if (!w.map.walkable(c.x, c.y) || !w.map.walkLine(e.pos, c, 0.4)) continue;
    let score = dist(e.pos, c);
    if (t && w.map.los(c, t.pos)) score += EXPOSED_PENALTY;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** 見えているグレネードの爆発に巻き込まれない場所。巻き込まれないなら null */
export function grenadeEscape(w: World, e: Actor, t: Actor | undefined): Vec | null {
  const reach = FRAG.radius + e.radius + 0.6;
  for (const g of w.grenades) {
    if (g.kind !== "frag" || g.t < g.flight + spec(e).reaction + GRENADE_NOTICE_DELAY) continue;
    if (dist(e.pos, g.to) > reach || !w.map.los(g.to, e.pos)) continue;
    const safe = (p: Vec) => dist(p, g.to) > reach || !w.map.los(g.to, p);
    const cands: Vec[] = [];
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2;
      for (let r = 1; r <= reach * 2; r += 0.75) {
        const p = { x: e.pos.x + Math.cos(ang) * r, y: e.pos.y + Math.sin(ang) * r };
        if (safe(p)) {
          cands.push(p);
          break;
        }
      }
    }
    // 逃げ場が無ければ、爆心からまっすぐ離れる
    return bestEscape(w, e, cands, t) ?? {
      x: e.pos.x + (e.pos.x - g.to.x) * 3,
      y: e.pos.y + (e.pos.y - g.to.y) * 3,
    };
  }
  return null;
}

/** 炎の中にいれば、炎の外の場所。留まると決めたときと、炎の外にいるときは null */
export function fireEscape(w: World, e: Actor, t: Actor | undefined): Vec | null {
  const reach = THERMITE.width / 2 + e.radius;
  for (const f of w.fires) {
    const c = closestOnSeg(e.pos, f.a, f.b);
    const d = dist(e.pos, c);
    if (d > reach) continue;
    const ai = e.ai!;
    if (t && ai.canSee && t.shield + t.health <= STAY_IN_FIRE_TARGET_HP && e.shield + e.health >= STAY_IN_FIRE_SELF_HP) return null;
    const lx = f.b.x - f.a.x, ly = f.b.y - f.a.y;
    const ll = Math.hypot(lx, ly) || 1;
    const ux = lx / ll, uy = ly / ll;
    const clear = reach + 0.6;
    // 炎の左右と、両端の先
    const cands: Vec[] = [
      { x: c.x - uy * clear, y: c.y + ux * clear },
      { x: c.x + uy * clear, y: c.y - ux * clear },
      { x: f.a.x - ux * clear, y: f.a.y - uy * clear },
      { x: f.b.x + ux * clear, y: f.b.y + uy * clear },
    ];
    return bestEscape(w, e, cands, t) ?? (d > 0.05 ? { x: c.x + ((e.pos.x - c.x) / d) * clear, y: c.y + ((e.pos.y - c.y) / d) * clear } : cands[0]);
  }
  return null;
}

/** 見えている敵対相手のうち、一番近いものを探す */
export function scan(w: World, e: Actor): Actor | null {
  const ai = e.ai!;
  const sight = spec(e).sight;
  let best: Actor | null = null;
  let bestScore = Infinity;
  const skipPlayer = ignoresPlayer(w, e);
  for (const o of w.actors) {
    if (!o.alive || !hostile(e, o)) continue;
    if (skipPlayer && o.faction === PLAYER_FACTION) continue;
    const d = dist(e.pos, o.pos);
    if (d > sight) continue;
    if (ai.state === "patrol" && d > 6) {
      const a = Math.atan2(o.pos.y - e.pos.y, o.pos.x - e.pos.x);
      if (Math.abs(angleDiff(e.facing, a)) > 1.2) continue;
    }
    const score = ai.rival && o.team === "enemy" ? d * 0.6 : d;
    if (score >= bestScore) continue;
    if (!w.map.los(e.pos, o.pos)) continue;
    best = o;
    bestScore = score;
  }
  return best;
}

export function updateEnemy(w: World, e: Actor, byId: Map<number, Actor>) {
  const ai = e.ai!;
  const sp = spec(e);
  ai.stateT -= DT;

  ai.scanT -= DT;
  if (ai.scanT <= 0) {
    ai.scanT = SCAN_INTERVAL;
    ai.outmatchedBy = strongerRival(w, e, byId)?.id ?? null;
    const found = scan(w, e);
    const cur = ai.target !== null ? byId.get(ai.target) : undefined;
    if (cur?.faction === PLAYER_FACTION && ignoresPlayer(w, e)) {
      ai.target = found?.id ?? ai.outmatchedBy;
    } else if (found && found.id !== ai.target) {
      if (!cur || !cur.alive || !ai.canSee || dist(e.pos, found.pos) < dist(e.pos, cur.pos) - 5) ai.target = found.id;
    }
  }

  let t = ai.target !== null ? byId.get(ai.target) : undefined;
  if (t && !t.alive) {
    ai.target = null;
    t = undefined;
    ai.canSee = false;
  }
  const d = t ? dist(e.pos, t.pos) : Infinity;
  ai.canSee = !!t && d < sp.sight * 1.15 && w.map.los(e.pos, t.pos);
  if (t && ai.canSee) {
    if (ai.state === "patrol") alert(w, e, t.pos, t);
    ai.lastSeen = { ...t.pos };
    ai.lastSeenT = w.time;
    for (const o of w.actors) {
      if (o === e || !o.ai || !o.alive || o.ai.group !== ai.group || o.ai.canSee) continue;
      if (dist(o.pos, e.pos) < 60) alert(w, o, t.pos, t, false);
    }
    ai.reactT -= DT;
  } else if (ai.reactT < sp.reaction * 0.5) {
    ai.reactT = sp.reaction * 0.5;
  }
  ai.hold = !t ? "noTarget" : ai.canSee ? "move" : "unseen";

  let vel: Vec = { x: 0, y: 0 };
  let trigger = false;
  const toT = t ? Math.atan2(t.pos.y - e.pos.y, t.pos.x - e.pos.x) : e.facing;

  const fromGrenade = grenadeEscape(w, e, t);
  const escape = fromGrenade ?? fireEscape(w, e, t);
  if (escape && e.heal) cancelHeal(w, e);

  if (e.heal) {
    ai.why = "回復している";
    if (t && ai.canSee && d < 7 && e.health > 35) {
      cancelHeal(w, e);
      ai.why = "近いので回復をやめる";
    } else if (t && ai.canSee) {
      vel = { x: -Math.cos(toT) * HEAL_MOVE_SPEED, y: -Math.sin(toT) * HEAL_MOVE_SPEED };
      ai.why = "回復しながら下がる";
    }
  }

  if (!e.heal) {
    switch (ai.state) {
      case "patrol": {
        ai.why = "巡回で立ち止まっている";
        ai.waitT -= DT;
        if (ai.waitT <= 0 && (!ai.pathTarget || dist(e.pos, ai.pathTarget) < 1)) {
          if (ai.roam && dist(e.pos, ai.home) < 20 && w.rng.chance(ROAM_CHANCE) && isLeader(w, e) && roamTo(w, e)) ai.why = "巡回の中心を遠くへ移す";
          for (let k = 0; k < 10; k++) {
            const q = { x: ai.home.x + w.rng.range(-18, 18), y: ai.home.y + w.rng.range(-18, 18) };
            if (w.map.walkable(q.x, q.y)) {
              ai.pathTarget = null;
              ai.path = [];
              vel = seek(w, e, q, ENEMY_SPEED.patrol);
              break;
            }
          }
          ai.waitT = w.rng.range(1.5, 4);
        } else if (ai.pathTarget && dist(e.pos, ai.pathTarget) >= 1) {
          const far = dist(e.pos, ai.home) > 30;
          ai.why = far ? "遠くの巡回先へ移っている" : "巡回している";
          vel = seek(w, e, ai.pathTarget, far ? ENEMY_SPEED.move * 0.7 : ENEMY_SPEED.patrol);
          // 探索の上限までに道が見つからなかった。同じ行き先を探し直し続けると重いので、今いる所を巡回の中心にする
          if (!ai.path.length) {
            ai.home = { ...e.pos };
            ai.pathTarget = null;
          }
        }
        if (Math.hypot(vel.x, vel.y) > 0.1) turnTo(e, Math.atan2(vel.y, vel.x), 4);
        break;
      }
      case "engage": {
        if (!ai.canSee && (!ai.lastSeen || w.time - ai.lastSeenT > FORGET_AFTER)) {
          ai.why = "見失ったので巡回に戻る";
          ai.state = "patrol";
          ai.target = null;
          ai.pathTarget = null;
          ai.path = [];
          ai.waitT = 0;
          break;
        }
        if (e.shield <= 0 && e.health < 60 && ai.heals > 0) {
          ai.why = "シールドが割れたので下がる";
          ai.state = "retreat";
          ai.pathTarget = null;
          ai.stateT = 6;
          break;
        }
        const exposed = !!t && (t.heal !== null || t.reloadT > 0);
        if (t && ai.canSee && exposed && e.shield + e.health >= 120 && d < 30) {
          ai.why = "相手が回復・リロード中なので詰める";
          ai.state = "push";
          ai.stateT = 2.5;
          break;
        }
        if (t && ai.canSee) {
          const keep = sp.keepDistance;
          const speed = ENEMY_SPEED.move;
          if (e.reloadT > 0 && d < keep + 5) {
            ai.why = "リロード中なので下がる";
            vel = { x: -Math.cos(toT) * speed, y: -Math.sin(toT) * speed };
          } else if (d > keep + 4) {
            ai.why = "保つ間合いより遠いので近づく";
            vel = seek(w, e, t.pos, speed);
          } else if (d < keep - 3) {
            ai.why = "保つ間合いより近いので離れる";
            vel = { x: -Math.cos(toT) * speed * 0.8, y: -Math.sin(toT) * speed * 0.8 };
          } else {
            ai.why = "間合いを保って横に動く";
            ai.strafeT -= DT;
            if (ai.strafeT <= 0) {
              ai.strafe = w.rng.chance(0.5) ? 1 : -1;
              ai.strafeT = w.rng.range(0.7, 1.8);
            }
            const s = ai.strafe * speed * 0.7;
            vel = { x: -Math.sin(toT) * s, y: Math.cos(toT) * s };
          }
          turnTo(e, toT, 7);
          trigger = aimReady(e, d, toT, 0.12);
        } else if (ai.lastSeen) {
          ai.why = "最後に見た所の周りを見回す";
          if (dist(e.pos, ai.lastSeen) > 1.5) {
            ai.why = "最後に見た所へ向かう";
            vel = seek(w, e, ai.lastSeen, ENEMY_SPEED.move);
            if (Math.hypot(vel.x, vel.y) > 0.1) turnTo(e, Math.atan2(vel.y, vel.x), 6);
          } else {
            turnTo(e, e.facing + 1, 2);
          }
        }
        break;
      }
      case "retreat": {
        const threat = t?.pos ?? ai.lastSeen ?? e.pos;
        if (!ai.pathTarget || ai.stateT <= 0) {
          const cover = findCover(w, e, threat);
          ai.stateT = 6;
          if (cover) {
            ai.why = "遮蔽へ下がる";
            ai.path = [];
            ai.pathTarget = null;
            vel = seek(w, e, cover, ENEMY_SPEED.move);
          } else {
            ai.why = "遮蔽が無いのでその場で回復する";
            if (startHeal(w, e, "cellBatch")) ai.heals--;
            ai.state = "engage";
          }
          break;
        }
        const arrived = dist(e.pos, ai.pathTarget) < 1;
        if (arrived || (!ai.canSee && w.time - ai.lastSeenT > 0.8)) {
          ai.why = "遮蔽に着いたので回復する";
          const kind = e.shield >= 50 && e.health < 60 ? "medSmall" : "cellBatch";
          if (startHeal(w, e, kind)) ai.heals--;
          ai.state = "engage";
          ai.pathTarget = null;
        } else {
          ai.why = "遮蔽へ下がる";
          vel = seek(w, e, ai.pathTarget, ENEMY_SPEED.move);
          if (Math.hypot(vel.x, vel.y) > 0.1) turnTo(e, Math.atan2(vel.y, vel.x), 6);
        }
        break;
      }
      case "push": {
        const exposed = !!t && (t.heal !== null || t.reloadT > 0);
        if (!t || ai.stateT <= 0 || (!exposed && ai.stateT < 1.5)) {
          ai.why = "隙が終わったので詰めるのをやめる";
          ai.state = "engage";
          break;
        }
        ai.why = "相手の隙に詰めている";
        vel = d < 4 ? { x: 0, y: 0 } : seek(w, e, t.pos, ENEMY_SPEED.push);
        if (ai.canSee) {
          turnTo(e, toT, 8);
          trigger = aimReady(e, d, toT, 0.15);
        }
        break;
      }
    }
  }

  if (escape) {
    ai.why = fromGrenade ? "グレネードから逃げる" : "炎の外へ出る";
    const dx = escape.x - e.pos.x, dy = escape.y - e.pos.y;
    const l = Math.hypot(dx, dy) || 1;
    vel = { x: (dx / l) * ENEMY_SPEED.push, y: (dy / l) * ENEMY_SPEED.push };
    if (!ai.canSee) turnTo(e, Math.atan2(dy, dx), 6);
  }

  if (e.reloadT > 0 || e.heal) {
    const s = Math.hypot(vel.x, vel.y);
    const max = e.heal ? HEAL_MOVE_SPEED : 4.4;
    if (s > max) {
      vel.x = (vel.x / s) * max;
      vel.y = (vel.y / s) * max;
    }
  }

  const slow = burnMul(e);
  vel.x *= slow;
  vel.y *= slow;

  const k = 1 - Math.exp(-DT * 12);
  e.vel.x += (vel.x - e.vel.x) * k;
  e.vel.y += (vel.y - e.vel.y) * k;

  if (ai.restT > 0) {
    ai.restT -= DT;
    if (trigger) ai.hold = "rest";
    trigger = false;
  }
  if (trigger) {
    pullTrigger(w, e, e.facing, sp.aimError);
    ai.burstT += DT;
    if (ai.burstT >= ai.burstLen) {
      ai.burstT = 0;
      ai.burstLen = w.rng.range(sp.burst[0], sp.burst[1]);
      ai.restT = w.rng.range(sp.rest[0], sp.rest[1]);
    }
  } else {
    releaseTrigger(e);
    if (weapon(e).mag === 0) startReload(w, e);
  }
}
