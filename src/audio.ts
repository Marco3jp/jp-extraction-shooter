import type { GameEvent, World } from "./sim/world";

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  unlock() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 0.5;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  private burst(dur: number, freq: number, gain: number, q = 1) {
    const ctx = this.ctx, m = this.master;
    if (!ctx || !m || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(m);
    src.start(t);
    src.stop(t + dur);
  }

  private tone(freqs: number[], step: number, gain: number, type: OscillatorType = "sine") {
    const ctx = this.ctx, m = this.master;
    if (!ctx || !m) return;
    const t = ctx.currentTime;
    freqs.forEach((fr, i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = fr;
      const g = ctx.createGain();
      const t0 = t + i * step;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + step * 1.6);
      o.connect(g).connect(m);
      o.start(t0);
      o.stop(t0 + step * 1.8);
    });
  }

  handle(w: World, events: GameEvent[]) {
    if (!this.ctx) return;
    const p = w.player;
    const byId = new Map(w.actors.map((a) => [a.id, a]));
    const near = (pos: { x: number; y: number }, r: number) => {
      const d = Math.hypot(pos.x - p.pos.x, pos.y - p.pos.y);
      return d < r ? 1 - (d / r) * 0.7 : 0;
    };
    let shots = 0;
    for (const ev of events) {
      switch (ev.type) {
        case "shot": {
          if (shots++ > 3) break;
          const mine = ev.actor === p.id;
          const v = mine ? 0.5 : near(ev.pos, 60) * 0.3;
          if (v > 0) this.burst(0.09, mine ? 1400 : 900, v, 0.8);
          break;
        }
        case "hit": {
          const t = byId.get(ev.actor);
          if (t?.team === "player") this.burst(0.12, 300, 0.6, 2);
          else if (ev.by === p.id) this.tone([ev.shield ? 1800 : 1200], 0.04, 0.12, "square");
          break;
        }
        case "shieldBreak": {
          const t = byId.get(ev.actor);
          if (t?.team === "player") this.tone([900, 500, 300], 0.06, 0.25, "sawtooth");
          else if (t && (t.seen || t.info >= 2)) {
            this.burst(0.35, 4200, 0.6, 3);
            this.tone([2400, 1600], 0.05, 0.15, "triangle");
          }
          break;
        }
        case "reloadStart": {
          const t = byId.get(ev.actor);
          if (t && t.team === "enemy" && (t.seen || t.info >= 2)) this.tone([520, 380], 0.07, 0.18, "square");
          if (t?.team === "player") this.tone([300, 260], 0.06, 0.08, "square");
          break;
        }
        case "healStart": {
          const t = byId.get(ev.actor);
          if (t && t.team === "enemy" && (t.seen || t.info >= 2)) this.tone([440, 660, 880], 0.08, 0.14, "triangle");
          if (t?.team === "player") this.tone([660, 880], 0.06, 0.08);
          break;
        }
        case "healDone": {
          const t = byId.get(ev.actor);
          if (t?.team === "player") this.tone([880, 1320], 0.07, 0.12);
          break;
        }
        case "death":
          this.burst(0.4, 200, 0.5, 1);
          if (byId.get(ev.actor)?.team === "partner") this.tone([660, 440, 330], 0.1, 0.2, "sawtooth");
          break;
        case "revive":
          this.tone([440, 660, 880, 1100], 0.07, 0.16, "triangle");
          break;
        case "explosion": {
          const v = near(ev.pos, 70);
          if (v > 0) {
            this.burst(0.7, 120, 0.9 * v, 0.7);
            this.burst(0.25, 900, 0.4 * v, 0.6);
          }
          break;
        }
        case "fireStart": {
          const v = near(ev.a, 60);
          if (v > 0) this.burst(0.9, 2500, 0.25 * v, 0.4);
          break;
        }
        case "throw":
          if (ev.actor === p.id) this.burst(0.12, 600, 0.2, 1.5);
          break;
        case "dash":
          if (ev.actor === p.id) this.burst(0.18, 1800, 0.25, 0.8);
          break;
        case "pickup":
          this.tone([700, 1050], 0.05, 0.1);
          break;
        case "skill":
          if (ev.actor === p.id) this.tone([600, 900, 1200], 0.05, 0.14, "triangle");
          break;
        case "barrierBreak":
          this.burst(0.3, 700, near(ev.pos, 50) * 0.5, 1);
          break;
        case "extractCall":
          this.tone([520, 780, 520, 780], 0.12, 0.2, "square");
          break;
        case "extractReady":
          this.tone([660, 990, 1320], 0.1, 0.18, "triangle");
          break;
      }
    }
  }
}
