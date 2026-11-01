// Three.js view of the World. It never changes the simulation: it draws the current state and
// plays back the animation events that World actions return, then snaps to the true state.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CFG, LAYOUT, ISLANDS, islandRadiusAt, buildingAt, key, skyAt } from './world.js';

// Grid cell (x east, y north, height h) -> three.js position (x, y up, z south).
const V = (x, y, h = 0) => new THREE.Vector3(x, h, -y);
const HOLD_Y = 2.15;
const CARRY_LIFT = 0.5; // arms held out in front while carrying another robot
// Accent paint for each robot (by world robot id).
const ROBOT_COLORS = { orange: 0xf28c28, blue: 0x2f7fe0 };
// Where each charger part sits once fitted, relative to the centre of its device: [east, up, south], tilt about x.
const SLOTS = {
  stand: { at: [0, -0.15, 0] },
  box: { at: [-0.24, -0.19, 0.16] },
  arm: { at: [0.14, 0.06, -0.06], tilt: 0, yaw: 0.6 },
  panel: { at: [0, 0.2, 0], tilt: 0.55 },
  cable: { at: [0.3, -0.25, 0.2] },
};
// Centre of the map, for the terrain and water meshes.
const MID = { x: (CFG.bounds.x0 + CFG.bounds.x1) / 2, y: (CFG.bounds.y0 + CFG.bounds.y1) / 2 };
const lerp = THREE.MathUtils.lerp;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Height of the visible sea floor / beach at a world point (cell coords): the highest of the islands' slopes.
function groundHeight(x, y) {
  let best = -5;
  for (const isl of ISLANDS) {
    const d = Math.hypot(x - isl.cx, y - isl.cy);
    const r = islandRadiusAt(Math.atan2(y - isl.cy, x - isl.cx), isl) + 0.55;
    if (d <= r) return 0.004 * Math.sin(x * 1.7) * Math.cos(y * 1.3);
    const t = d - r;
    best = Math.max(best, -Math.min(5, t * 0.6 + t * t * 0.05));
  }
  return best;
}

class Particles {
  constructor(scene, { count, color, size, pos, spread, up, gravity, life, opacity = 0.9 }) {
    this.geo = new THREE.BufferGeometry();
    this.p = new Float32Array(count * 3);
    this.v = [];
    for (let i = 0; i < count; i++) {
      this.p.set([pos.x + (Math.random() - 0.5) * 0.4, pos.y, pos.z + (Math.random() - 0.5) * 0.4], i * 3);
      const a = Math.random() * Math.PI * 2;
      const s = spread * (0.4 + Math.random() * 0.6);
      this.v.push(new THREE.Vector3(Math.cos(a) * s, up * (0.5 + Math.random() * 0.7), Math.sin(a) * s));
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.p, 3));
    this.mat = new THREE.PointsMaterial({ color, size, transparent: true, opacity, depthWrite: false });
    this.pts = new THREE.Points(this.geo, this.mat);
    scene.add(this.pts);
    this.scene = scene;
    this.age = 0;
    this.life = life;
    this.gravity = gravity;
    this.opacity = opacity;
  }
  update(dt) {
    this.age += dt;
    for (let i = 0; i < this.v.length; i++) {
      this.v[i].y -= this.gravity * dt;
      this.p[i * 3] += this.v[i].x * dt;
      this.p[i * 3 + 1] += this.v[i].y * dt;
      this.p[i * 3 + 2] += this.v[i].z * dt;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.mat.opacity = this.opacity * Math.max(0, 1 - this.age / this.life);
    if (this.age >= this.life) {
      this.scene.remove(this.pts);
      this.geo.dispose();
      this.mat.dispose();
      return false;
    }
    return true;
  }
}

export class Renderer {
  constructor(container, world) {
    this.world = world;
    this.container = container;
    this.speed = 1;
    this.follow = true;
    this.tweens = [];
    this.particles = [];
    this.itemMeshes = new Map();
    this.animating = new Set();
    this.clock = new THREE.Clock();
    this.time = 0;

    const r = (this.gl = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xcfe8f3, 70, 260);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1200);
    this.camera.position.set(14, 17, 26);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.target.set(0, 1, 0);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 120;
    this.controls.addEventListener('start', () => { this.userOrbiting = true; });
    this.controls.addEventListener('end', () => { this.userOrbiting = false; });

