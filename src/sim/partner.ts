import { angleDiff, findCover, fireEscape, grenadeEscape, scan, seek, turnTo } from "./ai";
import { burnMul, cancelHeal, pullTrigger, releaseTrigger, startHeal, startReload, weapon } from "./combat";
import {
  DT, HEAL_MOVE_SPEED, HEALTH_MAX, MOVE_SPEED, PARTNER, PARTNER_COVER, PARTNER_COVER_DIST, PARTNER_FOCUS_TIME, PARTNER_HEAL, PARTNER_LEASH, PARTNER_TACTICS, PARTNER_WIN_MARGIN,
  PARTNER_RETURN_UNTIL, PARTNER_SLOTS, SHIELD_PER_CELL, SPRINT_SPEED, type HealKind,
} from "./data";
import type { Vec } from "./map";
import type { Actor, World } from "./world";

const SCAN_INTERVAL = 0.2;
/** 見失ってから狙う相手を忘れるまで */
const FORGET_AFTER = 8;
/** 付く位置の向きを、プレイヤーの向きへ寄せる速さ（rad/秒）。マウスを振るたびに左右が入れ替わらないように遅くする */
const HEADING_RATE = 1.5;
/** 付く位置からこれ以上離れていたら走る。さらに catchUpFrom より離れていたら、プレイヤーが走るより少し速く走って追いつく */
const RUN_FROM = 5;
const CATCH_UP_FROM = 7;
const CATCH_UP_MUL = 1.15;

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

/** プレイヤーの左後ろ・右後ろの位置。塞がっていたり壁の向こうだったりしたら、プレイヤーに近づける */
export function slotPos(w: World, e: Actor): Vec {
  const p = w.player;
  const slot = PARTNER_SLOTS[e.partner!.index % PARTNER_SLOTS.length];
  const ang = e.partner!.heading + (slot.angle * Math.PI) / 180;
  for (const r of [slot.dist, slot.dist * 0.5]) {
    const q = { x: p.pos.x + Math.cos(ang) * r, y: p.pos.y + Math.sin(ang) * r };
    if (w.map.walkable(q.x, q.y) && w.map.los(p.pos, q)) return q;
  }
  return { ...p.pos };
}

function pickTarget(w: World, e: Actor, byId: Map<number, Actor>) {
  const ai = e.ai!;
  const focus = w.focus && w.time - w.focus.t < PARTNER_FOCUS_TIME ? byId.get(w.focus.actor) : undefined;
  if (focus && focus.alive && dist(e.pos, focus.pos) <= PARTNER.sight && w.map.los(e.pos, focus.pos)) {
    ai.target = focus.id;
    return;
  }
  const found = scan(w, e);
  if (!found || found.id === ai.target) return;
  const cur = ai.target !== null ? byId.get(ai.target) : undefined;
  if (!cur || !cur.alive || !ai.canSee || dist(e.pos, found.pos) < dist(e.pos, cur.pos) - 5) ai.target = found.id;
}

/** threat から隠れられて、少し出れば撃てる場所。付く位置の近くで、今いる所から近いものを選ぶ。無ければ null */
function findPeekCover(w: World, e: Actor, threat: Vec, anchor: Vec): { hide: Vec; peek: Vec } | null {
  const m = w.map;
  const p = w.player;
  let best: { hide: Vec; peek: Vec } | null = null;
  let bestScore = Infinity;
  const cands: Vec[] = [{ ...e.pos }, { ...anchor }];
  for (let r = 1.5; r <= PARTNER_COVER.searchRadius; r += 1.5) {
    const n = Math.round(r * 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      cands.push({ x: anchor.x + Math.cos(a) * r, y: anchor.y + Math.sin(a) * r });
    }
  }
  for (const h of cands) {
    const score = dist(e.pos, h) + dist(h, anchor) * 0.5;
    if (score >= bestScore) continue;
    if (!m.walkable(h.x, h.y) || dist(h, p.pos) > PARTNER_COVER.maxFromPlayer || dist(h, threat) < PARTNER_HEAL.closeRange) continue;
    if (m.los(h, threat)) continue;
    let peek: Vec | null = null;
    for (const r of PARTNER_COVER.peekDist) {
      for (let i = 0; i < 8 && !peek; i++) {
        const a = (i / 8) * Math.PI * 2;
        const q = { x: h.x + Math.cos(a) * r, y: h.y + Math.sin(a) * r };
        if (m.walkable(q.x, q.y) && m.walkLine(h, q, 0.4) && m.los(q, threat)) peek = q;
      }
      if (peek) break;
    }
    if (!peek) continue;
    best = { hide: h, peek };
    bestScore = score;
  }
  return best;
}

