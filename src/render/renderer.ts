import * as THREE from "three";
import {
  BEACON_RADIUS, EXTRACT_RADIUS, HEALS, ITEMS, PLAYER_FACTION, RARITY_COLORS, factionDef, type ItemCategory,
} from "../sim/data";
import { weapon, isMoving } from "../sim/combat";
import { Solid, chunkKey, type ChunkJson, type GameMap, type Vec } from "../sim/map";
import { MeshBuilder, addBuilding, buildGround, buildRoadText, buildSigns, disposeChunk, hash } from "./cityscape";
import { nearestLoot } from "../sim/sim";
import { grenadePos, thermiteLine, throwLanding } from "../sim/throwables";
import { BARRIER, DT, FRAG, HEAL_SENSE, THERMITE, type ThrowableId } from "../sim/data";
import type { Actor, Extract, GameEvent, Loot, World } from "../sim/world";

const CAM_OFFSET = new THREE.Vector3(0, 56, 36);
const GUN_Y = 1.0;

/** 呼んでいない・迎えを待っている・迎えが来ている */
export const EXTRACT_COLORS = { idle: 0x7fbf9a, called: 0xffc84a, ready: 0x50ff9a };

export function extractColor(e: Extract): number {
  return e.ready ? EXTRACT_COLORS.ready : e.readyAt !== null ? EXTRACT_COLORS.called : EXTRACT_COLORS.idle;
}

export const TYPE_COLORS = { short: 0xff8a3a, mid: 0x60d0c0, long: 0xb070ff, partner: 0x9ae8ff };
/** パートナーの体の色。プレイヤー（勢力0の色）に寄せて、少し明るくする */
export const PARTNER_COLOR = 0x8fd8ff;