    this._buildSky();
    this._buildLights();
    this._buildTerrain();
    this._buildWater();
    this._buildGrid();
    this._buildDock();
    this._buildHut();
    this._buildTower();
    this.palmLeaves = new Map();
    LAYOUT.palms.forEach((p, i) => this._buildPalm(p, i));
    for (const isl of ISLANDS.filter((i) => i.volcano)) this._buildVolcano(isl);
    this._buildBoat();
    this.thoughtsOn = true;
    this.rigs = world.robots.map((r) => this._buildRobot(r.id));
    this.nativeRigs = world.natives.map((n, i) => this._buildNative(n.id, i));
    this.focus = this.rigs[0]; // the robot the camera follows: whoever acted last, unless locked onto one
    this.lock = null;
    this.rebuildItems();
    this._buildHover();

    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();
    r.setAnimationLoop(() => this._frame());
    // Browsers pause animation frames in hidden tabs; keep tweens moving so the agent never stalls.
    this.lastFrame = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (now - this.lastFrame > 300) {
        this._advance(Math.min(1, (now - this.lastFrame) / 1000));
        this.lastFrame = now;
      }
    }, 250);
  }

  _advance(dt) {
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      if (i >= this.tweens.length) continue;
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      tw.fn(k);
      if (k >= 1) {
        this.tweens.splice(this.tweens.indexOf(tw), 1);
        tw.resolve();
      }
    }
  }

  // ---------- scene construction ----------
  // Sky dome: day blue, a warm glow toward the sun near sunrise and sunset, deep blue at night with a moon.
  _buildSky() {
    const geo = new THREE.SphereGeometry(900, 32, 16);
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        sun: { value: new THREE.Vector3(0.55, 0.5, 0.35).normalize() },
        moon: { value: new THREE.Vector3(-0.55, 0.5, -0.35).normalize() },
        day: { value: 1 },
        dusk: { value: 0 },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 sun; uniform vec3 moon; uniform float day; uniform float dusk; varying vec3 vDir;
        void main(){
          float h = max(vDir.y, 0.0);
          vec3 top = mix(vec3(0.01,0.015,0.05), vec3(0.18,0.47,0.82), day);
          vec3 hor = mix(vec3(0.04,0.06,0.13), vec3(0.80,0.91,0.96), day);
          float toward = (length(vDir.xz) > 1e-4 && length(sun.xz) > 1e-4) ? max(dot(normalize(vDir.xz), normalize(sun.xz)), 0.0) : 0.0;
          hor = mix(hor, vec3(1.0,0.5,0.25), dusk * (0.25 + 0.75 * pow(toward, 3.0)));
          vec3 c = mix(hor, top, pow(h, 0.55));
          float s = max(dot(vDir, sun), 0.0);
          c += vec3(1.0,0.9,0.7) * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.25) * smoothstep(-0.06, 0.04, sun.y);
          float m = max(dot(vDir, moon), 0.0);
          c += vec3(0.85,0.9,1.0) * (pow(m, 1200.0) * 2.5 + pow(m, 40.0) * 0.08) * (1.0 - day) * smoothstep(-0.05, 0.05, moon.y);
          if (vDir.y < 0.0) c = hor;
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.scene.add(new THREE.Mesh(geo, this.skyMat));
    // Stars, fading in as it gets dark.
    const r = rng(42);
    const pos = [];
    for (let i = 0; i < 1400; i++) {
      const a = r() * Math.PI * 2;
      const y = 0.04 + r() * 0.96;
      const rad = Math.sqrt(1 - y * y);
      pos.push(Math.cos(a) * rad * 850, y * 850, Math.sin(a) * rad * 850);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    this.scene.add(this.stars);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xcfe9ff, 0xd9c28c, 1.1);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
    sun.position.set(33, 30, -21);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -32; c.right = 32; c.top = 32; c.bottom = -32; c.near = 1; c.far = 120;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    // Pale moonlight at night (no shadows).
    this.moonLight = new THREE.DirectionalLight(0x9fb4ff, 0);
    this.scene.add(this.moonLight, this.moonLight.target);
    this.nightGlows = []; // lantern and torch lights, brighter after dark
    this.shownMinutes = this.world.minutes;
  }

  // Ease the drawn time of day toward the world clock, and light the scene for it.
  _updateSky(dt) {
    const target = this.world.minutes;
    if (target < this.shownMinutes - 1) this.shownMinutes = target; // the world was reset
    const gap = target - this.shownMinutes;
    if (gap > 0) this.shownMinutes += Math.min(gap, Math.max(30, gap * 1.5) * dt * this.speed);
    const sky = skyAt(this.shownMinutes);
    this.skyNow = sky;
    const d = sky.dir;
    const sunDir = new THREE.Vector3(d.x, d.h, -d.y);
    // The moon stays low across the night sky (opposite the sun), where the camera can see it.
    const moonDir = new THREE.Vector3(-d.x, Math.min(0.24, Math.max(0.1, -d.h * 0.3)), d.y * 0.6).normalize();
    const day = sky.light;
    const dusk = Math.max(0, 1 - Math.abs(sky.up) / 0.3) * (sky.up > -0.2 ? 1 : 0);
    const u = this.skyMat.uniforms;
    u.sun.value.copy(sunDir);
    u.moon.value.copy(moonDir);
    u.day.value = day;
    u.dusk.value = dusk;
    this.stars.material.opacity = Math.pow(1 - day, 2) * 0.9;
    const sunUp = Math.min(1, Math.max(0, sky.up / 0.25));
    this.sun.intensity = 2.4 * sunUp;
    this.sun.color.setHex(0xff9a50).lerp(new THREE.Color(0xfff0d8), sunUp);
    this.hemi.intensity = 0.14 + 0.96 * day;
    this.hemi.color.setHex(0x4a5a99).lerp(new THREE.Color(0xcfe9ff), day);
    this.hemi.groundColor.setHex(0x1c1a24).lerp(new THREE.Color(0xd9c28c), day);
    this.moonLight.intensity = 0.45 * (1 - day);
    const fog = new THREE.Color(0x0a0f1e).lerp(new THREE.Color(0xcfe8f3), day).lerp(new THREE.Color(0xe8a070), dusk * 0.35);
    this.scene.fog.color.copy(fog);
    this.seaFloor.material.color.setHex(0x0a1c24).lerp(new THREE.Color(0x2c6f7c), day);
    this.foamLight = 0.25 + 0.75 * day;
    for (const g of this.nightGlows) g.light.intensity = g.base * (0.7 + 1.8 * (1 - day));
    return { sunDir, moonDir };
  }

  _buildTerrain() {
    const B = CFG.bounds;
    const w = B.x1 - B.x0 + 28;
    const d = B.y1 - B.y0 + 28;
    const geo = new THREE.PlaneGeometry(w, d, Math.round(w * 2.5), Math.round(d * 2.5));
    geo.rotateX(-Math.PI / 2);
    geo.translate(MID.x, 0, -MID.y);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const sand = new THREE.Color(0xf0dcaa);
    const sand2 = new THREE.Color(0xe6cd92);
    const wet = new THREE.Color(0xbf9f68);
    const deep = new THREE.Color(0x4f8c86);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = -pos.getZ(i);
      const h = groundHeight(x, y);
      pos.setY(i, h);
      if (h > -0.02) c.copy(sand).lerp(sand2, 0.5 + 0.5 * Math.sin(x * 0.7 + Math.cos(y * 0.5) * 2) * Math.sin(y * 0.6));
      else if (h > CFG.waterLevel - 0.25) c.copy(sand2).lerp(wet, Math.min(1, -h / 0.6));
      else c.copy(wet).lerp(deep, Math.min(1, (-h - 0.6) / 3));
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    mesh.receiveShadow = true;
    this.terrainMesh = mesh;
    this.scene.add(mesh);
    const floor = (this.seaFloor = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), new THREE.MeshBasicMaterial({ color: 0x2c6f7c })));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -5.05;
    this.scene.add(floor);
  }

  _buildWater() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1fa3c4, transparent: true, opacity: 0.78, roughness: 0.12, metalness: 0.15, flatShading: true,
    });
    const geo = new THREE.PlaneGeometry(140, 140, 120, 120);
    geo.rotateX(-Math.PI / 2);
    geo.translate(MID.x, 0, -MID.y);
    this.waterGeo = geo;
    this.waterBase = Float32Array.from(geo.attributes.position.array);
    const water = new THREE.Mesh(geo, mat);
    water.position.y = CFG.waterLevel;
    water.receiveShadow = true;
    this.scene.add(water);
    // Far ocean: a flat ring around the animated patch.
    const far = new THREE.Mesh(new THREE.RingGeometry(69.5, 1000, 64, 1), mat);
    far.rotation.x = -Math.PI / 2;
    far.position.copy(V(MID.x, MID.y, CFG.waterLevel));
    this.scene.add(far);
    // Foam line around each island's shore.
    const fp = [];
    const idx = [];
    const n = 220;
    for (const isl of ISLANDS) {
      const base = fp.length / 3;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr = islandRadiusAt(a, isl) + 0.55;
        let t = 0;
        while (groundHeight(isl.cx + Math.cos(a) * (rr + t), isl.cy + Math.sin(a) * (rr + t)) > CFG.waterLevel && t < 3) t += 0.02;
        for (const off of [-0.25, 0.45]) fp.push(isl.cx + Math.cos(a) * (rr + t + off), CFG.waterLevel + 0.03, -(isl.cy + Math.sin(a) * (rr + t + off)));
        const j = base + i * 2;
        if (i < n) idx.push(j, j + 1, j + 2, j + 1, j + 3, j + 2);
      }
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
    fg.setIndex(idx);
    this.foam = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }));
    this.scene.add(this.foam);
  }

  _updateWater(t) {
    const p = this.waterGeo.attributes.position;
    const b = this.waterBase;
    for (let i = 0; i < p.count; i++) {
      const x = b[i * 3];
      const z = b[i * 3 + 2];
      const fade = Math.max(0, 1 - Math.max(Math.abs(x - MID.x), Math.abs(z + MID.y)) / 70);
      p.array[i * 3 + 1] = fade * (0.09 * Math.sin(x * 0.45 + t * 1.3) + 0.07 * Math.sin(z * 0.6 - t * 1.1) + 0.04 * Math.sin((x + z) * 1.1 + t * 2.1));
    }
    p.needsUpdate = true;
    this.foam.material.opacity = (0.3 + 0.18 * Math.sin(t * 1.6)) * (this.foamLight ?? 1);
  }

  _buildGrid() {
    const w = this.world;
    const edges = new Set();
    const verts = [];
    const add = (x1, z1, x2, z2) => {
      const k = `${x1},${z1},${x2},${z2}`;
      if (edges.has(k)) return;
      edges.add(k);
      verts.push(x1, 0.012, z1, x2, 0.012, z2);
    };
    for (const [k, t] of w.terrain) {
      if (t !== 'sand') continue;
      const [x, y] = k.split(',').map(Number);
      const z = -y;
      add(x - 0.5, z - 0.5, x + 0.5, z - 0.5);
      add(x - 0.5, z + 0.5, x + 0.5, z + 0.5);
      add(x - 0.5, z - 0.5, x - 0.5, z + 0.5);
      add(x + 0.5, z - 0.5, x + 0.5, z + 0.5);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.grid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x7a5a2a, transparent: true, opacity: 0.16 }));
    this.scene.add(this.grid);
    // Compass letters on the sand so "north" in prompts is obvious.
    const mk = (txt, x, y) => {
      const tex = canvasTexture(128, 128, (g2) => {
        g2.fillStyle = 'rgba(120,85,40,0.55)';
        g2.font = 'bold 96px system-ui, sans-serif';
        g2.textAlign = 'center';
        g2.textBaseline = 'middle';
        g2.fillText(txt, 64, 68);
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.copy(V(x, y, 0.02));
      this.scene.add(m);
    };
    mk('N', 0, 13);
    mk('E', 13.5, 0);
    mk('W', -13.5, 0);
  }

  _woodTex(base, dark, planks = 6, vertical = false) {
    return canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = base;
      g.fillRect(0, 0, w, h);
      const r = rng(planks * 97);
      for (let i = 0; i < 260; i++) {
        g.strokeStyle = `rgba(60,35,15,${0.05 + r() * 0.08})`;
        g.lineWidth = 1 + r() * 2;
        g.beginPath();
        const p = r() * w;
        if (vertical) { g.moveTo(p, 0); g.lineTo(p + (r() - 0.5) * 10, h); } else { g.moveTo(0, p); g.lineTo(w, p + (r() - 0.5) * 10); }
        g.stroke();
      }
      g.fillStyle = dark;
      for (let i = 1; i < planks; i++) {
        const p = (i / planks) * w;
        if (vertical) g.fillRect(p - 2, 0, 4, h); else g.fillRect(0, p - 2, w, 4);
      }
    });
  }

  _buildDock() {
    const d = this.world.dock;
    const wood = new THREE.MeshStandardMaterial({ color: 0xb08155, roughness: 0.9, map: this._woodTex('#c8996a', '#6b4a2a', 1) });
    const dark = new THREE.MeshStandardMaterial({ color: 0x6d4b2c, roughness: 1 });
    const yTop = d.yLand + 0.5;
    const yBot = d.yEnd - 0.5;
    const len = yTop - yBot;
    const xMid = (d.x0 + d.x1) / 2;
    const width = d.x1 - d.x0 + 1;
    const group = new THREE.Group();
    const plank = new THREE.BoxGeometry(width + 0.1, 0.07, 0.23);
    const n = Math.round(len / 0.25);
    const r = rng(7);
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(plank, wood);
      m.position.set(xMid + (r() - 0.5) * 0.05, CFG.dockHeight - 0.035, -(yBot + (i + 0.5) * (len / n)));
      m.rotation.y = (r() - 0.5) * 0.02;
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
    for (const sx of [-1, 1]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, len), dark);
      beam.position.set(xMid + sx * (width / 2 - 0.05), CFG.dockHeight - 0.16, -(yBot + len / 2));
      group.add(beam);
      for (let yy = yBot; yy <= yTop + 0.01; yy += 2) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 3.2, 8), dark);
        post.position.set(xMid + sx * (width / 2 + 0.05), CFG.dockHeight - 1.45, -yy);
        post.castShadow = true;
        group.add(post);
      }
    }
    // Mooring bollards and a coil of rope at the far end.
    for (const sx of [-1, 1]) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.35, 10), dark);
      b.position.set(xMid + sx * (width / 2 + 0.05), CFG.dockHeight + 0.17, -(yBot + 0.3));
      group.add(b);
    }
    this.scene.add(group);
  }

  // Four walls round a w x d footprint (local coordinates, centred), with a doorway gap in the south (+z) wall.
  // Returns the wall meshes so they can be made see-through while the robot is inside.
  _hollowWalls(g, { w, d, h, thick, mat, doorX, doorW, doorH }) {
    const meshes = [];
    const add = (sx, sy, sz, px, py, pz) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
      m.position.set(px, py, pz);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      meshes.push(m);
    };
    add(w, h, thick, 0, h / 2, -d / 2 + thick / 2); // north
    add(thick, h, d, -w / 2 + thick / 2, h / 2, 0); // west
    add(thick, h, d, w / 2 - thick / 2, h / 2, 0); // east
    // South wall: left and right of the doorway, plus a lintel above it.
    const z = d / 2 - thick / 2;
    const left = doorX - doorW / 2 + w / 2;
    const right = w / 2 - (doorX + doorW / 2);
    add(left, h, thick, -w / 2 + left / 2, h / 2, z);
    add(right, h, thick, w / 2 - right / 2, h / 2, z);
    add(doorW, h - doorH, thick, doorX, doorH + (h - doorH) / 2, z);
    return meshes;
  }

  // Remember a building's parts: the roof hides and the walls fade while the robot is inside.
  _registerBuilding(name, roofParts, walls) {
    this.buildingParts ||= {};
    for (const m of walls) m.material = m.material.clone();
    this.buildingParts[name] = { roofParts, walls, open: false };
  }

  _buildHut() {
    const h = LAYOUT.hut;
    const cx = (h.x0 + h.x1) / 2;
    const cy = (h.y0 + h.y1) / 2;
    const w = h.x1 - h.x0 + 1;
    const dpt = h.y1 - h.y0 + 1;
    const g = new THREE.Group();
    g.position.copy(V(cx, cy));
    const wallMat = new THREE.MeshStandardMaterial({ map: this._woodTex('#b98a52', '#7a5530', 10, true), roughness: 0.95 });
    const wallH = h.ceiling;
    const doorX = h.door.x - cx;
    const walls = this._hollowWalls(g, { w: w - 0.1, d: dpt - 0.1, h: wallH, thick: 0.16, mat: wallMat, doorX, doorW: 0.95, doorH: 2.0 });
    // Plank floor and a woven rug inside.
    const floor = new THREE.Mesh(new THREE.BoxGeometry(w - 0.3, 0.04, dpt - 0.3), new THREE.MeshStandardMaterial({ map: this._woodTex('#a77b4c', '#6e4c2a', 8), roughness: 1 }));
    floor.position.y = 0.0;
    floor.receiveShadow = true;
    g.add(floor);
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.0), new THREE.MeshStandardMaterial({ color: 0xa0412d, roughness: 1 }));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0.6, 0.025, -0.2);
    rug.receiveShadow = true;
    g.add(rug);
    // Lantern hanging in a corner, glowing softly.
    const lantern = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.22, 8), new THREE.MeshStandardMaterial({ color: 0xffd28a, emissive: 0xffa040, emissiveIntensity: 1.6 }));
    lantern.position.set(-w / 2 + 0.45, wallH - 0.35, -dpt / 2 + 0.45);
    g.add(lantern);
    const glow = new THREE.PointLight(0xffb060, 2.5, 5, 2);
    glow.position.copy(lantern.position);
    g.add(glow);
    this.nightGlows.push({ light: glow, base: 2.5 });
    // The door stands open, swung in against the inside wall.
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.95, 0.06), new THREE.MeshStandardMaterial({ color: 0x5a3a1c, roughness: 1 }));
    door.geometry.translate(0.45, 0, 0);
    door.position.set(doorX + 0.47, 0.99, dpt / 2 - 0.2);
    door.rotation.y = Math.PI / 2 + 0.25;
    door.castShadow = true;
    g.add(door);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1, 1.5, 4, 1), new THREE.MeshStandardMaterial({ color: 0xd6b25e, roughness: 1, flatShading: true }));
    roof.rotation.y = Math.PI / 4;
    roof.scale.set((w + 0.9) / Math.SQRT2, 1, (dpt + 0.9) / Math.SQRT2);
    roof.position.y = wallH + 0.7;
    roof.castShadow = true;
    g.add(roof);
    // Straw fringe under the roof edge.
    const fringe = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.18, dpt + 0.6), new THREE.MeshStandardMaterial({ color: 0xc09a48, roughness: 1 }));
    fringe.position.y = wallH - 0.02;
    g.add(fringe);
    const winMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0c });
    for (const sx of [-1, 1]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.55, 0.7), winMat);
      win.position.set(sx * (w / 2 - 0.02), 1.4, 0);
      g.add(win);
    }
    // Little barrel by the door.
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.7, 14), new THREE.MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.9 }));
    barrel.position.set(doorX + 1.3, 0.35, dpt / 2 + 0.3);
    barrel.castShadow = true;
    g.add(barrel);
    this.scene.add(g);
    this._registerBuilding('hut', [roof, fringe], walls);
  }

  _buildTower() {
    const t = LAYOUT.tower;
    const cx = (t.x0 + t.x1) / 2;
    const cy = (t.y0 + t.y1) / 2;
    const w = t.x1 - t.x0 + 1;
    const H = CFG.towerHeight;
    const stone = canvasTexture(256, 256, (g, W, Hh) => {
      g.fillStyle = '#a79c8a';
      g.fillRect(0, 0, W, Hh);
      const r = rng(3);
      const rows = 8;
      for (let row = 0; row < rows; row++) {
        const y = (row / rows) * Hh;
        let x = row % 2 ? -32 : 0;
        while (x < W) {
          const bw = 48 + r() * 30;
          const shade = 150 + r() * 40;
          g.fillStyle = `rgb(${shade},${shade - 8},${shade - 22})`;
          g.fillRect(x + 2, y + 2, bw - 4, Hh / rows - 4);
          x += bw;
        }
      }
    });
    stone.wrapS = stone.wrapT = THREE.RepeatWrapping;
    stone.repeat.set(1.5, 2.5);
    const mat = new THREE.MeshStandardMaterial({ map: stone, roughness: 0.95 });
    const g = new THREE.Group();
    g.position.copy(V(cx, cy));
    const doorX = t.door.x - cx;
    const walls = this._hollowWalls(g, { w, d: w, h: t.ceiling, thick: 0.26, mat, doorX, doorW: 0.95, doorH: 2.05 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(w - 0.4, 0.04, w - 0.4), new THREE.MeshStandardMaterial({ color: 0x77706a, roughness: 1 }));
    floor.receiveShadow = true;
    g.add(floor);
    // Torch on the back wall.
    const torch = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 8), new THREE.MeshStandardMaterial({ color: 0xffb050, emissive: 0xff7a20, emissiveIntensity: 2 }));
    torch.position.set(0.6, 2.2, -w / 2 + 0.36);
    g.add(torch);
    const glow = new THREE.PointLight(0xff9a40, 2.5, 5, 2);
    glow.position.copy(torch.position);
    g.add(glow);
    this.nightGlows.push({ light: glow, base: 2.5 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0x8d8475, roughness: 0.9 });
    // The roof slab: its top is the tower's standable surface.
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, H - t.ceiling, w + 0.2), capMat);
    cap.position.y = (H + t.ceiling) / 2;
    cap.castShadow = cap.receiveShadow = true;
    g.add(cap);
    const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.2, w + 0.12), capMat);
    band.position.y = H - 0.55;
    g.add(band);
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2420 });
    for (const [px, pz, ry] of [[w / 2 + 0.01, 0, Math.PI / 2], [-w / 2 - 0.01, 0, Math.PI / 2]]) {
      const slit = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.7, 0.06), dark);
      slit.position.set(px, 3.0, pz);
      slit.rotation.y = ry;
      g.add(slit);
    }
    // Flag pole on the east face, clear of the walkable top.
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.6, 8), new THREE.MeshStandardMaterial({ color: 0x5a4a3a }));
    pole.position.set(w / 2 + 0.18, H + 0.9, -w / 2 + 0.3);
    g.add(pole);
    const fg = new THREE.PlaneGeometry(1.4, 0.8, 12, 4);
    fg.translate(0.7, 0, 0);
    this.flagGeo = fg;
    this.flagBase = Float32Array.from(fg.attributes.position.array);
    const flag = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ color: 0xe0453a, side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(w / 2 + 0.2, H + 2.3, -w / 2 + 0.3);
    flag.castShadow = true;
    g.add(flag);
    this.scene.add(g);
    this._registerBuilding('tower', [cap, band], walls);
  }

  // While a robot (as drawn) is inside a building, hide its roof and fade its walls so you can see in.
  _updateBuildingCutaway() {
    const inside = new Set();
    for (const rig of this.rigs) {
      const p = rig.group.position;
      const b = buildingAt(Math.round(p.x), Math.round(-p.z));
      if (b && p.y < LAYOUT[b].ceiling - 0.5) inside.add(b);
    }
    for (const [name, parts] of Object.entries(this.buildingParts)) {
      const open = inside.has(name);
      if (open === parts.open) continue;
      parts.open = open;
      for (const m of parts.roofParts) m.visible = !open;
      for (const m of parts.walls) {
        m.material.transparent = open;
        m.material.opacity = open ? 0.28 : 1;
        m.material.depthWrite = !open;
        m.castShadow = !open;
        m.material.needsUpdate = true;
      }
    }
  }

  // A steep cone of dark rock with a glowing crater and a plume of smoke.
  _buildVolcano(isl) {
    const g = new THREE.Group();
    g.position.copy(V(isl.cx, isl.cy, -0.05));
    const R = isl.volcano + 0.6;
    const H = 9;
    const pts = [
      new THREE.Vector2(R, 0), new THREE.Vector2(R * 0.78, H * 0.22), new THREE.Vector2(R * 0.52, H * 0.55),
      new THREE.Vector2(R * 0.3, H * 0.86), new THREE.Vector2(1.5, H), new THREE.Vector2(1.25, H - 0.15), new THREE.Vector2(0.9, H - 0.9),
    ];
    const geo = new THREE.LatheGeometry(pts, 28);
    // Rough it up a little so it doesn't look turned on a lathe.
    const p = geo.attributes.position;
    const r = rng(77);
    const bump = new Map();
    for (let i = 0; i < p.count; i++) {
      const k = `${p.getX(i).toFixed(2)},${p.getY(i).toFixed(2)},${p.getZ(i).toFixed(2)}`;
      if (!bump.has(k)) bump.set(k, 1 + (r() - 0.5) * 0.16 * Math.min(1, p.getY(i) / 2));
      const b = bump.get(k);
      p.setX(i, p.getX(i) * b);
      p.setZ(i, p.getZ(i) * b);
    }
    geo.computeVertexNormals();
    const cone = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x4a3f3a, roughness: 1, flatShading: true }));
    cone.castShadow = cone.receiveShadow = true;
    g.add(cone);
    // Lava in the crater (glows; brighter at night through the point light).
    this.lavaMat = new THREE.MeshStandardMaterial({ color: 0xff5a1a, emissive: 0xff4010, emissiveIntensity: 2 });
    const lava = new THREE.Mesh(new THREE.CircleGeometry(1.0, 20), this.lavaMat);
    lava.rotation.x = -Math.PI / 2;
    lava.position.y = H - 0.85;
    g.add(lava);
    const glow = new THREE.PointLight(0xff5a20, 6, 16, 2);
    glow.position.y = H + 0.6;
    g.add(glow);
    this.nightGlows.push({ light: glow, base: 6 });
    // A halo over the crater: the red glow that shows from far away at night.
    this.craterHalo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: canvasTexture(128, 128, (c) => {
        const grd = c.createRadialGradient(64, 64, 4, 64, 64, 64);
        grd.addColorStop(0, 'rgba(255,120,40,0.9)');
        grd.addColorStop(0.45, 'rgba(255,70,20,0.35)');
        grd.addColorStop(1, 'rgba(255,60,20,0)');
        c.fillStyle = grd;
        c.fillRect(0, 0, 128, 128);
      }),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    this.craterHalo.position.y = H + 0.8;
    this.craterHalo.scale.set(7, 5, 1);
    g.add(this.craterHalo);
    this.scene.add(g);
    // Smoke: soft puffs that rise from the crater, drift and fade, then start again.
    const tex = canvasTexture(64, 64, (c) => {
      const grd = c.createRadialGradient(32, 32, 2, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,255,0.85)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = grd;
      c.fillRect(0, 0, 64, 64);
    });
    this.smoke = [];
    for (let i = 0; i < 26; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0x8a8580, transparent: true, depthWrite: false, opacity: 0 }));
      sp.userData = { phase: i / 26, wob: r() * 6.28 };
      this.scene.add(sp);
      this.smoke.push(sp);
    }
    this.smokeBase = V(isl.cx, isl.cy, H);
  }

  // The sailboat: a hull whose flat deck covers the boat's cells (local +x runs stern to bow), a mast, a boom with
  // the sail furled along it, and a full sail that only shows while it is under way. Placed from world.boat.
  _buildBoat() {
    const L = this.world.boat.cells.length;
    const g = new THREE.Group();
    const hullMat = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 });
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x2a5d8f, roughness: 0.6 });
    const deckMat = new THREE.MeshStandardMaterial({ color: 0xc49a66, roughness: 0.85, map: this._woodTex('#d0a672', '#7a5531', 8, true) });
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a6440, roughness: 0.9 });
    // Top view of the hull: square-ish transom at the stern, a pointed bow past the last deck cell.
    const half = L / 2;
    const hw = 0.62;
    const outline = (inset) => {
      const sh = new THREE.Shape();
      const w = hw - inset;
      sh.moveTo(-half - 0.1 + inset, -w * 0.85);
      sh.lineTo(half - 0.4, -w);
      sh.quadraticCurveTo(half + 0.35 - inset, -w * 0.7, half + 0.75 - inset * 2, 0);
      sh.quadraticCurveTo(half + 0.35 - inset, w * 0.7, half - 0.4, w);
      sh.lineTo(-half - 0.1 + inset, w * 0.85);
      sh.closePath();
      return sh;
    };
    // Shapes are drawn in (x, z) and extruded downward from the deck.
    const slab = (shape, depth, mat, y, bevel = true) => {
      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2, curveSegments: 12 });
      geo.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(geo, mat);
      m.position.y = y;
      m.castShadow = m.receiveShadow = true;
      return m;
    };
    const hull = new THREE.Group();
    // White topsides down to just under the waterline, a blue bottom below, planked deck on top (at deck height).
    hull.add(slab(outline(0), 0.3, hullMat, CFG.boatDeck - 0.07));
    hull.add(slab(outline(0.04), 0.35, stripeMat, CFG.boatDeck - 0.41));
    hull.add(slab(outline(0.05), 0.04, deckMat, CFG.boatDeck, false));
    // A low rail (gunwale) round the deck edge.
    const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(outline(0.02).getPoints(40).map((p) => new THREE.Vector3(p.x, CFG.boatDeck + 0.16, p.y)), true), 60, 0.035, 6, true), wood);
    hull.add(rail);
    g.add(hull);
    this.boatHull = hull;
    // Mast at the middle of the deck, near the port rail so robots can stand either side of it.
    const mastX = 0;
    const mastZ = -0.42;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 4.6, 8), wood);
    mast.position.set(mastX, CFG.boatDeck + 2.3, mastZ);
    mast.castShadow = true;
    g.add(mast);
    // Boom up high (above a robot's head), reaching back toward the stern, with the furled sail lashed along it.
    const boomLen = half + 0.2;
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, boomLen, 6), wood);
    boom.rotation.z = Math.PI / 2;
    boom.position.set(mastX - boomLen / 2, CFG.boatDeck + 2.1, mastZ);
    g.add(boom);
    const sailMat = new THREE.MeshStandardMaterial({ color: 0xfbf8ef, roughness: 0.8, side: THREE.DoubleSide });
    const furled = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, boomLen - 0.3, 4, 8), sailMat);
    furled.rotation.z = Math.PI / 2;
    furled.position.set(mastX - boomLen / 2, CFG.boatDeck + 2.22, mastZ);
    g.add(furled);
    // The full sail: a triangle from the mast top down to the boom, a little bellied.
    const sailGeo = new THREE.BufferGeometry();
    const top = CFG.boatDeck + 4.5;
    const foot = CFG.boatDeck + 2.15;
    // Horizontal strips from the foot (luff on the mast, clew at the boom's end) up to the head, so it can belly.
    const verts = [];
    const N = 8;
    const luff = (t) => new THREE.Vector3(mastX, foot + (top - foot) * t, mastZ);
    const leech = (t) => new THREE.Vector3(mastX - boomLen * (1 - t), foot + (top - foot) * t, mastZ);
    for (let i = 0; i < N; i++) {
      const a = i / N;
      const b = (i + 1) / N;
      verts.push(luff(a), leech(a), luff(b), luff(b), leech(a), leech(b));
    }
    sailGeo.setFromPoints(verts);
    sailGeo.computeVertexNormals();
    this.sailBase = Float32Array.from(sailGeo.attributes.position.array);
    const sail = new THREE.Mesh(sailGeo, sailMat);
    sail.castShadow = true;
    sail.visible = false;
    g.add(sail);
    this.boatSail = { sail, furled, mastX, mastZ, boomLen, top, foot, open: 0 };
    // A pennant at the masthead.
    const pen = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.5, 4), new THREE.MeshStandardMaterial({ color: 0xd8462f }));
    pen.rotation.z = Math.PI / 2;
    pen.position.set(mastX - 0.25, CFG.boatDeck + 4.55, mastZ);
    g.add(pen);
    this.boatPennant = pen;
    this.scene.add(g);
    this.boatGroup = g;
    this._placeBoat();
  }

  // The boat's pose from a list of deck cells (stern to bow): centre and yaw.
  _boatPose(cells) {
    const a = cells[0];
    const b = cells[cells.length - 1];
    return { pos: V((a.x + b.x) / 2, (a.y + b.y) / 2, 0), yaw: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  _placeBoat() {
    if (!this.boatGroup) return;
    const { pos, yaw } = this._boatPose(this.world.boat.cells);
    this.boatGroup.position.copy(pos);
    this.boatGroup.rotation.y = yaw;
  }
  // Furl (0) or set (1) the sail.
  _setSail(k) {
    const s = this.boatSail;
    s.open = k;
    s.sail.visible = k > 0.02;
    s.furled.visible = k < 0.98;
    s.sail.scale.set(1, Math.max(0.02, k), 1);
    s.sail.position.y = s.foot * (1 - Math.max(0.02, k));
  }

  _updateSmoke(t) {
    if (!this.smoke) return;
    for (const sp of this.smoke) {
      const k = (t * 0.045 + sp.userData.phase) % 1; // 0..1 over a puff's life
      sp.position.copy(this.smokeBase).add(new THREE.Vector3(k * 6 + Math.sin(k * 5 + sp.userData.wob) * 0.8, k * 14, -k * 2));
      const size = 1.2 + k * 6;
      sp.scale.set(size, size, 1);
      const day = this.skyNow?.light ?? 1;
      sp.material.opacity = Math.sin(k * Math.PI) * 0.55 * (0.45 + 0.55 * day);
      // Lit red from below at night, more so near the crater.
      sp.material.color.setHex(0x8a8580).lerp(new THREE.Color(0xc04a20), (1 - day) * (1 - k) * 0.9);
    }
    if (this.craterHalo) {
      const day = this.skyNow?.light ?? 1;
      this.craterHalo.material.opacity = (0.04 + 0.96 * (1 - day)) * (0.85 + 0.15 * Math.sin(t * 3.1));
    }
    if (this.lavaMat) this.lavaMat.emissiveIntensity = 1.8 + Math.sin(t * 2.3) * 0.4 + Math.sin(t * 7.1) * 0.2;
  }

  _buildPalm(p, i) {
    const r = rng(i * 31 + 5);
    const g = new THREE.Group();
    g.position.copy(V(p.x, p.y));
    const lean = new THREE.Vector3((r() - 0.5) * 1.6, 0, (r() - 0.5) * 1.6);
    const height = 4.2 + r() * 1.2;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(lean.x * 0.2, height * 0.35, lean.z * 0.2),
      new THREE.Vector3(lean.x * 0.6, height * 0.7, lean.z * 0.6),
      new THREE.Vector3(lean.x, height, lean.z),
    ]);
    const trunk = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.17, 8), new THREE.MeshStandardMaterial({ color: 0x8b6a45, roughness: 1, flatShading: true }));
    trunk.castShadow = true;
    g.add(trunk);
    const top = curve.getPoint(1);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f8f3a, roughness: 0.85, side: THREE.DoubleSide, flatShading: true });
    const fronds = 8;
    const leaves = [];
    this.palmLeaves.set(key(p.x, p.y), { leaves, top: g.position.clone().add(curve.getPoint(1)) });
    for (let f = 0; f < fronds; f++) {
      const geo = new THREE.PlaneGeometry(0.75, 2.8, 2, 8);
      const pos = geo.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const yy = pos.getY(v) + 1.4; // 0..2.8 along the frond
        const xx = pos.getX(v);
        pos.setX(v, xx * (1 - yy / 3.2));
        pos.setZ(v, -0.12 * yy * yy + Math.abs(xx) * 0.3);
        pos.setY(v, yy);
      }
      geo.computeVertexNormals();
      const leaf = new THREE.Mesh(geo, leafMat);
      leaf.position.copy(top);
      leaf.rotation.order = 'YXZ';
      leaf.rotation.y = (f / fronds) * Math.PI * 2 + r() * 0.3;
      leaf.rotation.x = -1.15 + r() * 0.3;
      leaf.castShadow = true;
      g.add(leaf);
      leaves.push(leaf);
    }
    const nut = new THREE.MeshStandardMaterial({ color: 0x5b3a1e, roughness: 0.8 });
    for (let k = 0; k < 3; k++) {
      const c = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), nut);
      const a = (k / 3) * Math.PI * 2;
      c.position.set(top.x + Math.cos(a) * 0.18, top.y - 0.18, top.z + Math.sin(a) * 0.18);
      g.add(c);
    }
    this.scene.add(g);
  }

  // One robot: its meshes, its pose state (yaw, arms, walk cycle…), and its speech bubble and thought cloud.
  _buildRobot(id) {
    const R = new THREE.Group();
    const rig = { id, group: R, yaw: 0, armLift: 0, walkPhase: 0, walking: 0, headShake: 0, squash: 0, paddleK: null, blink: Math.random() * 10 };
    const white = new THREE.MeshStandardMaterial({ color: 0xeef1f4, roughness: 0.35, metalness: 0.25 });
    const orange = new THREE.MeshStandardMaterial({ color: ROBOT_COLORS[id] ?? 0xf28c28, roughness: 0.45, metalness: 0.2 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.4, metalness: 0.4 });
    const glow = (rig.eyeMat = new THREE.MeshStandardMaterial({ color: 0x65f0ff, emissive: 0x30e0ff, emissiveIntensity: 2.2 }));
    const box = (w, h, d, m) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.castShadow = true;
      return mesh;
    };
    const body = (rig.body = new THREE.Group());
    R.add(body);
    rig.legs = [-1, 1].map((s) => {
      const hip = new THREE.Group();
      hip.position.set(s * 0.17, 0.52, 0);
      const leg = box(0.17, 0.44, 0.2, dark);
      leg.position.y = -0.22;
      const foot = box(0.22, 0.1, 0.3, orange);
      foot.position.set(0, -0.47, 0.04);
      hip.add(leg, foot);
      body.add(hip);
      return hip;
    });
    const torso = box(0.68, 0.58, 0.44, white);
    torso.position.y = 0.82;
    body.add(torso);
    const panel = box(0.4, 0.26, 0.03, orange);
    panel.position.set(0, 0.86, 0.23);
    body.add(panel);
    const light = new THREE.Mesh(new THREE.CircleGeometry(0.05, 16), glow);
    light.position.set(0.1, 0.88, 0.25);
    body.add(light);
    const head = (rig.head = new THREE.Group());
    head.position.y = 1.13;
    body.add(head);
    const skull = box(0.52, 0.38, 0.42, white);
    skull.position.y = 0.2;
    const visor = box(0.44, 0.2, 0.03, dark);
    visor.position.set(0, 0.21, 0.215);
    head.add(skull, visor);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.CircleGeometry(0.05, 16), glow);
      eye.position.set(s * 0.1, 0.22, 0.232);
      head.add(eye);
      const ear = box(0.06, 0.16, 0.16, orange);
      ear.position.set(s * 0.29, 0.2, 0);
      head.add(ear);
    }
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.22, 6), dark);
    ant.position.set(0.12, 0.5, 0);
    rig.bulbMat = new THREE.MeshStandardMaterial({ color: 0xff5040, emissive: 0xff3020, emissiveIntensity: 2 });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), rig.bulbMat);
    bulb.position.set(0.12, 0.62, 0);
    head.add(ant, bulb);
    rig.arms = [-1, 1].map((s) => {
      const sh = new THREE.Group();
      sh.position.set(s * 0.43, 1.03, 0);
      const arm = box(0.13, 0.48, 0.13, white);
      arm.position.y = -0.22;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), orange);
      hand.position.y = -0.48;
      hand.castShadow = true;
      sh.add(arm, hand);
      body.add(sh);
      return sh;
    });
    this.scene.add(R);
    // Speech bubble and thought cloud (the robot's latest thought), edged in its paint colour.
    const css = `#${(ROBOT_COLORS[id] ?? 0xf28c28).toString(16).padStart(6, '0')}`;
    rig.bubble = document.createElement('div');
    rig.bubble.className = 'bubble';
    rig.bubble.style.borderColor = css;
    this.container.appendChild(rig.bubble);
    rig.thoughtEl = document.createElement('div');
    rig.thoughtEl.className = 'thought-cloud';
    rig.thoughtEl.style.borderColor = css;
    rig.thoughtEl.innerHTML = '<span class="txt"></span><i class="puff p1"></i><i class="puff p2"></i>';
    this.container.appendChild(rig.thoughtEl);
    this._snapRobot(rig);
    return rig;
  }

  _rig(id) {
    return this.rigs.find((r) => r.id === id) || this.rigs[0];
  }

  // One native: a weathered bronze robot in a skirt of palm fronds, with a stick whose tip glows; red eyes.
  _buildNative(id, i) {
    const N = new THREE.Group();
    const rig = { id, group: N, yaw: 0, walking: 0, walkPhase: 0, jabK: 0, flash: 0, phase: i * 1.7 };
    const tones = [0x7a5634, 0x6b4a2b, 0x85613a];
    const bronze = new THREE.MeshStandardMaterial({ color: tones[i % tones.length], roughness: 0.55, metalness: 0.55 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.6, metalness: 0.3 });
    const leafMats = [0x4f8f3a, 0x6aa84f, 0x3f7a2e].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, side: THREE.DoubleSide }));
    rig.eyeMat = new THREE.MeshStandardMaterial({ color: 0xff4a3a, emissive: 0xff2010, emissiveIntensity: 2.4 });
    rig.tipMat = new THREE.MeshStandardMaterial({ color: 0xd8ff6a, emissive: 0xb8ff30, emissiveIntensity: 1.6 });
    const box = (w, h, d, m) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.castShadow = true;
      return mesh;
    };
    const body = (rig.body = new THREE.Group());
    N.add(body);
    rig.legs = [-1, 1].map((s) => {
      const hip = new THREE.Group();
      hip.position.set(s * 0.14, 0.5, 0);
      const leg = box(0.14, 0.46, 0.16, dark);
      leg.position.y = -0.23;
      const foot = box(0.18, 0.08, 0.26, bronze);
      foot.position.set(0, -0.46, 0.04);
      hip.add(leg, foot);
      body.add(hip);
      return hip;
    });
    const torso = box(0.56, 0.56, 0.38, bronze);
    torso.position.y = 0.84;
    body.add(torso);
    // The frond skirt: strips hanging from the waist, flaring outward; it sways as the native moves.
    const skirt = (rig.skirt = new THREE.Group());
    skirt.position.y = 0.62;
    const n = 14;
    for (let k = 0; k < n; k++) {
      const pivot = new THREE.Group();
      pivot.rotation.y = (k / n) * Math.PI * 2;
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.46), leafMats[k % 3]);
      strip.position.set(0, -0.2, 0.3);
      strip.rotation.x = -0.32;
      strip.castShadow = true;
      pivot.add(strip);
      skirt.add(pivot);
    }
    body.add(skirt);
    const head = (rig.head = new THREE.Group());
    head.position.y = 1.12;
    body.add(head);
    const skull = box(0.44, 0.34, 0.38, bronze);
    skull.position.y = 0.18;
    const brow = box(0.46, 0.06, 0.06, dark);
    brow.position.set(0, 0.28, 0.2);
    head.add(skull, brow);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.CircleGeometry(0.045, 12), rig.eyeMat);
      eye.position.set(s * 0.1, 0.19, 0.192);
      head.add(eye);
    }
    // A crest of three short fronds on top of the head.
    for (const s of [-1, 0, 1]) {
      const c = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.3), leafMats[(s + 3) % 3]);
      c.position.set(s * 0.1, 0.48, -0.02);
      c.rotation.z = -s * 0.35;
      head.add(c);
    }
    rig.arms = [-1, 1].map((s) => {
      const sh = new THREE.Group();
      sh.position.set(s * 0.36, 1.02, 0);
      const arm = box(0.11, 0.46, 0.11, bronze);
      arm.position.y = -0.21;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), dark);
      hand.position.y = -0.46;
      sh.add(arm, hand);
      body.add(sh);
      return sh;
    });
    // The stick, held in the right hand and pointing forward, its tip glowing.
    const stick = new THREE.Group();
    stick.position.y = -0.46;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.95, 8), new THREE.MeshStandardMaterial({ color: 0x5b3a1e, roughness: 0.9 }));
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = 0.25;
    shaft.castShadow = true;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), rig.tipMat);
    tip.position.z = 0.74;
    stick.add(shaft, tip);
    rig.arms[0].add(stick);
    rig.tip = tip;
    this.scene.add(N);
    this._snapNative(rig);
    return rig;
  }

  _snapNative(rig) {
    const n = this.world.nativeById(rig.id);
    if (!n) return;
    rig.group.position.copy(V(n.x, n.y, n.h));
    rig.yaw = Math.atan2(n.facing.x, -n.facing.y);
  }

  _poseNative(rig, dt, t) {
    rig.group.rotation.set(0, rig.yaw, 0);
    if (rig.walking) rig.walkPhase += dt * 10 * this.speed;
    const swing = rig.walking ? Math.sin(rig.walkPhase) * 0.6 : 0;
    rig.legs[0].rotation.x = swing;
    rig.legs[1].rotation.x = -swing;
    rig.skirt.rotation.z = Math.sin(t * 1.6 + rig.phase) * 0.04 + swing * 0.08;
    rig.skirt.rotation.x = swing * 0.06;
    // Stick arm: held low and forward; a jab thrusts it up and out.
    rig.arms[0].rotation.x = -0.35 - rig.jabK * 1.1;
    rig.arms[1].rotation.x = rig.walking ? -swing * 0.7 : Math.sin(t * 0.8 + rig.phase) * 0.05;
    rig.body.position.y = rig.walking ? Math.abs(Math.sin(rig.walkPhase)) * 0.04 : Math.sin(t * 1.8 + rig.phase) * 0.012;
    rig.head.rotation.y = rig.walking ? 0 : Math.sin(t * 0.5 + rig.phase) * 0.35;
    rig.flash = Math.max(0, rig.flash - dt * 2.5);
    rig.tipMat.emissiveIntensity = 1.2 + Math.max(0, Math.sin(t * 3 + rig.phase)) * 0.8 + rig.flash * 6;
    rig.tip.scale.setScalar(1 + rig.flash * 0.8);
  }

  // The natives' moves during one action (all at once), then their jabs (one after another).
  async _playNatives(ev) {
    const rigs = new Map(this.nativeRigs.map((r) => [r.id, r]));
    const moves = ev.moves.filter((m) => rigs.has(m.id));
    const steps = Math.max(0, ...moves.map((m) => m.path.length - 1));
    for (const m of moves) rigs.get(m.id).walking = 1;
    for (let i = 1; i <= steps; i++) {
      const legs = moves.filter((m) => m.path[i]).map((m) => {
        const a = m.path[i - 1];
        const b = m.path[i];
        const rig = rigs.get(m.id);
        rig.yaw = Math.atan2(b.x - a.x, -(b.y - a.y));
        return { rig, from: V(a.x, a.y, a.h), to: V(b.x, b.y, b.h) };
      });
      for (const m of moves) if (!m.path[i]) rigs.get(m.id).walking = 0;
      await this.tween(0.28, (k) => { for (const l of legs) l.rig.group.position.lerpVectors(l.from, l.to, k); });
    }
    for (const m of moves) rigs.get(m.id).walking = 0;
    for (const j of ev.jabs) {
      const rig = rigs.get(j.id);
      if (!rig) continue;
      rig.yaw = Math.atan2(j.tx - j.x, -(j.ty - j.y));
      const target = this._rig(j.robot);
      let hit = false;
      await this.tween(0.42, (k) => {
        rig.jabK = Math.sin(k * Math.PI);
        if (!hit && k > 0.5) {
          hit = true;
          rig.flash = 1;
          this.burst('zap', target.group.position.clone().add(new THREE.Vector3(0, 0.9, 0)));
        }
        target.squash = hit ? Math.sin(Math.min(1, (k - 0.5) * 2) * Math.PI) * 0.35 : 0;
      });
      rig.jabK = 0;
      target.squash = 0;
    }
  }

  _blockMaterial(id) {
    const n = id.split('_')[1];
    const tex = canvasTexture(128, 128, (g, w, h) => {
      g.fillStyle = '#c99556';
      g.fillRect(0, 0, w, h);
      const r = rng(Number(n) * 13);
      for (let i = 0; i < 60; i++) {
        g.strokeStyle = `rgba(90,55,20,${0.05 + r() * 0.1})`;
        g.beginPath();
        const y = r() * h;
        g.moveTo(0, y);
        g.lineTo(w, y + (r() - 0.5) * 6);
        g.stroke();
      }
      g.strokeStyle = '#7b4f24';
      g.lineWidth = 12;
      g.strokeRect(6, 6, w - 12, h - 12);
      g.lineWidth = 9;
      g.beginPath();
      g.moveTo(10, 10);
      g.lineTo(w - 10, h - 10);
      g.stroke();
      g.fillStyle = 'rgba(255,248,235,0.92)';
      g.beginPath();
      g.arc(w / 2, h / 2, 30, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#4a2c10';
      g.font = `bold ${n.length > 1 ? 34 : 42}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(n, w / 2, h / 2 + 2);
    });
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
  }

  _makeItemMesh(it) {
    let mesh;
    if (it.type === 'block') {
      this.blockGeo ||= new THREE.BoxGeometry(0.97, 0.97, 0.97);
      mesh = new THREE.Mesh(this.blockGeo, this._blockMaterial(it.id));
    } else if (it.type === 'rock') {
      const geo = new THREE.IcosahedronGeometry(0.5, 1);
      const r = rng(11);
      const p = geo.attributes.position;
      const seen = new Map();
      for (let i = 0; i < p.count; i++) {
        const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
        if (!seen.has(k)) seen.set(k, 0.85 + r() * 0.25);
        const s = seen.get(k);
        p.setXYZ(i, p.getX(i) * s, p.getY(i) * s, p.getZ(i) * s);
      }
      geo.computeVertexNormals();
      geo.scale(1.1, 0.6, 0.95);
      mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8c877f, roughness: 0.95, flatShading: true }));
      // A faint magic shimmer so it reads as special.
      const glint = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.015, 6, 40), new THREE.MeshBasicMaterial({ color: 0xb48cff, transparent: true, opacity: 0.55 }));
      glint.rotation.x = Math.PI / 2;
      glint.position.y = -0.2;
      mesh.add(glint);
      this.rockGlint = glint;
    } else if (it.type === 'frond') {
      // A palm frond: a stiff stalk with a broad blade at one end, lying along x.
      mesh = new THREE.Group();
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 1.1, 6), new THREE.MeshStandardMaterial({ color: 0x8a7a3a, roughness: 0.9 }));
      stalk.rotation.z = Math.PI / 2;
      stalk.position.x = -0.4;
      mesh.add(stalk);
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.quadraticCurveTo(0.35, 0.3, 0.95, 0.04);
      shape.lineTo(0.95, -0.04);
      shape.quadraticCurveTo(0.35, -0.3, 0, 0);
      const blade = new THREE.Mesh(new THREE.ShapeGeometry(shape, 8), new THREE.MeshStandardMaterial({ color: 0x4f9a3c, roughness: 0.8, side: THREE.DoubleSide }));
      blade.rotation.x = -Math.PI / 2;
      blade.position.x = 0.12;
      mesh.add(blade);
    } else if (it.type === 'part') {
      mesh = this._partMesh(it.role);
    } else if (it.type === 'device') {
      // A metal base plate the parts fit onto, and the status light on the box.
      mesh = new THREE.Group();
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.04, 0.65), new THREE.MeshStandardMaterial({ color: 0x8d949c, metalness: 0.7, roughness: 0.4 }));
      plate.position.y = -0.28;
      mesh.add(plate);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshStandardMaterial({ color: 0x1d2a1d, emissive: 0x000000 }));
      const b = SLOTS.box.at;
      led.position.set(b[0] + 0.06, b[1] + 0.11, b[2] + 0.1);
      mesh.add(led);
      mesh.userData.led = led;
    } else {
      mesh = new THREE.Group();
      const torus = new THREE.Mesh(
        new THREE.TorusGeometry(0.5, 0.085, 18, 56),
        new THREE.MeshStandardMaterial({ color: 0xffc83d, metalness: 1, roughness: 0.22, emissive: 0x7a4a00, emissiveIntensity: 0.6 }),
      );
      torus.castShadow = true;
      mesh.add(torus);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: canvasTexture(128, 128, (g) => {
          const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
          grd.addColorStop(0, 'rgba(255,230,140,0.9)');
          grd.addColorStop(0.4, 'rgba(255,200,80,0.35)');
          grd.addColorStop(1, 'rgba(255,200,80,0)');
          g.fillStyle = grd;
          g.fillRect(0, 0, 128, 128);
        }),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      halo.scale.set(2.2, 2.2, 1);
      mesh.add(halo);
      const light = new THREE.PointLight(0xffc860, 3, 6, 2);
      mesh.add(light);
      this.ringTorus = torus;
    }
    mesh.traverse((o) => { if (o.isMesh && !o.material.transparent) { o.castShadow = true; o.receiveShadow = true; } });
    mesh.userData.id = it.id;
    this.scene.add(mesh);
    return mesh;
  }

  // The five solar-charger parts, each about 0.3 m tall when loose, centred on the origin.
  _partMesh(role) {
    const metal = new THREE.MeshStandardMaterial({ color: 0xa7adb4, metalness: 0.75, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6 });
    const g = new THREE.Group();
    const add = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
    if (role === 'stand') {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const leg = add(new THREE.CylinderGeometry(0.015, 0.015, 0.32, 6), metal, Math.cos(a) * 0.1, 0, Math.sin(a) * 0.1);
        leg.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
      }
      add(new THREE.BoxGeometry(0.16, 0.03, 0.08), metal, 0, 0.15, 0);
    } else if (role === 'arm') {
      add(new THREE.BoxGeometry(0.45, 0.045, 0.045), metal);
      for (const x of [-0.22, 0.22]) add(new THREE.BoxGeometry(0.05, 0.09, 0.08), dark, x, 0, 0);
    } else if (role === 'cable') {
      const coil = add(new THREE.TorusGeometry(0.11, 0.025, 8, 24), dark);
      coil.rotation.x = Math.PI / 2;
      add(new THREE.BoxGeometry(0.05, 0.04, 0.09), metal, 0.16, 0, 0);
    } else if (role === 'box') {
      add(new THREE.BoxGeometry(0.24, 0.18, 0.2), new THREE.MeshStandardMaterial({ color: 0x5e6a5a, metalness: 0.5, roughness: 0.5 }));
      const dial = add(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 16), new THREE.MeshStandardMaterial({ color: 0xf2efe6 }), 0, 0.02, 0.105);
      dial.rotation.x = Math.PI / 2;
    } else {
      add(new THREE.BoxGeometry(0.72, 0.035, 0.52), metal);
      add(new THREE.BoxGeometry(0.66, 0.04, 0.46), new THREE.MeshStandardMaterial({ color: 0x14244a, metalness: 0.3, roughness: 0.15, emissive: 0x0a1430, emissiveIntensity: 0.4 }));
    }
    return g;
  }

  // Create/remove meshes so they match the world's items.
  rebuildItems() {
    for (const [id, m] of this.itemMeshes) {
      if (!this.world.items.has(id) || m.userData.version !== this.world.version) {
        this.scene.remove(m);
        this.itemMeshes.delete(id);
      }
    }
    for (const it of this.world.items.values()) {
      if (this.itemMeshes.has(it.id)) continue;
      const m = this._makeItemMesh(it);
      m.userData.version = this.world.version;
      m.userData.phase = Math.random() * 6.28;
      this.itemMeshes.set(it.id, m);
    }
    this.syncAll();
  }

  _buildHover() {
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.container.appendChild(this.tip);
    const marker = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false }));
    marker.rotation.x = -Math.PI / 2;
    marker.visible = false;
    this.marker = marker;
    this.scene.add(marker);
    const el = this.gl.domElement;
    el.addEventListener('pointermove', (e) => this._hover(e));
    el.addEventListener('pointerleave', () => { this.tip.style.display = 'none'; marker.visible = false; });
  }

  _hover(e) {
    const rect = this.gl.domElement.getBoundingClientRect();
    this.mouse.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const targets = [this.terrainMesh, ...[...this.itemMeshes.values()].filter((m) => m.isMesh)];
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) { this.tip.style.display = 'none'; this.marker.visible = false; return; }
    const p = hit.point.clone();
    if (hit.face) p.addScaledVector(hit.face.normal.clone().transformDirection(hit.object.matrixWorld), -0.02);
    const x = Math.round(p.x);
    const y = Math.round(-p.z);
    const w = this.world;
    if (!w.inGrid(x, y)) { this.tip.style.display = 'none'; this.marker.visible = false; return; }
    const t = w.terrainAt(x, y);
    const col = w.column(x, y);
    const indoors = buildingAt(x, y) ? w.column(x, y, true) : [];
    const parts = [`<b>(${x}, ${y})</b> ${t}`];
    if ((t !== 'water' || col.length) && t !== 'hut' && t !== 'palm') parts.push(`top ${w.topHeight(x, y).toFixed(1)} m`);
    if (w.onBoat(x, y)) parts.push('sailboat deck');
    if (col.length) parts.push(`${t === 'water' && !w.onBoat(x, y) ? 'floating: ' : ''}${col.join(' › ')}`);
    if (buildingAt(x, y)) parts.push(`inside: ${indoors.length ? indoors.join(' › ') : 'empty floor'}`);
    this.tip.innerHTML = parts.join(' · ');
    this.tip.style.display = 'block';
    this.tip.style.left = `${e.clientX - rect.left + 14}px`;
    this.tip.style.top = `${e.clientY - rect.top + 12}px`;
    const top = w.topHeight(x, y);
    this.marker.position.copy(V(x, y, (top === -Infinity ? CFG.waterLevel : top) + 0.03));
    this.marker.visible = true;
  }

  // ---------- state -> visuals ----------
  _itemTargetPos(id) {
    const w = this.world;
    const it = w.items.get(id);
    if (it.state === 'stacked') return V(it.x, it.y, w.bottomOf(id) + w.itemHeight(id) / 2);
    if (it.state === 'hover') return V(it.x, it.y, it.alt);
    if (it.state === 'sunk') return V(it.x, it.y, groundHeight(it.x, it.y) + 0.25);
    if (it.state === 'fitted') {
      const a = SLOTS[it.role].at;
      return this._itemTargetPos(it.device).add(new THREE.Vector3(a[0], a[1], a[2]));
    }
    return this._holdPos(this._rig(w.holderOf(id)?.id));
  }

  // A robot carried by `carrier` lies on its side across the carrier's forearms, in front of its chest.
  _carryPose(carrier) {
    const yaw = carrier.yaw;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const rot = new THREE.Euler(0, yaw, Math.PI / 2);
    const up = new THREE.Vector3(0, 1, 0).applyEuler(rot);
    const mid = carrier.group.position.clone().addScaledVector(fwd, 0.7).add(new THREE.Vector3(0, 1.05 - carrier.squash * 0.3, 0));
    return { pos: mid.addScaledVector(up, -CFG.robotHeight / 2), rot };
  }

  _holdPos(rig) {
    return rig.group.position.clone().add(new THREE.Vector3(0, HOLD_Y - rig.squash * 0.3, 0));
  }

  _snapRobot(rig) {
    const r = this.world.robotById(rig.id);
    rig.group.position.copy(V(r.x, r.y, r.h));
    rig.yaw = Math.atan2(r.facing.x, -r.facing.y);
  }

  syncAll() {
    if (!this.boatMoving) this._placeBoat();
    for (const rig of this.nativeRigs || []) this._snapNative(rig);
    for (const rig of this.rigs) {
      this._snapRobot(rig);
      const r = this.world.robotById(rig.id);
      rig.armLift = r.holding ? 1 : r.carrying ? CARRY_LIFT : 0;
    }
    for (const [id, m] of this.itemMeshes) {
      const it = this.world.items.get(id);
      const dev = it.state === 'fitted' ? this.itemMeshes.get(it.device) : null;
      if (dev) {
        // Fitted parts ride on their device's mesh, so they move with it.
        if (m.parent !== dev) dev.add(m);
        const slot = SLOTS[it.role];
        m.position.set(...slot.at);
        m.rotation.set(slot.tilt || 0, slot.yaw || 0, 0);
        continue;
      }
      if (m.parent !== this.scene) this.scene.add(m);
      m.position.copy(this._itemTargetPos(id));
      m.visible = it.state !== 'sunk';
      if (it.type === 'block' || it.type === 'frond' || it.type === 'part') m.rotation.set(0, 0, 0);
    }
    // Palms lose a leaf for every frond torn off them.
    for (const [k, p] of this.palmLeaves) {
      const taken = this.world.frondsTaken.get(k) || 0;
      p.leaves.forEach((leaf, i) => { leaf.visible = i >= taken; });
    }
  }

  // ---------- tweens & event playback ----------
  tween(seconds, fn) {
    return new Promise((resolve) => {
      this.tweens.push({ t: 0, dur: Math.max(0.01, seconds / this.speed), fn, resolve });
    });
  }

  wait(seconds) {
    return this.tween(seconds, () => {});
  }

  _turnTo(rig, dx, dy, seconds = 0.18) {
    if (!dx && !dy) return Promise.resolve();
    const target = Math.atan2(dx, -dy);
    const from = rig.yaw;
    let delta = target - from;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    if (Math.abs(delta) < 0.01) return Promise.resolve();
    return this.tween(seconds, (k) => { rig.yaw = from + delta * ease(k); });
  }

  burst(kind, pos) {
    const presets = {
      splash: { count: 40, color: 0xe8fbff, size: 0.14, spread: 1.6, up: 4.2, gravity: 11, life: 0.9 },
      dust: { count: 22, color: 0xe9d6a6, size: 0.12, spread: 1.4, up: 1.0, gravity: 2, life: 0.7, opacity: 0.8 },
      poof: { count: 36, color: 0xd9c4ff, size: 0.2, spread: 2.2, up: 2.5, gravity: 1.5, life: 1.0 },
      sparkle: { count: 30, color: 0xfff0a0, size: 0.12, spread: 1.2, up: 1.6, gravity: 0.5, life: 1.0 },
      leaves: { count: 18, color: 0x5aa845, size: 0.16, spread: 1.0, up: 0.6, gravity: 1.8, life: 1.2 },
      zap: { count: 30, color: 0xd8ff6a, size: 0.1, spread: 2.0, up: 1.4, gravity: 0.6, life: 0.55 },
      wake: { count: 14, color: 0xe8fbff, size: 0.11, spread: 0.7, up: 1.6, gravity: 8, life: 0.6 },
    };
    this.particles.push(new Particles(this.scene, { ...presets[kind], pos }));
  }

  say(rig, text) {
    if (!text) return;
    rig.bubble.textContent = text;
    rig.bubble.classList.add('show');
    clearTimeout(rig.bubbleTimer);
    rig.bubbleTimer = setTimeout(() => rig.bubble.classList.remove('show'), 2500 + text.length * 45);
  }

  // who: robot id. pending: the model hasn't produced anything yet, so show animated dots.
  setThought(who, text, pending = false) {
    const rig = this._rig(who);
    clearTimeout(rig.thoughtTimer);
    const el = rig.thoughtEl;
    el.classList.toggle('pending', pending);
    el.querySelector('.txt').textContent = pending ? '' : text;
    el.classList.toggle('show', this.thoughtsOn && (pending || !!text));
    this._placeThought(rig);
  }

  thoughtPending(who) {
    return this._rig(who).thoughtEl.classList.contains('pending');
  }

  // Centre the cloud over the robot; its puffs trail down to just above the head (or the item it carries).
  _placeThought(rig) {
    const top = this.world.robotById(rig.id).holding ? 2.75 : 1.85;
    const p = rig.group.position.clone().add(new THREE.Vector3(0, top, 0)).project(this.camera);
    // Sit above the speech bubble when the robot is also talking.
    const talking = rig.bubble.classList.contains('show') ? rig.bubble.offsetHeight + 14 : 0;
    rig.thoughtEl.style.left = `${((p.x + 1) / 2) * this.container.clientWidth}px`;
    rig.thoughtEl.style.top = `${((1 - p.y) / 2) * this.container.clientHeight - talking}px`;
    // Hide it while the robot is behind the camera.
    rig.thoughtEl.style.visibility = p.z > 1 ? 'hidden' : '';
  }

  clearThought(who, afterMs = 0) {
    const rig = this._rig(who);
    clearTimeout(rig.thoughtTimer);
    rig.thoughtTimer = setTimeout(() => rig.thoughtEl.classList.remove('show'), afterMs);
  }

  showThoughts(on) {
    this.thoughtsOn = on;
    if (!on) for (const rig of this.rigs) rig.thoughtEl.classList.remove('show');
  }

  async play(events) {
    const actor = (events || []).find((e) => e.robot);
    if (actor && !this.lock) this.focus = this._rig(actor.robot);
    for (const ev of events || []) await this._playOne(ev);
    this.rebuildItems();
  }

  async _playOne(ev) {
    const w = this.world;
    const rig = this._rig(ev.robot);
    const mesh = ev.item ? this.itemMeshes.get(ev.item) : null;
    // A group of fitted parts set onto another merges into it and is gone: just settle the arms.
    if (ev.item && (!mesh || !w.items.has(ev.item))) {
      rig.armLift = 0;
      return;
    }
    switch (ev.type) {
      case 'face':
        return this._turnTo(rig, ev.x, ev.y);
      case 'walk': {
        rig.walking = 1;
        for (let i = 1; i < ev.path.length; i++) {
          const a = ev.path[i - 1];
          const b = ev.path[i];
          const from = V(a.x, a.y, a.h);
          const to = V(b.x, b.y, b.h);
          this._turnTo(rig, b.x - a.x, b.y - a.y, 0.12);
          const diag = a.x !== b.x && a.y !== b.y;
          await this.tween(diag ? 0.36 : 0.26, (k) => {
            rig.group.position.lerpVectors(from, to, k);
            rig.group.position.y = b.h > a.h ? lerp(a.h, b.h, Math.min(1, k * 2.5)) : lerp(a.h, b.h, Math.max(0, k * 2.5 - 1.5));
          });
        }
        rig.walking = 0;
        return;
      }
      case 'jump': {
        const from = V(ev.from.x, ev.from.y, ev.from.h);
        const to = V(ev.to.x, ev.to.y, ev.to.h);
        // Indoors, keep the robot's head below the ceiling.
        const top = Math.max(ev.from.h, ev.to.h);
        const apex = Math.max(top + 0.05, Math.min(top + 0.9, (ev.ceiling ?? Infinity) - CFG.robotHeight));
        await this.tween(0.14, (k) => { rig.squash = Math.sin(k * Math.PI / 2) * 0.5; });
        const dur = 0.45 + 0.05 * Math.max(0, ev.from.h - ev.to.h);
        await this.tween(dur, (k) => {
          rig.squash = Math.max(0, 0.5 - k * 3) * -0.4;
          rig.group.position.lerpVectors(from, to, k);
          // Quadratic through from.h -> apex -> to.h.
          const h0 = ev.from.h;
          const h1 = ev.to.h;
          const m = apex;
          rig.group.position.y = (1 - k) * (1 - k) * h0 + 2 * (1 - k) * k * (2 * m - (h0 + h1) / 2) + k * k * h1;
        });
        this.burst('dust', V(ev.to.x, ev.to.y, ev.to.h + 0.05));
        await this.tween(0.16, (k) => { rig.squash = Math.sin(k * Math.PI) * 0.35; });
        rig.squash = 0;
        return;
      }
      case 'pickup': {
        this.animating.add(ev.item);
        const start = mesh.position.clone();
        await this.tween(0.42, (k) => {
          rig.armLift = Math.max(rig.armLift, k);
          const e = ease(k);
          mesh.position.lerpVectors(start, this._holdPos(rig), e);
          mesh.position.y += Math.sin(e * Math.PI) * 0.4;
          mesh.rotation.y *= 1 - k;
          mesh.rotation.z *= 1 - k;
        });
        this.animating.delete(ev.item);
        if (ev.item === 'ring') this.burst('sparkle', this._holdPos(rig));
        return;
      }
      case 'place': {
        this.animating.add(ev.item);
        const start = mesh.position.clone();
        const end = this._itemTargetPos(ev.item);
        const it = w.items.get(ev.item);
        const flyEnd = it.state === 'hover' ? V(it.x, it.y, w.robotById(rig.id).h + 1.2) : end;
        await this.tween(0.45, (k) => {
          rig.armLift = 1 - k * 0.6;
          const e = ease(k);
          mesh.position.lerpVectors(start, flyEnd, e);
          mesh.position.y += Math.sin(e * Math.PI) * 0.3;
        });
        rig.armLift = 0;
        if (it.state === 'hover') await this._floatUp(mesh, end);
        else if (w.isWater(it.x, it.y)) this.burst('splash', end.clone().setY(CFG.waterLevel + 0.1));
        else this.burst('dust', end.clone().setY(end.y - 0.4));
        this.animating.delete(ev.item);
        return;
      }
      case 'throw': {
        this.animating.add(ev.item);
        const it = w.items.get(ev.item);
        await this.tween(0.16, (k) => { rig.armLift = 1 + k * 0.35; });
        const start = mesh.position.clone();
        let end = this._itemTargetPos(ev.item);
        if (it.state === 'sunk') end = V(ev.to.x, ev.to.y, CFG.waterLevel);
        if (it.state === 'hover') end = V(ev.to.x, ev.to.y, Math.max(this.world.topHeight(ev.to.x, ev.to.y), 0) + 1.2);
        const dist = start.distanceTo(end);
        const apex = Math.max(start.y, end.y) + 1.2 + dist * 0.22;
        const spin = (Math.random() - 0.5) * 8;
        let landedFirst = null;
        // If it bounced off something, fly to the aim point first, then hop to the resting cell.
        const aimWater = ev.aim && this.world.isWater(ev.aim.x, ev.aim.y);
        if (ev.aim && (ev.aim.x !== ev.to.x || ev.aim.y !== ev.to.y)) {
          const ah = aimWater ? CFG.waterLevel + 0.1 : this.world.isBlocked(ev.aim.x, ev.aim.y) ? CFG.hutHeight + 0.4 : end.y;
          landedFirst = V(ev.aim.x, ev.aim.y, ah);
        }
        const firstEnd = landedFirst || end;
        const d1 = start.distanceTo(firstEnd);
        await this.tween(0.45 + d1 * 0.045, (k) => {
          rig.armLift = k < 0.3 ? lerp(1.35, -0.2, k / 0.3) : -0.2 + (k - 0.3) * 0.3;
          mesh.position.lerpVectors(start, firstEnd, k);
          mesh.position.y = (1 - k) * (1 - k) * start.y + 2 * (1 - k) * k * (2 * apex - (start.y + firstEnd.y) / 2) + k * k * firstEnd.y;
          if (it.type !== 'ring') { mesh.rotation.x = spin * k; mesh.rotation.z = spin * 0.6 * k; } else mesh.rotation.y += 0.3;
        });
        rig.armLift = 0;
        if (landedFirst) {
          this.burst(aimWater ? 'splash' : 'dust', landedFirst);
          const s2 = mesh.position.clone();
          const hop = s2.distanceTo(end);
          // A rock that hits the water skips back to shore in a few shrinking hops.
          const hops = aimWater ? Math.max(1, Math.min(4, Math.round(hop / 2))) : 1;
          for (let i = 0; i < hops; i++) {
            const a = s2.clone().lerp(end, i / hops);
            const b = s2.clone().lerp(end, (i + 1) / hops);
            const lift = (0.8 + hop * 0.12) * (1 - i / (hops + 1));
            await this.tween(0.3 + (hop / hops) * 0.05, (k) => {
              mesh.position.lerpVectors(a, b, k);
              mesh.position.y += Math.sin(k * Math.PI) * lift;
            });
            if (i < hops - 1 && this.world.isWater(Math.round(b.x), Math.round(-b.z))) this.burst('splash', b);
          }
        }
        mesh.rotation.set(0, 0, 0);
        this.animating.delete(ev.item);
        if (it.state === 'hover') {
          this.animating.add(ev.item);
          await this._floatUp(mesh, this._itemTargetPos(ev.item));
          this.animating.delete(ev.item);
        }
        return;
      }
      case 'landed': {
        const it = w.items.get(ev.item);
        if (it.type === 'ring') return;
        if (ev.water) {
          this.burst('splash', V(it.x, it.y, CFG.waterLevel + 0.1));
          if (it.state === 'sunk') {
            this.animating.add(ev.item);
            const s = mesh.position.clone();
            const e = V(it.x, it.y, groundHeight(it.x, it.y) + 0.25);
            await this.tween(0.9, (k) => mesh.position.lerpVectors(s, e, ease(k)));
            this.animating.delete(ev.item);
          }
        } else {
          const p = mesh.position.clone();
          this.burst('dust', p.setY(p.y - 0.4));
          if (it.type === 'rock') this.burst('poof', mesh.position.clone());
        }
        return;
      }
      case 'spawn': {
        this.rebuildItems();
        const jobs = ev.items.map(async (id, i) => {
          const m = this.itemMeshes.get(id);
          const end = this._itemTargetPos(id);
          const start = end.clone().add(new THREE.Vector3(0, 7, 0));
          m.position.copy(start);
          m.scale.setScalar(0.01);
          this.animating.add(id);
          await this.wait(i * 0.12);
          this.burst('poof', start.clone().setY(start.y - 1));
          await this.tween(0.55, (k) => {
            m.scale.setScalar(Math.min(1, 0.01 + k * 3));
            m.position.lerpVectors(start, end, k * k);
            m.rotation.y = (1 - k) * 3;
          });
          m.rotation.set(0, 0, 0);
          const wet = w.isWater(w.items.get(id).x, w.items.get(id).y);
          this.burst(wet ? 'splash' : 'dust', wet ? end.clone().setY(CFG.waterLevel + 0.1) : end.clone().setY(end.y - 0.4));
          this.animating.delete(id);
        });
        await Promise.all(jobs);
        return;
      }
      case 'tear': {
        // Reach up into the palm, tear a frond off and bring it down overhead.
        this.rebuildItems();
        const m = this.itemMeshes.get(ev.item);
        const palm = this.palmLeaves.get(key(ev.palm.x, ev.palm.y));
        const top = palm ? palm.top.clone().add(new THREE.Vector3(0, -0.6, 0)) : V(ev.palm.x, ev.palm.y, 3.5);
        this.animating.add(ev.item);
        m.position.copy(top);
        await this.tween(0.3, (k) => { rig.armLift = k; });
        this.burst('leaves', top);
        const end = this._holdPos(rig);
        await this.tween(0.5, (k) => {
          m.position.lerpVectors(top, end, ease(k));
          m.rotation.z = (1 - k) * 1.2;
        });
        m.rotation.set(0, 0, 0);
        this.animating.delete(ev.item);
        return;
      }
      case 'raft': {
        // Paddle strokes: the whole raft (crates, load, riders) glides one cell per stroke.
        const ids = ev.items.filter((id) => this.itemMeshes.has(id));
        for (const id of ids) this.animating.add(id);
        const parts = [
          ...ids.map((id) => ({ obj: this.itemMeshes.get(id), end: this._itemTargetPos(id) })),
          ...ev.riders.map((id) => { const r = this._rig(id); return { obj: r.group, end: this._snapTarget(r) }; }),
        ].map((p) => ({ ...p, start: p.obj.position.clone() }));
        for (let i = 0; i < ev.steps; i++) {
          await this.tween(0.55, (k) => {
            rig.paddleK = k;
            const f = (i + ease(k)) / ev.steps;
            for (const p of parts) p.obj.position.lerpVectors(p.start, p.end, f);
          });
          const back = rig.group.position.clone().add(new THREE.Vector3(-ev.dx * 0.9, 0, ev.dy * 0.9)).setY(CFG.waterLevel + 0.1);
          this.burst('wake', back);
        }
        rig.paddleK = null;
        for (const id of ids) this.animating.delete(id);
        return;
      }
      case 'carry': {
        // Lift the limp robot off its feet and swing it up into the arms.
        const t = this._rig(ev.target);
        t.carryAnim = true;
        const start = t.group.position.clone();
        const yaw0 = t.yaw;
        await this.tween(0.65, (k) => {
          rig.armLift = CARRY_LIFT * Math.min(1, k * 2);
          const e = ease(k);
          const p = this._carryPose(rig);
          t.group.position.lerpVectors(start, p.pos, e);
          t.group.position.y += Math.sin(e * Math.PI) * 0.25;
          t.group.rotation.set(0, yaw0 + Math.atan2(Math.sin(p.rot.y - yaw0), Math.cos(p.rot.y - yaw0)) * e, p.rot.z * e);
        });
        t.carryAnim = false;
        return;
      }
      case 'uncarry': {
        // Swing the robot down and stand it on its feet.
        const t = this._rig(ev.target);
        const r = w.robotById(t.id);
        t.carryAnim = true;
        const from = this._carryPose(rig);
        const end = this._snapTarget(t);
        const yaw1 = Math.atan2(r.facing.x, -r.facing.y);
        await this.tween(0.6, (k) => {
          rig.armLift = CARRY_LIFT * (1 - k);
          const e = ease(k);
          t.group.position.lerpVectors(from.pos, end, e);
          t.group.position.y += Math.sin(e * Math.PI) * 0.2;
          t.group.rotation.set(0, from.rot.y + Math.atan2(Math.sin(yaw1 - from.rot.y), Math.cos(yaw1 - from.rot.y)) * e, from.rot.z * (1 - e));
        });
        t.yaw = yaw1;
        t.carryAnim = false;
        this.burst('dust', end.clone().setY(end.y + 0.05));
        return;
      }
      case 'boat':
        return this._playBoat(ev, rig);
      case 'natives':
        return this._playNatives(ev);
      case 'say':
        this.say(rig, ev.text);
        return this.wait(0.6 + Math.min(2.5, ev.text.length * 0.03));
      case 'shrug':
        await this.tween(0.55, (k) => { rig.headShake = Math.sin(k * Math.PI * 4) * 0.45 * (1 - k); });
        rig.headShake = 0;
        return;
      default:
        return;
    }
  }

  // Sailing: the sail goes up, the hull swings round if it turned, then glides along its path with everything aboard.
  async _playBoat(ev, rig) {
    const ids = ev.items.filter((id) => this.itemMeshes.has(id));
    const riders = ev.riders.map((id) => this._rig(id));
    for (const id of ids) this.animating.add(id);
    this.boatMoving = true;
    const g = this.boatGroup;
    // Everything aboard, as offsets in the boat's own frame, so it turns and moves with the hull.
    const frame = (pos, yaw) => ({ pos, yaw });
    const start = frame(g.position.clone(), g.rotation.y);
    const objs = [...ids.map((id) => this.itemMeshes.get(id)), ...riders.map((r) => r.group)].map((obj) => {
      const local = obj.position.clone().sub(start.pos).applyAxisAngle(new THREE.Vector3(0, 1, 0), -start.yaw);
      return { obj, local };
    });
    const riderYaw = riders.map((r) => r.yaw);
    const apply = (pos, yaw) => {
      g.position.copy(pos);
      g.rotation.y = yaw;
      for (const o of objs) o.obj.position.copy(o.local.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).add(pos));
      riders.forEach((r, i) => { r.yaw = riderYaw[i] + (yaw - start.yaw); });
    };
    await this.tween(0.6, (k) => this._setSail(ease(k)));
    // Turning.
    const turned = this._boatPose(ev.afterTurn);
    if (ev.turned) {
      let dy = turned.yaw - start.yaw;
      while (dy > Math.PI + 1e-6) dy -= Math.PI * 2;
      while (dy < -Math.PI + 1e-6) dy += Math.PI * 2;
      if (Math.abs(Math.abs(dy) - Math.PI) < 1e-3) dy = Math.PI;
      await this.tween(0.5 + Math.abs(dy) * 0.45, (k) => {
        const e = ease(k);
        apply(start.pos.clone().lerp(turned.pos, e), start.yaw + dy * e);
      });
      start.yaw += dy;
    }
    // Gliding along the path, a cell at a time (quicker than paddling).
    const n = ev.steps.length;
    if (n) {
      const pts = [turned.pos.clone()];
      for (const [dx, dy] of ev.steps) pts.push(pts.at(-1).clone().add(new THREE.Vector3(dx, 0, -dy)));
      let lastWake = 0;
      await this.tween(Math.min(7, 0.8 + n * 0.22), (k) => {
        const f = (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2) * n;
        const i = Math.min(n - 1, Math.floor(f));
        apply(pts[i].clone().lerp(pts[i + 1], f - i), start.yaw);
        if (f - lastWake > 1.5) {
          lastWake = f;
          const back = new THREE.Vector3(-Math.cos(start.yaw) * 2.6, 0, Math.sin(start.yaw) * 2.6).add(g.position).setY(CFG.waterLevel + 0.1);
          this.burst('wake', back);
        }
      });
    }
    await this.tween(0.6, (k) => this._setSail(1 - ease(k)));
    this.boatMoving = false;
    this._placeBoat();
    for (const id of ids) this.animating.delete(id);
    for (const r of riders) this._snapRobot(r);
  }

  async _floatUp(mesh, end) {
    const s = mesh.position.clone();
    await this.tween(1.1, (k) => {
      mesh.position.lerpVectors(s, end, ease(k));
    });
    this.burst('sparkle', end);
  }

  // ---------- per-frame ----------
  _resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.gl.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Where a robot should be drawn, from the world state.
  _snapTarget(rig) {
    const r = this.world.robotById(rig.id);
    return V(r.x, r.y, r.h);
  }

  resetCamera() {
    const p = this.focus.group.position;
    this.camera.position.set(p.x + 14, 17, p.z + 26);
    this.controls.target.set(p.x, 1, p.z);
  }

  _frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.lastFrame = performance.now();
    this.time += dt;
    const t = this.time;
    this._advance(dt);
    this.particles = this.particles.filter((p) => p.update(dt));
    this._updateWater(t);
    this._updateSmoke(t);
    if (this.flagGeo) {
      const p = this.flagGeo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = this.flagBase[i * 3];
        p.array[i * 3 + 2] = Math.sin(x * 3 - t * 5) * 0.12 * x;
      }
      p.needsUpdate = true;
    }

    // Robot poses.
    for (const rig of this.rigs) this._poseRobot(rig, dt, t);
    for (const rig of this.nativeRigs || []) this._poseNative(rig, dt, t);

    // Items: held follow the robot; crates in the water bob gently (the whole raft together); the ring spins.
    for (const [id, m] of this.itemMeshes) {
      const it = this.world.items.get(id);
      if (!it) continue;
      if (id === 'ring' && this.ringTorus) {
        this.ringTorus.rotation.y = t * 1.4;
      }
      if (this.animating.has(id)) continue;
      if (it.state === 'held') {
        const rig = this._rig(this.world.holderOf(id)?.id);
        if (rig.paddleK != null) this._paddlePose(rig, m);
        else {
          m.position.copy(this._holdPos(rig));
          m.rotation.set(0, rig.yaw, 0);
        }
      } else if (it.state === 'stacked' && this.world.isWater(it.x, it.y) && !this.world.onBoat(it.x, it.y)) {
        const base = this._itemTargetPos(id);
        const occupied = this.world.robots.some((r) => r.x === it.x && r.y === it.y);
        m.position.set(base.x, base.y + (occupied ? 0 : Math.sin(t * 1.6 + it.x * 1.3 + it.y * 0.7) * 0.04), base.z);
      } else if (it.state === 'hover') {
        const base = this._itemTargetPos(id);
        m.position.set(base.x, base.y + Math.sin(t * 1.3) * 0.08, base.z);
      }
    }
    if (this.boatHull) {
      this.boatHull.rotation.x = Math.sin(t * 1.1) * 0.025;
      this.boatPennant.rotation.y = Math.sin(t * 3.1) * 0.35;
      const s = this.boatSail;
      if (s.sail.visible) {
        // Belly the sail out sideways, most in the middle.
        const pos = s.sail.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = this.sailBase[i * 3];
          const y = this.sailBase[i * 3 + 1];
          const u = Math.min(1, (s.mastX - x) / s.boomLen);
          const v = Math.min(1, Math.max(0, (y - s.foot) / (s.top - s.foot)));
          pos.array[i * 3 + 2] = this.sailBase[i * 3 + 2] + Math.sin(u * Math.PI) * (1 - v) * (0.45 + 0.05 * Math.sin(t * 2.3)) * s.open;
        }
        pos.needsUpdate = true;
        s.sail.geometry.computeVertexNormals();
      }
    }
    if (this.rockGlint) this.rockGlint.material.opacity = 0.25 + 0.35 * Math.abs(Math.sin(t * 1.5));
    for (const m of this.itemMeshes.values()) {
      const led = m.userData.led;
      if (!led) continue;
      const on = this.world.chargerWorks(this.world.items.get(m.userData.id));
      led.material.emissive.setHex(on ? 0x35ff6a : 0x000000);
      led.material.emissiveIntensity = on ? 1.4 + 0.6 * Math.sin(t * 3) : 0;
    }

    // Follow camera: slide the orbit target toward the robot that acted last, keeping the user's angle and zoom.
    const R = this.focus.group;
    if (this.follow && !this.userOrbiting) {
      const goal = R.position.clone().add(new THREE.Vector3(0, 1, 0));
      const delta = goal.sub(this.controls.target).multiplyScalar(Math.min(1, dt * 2.5));
      this.controls.target.add(delta);
      this.camera.position.add(delta);
    }
    // Sun and moon light come from where they are in the sky; shadows cover a 64 m square around the followed robot.
    const { sunDir, moonDir } = this._updateSky(dt);
    const sx = Math.round(R.position.x);
    const sz = Math.round(R.position.z);
    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx, 0, sz).addScaledVector(sunDir.y > 0.02 ? sunDir : new THREE.Vector3(0, 1, 0), 50);
    this.moonLight.target.position.set(sx, 0, sz);
    this.moonLight.position.set(sx, 0, sz).addScaledVector(moonDir, 50);
    this._updateBuildingCutaway();
    this.controls.update();
    this.gl.render(this.scene, this.camera);

    for (const rig of this.rigs) {
      if (rig.thoughtEl.classList.contains('show')) this._placeThought(rig);
      // Speech bubble follows the robot's head.
      if (rig.bubble.classList.contains('show')) {
        const p = rig.group.position.clone().add(new THREE.Vector3(0, this.world.robotById(rig.id).holding ? 3.0 : 2.1, 0)).project(this.camera);
        rig.bubble.style.left = `${((p.x + 1) / 2) * this.container.clientWidth}px`;
        rig.bubble.style.top = `${((1 - p.y) / 2) * this.container.clientHeight}px`;
      }
    }
  }

  _poseRobot(rig, dt, t) {
    const wr = this.world.robotById(rig.id);
    if (rig.carryAnim) {
      // The carry / uncarry tween is moving it.
    } else if (wr.carriedBy) {
      const p = this._carryPose(this._rig(wr.carriedBy));
      rig.group.position.copy(p.pos);
      rig.group.rotation.copy(p.rot);
    } else {
      rig.group.rotation.set(0, rig.yaw, 0);
    }
    if (rig.walking) rig.walkPhase += dt * 11 * this.speed;
    const swing = rig.walking ? Math.sin(rig.walkPhase) * 0.6 : 0;
    rig.legs[0].rotation.x = swing;
    rig.legs[1].rotation.x = -swing;
    // Paddling: both arms sweep from forward to back with each stroke.
    const lift = rig.paddleK != null ? 0.55 + 0.25 * Math.cos(rig.paddleK * Math.PI * 2) : rig.armLift;
    rig.arms.forEach((a, i) => {
      const s = i ? 1 : -1;
      a.rotation.x = -lift * Math.PI * 0.95 + (lift < 0.5 ? (i ? swing : -swing) * 0.8 : 0);
      a.rotation.z = s * (0.08 + lift * 0.12);
    });
    const idle = rig.walking ? Math.abs(Math.sin(rig.walkPhase)) * 0.05 : Math.sin(t * 2 + rig.blink) * 0.015;
    rig.body.position.y = idle - rig.squash * 0.25;
    rig.body.scale.set(1 + rig.squash * 0.15, 1 - rig.squash * 0.25, 1 + rig.squash * 0.15);
    rig.head.rotation.y = rig.headShake + (rig.walking ? 0 : Math.sin(t * 0.7 + rig.blink) * 0.15);
    // A flat battery: eyes and bulb go dark.
    const flat = wr.battery <= 0;
    rig.bulbMat.emissiveIntensity = flat ? 0 : 1 + Math.max(0, Math.sin(t * 4 + rig.blink)) * 2.5;
    rig.eyeMat.emissiveIntensity = flat ? 0.04 : Math.sin(t * 0.9 + rig.blink) > 0.985 ? 0.1 : 2.2;
    rig.eyeMat.color.setHex(flat ? 0x1c2b30 : 0x65f0ff);
  }

  // The frond held like a paddle: down at the robot's right side, blade in the water, sweeping back each stroke.
  _paddlePose(rig, m) {
    const k = rig.paddleK;
    const yaw = rig.yaw;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const p = rig.group.position.clone()
      .addScaledVector(side, 0.55)
      .addScaledVector(fwd, 0.5 - Math.sin(k * Math.PI) * 0.9 + k * 0.4);
    p.y += 0.65 - Math.sin(k * Math.PI) * 0.3;
    m.position.copy(p);
    // Point the blade (local +x) down toward the water.
    m.rotation.set(0, yaw - Math.PI / 2, -1.25);
  }
}