/** 相手のシールドとヘルスが、自分より十分に少ないか */
function winning(e: Actor, t: Actor | undefined): boolean {
  return !!t && e.ai!.canSee && t.shield + t.health + PARTNER_WIN_MARGIN <= e.shield + e.health;
}

/** 今巻くもの。cover なら遮蔽へ引いてから巻く。巻かないなら null */
function chooseHeal(w: World, e: Actor, t: Actor | undefined, d: number): { kind: HealKind; cover: boolean } | null {
  const ai = e.ai!;
  if (PARTNER_TACTICS.mode === "classic") {
    return e.shield <= 0 && e.health < 60 && ai.heals > 0 ? { kind: "cellBatch", cover: true } : null;
  }
  const inCombat = !!t && w.time - ai.lastSeenT < PARTNER_HEAL.combatHold;
  if (!inCombat) {
    if (e.shield < e.shieldMax) return { kind: "cellBatch", cover: false };
    if (e.health < HEALTH_MAX) return { kind: e.health < 60 ? "medLarge" : "medSmall", cover: false };
    return null;
  }
  if (e.health < PARTNER_HEAL.fullHealBelow) return { kind: "medLarge", cover: true };
  const close = ai.canSee && d < PARTNER_HEAL.closeRange;
  const finishing = ai.canSee && t!.shield + t!.health <= PARTNER_HEAL.finishHp;
  if (close || finishing || winning(e, t) || w.player.heal) return null;
  if (e.shield <= 0 && e.health < PARTNER_HEAL.breakRetreatBelow) return { kind: "cellBatch", cover: true };
  // 相手から見えていないときに、隠れるたびに1回だけ巻く。マガジンが空なら、巻いてからリロードする
  if (ai.canSee || e.partner!.hideHealed) return null;
  if (e.health < PARTNER_HEAL.oneHealBelow) return { kind: "medSmall", cover: false };
  if (e.shieldMax - e.shield >= SHIELD_PER_CELL) return { kind: "cell", cover: false };
  return null;
}

