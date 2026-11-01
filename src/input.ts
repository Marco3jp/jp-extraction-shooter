import type { HealKind, ThrowableId } from "./sim/data";
import { emptyInput, type Command, type Input } from "./sim/sim";

const HEAL_KEYS: Record<string, HealKind> = {
  Digit3: "cell",
  Digit4: "cellBatch",
  Digit5: "medSmall",
  Digit6: "medLarge",
};

export class InputState {
  mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  private keys = new Set<string>();
  private fire = false;
  private pending = emptyInput();
  /** 投げ物のキーを押している間、その種類。離すと投げる */
  aimingThrow: ThrowableId | null = null;
  /** false の間はキー入力を受け付けない（拠点の画面のフォームで Tab などを使えるように） */
  enabled = true;
  onEscape: () => void = () => {};
  onPauseKey: () => void = () => {};
  onInventory: () => void = () => {};
  onMap: () => void = () => {};
  /** F キー。true を返したら（箱の中身を取ったなど）ゲームには渡さない */
  onInteract: () => boolean = () => false;
  onDebug: (key: "sight" | "beacon") => void = () => {};
  onRestart: () => void = () => {};

  constructor(target: HTMLElement) {
    window.addEventListener("keydown", (e) => {
      if (!this.enabled) return;
      if (["Tab", "Space", "ShiftLeft", "ShiftRight"].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      switch (e.code) {
        case "KeyR": this.pending.reload = true; break;
        case "Space": this.pending.dash = true; break;
        case "KeyG": this.aimingThrow = "frag"; break;
        case "KeyT": this.aimingThrow = "thermite"; break;
        case "Digit1": this.pending.swap = 0; break;
        case "Digit2": this.pending.swap = 1; break;
        case "KeyQ": this.pending.swap = -1; break;
        case "KeyX": this.pending.cancel = true; break;
        case "KeyF":
          if (!this.onInteract()) this.pending.interact = true;
          break;
        case "Tab": this.onInventory(); break;
        case "KeyM": this.onMap(); break;
        case "Escape": this.onEscape(); break;
        case "KeyP": this.onPauseKey(); break;
        case "KeyN": this.onDebug("sight"); break;
        case "KeyB": this.onDebug("beacon"); break;
        case "Enter": this.onRestart(); break;
      }
      if (HEAL_KEYS[e.code]) this.pending.heal = HEAL_KEYS[e.code];
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      const released = e.code === "KeyG" ? "frag" : e.code === "KeyT" ? "thermite" : null;
      if (released && this.aimingThrow === released) {
        this.pending.throw = released;
        this.aimingThrow = null;
      }
    });
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.fire = false;
    });
    window.addEventListener("mousemove", (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
    target.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.fire = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.fire = false;
    });
    target.addEventListener("wheel", (e) => {
      this.pending.swap = -1;
      e.preventDefault();
    }, { passive: false });
    target.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  command(c: Command) {
    this.pending.commands.push(c);
  }

  /** 1ティック分の入力を取り出す。押した瞬間の操作は1回だけ渡す */
  take(aim: { x: number; y: number }, currentWeapon: number, mouseBlocked: boolean): Input {
    const k = this.keys;
    const input = this.pending;
    this.pending = emptyInput();
    input.move = {
      x: (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0),
      y: (k.has("KeyS") ? 1 : 0) - (k.has("KeyW") ? 1 : 0),
    };
    input.aim = aim;
    input.fire = this.fire && !mouseBlocked;
    input.sprint = k.has("ShiftLeft") || k.has("ShiftRight");
    if (input.swap === -1) input.swap = currentWeapon === 0 ? 1 : 0;
    return input;
  }

  clearHeld() {
    this.fire = false;
    this.aimingThrow = null;
    const commands = this.pending.commands;
    this.pending = emptyInput();
    this.pending.commands = commands;
  }
}