type BoxState = "closed" | "opened" | "empty";
type BoxColors = { body: number; lid: number; accent: number };
const BIN_COLORS: Record<BoxState, BoxColors> = {
  closed: { body: 0x2e3d4c, lid: 0x40566a, accent: 0xffc840 },
  opened: { body: 0x2c3844, lid: 0x3a4a58, accent: 0x7a8a7c },
  empty: { body: 0x23282e, lid: 0x2a3036, accent: 0x2a2e33 },
};
const DEATHBOX_COLORS: Record<BoxState, BoxColors> = {
  closed: { body: 0x4a2426, lid: 0, accent: 0xff5a40 },
  opened: { body: 0x44282a, lid: 0, accent: 0x8a4038 },
  empty: { body: 0x2e2828, lid: 0, accent: 0x342a2a },
};
const MARKER_COLORS = { bin: 0xffd257, deathbox: 0xff5a46 };
const BIN_INNER = { filled: 0x8a6a20, empty: 0x101214 };
const MONEY_COLOR = 0xffc030;
const BIN = { w: 1.1, h: 0.72, d: 0.7, lidH: 0.16 };
const DEATHBOX = { w: 0.9, h: 0.5, d: 0.9 };
const LID_OPEN_ANGLE = 1.95;
const MAX_BINS = 400;
const MAX_DEATHBOXES = 100;
const MAX_MARKERS = MAX_BINS + MAX_DEATHBOXES;

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  // 明るい地面でも見えるよう、中心をやや濃くして縁にもう一段の輪を作る
  grad.addColorStop(0, "rgba(255,255,255,0.55)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.3)");
  grad.addColorStop(0.72, "rgba(255,255,255,0.6)");
  grad.addColorStop(0.82, "rgba(255,255,255,0.25)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const buildingVert = /* glsl */ `
attribute vec3 aColor;
varying vec3 vColor;
varying vec3 vNormal;
varying float vViewZ;
varying float vY;
void main() {
  vColor = aColor;
  vNormal = normal;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vY = wp.y;
  vec4 mv = viewMatrix * wp;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const buildingFrag = /* glsl */ `
uniform vec2 uPlayerScreen;
uniform float uPlayerDepth;
uniform float uRadius;
varying vec3 vColor;
varying vec3 vNormal;
varying float vViewZ;
varying float vY;
void main() {
  // プレイヤーより手前にあって、画面上でプレイヤーに重なる部分を網目状に抜く
  if (vViewZ < uPlayerDepth - 1.0 && vY > 0.4) {
    float d = distance(gl_FragCoord.xy, uPlayerScreen);
    if (d < uRadius) {
      vec2 c = floor(gl_FragCoord.xy / 2.0);
      float checker = mod(c.x + c.y, 2.0);
      float edge = smoothstep(uRadius * 0.55, uRadius, d);
      if (edge < 0.5 || checker < 0.5) discard;
    }
  }
  vec3 n = normalize(vNormal);
  float l = 0.62 + 0.38 * max(dot(n, normalize(vec3(-0.35, 1.0, 0.5))), 0.0);
  if (n.y > 0.5) l = 1.05;
  gl_FragColor = vec4(vColor * l, 1.0);
}`;

type ActorView = {
  group: THREE.Group;
  body: THREE.Mesh;
  bodyMat: THREE.MeshLambertMaterial;
  ghost: THREE.Mesh;
  ghostMat: THREE.MeshBasicMaterial;
  typeRing: THREE.Mesh;
  typeRingMat: THREE.MeshBasicMaterial;
  healRing: THREE.Mesh;
  healMat: THREE.MeshBasicMaterial;
  reloadArc: THREE.Mesh;
};

type Particle = { p: THREE.Vector3; v: THREE.Vector3; life: number; max: number; color: THREE.Color; size: number };

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, max: number) {
  const m = new THREE.InstancedMesh(geo, mat, max);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = false;
  m.count = 0;
  m.setColorAt(0, new THREE.Color());
  return m;
}

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private camTarget = new THREE.Vector3();
  private camInit = false;
  private buildingMat: THREE.ShaderMaterial;
  private actorViews = new Map<number, ActorView>();
  private bullets: THREE.InstancedMesh;
  private particles: Particle[] = [];
  private particleMesh: THREE.InstancedMesh;
  private aimLine: THREE.Line;
  private spreadLines: THREE.LineSegments;
  private beaconRing: THREE.Mesh;
  /** 脱出地点ごとの光の柱と足元の輪。world.extracts と同じ並び */
  private extractMarks: { beam: THREE.Mesh; ring: THREE.Mesh }[] = [];
  private bins: THREE.InstancedMesh;
  private binLids: THREE.InstancedMesh;
  private binStripes: THREE.InstancedMesh;
  private binInners: THREE.InstancedMesh;
  private binLidBands: THREE.InstancedMesh;
  private deathboxes: THREE.InstancedMesh;
  private deathboxTops: THREE.InstancedMesh;
  private lootMarkers: THREE.InstancedMesh;
  private lootGlows: THREE.InstancedMesh;
  private markerBase = new Float32Array(MAX_MARKERS * 3);
  private markerCount = 0;
  private tmpM = new THREE.Matrix4();
  private tmpM2 = new THREE.Matrix4();
  private groundItems: Record<ItemCategory, THREE.InstancedMesh>;
  private lootHighlight: THREE.Mesh;
  private lootVersion = -1;
  private dummy = new THREE.Object3D();
  private raycaster = new THREE.Raycaster();
  private aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GUN_Y);
  private tmpV = new THREE.Vector3();
  private time = 0;
  private grenadeMesh!: THREE.InstancedMesh;
  private flameMesh!: THREE.InstancedMesh;
  private shockwaves: { mesh: THREE.Mesh; life: number; radius: number }[] = [];
  private throwRing!: THREE.Mesh;
  private throwLine!: THREE.Mesh;
  private barrierMesh!: THREE.InstancedMesh;
  private barrierGhost!: THREE.InstancedMesh;
  private railMesh!: THREE.InstancedMesh;
  private healMarkMesh!: THREE.InstancedMesh;
  private overshieldRing!: THREE.Mesh;

  private map: GameMap;
  private chunkViews = new Map<string, THREE.Group>();
  private chunkVersion = -1;

  constructor(container: HTMLElement, map: GameMap) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.setClearColor(0x1a1c20);
    container.appendChild(this.gl.domElement);
    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 500);

    this.scene.add(new THREE.HemisphereLight(0xdde6ff, 0x484038, 1.6));
    const sun = new THREE.DirectionalLight(0xfff2e0, 1.6);
    sun.position.set(-30, 60, 40);
    this.scene.add(sun);

    this.buildingMat = new THREE.ShaderMaterial({
      vertexShader: buildingVert,
      fragmentShader: buildingFrag,
      uniforms: {
        uPlayerScreen: { value: new THREE.Vector2() },
        uPlayerDepth: { value: 0 },
        uRadius: { value: 140 },
      },
    });
    this.map = map;

    this.bullets = instanced(new THREE.BoxGeometry(0.09, 0.09, 1.6), new THREE.MeshBasicMaterial({ color: 0xffffff }), 800);
    this.scene.add(this.bullets);
    this.particleMesh = instanced(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), 600);
    this.scene.add(this.particleMesh);

    const lootMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const accentMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.bins = instanced(new THREE.BoxGeometry(BIN.w, BIN.h, BIN.d).translate(0, BIN.h / 2, 0), lootMat, MAX_BINS);
    // ふたは奥側の辺を原点にしておき、開けたときはそこを軸に回す
    this.binLids = instanced(
      new THREE.BoxGeometry(BIN.w + 0.06, BIN.lidH, BIN.d + 0.06).translate(0, BIN.lidH / 2, (BIN.d + 0.06) / 2),
      lootMat, MAX_BINS,
    );
    this.binLidBands = instanced(
      new THREE.BoxGeometry(BIN.w + 0.08, 0.03, 0.2).translate(0, BIN.lidH + 0.005, (BIN.d + 0.06) / 2),
      accentMat, MAX_BINS,
    );
    this.binStripes = instanced(new THREE.BoxGeometry(BIN.w + 0.04, 0.11, BIN.d + 0.04).translate(0, BIN.h * 0.55, 0), accentMat, MAX_BINS);
    this.binInners = instanced(new THREE.BoxGeometry(BIN.w - 0.14, 0.01, BIN.d - 0.14).translate(0, BIN.h + 0.006, 0), accentMat, MAX_BINS);
    this.deathboxes = instanced(new THREE.BoxGeometry(DEATHBOX.w, DEATHBOX.h, DEATHBOX.d).translate(0, DEATHBOX.h / 2, 0), lootMat, MAX_DEATHBOXES);
    this.deathboxTops = instanced(
      new THREE.BoxGeometry(DEATHBOX.w - 0.14, 0.08, DEATHBOX.d - 0.14).translate(0, DEATHBOX.h + 0.04, 0),
      accentMat, MAX_DEATHBOXES,
    );
    this.lootMarkers = instanced(new THREE.OctahedronGeometry(1).scale(0.26, 0.4, 0.26), accentMat, MAX_MARKERS);
    this.lootGlows = instanced(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0.03, 0),
      new THREE.MeshBasicMaterial({
        map: glowTexture(), transparent: true, depthWrite: false,
      }),
      MAX_BINS + MAX_DEATHBOXES + 1200,
    );
    this.scene.add(this.lootGlows, this.binLids, this.binStripes, this.binInners, this.binLidBands, this.deathboxTops, this.lootMarkers);
    const glow = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.groundItems = {
      ammo: instanced(new THREE.BoxGeometry(0.55, 0.35, 0.4).translate(0, 0.18, 0), glow, 600),
      heal: instanced(new THREE.CylinderGeometry(0.2, 0.2, 0.55, 10).translate(0, 0.28, 0), glow, 600),
      throwable: instanced(new THREE.SphereGeometry(0.24, 12, 8).translate(0, 0.24, 0), glow, 600),
      material: instanced(new THREE.OctahedronGeometry(0.3).translate(0, 0.32, 0), glow, 600),
      money: instanced(new THREE.BoxGeometry(0.55, 0.12, 0.32).translate(0, 0.06, 0), glow, 600),
      buff: instanced(new THREE.CylinderGeometry(0.3, 0.3, 0.16, 6).translate(0, 0.3, 0), glow, 100),
    };
    this.scene.add(this.bins, this.deathboxes, ...Object.values(this.groundItems));
    this.lootHighlight = new THREE.Mesh(
      new THREE.RingGeometry(0.75, 0.9, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.lootHighlight.rotation.x = -Math.PI / 2;
    this.scene.add(this.lootHighlight);

    const aimGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.aimLine = new THREE.Line(aimGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18 }));
    this.aimLine.frustumCulled = false;
    this.scene.add(this.aimLine);
    const spreadGeo = new THREE.BufferGeometry().setFromPoints([0, 1, 2, 3].map(() => new THREE.Vector3()));
    this.spreadLines = new THREE.LineSegments(spreadGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    this.spreadLines.frustumCulled = false;
    this.scene.add(this.spreadLines);

    this.beaconRing = new THREE.Mesh(
      new THREE.RingGeometry(BEACON_RADIUS - 0.2, BEACON_RADIUS, 128),
      new THREE.MeshBasicMaterial({ color: 0x60e0ff, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    this.beaconRing.rotation.x = -Math.PI / 2;
    this.scene.add(this.beaconRing);


    this.grenadeMesh = instanced(new THREE.SphereGeometry(0.2, 10, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }), 64);
    this.flameMesh = instanced(
      new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
      600,
    );
    this.scene.add(this.grenadeMesh, this.flameMesh);
    this.throwRing = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.8, depthWrite: false, depthTest: false }),
    );
    this.throwRing.renderOrder = 30;
    this.throwLine = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff7a2c, transparent: true, opacity: 0.45, depthWrite: false, depthTest: false }),
    );
    this.throwLine.renderOrder = 30;
    this.scene.add(this.throwRing, this.throwLine);

    this.barrierMesh = instanced(
      new THREE.BoxGeometry(0.96, BARRIER.height, 0.96).translate(0, BARRIER.height / 2, 0),
      new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
      64,
    );
    // 建物の向こうに立てても見えるように、隠れた所だけ薄く重ねて描く
    this.barrierGhost = new THREE.InstancedMesh(
      this.barrierMesh.geometry,
      new THREE.MeshBasicMaterial({ color: 0x9ad8ff, transparent: true, opacity: 0.3, depthWrite: false, depthFunc: THREE.GreaterDepth }),
      64,
    );
    this.barrierGhost.instanceMatrix = this.barrierMesh.instanceMatrix;
    this.barrierGhost.frustumCulled = false;
    this.barrierGhost.count = 0;
    this.barrierGhost.renderOrder = 18;
    this.railMesh = instanced(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x80e8ff, transparent: true, opacity: 0.55, depthWrite: false }),
      16,
    );
    // 巻き検知の円は壁越しにも見せるので、建物に隠れないようにする
    this.healMarkMesh = instanced(
      new THREE.RingGeometry(0.94, 1, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x50e070, transparent: true, opacity: 0.75, depthWrite: false, depthTest: false }),
      32,
    );
    this.healMarkMesh.renderOrder = 25;
    this.overshieldRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.05, 6, 32).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd040, transparent: true, opacity: 0.8 }),
    );
    this.scene.add(this.barrierMesh, this.barrierGhost, this.railMesh, this.healMarkMesh, this.overshieldRing);

    this.resize();
  }

  private spawnShockwave(at: Vec, radius: number) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    mesh.position.set(at.x, 0.08, at.y);
    this.scene.add(mesh);
    this.shockwaves.push({ mesh, life: 0.45, radius });
  }

  private renderThrowPreview(w: World, kind: ThrowableId | null, aim: Vec) {
    this.throwRing.visible = false;
    this.throwLine.visible = false;
    if (!kind || !w.player.alive) return;
    const { to, angle } = throwLanding(w.map, w.player.pos, kind, aim);
    this.throwRing.visible = true;
    this.throwRing.position.set(to.x, 0.1, to.y);
    if (kind === "frag") {
      this.throwRing.scale.setScalar(FRAG.radius);
      return;
    }
    this.throwRing.scale.setScalar(0.6);
    const { a, b } = thermiteLine(w.map, to, angle);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    this.throwLine.visible = len > 0.1;
    this.throwLine.position.set((a.x + b.x) / 2, 0.09, (a.y + b.y) / 2);
    this.throwLine.rotation.set(0, -Math.atan2(b.y - a.y, b.x - a.x), 0);
    this.throwLine.scale.set(len, 1, THERMITE.width);
  }

  private renderThrowables(w: World, alpha: number, frameDt: number) {
    const col = new THREE.Color();
    let gi = 0;
    for (const g of w.grenades) {
      if (gi >= 64) break;
      const p = grenadePos({ ...g, t: g.t + alpha * DT });
      this.dummy.position.set(p.x, Math.max(0.2, p.h), p.y);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.grenadeMesh.setMatrixAt(gi, this.dummy.matrix);
      // グレネードは爆発が近づくと赤く点滅させる
      const blink = g.kind === "frag" && g.t > FRAG.fuse - 0.6 && Math.sin(this.time * 40) > 0;
      this.grenadeMesh.setColorAt(gi, col.setHex(g.kind === "thermite" ? 0xff7a2c : blink ? 0xff3030 : 0x4a6a3a));
      gi++;
    }
    this.grenadeMesh.count = gi;
    this.grenadeMesh.instanceMatrix.needsUpdate = true;
    if (this.grenadeMesh.instanceColor) this.grenadeMesh.instanceColor.needsUpdate = true;

    let fi = 0;
    for (const f of w.fires) {
      const len = Math.hypot(f.b.x - f.a.x, f.b.y - f.a.y);
      const n = Math.max(1, Math.ceil(len / 0.6));
      const fade = Math.min(1, f.t / 0.8);
      for (let k = 0; k <= n && fi < 600; k++) {
        const s = k / n;
        const seed = f.id * 13.7 + k * 3.1;
        const flick = 0.6 + 0.4 * Math.abs(Math.sin(this.time * 9 + seed));
        this.dummy.position.set(f.a.x + (f.b.x - f.a.x) * s, 0, f.a.y + (f.b.y - f.a.y) * s);
        this.dummy.rotation.set(0, seed, 0);
        this.dummy.scale.set(THERMITE.width * 0.55, (0.9 + 1.4 * flick) * fade, THERMITE.width * 0.55);
        this.dummy.updateMatrix();
        this.flameMesh.setMatrixAt(fi, this.dummy.matrix);
        this.flameMesh.setColorAt(fi, col.setHSL(0.03 + 0.07 * flick, 1, 0.45 + 0.15 * flick));
        fi++;
      }
    }
    this.dummy.scale.setScalar(1);
    this.flameMesh.count = fi;
    this.flameMesh.instanceMatrix.needsUpdate = true;
    if (this.flameMesh.instanceColor) this.flameMesh.instanceColor.needsUpdate = true;

    for (const sw of this.shockwaves) {
      sw.life -= frameDt;
      const k = 1 - Math.max(0, sw.life) / 0.45;
      sw.mesh.scale.setScalar(0.3 + k * sw.radius);
      (sw.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
      if (sw.life <= 0) {
        this.scene.remove(sw.mesh);
        sw.mesh.geometry.dispose();
        (sw.mesh.material as THREE.Material).dispose();
      }
    }
    this.shockwaves = this.shockwaves.filter((sw) => sw.life > 0);
  }

  private renderSkillObjects(w: World, px: number, py: number) {
    const col = new THREE.Color();
    let bi = 0;
    for (const b of w.barriers) {
      const k = Math.max(0, b.hp / BARRIER.hp);
      for (const c of b.cells) {
        if (bi >= 64) break;
        this.dummy.position.set(c.x + 0.5, 0, c.y + 0.5);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.setScalar(1);
        this.dummy.updateMatrix();
        this.barrierMesh.setMatrixAt(bi, this.dummy.matrix);
        // 耐久が減るほど赤くする
        this.barrierMesh.setColorAt(bi, col.setRGB(0.55 + 0.4 * (1 - k), 0.62 * k + 0.25, 0.75 * k + 0.2));
        bi++;
      }
    }
    this.barrierMesh.count = bi;
    this.barrierGhost.count = bi;
    this.barrierMesh.instanceMatrix.needsUpdate = true;
    if (this.barrierMesh.instanceColor) this.barrierMesh.instanceColor.needsUpdate = true;

    let ri = 0;
    for (const r of w.rails) {
      if (ri >= 16) break;
      const len = Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y);
      this.dummy.position.set((r.a.x + r.b.x) / 2, 0.08, (r.a.y + r.b.y) / 2);
      this.dummy.rotation.set(0, -Math.atan2(r.b.y - r.a.y, r.b.x - r.a.x), 0);
      this.dummy.scale.set(len, 1, 0.5);
      this.dummy.updateMatrix();
      this.railMesh.setMatrixAt(ri, this.dummy.matrix);
      ri++;
    }
    this.dummy.scale.setScalar(1);
    this.railMesh.count = ri;
    this.railMesh.instanceMatrix.needsUpdate = true;

    let hi = 0;
    for (const m of w.healMarks) {
      if (hi >= 32) break;
      this.dummy.position.set(m.pos.x, 0.12, m.pos.y);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(HEAL_SENSE.radius);
      this.dummy.updateMatrix();
      this.healMarkMesh.setMatrixAt(hi, this.dummy.matrix);
      hi++;
    }
    this.dummy.scale.setScalar(1);
    this.healMarkMesh.count = hi;
    this.healMarkMesh.instanceMatrix.needsUpdate = true;

    const p = w.player;
    this.overshieldRing.visible = p.alive && p.overshield > 0;
    this.overshieldRing.position.set(px, 0.9 + Math.sin(this.time * 4) * 0.08, py);
  }

  /** 読み込んである区画と、描いている区画を揃える */
  private syncChunks() {
    const map = this.map;
    if (this.chunkVersion === map.version) return;
    this.chunkVersion = map.version;
    for (const [key, g] of this.chunkViews) {
      if (map.chunks.has(key)) continue;
      this.scene.remove(g);
      disposeChunk(g, this.buildingMat);
      this.chunkViews.delete(key);
    }
    const added: ChunkJson[] = [];
    for (const [key, c] of map.chunks) {
      if (this.chunkViews.has(key)) continue;
      const g = new THREE.Group();
      g.add(buildSigns(c, CAM_OFFSET.clone().normalize()), buildRoadText(c), this.buildStructures(c));
      this.scene.add(g);
      this.chunkViews.set(key, g);
      added.push(c);
    }
    // 地面は道の縁を隣の区画のマスで決めるので、隣が来たら描き直す
    const repaint = new Set<string>();
    for (const c of added) {
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) repaint.add(chunkKey(c.i + di, c.j + dj));
    }
    for (const key of repaint) {
      const c = map.chunks.get(key);
      const g = this.chunkViews.get(key);
      if (!c || !g) continue;
      const old = g.getObjectByName("ground");
      if (old) {
        g.remove(old);
        disposeChunk(old, this.buildingMat);
      }
      const ground = buildGround(map, c, this.gl.capabilities.getMaxAnisotropy());
      ground.name = "ground";
      g.add(ground);
    }
  }

  private buildStructures(chunk: ChunkJson) {
    const mb = new MeshBuilder();
    for (const b of chunk.buildings) addBuilding(mb, b);

    const carColors = [0xf0f0f0, 0x303438, 0xb02828, 0x2858a8, 0x909498, 0xe0c060];
    chunk.covers.forEach((c) => {
      const ci = c.id;
      let h = 1.2, cc = 0x888888, roofC: number | null = null;
      if (c.kind === "car") {
        h = 1.5;
        cc = carColors[Math.floor(hash(ci + 3.3) * carColors.length)];
      } else if (c.kind === "vending") {
        h = 1.9;
        cc = hash(ci) < 0.5 ? 0xe8e8e8 : 0xc03030;
      } else if (c.kind === "barrier") {
        h = 1.1;
        cc = 0xd0b030;
        roofC = 0x303030;
      }
      const wc = new THREE.Color(cc);
      mb.box(c.x + 0.05, c.y + 0.05, c.w - 0.1, c.h - 0.1, 0, h, wc.clone().multiplyScalar(0.85), new THREE.Color(roofC ?? cc));
    });

    return new THREE.Mesh(mb.geometry(), this.buildingMat);
  }

  private drawExtracts(w: World) {
    while (this.extractMarks.length < w.extracts.length) {
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(EXTRACT_RADIUS, EXTRACT_RADIUS, 30, 48, 1, true),
        new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }),
      );
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(EXTRACT_RADIUS - 0.3, EXTRACT_RADIUS, 64),
        new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      this.scene.add(beam, ring);
      this.extractMarks.push({ beam, ring });
    }
    this.extractMarks.forEach(({ beam, ring }, i) => {
      const e = w.extracts[i];
      beam.visible = ring.visible = !!e;
      if (!e) return;
      beam.position.set(e.pos.x, 15, e.pos.y);
      ring.position.set(e.pos.x, 0.07, e.pos.y);
      const bm = beam.material as THREE.MeshBasicMaterial, rm = ring.material as THREE.MeshBasicMaterial;
      const color = extractColor(e);
      bm.color.setHex(color);
      rm.color.setHex(color);
      const pulse = Math.sin(this.time * 3) * 0.04;
      bm.opacity = e.ready ? 0.14 + pulse : e.readyAt !== null ? 0.09 + pulse : 0.04;
      rm.opacity = e.readyAt !== null ? 0.85 : 0.45;
    });
  }

  reset() {
    for (const v of this.actorViews.values()) this.scene.remove(v.group);
    this.actorViews.clear();
    this.particles = [];
    this.camInit = false;
    this.lootVersion = -1;
    for (const sw of this.shockwaves) this.scene.remove(sw.mesh);
    this.shockwaves = [];
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.gl.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 画面座標から、銃の高さの平面上のワールド座標を求める */
  screenToWorld(sx: number, sy: number): Vec {
    const ndc = new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.aimPlane, this.tmpV);
    if (!hit) return { x: this.camTarget.x, y: this.camTarget.z };
    return { x: hit.x, y: hit.z };
  }

  worldToScreen(x: number, y: number, h: number) {
    const v = new THREE.Vector3(x, h, y).project(this.camera);
    return {
      x: (v.x + 1) * 0.5 * window.innerWidth,
      y: (1 - v.y) * 0.5 * window.innerHeight,
      visible: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1,
    };
  }

  private makeActorView(a: Actor): ActorView {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshLambertMaterial({ color: a.team === "partner" ? PARTNER_COLOR : factionDef(a.faction).color });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.42, 1.55, 16), bodyMat);
    body.position.y = 0.78;
    group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 8), bodyMat);
    head.position.y = 0.97;
    body.add(head);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.14, 0.14), new THREE.MeshLambertMaterial({ color: 0x222222 }));
    gun.position.set(0.55, 0.25, 0);
    body.add(gun);

    const ghostMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
    const ghost = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 1.8, 12), ghostMat);
    ghost.position.y = 0.9;
    ghost.renderOrder = 20;
    group.add(ghost);

    const typeRingMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
    const typeRing = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.95, 32), typeRingMat);
    typeRing.rotation.x = -Math.PI / 2;
    typeRing.position.y = 0.05;
    typeRing.renderOrder = 19;
    group.add(typeRing);

    const healMat = new THREE.MeshBasicMaterial({ color: 0x4aa0ff, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false });
    const healRing = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.07, 6, 40), healMat);
    healRing.rotation.x = -Math.PI / 2;
    healRing.renderOrder = 21;
    group.add(healRing);

    const reloadArc = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.62, 24, 1, 0, Math.PI * 1.2),
      new THREE.MeshBasicMaterial({ color: 0xffd040, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
    );
    reloadArc.position.y = 2.6;
    reloadArc.rotation.x = -Math.PI / 2;
    reloadArc.renderOrder = 22;
    group.add(reloadArc);

    this.scene.add(group);
    return { group, body, bodyMat, ghost, ghostMat, typeRing, typeRingMat, healRing, healMat, reloadArc };
  }

  private spawnParticles(at: Vec, y: number, n: number, color: number, speed: number, size = 0.12, life = 0.5) {
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= 600) this.particles.shift();
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({
        p: new THREE.Vector3(at.x, y, at.y),
        v: new THREE.Vector3(Math.cos(a) * s, 2 + Math.random() * speed * 0.6, Math.sin(a) * s),
        life, max: life,
        color: new THREE.Color(color),
        size,
      });
    }
  }

  handleEvents(w: World, events: GameEvent[]) {
    const byId = new Map(w.actors.map((a) => [a.id, a]));
    const visible = (id: number) => {
      const t = byId.get(id);
      return !t || t.team === "player" || t.seen || t.info >= 1;
    };
    for (const ev of events) {
      switch (ev.type) {
        case "hit":
          if (visible(ev.actor)) this.spawnParticles(ev.pos, 1.1, 5, ev.shield ? 0x7cc8ff : 0xff5040, 3, 0.1, 0.3);
          break;
        case "wallHit":
          this.spawnParticles(ev.pos, 1.0, 3, 0xd8d0b0, 2, 0.08, 0.25);
          break;
        case "shieldBreak":
          if (visible(ev.actor)) this.spawnParticles(ev.pos, 1.2, 28, 0x60c0ff, 6, 0.16, 0.7);
          break;
        case "death":
          if (visible(ev.actor)) this.spawnParticles(ev.pos, 1.0, 20, 0xffffff, 4, 0.14, 0.6);
          break;
        case "explosion":
          this.spawnShockwave(ev.pos, ev.radius);
          this.spawnParticles(ev.pos, 0.6, 50, 0xffa040, 9, 0.22, 0.7);
          this.spawnParticles(ev.pos, 0.6, 25, 0x5a5048, 5, 0.3, 1.1);
          break;
        case "fireStart":
          this.spawnParticles({ x: (ev.a.x + ev.b.x) / 2, y: (ev.a.y + ev.b.y) / 2 }, 0.5, 30, 0xff8030, 6, 0.16, 0.6);
          break;
        case "barrierBreak":
          this.spawnParticles(ev.pos, 0.8, 18, 0x9ab8d0, 5, 0.18, 0.7);
          break;
        case "dash":
          for (let k = 0; k < 6; k++) {
            const at = { x: ev.pos.x + ev.dir.x * k * 0.6, y: ev.pos.y + ev.dir.y * k * 0.6 };
            this.spawnParticles(at, 0.8, 2, 0x9ad8ff, 1, 0.12, 0.35);
          }
          break;
      }
    }
  }

  /** 箱の奥（壁のある側）が -z になる向き。壁が見つからなければ箱の向きをそのまま使う */
  private boxYaw(w: World, l: Loot) {
    const m = w.map;
    const cx = Math.floor(l.pos.x), cy = Math.floor(l.pos.y);
    const at = (x: number, y: number) => m.solidAt(x, y) === Solid.building;
    if (at(cx, cy - 1)) return 0;
    if (at(cx, cy + 1)) return Math.PI;
    if (at(cx - 1, cy)) return -Math.PI / 2;
    if (at(cx + 1, cy)) return Math.PI / 2;
    return l.angle;
  }

  private syncLoot(w: World) {
    if (this.lootVersion === w.lootVersion) return;
    this.lootVersion = w.lootVersion;
    const col = new THREE.Color();
    const counts = { bins: 0, deathboxes: 0, ammo: 0, heal: 0, throwable: 0, material: 0, money: 0, buff: 0, glows: 0 };
    let markers = 0;
    const put = (mesh: THREE.InstancedMesh, i: number, m: THREE.Matrix4, c: number) => {
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, col.setHex(c));
    };
    const glowAt = (x: number, z: number, size: number, c: number, k: number) => {
      if (counts.glows >= this.lootGlows.instanceMatrix.count) return;
      this.dummy.position.set(x, 0, z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(size);
      this.dummy.updateMatrix();
      this.lootGlows.setMatrixAt(counts.glows, this.dummy.matrix);
      this.lootGlows.setColorAt(counts.glows, col.setHex(c).multiplyScalar(k));
      counts.glows++;
    };
    for (const l of w.loot) {
      if (l.kind === "bin" || l.kind === "deathbox") {
        const state: BoxState = l.items.length === 0 ? "empty" : l.opened ? "opened" : "closed";
        const isBin = l.kind === "bin";
        const pal = (isBin ? BIN_COLORS : DEATHBOX_COLORS)[state];
        const key = isBin ? "bins" : "deathboxes";
        const body = isBin ? this.bins : this.deathboxes;
        if (counts[key] >= body.instanceMatrix.count) continue;
        const i = counts[key]++;
        this.dummy.position.set(l.pos.x, 0, l.pos.y);
        this.dummy.rotation.set(0, isBin ? this.boxYaw(w, l) : l.angle, 0);
        this.dummy.scale.setScalar(1);
        this.dummy.updateMatrix();
        const base = this.dummy.matrix;
        put(body, i, base, pal.body);
        if (isBin) {
          put(this.binStripes, i, base, pal.accent);
          this.tmpM.makeTranslation(0, BIN.h, -BIN.d / 2 - 0.03);
          if (state !== "closed") this.tmpM.multiply(this.tmpM2.makeRotationX(-LID_OPEN_ANGLE));
          put(this.binLids, i, this.tmpM2.multiplyMatrices(base, this.tmpM), pal.lid);
          put(this.binLidBands, i, this.tmpM2, pal.accent);
          // 閉じているときの中敷きはふたに隠れるので、色だけ決めておけばよい
          put(this.binInners, i, base, state === "opened" ? BIN_INNER.filled : BIN_INNER.empty);
        } else {
          put(this.deathboxTops, i, base, pal.accent);
        }
        const mc = MARKER_COLORS[l.kind];
        if (state === "closed") {
          glowAt(l.pos.x, l.pos.y, isBin ? 2.8 : 2.5, mc, 1);
          if (markers < MAX_MARKERS) {
            this.markerBase.set([l.pos.x, l.pos.y, hash(l.id) * Math.PI * 2], markers * 3);
            this.lootMarkers.setColorAt(markers, col.setHex(mc));
            markers++;
          }
        } else if (state === "opened") {
          glowAt(l.pos.x, l.pos.y, 1.9, mc, 0.45);
        }
        continue;
      }
      const s = l.items[0];
      if (!s) continue;
      const def = ITEMS[s.item];
      const mesh = this.groundItems[def.category];
      const k = def.category;
      if (counts[k] >= mesh.instanceMatrix.count) continue;
      this.dummy.position.set(l.pos.x, 0, l.pos.y);
      this.dummy.rotation.set(0, l.angle, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      const c = def.category === "money" ? MONEY_COLOR : RARITY_COLORS[def.rarity];
      mesh.setMatrixAt(counts[k], this.dummy.matrix);
      mesh.setColorAt(counts[k], col.setHex(c));
      counts[k]++;
      glowAt(l.pos.x, l.pos.y, def.rarity === "common" && def.category !== "money" ? 1.3 : 1.7, c, 1);
    }
    this.dummy.scale.setScalar(1);
    const apply = (m: THREE.InstancedMesh, n: number) => {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    };
    for (const m of [this.bins, this.binLids, this.binLidBands, this.binStripes, this.binInners]) apply(m, counts.bins);
    for (const m of [this.deathboxes, this.deathboxTops]) apply(m, counts.deathboxes);
    apply(this.lootGlows, counts.glows);
    for (const k of Object.keys(this.groundItems) as ItemCategory[]) apply(this.groundItems[k], counts[k]);
    this.markerCount = markers;
    apply(this.lootMarkers, markers);
  }

  /** 未開封の箱の上に浮かぶ目印だけを毎フレーム動かす */
  private animateLoot() {
    const t = this.time;
    for (let i = 0; i < this.markerCount; i++) {
      const x = this.markerBase[i * 3], z = this.markerBase[i * 3 + 1], ph = this.markerBase[i * 3 + 2];
      this.dummy.position.set(x, 1.75 + Math.sin(t * 2.2 + ph) * 0.14, z);
      this.dummy.rotation.set(0, t * 1.6 + ph, 0);
      this.dummy.updateMatrix();
      this.lootMarkers.setMatrixAt(i, this.dummy.matrix);
    }
    this.lootMarkers.instanceMatrix.needsUpdate = true;
    (this.lootGlows.material as THREE.MeshBasicMaterial).opacity = 0.75 + Math.sin(t * 2.4) * 0.2;
  }

  render(w: World, alpha: number, aim: Vec, frameDt: number, throwPreview: ThrowableId | null = null) {
    this.time += frameDt;
    this.syncChunks();
    const p = w.player;
    const px = p.prev.x + (p.pos.x - p.prev.x) * alpha;
    const py = p.prev.y + (p.pos.y - p.prev.y) * alpha;

    let lx = aim.x - px, ly = aim.y - py;
    const ll = Math.hypot(lx, ly);
    const look = Math.min(ll * 0.25, 7);
    if (ll > 0) {
      lx = (lx / ll) * look;
      ly = (ly / ll) * look;
    }
    const target = new THREE.Vector3(px + lx, 0, py + ly);
    if (!this.camInit) {
      this.camTarget.copy(target);
      this.camInit = true;
    } else {
      this.camTarget.lerp(target, 1 - Math.exp(-frameDt * 8));
    }
    this.camera.position.copy(this.camTarget).add(CAM_OFFSET);
    this.camera.lookAt(this.camTarget);
    this.camera.updateMatrixWorld();

    const pv = new THREE.Vector3(px, 1.0, py);
    const pView = pv.clone().applyMatrix4(this.camera.matrixWorldInverse);
    const pNdc = pv.clone().project(this.camera);
    const buf = this.gl.getDrawingBufferSize(new THREE.Vector2());
    this.buildingMat.uniforms.uPlayerScreen.value.set((pNdc.x + 1) * 0.5 * buf.x, (pNdc.y + 1) * 0.5 * buf.y);
    this.buildingMat.uniforms.uPlayerDepth.value = -pView.z;
    this.buildingMat.uniforms.uRadius.value = 150 * this.gl.getPixelRatio();

    for (const a of w.actors) {
      let v = this.actorViews.get(a.id);
      if (!v) {
        v = this.makeActorView(a);
        this.actorViews.set(a.id, v);
      }
      // プレイヤーとパートナーは、倒れても横になって残る
      const isPlayer = a.team !== "enemy";
      if (!a.alive && !isPlayer) {
        v.group.visible = false;
        continue;
      }
      v.group.visible = true;
      const ax = a.prev.x + (a.pos.x - a.prev.x) * alpha;
      const ay = a.prev.y + (a.pos.y - a.prev.y) * alpha;
      v.group.position.set(ax, 0, ay);
      v.body.rotation.y = -a.facing;
      v.body.visible = isPlayer || a.seen;
      v.body.rotation.z = a.alive ? 0 : Math.PI / 2;
      v.body.position.y = a.alive ? 0.78 : 0.4;
      const info = isPlayer ? 0 : a.info;
      const typeColor = a.kind === "player" ? 0xffffff : TYPE_COLORS[a.kind];
      v.ghost.visible = a.alive && !isPlayer && (info >= 1 || a.seen);
      if (v.ghost.visible) {
        v.ghostMat.color.setHex(info >= 2 ? typeColor : 0x101010);
        v.ghostMat.opacity = a.seen ? 0.25 : 0.55;
      }
      v.typeRing.visible = a.alive && !isPlayer && info >= 2;
      v.typeRingMat.color.setHex(typeColor);
      const stateVisible = isPlayer || a.seen || info >= 2;
      v.healRing.visible = a.alive && !!a.heal && stateVisible;
      if (a.heal) {
        const def = HEALS[a.heal.kind];
        v.healMat.color.setHex(def.shieldPerItem > 0 ? 0x4aa0ff : 0x50e070);
        const k = 1 - a.heal.t / a.heal.total;
        v.healRing.scale.setScalar(1.6 - k * 0.8);
        v.healRing.position.y = 0.1 + k * 1.8;
      }
      v.reloadArc.visible = a.alive && a.reloadT > 0 && stateVisible;
      v.reloadArc.rotation.z = this.time * 8;
    }

    let bi = 0;
    const col = new THREE.Color();
    for (const b of w.bullets) {
      if (bi >= 800) break;
      const x = b.prev.x + (b.pos.x - b.prev.x) * alpha;
      const y = b.prev.y + (b.pos.y - b.prev.y) * alpha;
      this.dummy.position.set(x, GUN_Y, y);
      this.dummy.rotation.set(0, -Math.atan2(b.vel.y, b.vel.x) + Math.PI / 2, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.bullets.setMatrixAt(bi, this.dummy.matrix);
      this.bullets.setColorAt(bi, col.setHex(b.faction === PLAYER_FACTION ? 0xfff0a0 : 0xff5050));
      bi++;
    }
    this.bullets.count = bi;
    this.bullets.instanceMatrix.needsUpdate = true;
    if (this.bullets.instanceColor) this.bullets.instanceColor.needsUpdate = true;

    let pi = 0;
    this.particles = this.particles.filter((pt) => (pt.life -= frameDt) > 0);
    for (const pt of this.particles) {
      pt.v.y -= 12 * frameDt;
      pt.p.addScaledVector(pt.v, frameDt);
      if (pt.p.y < 0.05) {
        pt.p.y = 0.05;
        pt.v.multiplyScalar(0.5);
      }
      const s = pt.size * (0.4 + 0.6 * (pt.life / pt.max));
      this.dummy.position.copy(pt.p);
      this.dummy.rotation.set(pt.life * 7, pt.life * 5, 0);
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      this.particleMesh.setMatrixAt(pi, this.dummy.matrix);
      this.particleMesh.setColorAt(pi, pt.color);
      pi++;
    }
    this.dummy.scale.setScalar(1);
    this.particleMesh.count = pi;
    this.particleMesh.instanceMatrix.needsUpdate = true;
    if (this.particleMesh.instanceColor) this.particleMesh.instanceColor.needsUpdate = true;

    this.syncLoot(w);
    this.renderThrowables(w, alpha, frameDt);
    this.renderThrowPreview(w, throwPreview, aim);
    this.renderSkillObjects(w, px, py);
    this.animateLoot();
    const near = p.alive ? nearestLoot(w) : null;
    this.lootHighlight.visible = !!near;
    if (near) {
      this.lootHighlight.position.set(near.pos.x, 0.05, near.pos.y);
      this.lootHighlight.scale.setScalar(near.kind === "ground" ? 0.7 : 1.1 + Math.sin(this.time * 6) * 0.05);
    }

    const ws = weapon(p);
    const aimDist = Math.min(Math.hypot(aim.x - px, aim.y - py), ws.def.range);
    const ang = Math.atan2(aim.y - py, aim.x - px);
    const ap = this.aimLine.geometry.attributes.position as THREE.BufferAttribute;
    ap.setXYZ(0, px, GUN_Y, py);
    ap.setXYZ(1, px + Math.cos(ang) * aimDist, GUN_Y, py + Math.sin(ang) * aimDist);
    ap.needsUpdate = true;
    this.aimLine.visible = p.alive && !p.sprinting;
    const cone = ((ws.def.spreadBase + p.bloom + (isMoving(p) ? ws.def.spreadMoving : 0)) * Math.PI) / 180 / 2;
    const sp = this.spreadLines.geometry.attributes.position as THREE.BufferAttribute;
    const r0 = 1.2, r1 = 7;
    for (let s = 0; s < 2; s++) {
      const a2 = ang + (s === 0 ? -cone : cone);
      sp.setXYZ(s * 2, px + Math.cos(a2) * r0, GUN_Y, py + Math.sin(a2) * r0);
      sp.setXYZ(s * 2 + 1, px + Math.cos(a2) * r1, GUN_Y, py + Math.sin(a2) * r1);
    }
    sp.needsUpdate = true;
    this.spreadLines.visible = p.alive && !p.sprinting;

    this.beaconRing.position.set(px, 0.06, py);
    this.beaconRing.visible = w.debug.beaconLevel > 0;
    this.drawExtracts(w);

    this.gl.render(this.scene, this.camera);
  }
}