export function updatePartner(w: World, e: Actor, byId: Map<number, Actor>) {
  const ai = e.ai!;
  const ps = e.partner!;
  const p = w.player;
  ai.stateT -= DT;
  ps.heading += Math.max(-HEADING_RATE * DT, Math.min(HEADING_RATE * DT, angleDiff(ps.heading, p.facing)));

  const before = ai.target;
  ai.scanT -= DT;
  if (ai.scanT <= 0) {
    ai.scanT = SCAN_INTERVAL;
    pickTarget(w, e, byId);
  }
  let t = ai.target !== null ? byId.get(ai.target) : undefined;
  if (t && !t.alive) t = undefined;
  if (!t) ai.target = null;
  if (ai.target !== before && ai.target !== null) ai.reactT = PARTNER.reaction * w.rng.range(1, 1.6);
  const d = t ? dist(e.pos, t.pos) : Infinity;
  ai.canSee = !!t && d < PARTNER.sight * 1.15 && w.map.los(e.pos, t.pos);
  if (t && ai.canSee) {
    ai.lastSeen = { ...t.pos };
    ai.lastSeenT = w.time;
    ai.reactT -= DT;
  } else {
    if (ai.reactT < PARTNER.reaction * 0.5) ai.reactT = PARTNER.reaction * 0.5;
    if (t && w.time - ai.lastSeenT > FORGET_AFTER) {
      ai.target = null;
      t = undefined;
    }
  }

  const dP = dist(e.pos, p.pos);
  if (ai.state === "return") {
    if (dP < PARTNER_RETURN_UNTIL) ai.state = "follow";
  } else if (dP > PARTNER_LEASH) {
    ai.state = "return";
    ai.pathTarget = null;
    if (e.heal) cancelHeal(w, e);
  }
  if (ai.state === "follow" && t && ai.canSee) ai.state = "fight";
  if (ai.state === "fight" && !t) ai.state = "follow";

  const escape = grenadeEscape(w, e, t) ?? fireEscape(w, e, t);
  if (escape && e.heal) cancelHeal(w, e);
  if (e.heal && t && ai.canSee && d < PARTNER_HEAL.closeRange && e.health > 35) cancelHeal(w, e);
  if (!e.heal && !escape && ai.state !== "return" && ai.state !== "heal") {
    const h = chooseHeal(w, e, t, d);
    if (h?.cover) {
      ai.state = "heal";
      ps.healKind = h.kind;
      ai.pathTarget = null;
      ai.stateT = 6;
    } else if (h && startHeal(w, e, h.kind)) {
      ps.hideHealed = true;
    }
  }
  if (ai.state !== "fight") {
    ps.cover = null;
    ps.phase = "hide";
  }
  if (!t) ps.hideHealed = false;

  const toT = t ? Math.atan2(t.pos.y - e.pos.y, t.pos.x - e.pos.x) : e.facing;
  const run = SPRINT_SPEED * e.moveMul;
  const walk = MOVE_SPEED * e.moveMul;
  let vel: Vec = { x: 0, y: 0 };
  let trigger = false;

  const faceMove = () => {
    if (Math.hypot(vel.x, vel.y) > 0.1) turnTo(e, Math.atan2(vel.y, vel.x), 6);
  };

  if (e.heal) {
    // 巻いている間は、隠れる所か付く位置へゆっくり寄る
    const to = ai.state === "fight" && ps.cover ? ps.cover.hide : slotPos(w, e);
    if (dist(e.pos, to) > 0.5) vel = seek(w, e, to, HEAL_MOVE_SPEED);
  } else {
    switch (ai.state) {
      case "return": {
        vel = seek(w, e, p.pos, run * CATCH_UP_MUL);
        faceMove();
        break;
      }
      case "heal": {
        const threat = t?.pos ?? ai.lastSeen ?? p.pos;
        if (!ai.pathTarget || ai.stateT <= 0) {
          const cover = ps.cover && !w.map.los(ps.cover.hide, threat) ? ps.cover.hide : findCover(w, e, threat);
          ai.stateT = 6;
          if (cover && dist(cover, p.pos) < PARTNER_LEASH * 0.6) {
            ai.path = [];
            ai.pathTarget = null;
            vel = seek(w, e, cover, run);
          } else {
            if (startHeal(w, e, ps.healKind ?? "cellBatch")) ai.heals--;
            ai.state = "follow";
          }
          break;
        }
        if (dist(e.pos, ai.pathTarget) < 1 || (!ai.canSee && w.time - ai.lastSeenT > 0.8)) {
          if (startHeal(w, e, ps.healKind ?? "cellBatch")) ai.heals--;
          ai.state = "follow";
          ai.pathTarget = null;
        } else {
          vel = seek(w, e, ai.pathTarget, run);
          faceMove();
        }
        break;
      }
      case "follow": {
        const slot = slotPos(w, e);
        const ds = dist(e.pos, slot);
        if (ds > 1) vel = seek(w, e, slot, ds > CATCH_UP_FROM ? run * CATCH_UP_MUL : ds > RUN_FROM || p.sprinting ? run : walk);
        if (t && ai.lastSeen) turnTo(e, Math.atan2(ai.lastSeen.y - e.pos.y, ai.lastSeen.x - e.pos.x), 6);
        else if (Math.hypot(vel.x, vel.y) > 0.1) faceMove();
        else turnTo(e, p.facing, 3);
        break;
      }
      case "fight": {
        const threat = ai.canSee ? t!.pos : ai.lastSeen ?? t!.pos;
        const slot = slotPos(w, e);
        const c = ps.cover;
        if (PARTNER_TACTICS.mode === "classic") ps.cover = null;
        else if (!c || dist(c.threat, threat) > PARTNER_COVER.threatMove || w.time - c.t > PARTNER_COVER.refresh || dist(c.hide, p.pos) > PARTNER_COVER.maxFromPlayer) {
          const found = findPeekCover(w, e, threat, slot);
          ps.cover = found ? { ...found, threat: { ...threat }, t: w.time } : null;
        }
        if (ps.cover && !p.heal && !winning(e, t)) {
          // 遮蔽の裏に隠れ、少し出て撃つ。マガジンが空・リロード中・出てから撃たれすぎたら隠れ直す。
          // 撃ち合いに勝っている間と、プレイヤーが巻いている間は、隠れずにその場で撃ち合う
          const cv = ps.cover;
          const hp = e.shield + e.health;
          if (ps.phase === "peek" && (weapon(e).mag === 0 || e.reloadT > 0 || ps.peekHp - hp >= PARTNER_COVER.peekDamage)) {
            ps.phase = "hide";
          } else if (ps.phase === "hide" && dist(e.pos, cv.hide) < 0.8 && e.reloadT <= 0 && weapon(e).mag > 0) {
            ps.phase = "peek";
            ps.peekHp = hp;
            ps.hideHealed = false;
          }
          let to = cv.hide;
          if (ps.phase === "peek") {
            // 止まっていると当たりやすいので、出た所と、隠れる所寄りの所の間を行き来しながら撃つ
            const k = (Math.sin(w.time * 2.4 + e.id) + 1) / 2;
            const f = 0.55 + 0.45 * k;
            to = { x: cv.hide.x + (cv.peek.x - cv.hide.x) * f, y: cv.hide.y + (cv.peek.y - cv.hide.y) * f };
          }
          const dd = dist(e.pos, to);
          if (dd > 0.3) vel = seek(w, e, to, dd > 4 ? run : walk);
          turnTo(e, toT, 7);
          // 遮蔽へ向かう間も、見えていれば撃つ
          trigger = ai.canSee && ai.reactT <= 0 && d <= weapon(e).def.range && Math.abs(angleDiff(e.facing, toT)) < 0.12;
          break;
        }
        // 隠れる所が無いときと、プレイヤーが巻いている間は、その場で撃ち合う。巻いている間はプレイヤーと敵の間に出る
        let anchor = slot;
        if (p.heal) {
          const a = Math.atan2(t!.pos.y - p.pos.y, t!.pos.x - p.pos.x);
          anchor = { x: p.pos.x + Math.cos(a) * PARTNER_COVER_DIST, y: p.pos.y + Math.sin(a) * PARTNER_COVER_DIST };
        }
        if (dist(e.pos, anchor) > 2.5 && w.map.walkable(anchor.x, anchor.y)) {
          vel = seek(w, e, anchor, walk);
        } else {
          ai.strafeT -= DT;
          if (ai.strafeT <= 0) {
            ai.strafe = w.rng.chance(0.5) ? 1 : -1;
            ai.strafeT = w.rng.range(0.7, 1.8);
          }
          const s = ai.strafe * walk * 0.5;
          vel = { x: -Math.sin(toT) * s, y: Math.cos(toT) * s };
        }
        turnTo(e, toT, 7);
        trigger = ai.canSee && ai.reactT <= 0 && d <= weapon(e).def.range && Math.abs(angleDiff(e.facing, toT)) < 0.12;
        break;
      }
    }
  }

  if (escape) {
    const dx = escape.x - e.pos.x, dy = escape.y - e.pos.y;
    const l = Math.hypot(dx, dy) || 1;
    vel = { x: (dx / l) * run, y: (dy / l) * run };
  }

  if (e.reloadT > 0 || e.heal) {
    const s = Math.hypot(vel.x, vel.y);
    const max = e.heal ? HEAL_MOVE_SPEED : walk * 0.8;
    if (s > max) {
      vel.x = (vel.x / s) * max;
      vel.y = (vel.y / s) * max;
    }
  }
  const slow = burnMul(e);
  const k = 1 - Math.exp(-DT * 12);
  e.vel.x += (vel.x * slow - e.vel.x) * k;
  e.vel.y += (vel.y * slow - e.vel.y) * k;

  if (ai.restT > 0) {
    ai.restT -= DT;
    trigger = false;
  }
  if (trigger) {
    pullTrigger(w, e, e.facing, PARTNER.aimError);
    ai.burstT += DT;
    if (ai.burstT >= ai.burstLen) {
      ai.burstT = 0;
      ai.burstLen = w.rng.range(PARTNER.burst[0], PARTNER.burst[1]);
      ai.restT = w.rng.range(PARTNER.rest[0], PARTNER.rest[1]);
    }
  } else {
    releaseTrigger(e);
    const ws = weapon(e);
    // 撃ち合っていない間に、半分を切ったマガジンを込め直しておく
    if (ws.mag === 0 || (!ai.canSee && ws.mag < ws.def.mag / 2)) startReload(w, e);
  }
}
