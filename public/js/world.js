// Desert Isle: pure simulation. No rendering, no DOM; runs in the browser and in Node tests.
//
// The world is a grid of 1 m cells. Cell (x, y): x grows east, y grows north. Every cell has a
// terrain type with a base height; blocks and the rock stack in columns on top of it. The robot
// always stands on one cell, on top of that cell's column. Actions mutate the world instantly and
// return a list of animation events for the renderer to play back.
//
// The hut and the tower can be entered through their doorways. Their footprint cells have a second,
// indoor layer (floor at 0 m, under a ceiling) besides the outdoor surface (the tower's flat top; the
// hut's roof can't be stood on). Every location carries an `inside` flag, and the only way between
// the two layers is a building's doorway. Walls block walking, jumping, reaching and throwing.

//
// There are two islands and two robots. Every action is done by one robot (exec's `who`); while it runs,
// `this.robot` is that robot. The other robot is an obstacle that can be seen and heard. Crates floating side by
// side in the water make a raft that a robot standing on it can paddle with a palm frond. A robot whose battery is
// flat can be picked up and carried in another robot's arms (`carrying` / `carriedBy`), and set down again.

export const CFG = {
  bounds: { x0: -30, x1: 62, y0: -32, y1: 92 }, // the map: cells x0..x1, y0..y1
  islandRadius: 15.5,
  waterLevel: -0.35,
  dockHeight: 0.3,
  towerHeight: 4,
  hutHeight: 2.8,
  blockHeight: 1,
  rockHeight: 0.6,
  stepUp: 0.5,           // highest rise the robot can walk up
  stepDown: 1.25,        // deepest drop the robot will walk down (jump for more)
  jumpUp: 1.25,          // highest rise a jump can reach
  jumpRange: 2,          // cells (Chebyshev distance)
  reachUp: 2.6,          // above the robot's feet
  reachDown: 1.6,        // below the robot's feet
  placeUp: 2.0,          // highest stack top (above feet) the robot can set something onto
  throwMin: 1,
  throwRange: 14,
  ringAltitude: 5.6,     // centre height the ring floats at
  rockSpawn: 4,          // blocks spawned each time the thrown rock lands
  sightRange: 7,         // cells: small objects farther than this are only "something in the distance"
  maxBlocks: 80,
  robotHeight: 1.7,      // headroom the robot needs under a ceiling
  robotSight: 16,        // cells: another robot is seen clearly within this; farther, only as a distant figure
  hearRange: 18,         // cells: how far a robot's voice carries outdoors (5 through a wall)
  frondsPerPalm: 3,      // fronds a robot can tear off each palm tree
  frondHeight: 0.1,
  raftMin: 2,            // floating crates (sharing sides) needed to make a raft that can be paddled
  paddleMax: 6,          // strokes (one cell each) per paddle action
  dayStart: 7 * 60,      // the clock starts at 07:00 on day 1 (minutes)
  timeScale: 3,          // multiplies every action's minutes (see actionMinutes); the UI can change it
  batteryHours: 72,      // a full battery runs down in this many hours of game time
  chargeHours: 2,        // hours of daylight next to the working charger to charge an empty battery fully
  chargeLight: 0.5,      // sky light (0..1) the charger's panel needs
  partHeight: 0.3,       // a loose charger part
  deviceHeight: 0.6,     // parts fitted together
  waitMax: 60,           // minutes per wait action
  sayMax: 1200,          // characters one say can carry; longer is cut at a word and the speaker is told
  voiceMax: 2000,        // characters one message from the Voice (you) can carry
  boatLength: 4,         // cells: the sailboat's deck (room for both robots and some cargo)
  boatDeck: 0.3,         // deck height, level with the dock and a raft's top
  sailMax: 30,           // cells per sail action
  boatSight: 20,         // cells: the boat is seen within this in daylight (less at twilight and night)
  nativeJab: 5,          // battery points (of 100) one jab of a native's stick drains
  nativeJabEvery: 20,    // game minutes a native needs between jabs (3 natives: about 4-5% per robot action)
  nativeSpeed: 0.5,      // cells per game minute (robots walk 2 cells per minute at timeScale 1)
  nativeReach: 1.3,      // m: the stick reaches a robot whose feet are this far above or below the native's
};

// The five parts of the solar charger, where they start and what a robot sees. Stacking one part (or a group of
// fitted parts) onto another fits them together; all five make a working charger. Robots are never told this.
export const PARTS = [
  { role: 'stand', x: 46, y: 2, looks: 'a folding metal stand with three legs and a bracket on top', gap: 'a mount underneath with nothing to stand on' },
  { role: 'arm', x: 9, y: 6, inside: true, looks: 'a short metal arm with a clamp at each end', gap: 'two clamp points with nothing joining them' },
  { role: 'cable', x: -9, y: -4, inside: true, looks: 'a coil of thick black cable with a plug on one end and a square fitting on the other', gap: 'an empty square socket' },
  { role: 'box', x: 38, y: -1, looks: 'a heavy little metal box with a dial on its face and sockets in its sides', gap: 'a box-shaped gap with loose plugs in it' },
  { role: 'panel', x: -7, y: -4, looks: 'a flat panel of dark glass in a metal frame, with a socket on its back', gap: 'a wide empty frame mount on top' },
];
// The natives: robots that live on the two native islands (ISLANDS with `natives`). They are not driven by a model:
// passTime moves them. A native stays on its own island. When a robot of ours stands on that island (or floats right
// against its shore) with power left, the natives walk over and jab it with their sticks, each jab draining
// CFG.nativeJab of its battery; otherwise they wander back to their posts. Robots are never told any of this, only
// what they see and feel.
const NATIVE_LOOKS = 'a robot unlike you: a dark, weathered body, a skirt of palm fronds around its hips and a short stick with a glowing metal tip in one hand';

// Actions that need power: with a flat battery a robot can still look, speak and wait.
const POWERED = new Set(['walk_to', 'jump_to', 'jump', 'pick_up', 'put_down', 'place', 'drop', 'throw', 'throw_item', 'paddle', 'row', 'sail']);

// Time passes only when a robot acts (thinking is free), so it runs the same for every model speed.
// Minutes an action takes at timeScale 1: average about 3, so at the default 3x a day is ~160 actions.
function actionMinutes(name, res) {
  if (!res.ok) return 1;
  const walk = res.events.find((e) => e.type === 'walk');
  const raft = res.events.find((e) => e.type === 'raft');
  const boat = res.events.find((e) => e.type === 'boat');
  if (walk) return 2 + 0.5 * (walk.path.length - 1);
  if (raft) return 1.5 * raft.steps;
  if (boat) return 1 + 0.4 * boat.steps.length;
  return { look: 2, say: 1, jump_to: 2, pick_up: 3, put_down: 2, throw: 3, describe: 0, battery: 0 }[name] ?? 2;
}

// The sky at a moment (minutes since midnight of day 1). The sun rises in the east at 06:00, passes high in the
// southern sky and sets in the west at 18:00. light: 0 at night to 1 in daylight. dir: unit vector toward the sun
// in world terms (x east, y north, h up). Shared with the renderer.
export function skyAt(minutes) {
  const day = Math.floor(minutes / 1440) + 1;
  const hour = (((minutes % 1440) + 1440) % 1440) / 60;
  const a = ((hour - 6) / 12) * Math.PI;
  const up = Math.sin(a);
  const len = Math.hypot(Math.cos(a), 0.35, up);
  const smooth = (e0, e1, v) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const phase = hour < 5.25 || hour >= 18.75 ? 'night' : hour < 6.5 ? 'dawn' : hour < 10 ? 'morning' : hour < 14 ? 'midday' : hour < 17.5 ? 'afternoon' : 'dusk';
  return { day, hour, phase, up, light: smooth(-0.15, 0.18, up), dir: { x: Math.cos(a) / len, y: -0.35 / len, h: up / len } };
}
// What a robot notices about the sky (no clock, no numbers).
const SKY_WORDS = {
  night: 'It is night: dark, with the sky full of stars.',
  dawn: 'It is getting light: the eastern sky is glowing and the sun is just rising.',
  morning: 'The sun is climbing in the eastern sky.',
  midday: 'The sun is high overhead.',
  afternoon: 'The sun is sinking toward the west.',
  dusk: 'The sun is setting in the west and the light is fading.',
};

const TERRAIN = {
  water: { base: -Infinity, walk: false, blocked: false },
  sand: { base: 0, walk: true, blocked: false },
  dock: { base: CFG.dockHeight, walk: true, blocked: false },
  tower: { base: CFG.towerHeight, walk: true, blocked: false },
  hut: { base: CFG.hutHeight, walk: false, blocked: true },
  palm: { base: 0, walk: false, blocked: true },
  volcano: { base: 0, walk: false, blocked: true },
};

export const key = (x, y) => `${x},${y}`;
// A crate in the water floats half-submerged: its bottom sits here, so its top is level with the dock.
const RAFT_BASE = CFG.waterLevel + 0.15 - CFG.blockHeight / 2;
const compass = (dx, dy) => ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'][((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8];
// Compass directions as grid steps (x east, y north), and short forms a model might use.
const DIR_STEPS = { north: [0, 1], 'north-east': [1, 1], east: [1, 0], 'south-east': [1, -1], south: [0, -1], 'south-west': [-1, -1], west: [-1, 0], 'north-west': [-1, 1] };
const DIR_SHORT = { n: 'north', ne: 'north-east', e: 'east', se: 'south-east', s: 'south', sw: 'south-west', w: 'west', nw: 'north-west', up: 'north', down: 'south' };
function dirName(v) {
  const d = String(v ?? '').toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/^(north|south)(east|west)$/, '$1-$2');
  return DIR_SHORT[d] || d;
}
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const r2 = (n) => Math.round(n * 100) / 100;
const fmtH = (h) => (h === -Infinity ? 'water' : r2(h).toFixed(1));

export const BUILDINGS = ['hut', 'tower'];
export function buildingAt(x, y) {
  for (const b of BUILDINGS) {
    const f = LAYOUT[b];
    if (x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1) return b;
  }
  return null;
}
const colKey = (x, y, inside) => (inside ? `${x},${y},in` : `${x},${y}`);
export function parseKey(k) {
  const [x, y, flag] = k.split(',');
  return { x: Number(x), y: Number(y), inside: flag === 'in' };
}

// Island outlines: radius as a function of angle around each centre (shared with the renderer's terrain mesh).
export const ISLANDS = [
  { name: 'big', cx: 0, cy: 0, r: CFG.islandRadius, wobble: [[1.2, 3, 0.5], [0.7, 5, 1.3]], looks: 'a large island with a square stone tower, a hut and a wooden pier' },
  { name: 'small', cx: 42, cy: 2, r: 8, wobble: [[0.8, 3, 2.1], [0.5, 4, 0.4]], looks: 'a small, flat island with a few palm trees' },
  // Far to the north. From the ground it is below the horizon; from up high (the tower top) only the volcano's tip shows.
  {
    name: 'volcano', cx: -10, cy: 75, r: 11, wobble: [[0.9, 4, 1.7], [0.6, 3, 0.2]],
    looks: 'an island with a tall volcano in the middle and a ring of sand around it; smoke rises from the crater',
    farLooks: 'the tip of a volcano poking above the horizon, a thin trail of smoke rising from it',
    nightLooks: 'a dull red glow on the horizon, flickering now and then',
    near: 35, volcano: 4.5,
  },
  // The natives' islands: south, between the two home islands; north, on the way to the volcano island.
  { name: 'south', cx: 26, cy: -22, r: 7, wobble: [[0.6, 3, 0.9], [0.4, 5, 2.2]], looks: 'a low, round island ringed with palm trees', natives: true },
  { name: 'north', cx: 18, cy: 42, r: 7, wobble: [[0.7, 4, 0.3], [0.4, 3, 1.1]], looks: 'a low, round island with a few palm trees', natives: true },
];
// How far away (cells, to its centre) each island can be seen from the ground; every metre of height adds 8.
// The big island's tower makes it visible from farther than the flat small island.
const ISLAND_SEEN = { big: 70, small: 55, volcano: 50, south: 50, north: 50 };
const SEEN_PER_METRE = 8;
export function islandRadiusAt(theta, island = ISLANDS[0]) {
  return island.wobble.reduce((r, [a, k, p]) => r + a * Math.sin(k * theta + p), island.r);
}
// Index of the island a point is on, or -1 for the sea.
export function islandAt(x, y) {
  return ISLANDS.findIndex((i) => Math.hypot(x - i.cx, y - i.cy) <= islandRadiusAt(Math.atan2(y - i.cy, x - i.cx), i));
}
export function isLandAt(x, y) {
  return islandAt(x, y) >= 0;
}

export const LAYOUT = {
  robot: { x: 0, y: -2 },
  robots: [{ id: 'orange', x: 0, y: -2 }, { id: 'blue', x: 42, y: 1 }],
  // door: the outdoor cell in front of the doorway; doorIn: the indoor cell just inside it.
  hut: { x0: 6, x1: 9, y0: 4, y1: 6, door: { x: 7, y: 3 }, doorIn: { x: 7, y: 4 }, ceiling: CFG.hutHeight },
  tower: { x0: -9, x1: -7, y0: -6, y1: -4, door: { x: -8, y: -7 }, doorIn: { x: -8, y: -6 }, ceiling: CFG.towerHeight - 0.2 },
  palms: [{ x: 3, y: 10 }, { x: -4, y: -11 }, { x: 11, y: -5 }, { x: -12, y: 3 }, { x: -8, y: 9 }, { x: 40, y: 6 }, { x: 46, y: -2 }, { x: 37, y: 0 }, { x: -16, y: 72 }, { x: -3, y: 79 },
    { x: 23, y: -18 }, { x: 30, y: -20 }, { x: 28, y: -26 }, { x: 21, y: -24 }, { x: 15, y: 45 }, { x: 22, y: 39 }],
  // The floating ring (set to { x: -3, y: 7 } to bring it back). Off: the robots fixated on it.
  ring: null,
  rock: { x: 4, y: 1 },
  blocks: [
    [2, -4], [3, -4], [4, -4], [-2, 2], [-3, 2], [-2, 3],
    [5, -8], [5, -8], [-5, -2], [-6, -1], [1, 5], [2, 6],
  ],
  // Crates on the small island (numbered after the big island's).
  blocks2: [[39, 3], [40, 3], [44, 4], [44, 5], [45, 1], [43, -2], [41, -3], [38, 2]],
  // Fronds palms have shed, lying on the sand (frond_1, frond_2, …).
  fronds: [{ x: 4, y: 9 }, { x: 39, y: 6 }],
  // Crates on the volcano island.
  blocks3: [[-17, 77], [-4, 70], [-12, 66], [-2, 74]],
  // Crates on the natives' islands.
  blocks4: [[27, -18], [22, -21], [20, 44], [14, 41]],
  // The natives, three on each native island: where each one keeps its post.
  natives: [{ x: 26, y: -21 }, { x: 25, y: -24 }, { x: 28, y: -23 }, { x: 18, y: 41 }, { x: 17, y: 44 }, { x: 20, y: 42 }],
  // The sailboat, moored off the volcano island's north beach (out of sight from its south shore): stern cell and the
  // direction its bow points. Its CFG.boatLength cells run from the stern toward the bow.
  boat: { x: -11, y: 87, dir: [1, 0] },
  dockX: [0, 1],
};

export class World {
  constructor() {
    this.reset();
  }

  reset() {
    this.terrain = new Map();
    const B = CFG.bounds;
    for (let x = B.x0; x <= B.x1; x++) {
      for (let y = B.y0; y <= B.y1; y++) this.terrain.set(key(x, y), isLandAt(x, y) ? 'sand' : 'water');
    }
    const L = LAYOUT;
    // Dock: two planks wide, starting two cells up the beach and running 8 cells out to sea.
    const shore = L.dockX.map((x) => { let y = 0; while (isLandAt(x, y - 1)) y--; return y; });
    this.dock = { x0: L.dockX[0], x1: L.dockX[1], yLand: Math.max(...shore) + 1, yEnd: Math.min(...shore) - 8 };
    for (const x of L.dockX) for (let y = this.dock.yEnd; y <= this.dock.yLand; y++) this.terrain.set(key(x, y), 'dock');
    for (let x = L.hut.x0; x <= L.hut.x1; x++) for (let y = L.hut.y0; y <= L.hut.y1; y++) this.terrain.set(key(x, y), 'hut');
    for (let x = L.tower.x0; x <= L.tower.x1; x++) for (let y = L.tower.y0; y <= L.tower.y1; y++) this.terrain.set(key(x, y), 'tower');
    for (const p of L.palms) this.terrain.set(key(p.x, p.y), 'palm');
    // The volcano's cone covers the middle of its island.
    for (const isl of ISLANDS.filter((i) => i.volcano)) {
      for (let x = Math.floor(isl.cx - isl.volcano); x <= Math.ceil(isl.cx + isl.volcano); x++) {
        for (let y = Math.floor(isl.cy - isl.volcano); y <= Math.ceil(isl.cy + isl.volcano); y++) {
          if (Math.hypot(x - isl.cx, y - isl.cy) <= isl.volcano) this.terrain.set(key(x, y), 'volcano');
        }
      }
    }

    this.items = new Map();   // id -> { id, type, state, x, y }
    this.columns = new Map(); // colKey -> [item ids], bottom to top (stacked blocks and the rock)
    this.blockCount = 0;
    [...L.blocks, ...L.blocks2, ...L.blocks3, ...L.blocks4].forEach(([x, y]) => this._stack(this._newBlock(), x, y));
    this.items.set('rock', { id: 'rock', type: 'rock', state: 'stacked', x: L.rock.x, y: L.rock.y });
    this._pushColumn('rock', L.rock.x, L.rock.y);
    if (L.ring) this.items.set('ring', { id: 'ring', type: 'ring', state: 'hover', x: L.ring.x, y: L.ring.y, alt: CFG.ringAltitude });
    this.deviceCount = 0;
    PARTS.forEach((p, i) => {
      const id = `part_${i + 1}`;
      this.items.set(id, { id, type: 'part', role: p.role, state: 'stacked', x: p.x, y: p.y, inside: !!p.inside });
      this._pushColumn(id, p.x, p.y, !!p.inside);
    });
    this.robots = L.robots.map((p) => ({ id: p.id, x: p.x, y: p.y, h: 0, inside: false, holding: null, facing: { x: 0, y: 1 }, battery: 100, charging: false, carrying: null, carriedBy: null }));
    this.robot = this.robots[0];
    this.notices = new Map(this.robots.map((r) => [r.id, []])); // what each robot has heard or felt, not yet told
    this.voices = new Map(this.robots.map((r) => [r.id, []])); // what the Voice (you) said to each robot, not yet told
    this.natives = L.natives.map((p, i) => ({ id: `native_${i + 1}`, x: p.x, y: p.y, h: 0, home: { x: p.x, y: p.y }, island: islandAt(p.x, p.y), facing: { x: 0, y: -1 }, cool: 0, budget: 0, target: null }));
    this.nativeLog = null; // what the natives did during the current action (for the renderer)
    this.frondsTaken = new Map(); // palm key -> fronds torn off it
    this.frondCount = 0;
    for (const f of L.fronds) {
      const id = `frond_${++this.frondCount}`;
      this.items.set(id, { id, type: 'frond', state: 'stacked', x: f.x, y: f.y, inside: false });
      this._pushColumn(id, f.x, f.y);
    }
    const B0 = L.boat;
    this.boat = { cells: Array.from({ length: CFG.boatLength }, (_, i) => ({ x: B0.x + B0.dir[0] * i, y: B0.y + B0.dir[1] * i })), dir: { x: B0.dir[0], y: B0.dir[1] } };
    this.boatSeen = new Set(); // robots that have seen the boat (they are offered the sail tool from then on)
    this.talk = []; // everything said aloud: { who, text, heardBy: [robot ids] } (for the UI, never the model)
    this.minutes = CFG.dayStart; // the clock (minutes since midnight of day 1); see actionMinutes
    this.timeScale ??= CFG.timeScale; // kept across resets (the UI sets it)
    this.rockThrows = 0;
    this.version = (this.version || 0) + 1;
  }

  // ---------- queries ----------
  inGrid(x, y) {
    const B = CFG.bounds;
    return x >= B.x0 && x <= B.x1 && y >= B.y0 && y <= B.y1;
  }
  robotById(who) {
    return typeof who === 'number' ? this.robots[who] : this.robots.find((r) => r.id === who) || null;
  }
  // The robots other than the acting one.
  others() {
    return this.robots.filter((r) => r !== this.robot);
  }
  // Another robot standing on this cell (same layer), if any. A robot being carried isn't standing anywhere.
  robotAt(x, y, inside = false) {
    return this.others().find((o) => !o.carriedBy && o.x === x && o.y === y && !!o.inside === !!inside) || (!inside && this.nativeAt(x, y)) || null;
  }
  nativeAt(x, y) {
    return this.natives.find((n) => n.x === x && n.y === y) || null;
  }
  nativeById(id) {
    return this.natives.find((n) => n.id === id) || null;
  }
  // A carried robot is wherever its carrier is.
  _syncCarried() {
    for (const c of this.robots) {
      const o = c.carrying && this.robotById(c.carrying);
      if (o) Object.assign(o, { x: c.x, y: c.y, h: c.h, inside: c.inside });
    }
  }
  // What a robot has in its hands, for status lines.
  _holdingText(r) {
    return r.carrying ? `the ${r.carrying} robot, in your arms` : r.holding || 'nothing';
  }
  holderOf(id) {
    return this.robots.find((r) => r.holding === id) || null;
  }
  terrainAt(x, y) {
    return this.terrain.get(key(x, y)) || 'water';
  }
  column(x, y, inside = false) {
    return this.columns.get(colKey(x, y, inside)) || [];
  }
  itemHeight(id) {
    const it = this.items.get(id);
    return { rock: CFG.rockHeight, block: CFG.blockHeight, frond: CFG.frondHeight, part: CFG.partHeight, device: CFG.deviceHeight }[it.type] || 0;
  }
  // Things that never stay in open water: the rock skips back to land; fronds and charger parts wash ashore.
  returnsToLand(id) {
    const t = this.items.get(id).type;
    return t === 'rock' || t === 'frond' || t === 'part' || t === 'device';
  }
  // Bottom of a cell's column. In water, crates float (a raft), so the column starts just below the surface.
  // Indoors, the column starts on the floor.
  baseHeight(x, y, inside = false) {
    if (inside) return 0;
    if (this.onBoat(x, y)) return CFG.boatDeck;
    return this.isWater(x, y) ? RAFT_BASE : TERRAIN[this.terrainAt(x, y)].base;
  }
  // Height of the top surface of a cell (open water, or "inside" where there is no building, report -Infinity).
  topHeight(x, y, inside = false) {
    if (inside ? !buildingAt(x, y) : this.openWater(x, y)) return -Infinity;
    return this.column(x, y, inside).reduce((h, id) => h + this.itemHeight(id), this.baseHeight(x, y, inside));
  }
  ceilingAt(x, y, inside = false) {
    return inside ? LAYOUT[buildingAt(x, y)].ceiling : Infinity;
  }
  // Water with floating crates in it (not the boat's deck).
  isRaft(x, y) {
    return this.isWater(x, y) && this.column(x, y).length > 0 && !this.onBoat(x, y);
  }
  // Is (x, y) one of the boat's deck cells?
  onBoat(x, y) {
    return !!this.boat?.cells.some((c) => c.x === x && c.y === y);
  }
  // Water with nothing floating on it: no crates, no boat.
  openWater(x, y) {
    return this.isWater(x, y) && !this.column(x, y).length && !this.onBoat(x, y);
  }
  topItem(x, y, inside = false) {
    const c = this.column(x, y, inside);
    return c.length ? c[c.length - 1] : null;
  }
  isWater(x, y) {
    return this.terrainAt(x, y) === 'water';
  }
  isBlocked(x, y) {
    return TERRAIN[this.terrainAt(x, y)].blocked;
  }
  // Can the robot stand on this cell (indoors: with room for its head)?
  standable(x, y, inside = false) {
    if (!this.inGrid(x, y)) return false;
    if (inside) {
      if (!buildingAt(x, y) || this.topHeight(x, y, true) + CFG.robotHeight > this.ceilingAt(x, y, true) + 1e-9) return false;
    } else if (!TERRAIN[this.terrainAt(x, y)].walk && !this.isRaft(x, y) && !this.onBoat(x, y)) return false;
    if (this.robotAt(x, y, inside)) return false;
    const top = this.topItem(x, y, inside);
    return !(top && this.items.get(top).type === 'rock');
  }
  // Where an item sits: bottom height of a stacked item.
  bottomOf(id) {
    const it = this.items.get(id);
    const col = this.column(it.x, it.y, it.inside);
    let h = this.baseHeight(it.x, it.y, it.inside);
    for (const other of col) {
      if (other === id) return h;
      h += this.itemHeight(other);
    }
    return h;
  }
  centerHeight(id) {
    const it = this.items.get(id);
    if (it.state === 'stacked') return this.bottomOf(id) + this.itemHeight(id) / 2;
    if (it.state === 'hover') return it.alt;
    if (it.state === 'held') return (this.holderOf(id) || this.robot).h + 2.1;
    return -3;
  }
  surfaceName(x, y, inside = false) {
    const top = this.topItem(x, y, inside);
    const raft = !inside && this.raftAt(x, y);
    if (raft) return `${top}, part of ${this.raftName(raft)} floating in the water`;
    const boat = !inside && this.onBoat(x, y);
    if (top) return `${top} (stack of ${this.column(x, y, inside).length}${boat ? ", on the sailboat's deck" : !inside && this.isWater(x, y) ? ', floating in the water' : ''})`;
    if (boat) return "the sailboat's deck";
    if (inside) return `the floor of the ${buildingAt(x, y)}`;
    const t = this.terrainAt(x, y);
    return t === 'tower' ? 'the top of the tower' : t;
  }
  // Where the robot is, for messages: "" outdoors, "inside the hut " indoors.
  _where(inside, x, y) {
    return inside ? `inside the ${buildingAt(x, y)} ` : '';
  }
  // Is there a wall between the robot and this place? (Both outdoors, or both inside the same building, is fine.)
  _wallBetween(x, y, inside) {
    const r = this.robot;
    if (!!inside !== !!r.inside) return true;
    return !!inside && buildingAt(x, y) !== buildingAt(r.x, r.y);
  }

  // Normalize what an LLM might call an item: "Block 3", "block3", "the ring", "rock_1".
  resolveItem(name) {
    if (name == null) return null;
    let s = String(name).toLowerCase().trim().replace(/^the\s+/, '').replace(/[\s-]+/g, '_');
    const m = s.match(/^(?:block|crate|box|cube)_?#?(\d+)$/);
    if (m) s = `block_${Number(m[1])}`;
    if (/^(rock|stone|boulder)(_?1)?$/.test(s)) s = 'rock';
    if (/^(ring|hoop|halo|floating_ring)(_?1)?$/.test(s)) s = 'ring';
    const pm = s.match(/^(?:part|piece)_?#?(\d+)$/);
    if (pm) s = `part_${Number(pm[1])}`;
    const dm = s.match(/^device_?#?(\d+)$/);
    if (dm) s = `device_${Number(dm[1])}`;
    // A part by what it looks like ("the panel"), or a bare "device": the nearest one.
    const role = PARTS.find((p) => s.replace(/^(?:metal_|black_|glass_)/, '') === p.role || s === `${p.role}s`);
    if (role || s === 'device') {
      const r = this.robot;
      const found = [...this.items.values()].filter((it) => (role ? it.type === 'part' && it.role === role.role : it.type === 'device'));
      found.sort((a, b) => (r.holding === a.id ? -1 : cheb(r, this._where2(a))) - (r.holding === b.id ? -1 : cheb(r, this._where2(b))));
      if (found.length) s = found[0].id;
    }
    const f = s.match(/^(?:palm_)?(?:frond|leaf)_?#?(\d+)$/);
    if (f) s = `frond_${Number(f[1])}`;
    // A bare "frond": the nearest one that nobody else is holding.
    if (/^(?:palm_)?(?:frond|leaf)$/.test(s)) {
      const r = this.robot;
      const fronds = [...this.items.values()].filter((it) => it.type === 'frond' && (it.state !== 'held' || r.holding === it.id));
      fronds.sort((a, b) => (r.holding === a.id ? -1 : cheb(r, a)) - (r.holding === b.id ? -1 : cheb(r, b)));
      if (fronds.length) s = fronds[0].id;
    }
    return this.items.has(s) ? s : null;
  }

  // Short description of an item for look.
  _desc(id) {
    const it = this.items.get(id);
    if (it.type === 'part') return `${id} (${PARTS.find((p) => p.role === it.role).looks})`;
    if (it.type === 'device') return `${id} (${this._deviceLooks(it)})`;
    return { rock: `${id} (a grey rock)`, frond: `${id} (a palm frond)` }[it.type] || `${id} (wooden crate)`;
  }
  // Where an item really is: a fitted part is wherever its device is.
  _where2(it) {
    return it.state === 'fitted' ? this._where2(this.items.get(it.device)) : it.state === 'held' ? this.holderOf(it.id) : it;
  }
  _deviceLooks(dev) {
    const looks = dev.parts.map((p) => PARTS.find((q) => q.role === this.items.get(p).role).looks);
    const list = looks.length > 1 ? `${looks.slice(0, -1).join('; ')} and ${looks.at(-1)}` : looks[0];
    if (!this.deviceComplete(dev)) return `${dev.parts.length} parts fitted together: ${list}. It looks unfinished: ${this._gaps(dev)}`;
    return `${dev.parts.length} parts fitted together into one machine: the dark glass panel sits tilted up on the stand, joined by the arm to the box, with the cable coiled at its foot. Every fitting is filled; nothing is missing. ${this.chargerWorks(dev) ? 'A small green light glows on the box and it hums softly' : 'Its light is dark'}`;
  }
  // The empty fittings of an unfinished device, e.g. "2 fittings are still empty: an empty square socket and …".
  _gaps(dev) {
    const have = new Set(dev.parts.map((p) => this.items.get(p).role));
    const gaps = PARTS.filter((p) => !have.has(p.role)).map((p) => p.gap);
    const list = gaps.length > 1 ? `${gaps.slice(0, -1).join(', ')} and ${gaps.at(-1)}` : gaps[0];
    return `${gaps.length} fitting${gaps.length > 1 ? 's are' : ' is'} still empty (${list})`;
  }
  deviceComplete(dev) {
    return dev?.type === 'device' && dev.parts.length >= PARTS.length;
  }
  // The finished charger works while it stands outdoors, uncovered, in daylight.
  chargerWorks(dev) {
    if (!this.deviceComplete(dev) || dev.state !== 'stacked' || dev.inside) return false;
    return this.topItem(dev.x, dev.y) === dev.id && this.sky().light >= CFG.chargeLight;
  }
  // Fit `id` (a part or device that just landed) onto `onto` (the part or device it landed on). Returns the text.
  _fit(id, onto) {
    const below = this.items.get(onto);
    let dev = below;
    if (below.type === 'part') {
      const did = `device_${++this.deviceCount}`;
      dev = { id: did, type: 'device', state: 'stacked', x: below.x, y: below.y, inside: below.inside, parts: [] };
      this.items.set(did, dev);
      const col = this.columns.get(colKey(below.x, below.y, below.inside));
      col[col.indexOf(onto)] = did;
      this._fitPart(dev, onto);
    }
    const it = this.items.get(id);
    const added = it.type === 'device' ? [...it.parts] : [id];
    if (it.type === 'device') this.items.delete(id);
    for (const p of added) this._fitPart(dev, p);
    let text = onto === dev.id
      ? `${id} clicked into place on ${dev.id}, which now has ${dev.parts.length} parts fitted together, at (${dev.x},${dev.y})`
      : `${id} clicked into place on ${onto}: they are now fitted together as ${dev.id} (${dev.parts.length} parts) at (${dev.x},${dev.y})`;
    if (!this.deviceComplete(dev)) text += `. It looks unfinished: ${this._gaps(dev)}`;
    else text += this.chargerWorks(dev) ? '. That was the last empty fitting: the machine looks complete. A small green light on the box lit up and it began to hum softly' : '. That was the last empty fitting: the machine looks complete, but it stays dark and silent';
    return text;
  }
  _fitPart(dev, pid) {
    Object.assign(this.items.get(pid), { state: 'fitted', device: dev.id, x: dev.x, y: dev.y, inside: dev.inside });
    dev.parts.push(pid);
  }

  // Why the robot can or can't pick this item up right now (null = it can).
  pickupProblem(id) {
    const it = this.items.get(id);
    const r = this.robot;
    if (!it) return `there is no item called "${id}"`;
    if (r.holding === id) return `you are already holding ${id}`;
    if (r.carrying) return `your arms are full (carrying the ${r.carrying} robot); put_down it first`;
    if (r.holding) return `your hands are full (holding ${r.holding}); put_down or throw it first`;
    if (it.state === 'sunk') return `${id} sank to the bottom of the sea and is lost`;
    if (it.state === 'fitted') return `${id} is fitted into ${it.device} and won't come loose (pick up ${it.device} to carry it all)`;
    if (it.state === 'held') return `${id} is in the ${this.holderOf(id).id} robot's hands`;
    if (this._wallBetween(it.x, it.y, it.inside)) {
      return it.inside ? `${id} is inside the ${buildingAt(it.x, it.y)}; go in through its doorway first` : `${id} is outside and you are inside the ${buildingAt(r.x, r.y)}; go out through the doorway first`;
    }
    const d = cheb(r, it);
    if (d > 1) return `${id} is at (${it.x},${it.y}), ${d} cells away; you must be on the same or an adjacent cell (walk_to it first)`;
    if (it.state === 'stacked') {
      if (it.x === r.x && it.y === r.y) return `you are standing on ${id}`;
      const top = this.topItem(it.x, it.y, it.inside);
      if (top !== id) return `${id} is under ${top}; take ${top} off the top of that stack first`;
      const o = this.robotAt(it.x, it.y, it.inside);
      if (o) return `the ${o.id} robot is standing on ${id}`;
    }
    const c = this.centerHeight(id);
    if (c > r.h + CFG.reachUp) return `${id} is too high (${fmtH(c)} m up; you can reach up to ${fmtH(r.h + CFG.reachUp)} m from your feet at ${fmtH(r.h)} m). You would need to stand higher`;
    if (c < r.h - CFG.reachDown) return `${id} is too far below you (${fmtH(c)} m; you reach down to ${fmtH(r.h - CFG.reachDown)} m)`;
    return null;
  }

  // Places the robot can reach by walking, with path back-pointers (Dijkstra over the 8-neighbour grid, on both
  // layers). Indoors it can only move within the same building; doorways are the only links between the layers.
  _walkGraph() {
    const r = this.robot;
    const start = colKey(r.x, r.y, r.inside);
    const dist = new Map([[start, 0]]);
    const prev = new Map();
    const open = [{ x: r.x, y: r.y, inside: !!r.inside, d: 0 }];
    const canStep = (a, b) => {
      if (b.inside && buildingAt(b.x, b.y) !== buildingAt(a.x, a.y) && a.inside) return false;
      if (!this.standable(b.x, b.y, b.inside)) return false;
      const dh = this.topHeight(b.x, b.y, b.inside) - this.topHeight(a.x, a.y, a.inside);
      return dh <= CFG.stepUp && dh >= -CFG.stepDown;
    };
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].d < open[bi].d) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (cur.d > dist.get(colKey(cur.x, cur.y, cur.inside))) continue;
      const steps = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const n = { x: cur.x + dx, y: cur.y + dy, inside: cur.inside };
          if (!canStep(cur, n)) continue;
          if (dx && dy && !(canStep(cur, { x: n.x, y: cur.y, inside: cur.inside }) && canStep(cur, { x: cur.x, y: n.y, inside: cur.inside }))) continue;
          steps.push([n, dx && dy ? Math.SQRT2 : 1]);
        }
      }
      // Doorways: step straight through between the cell in front of a door and the cell just inside it.
      for (const b of BUILDINGS) {
        const { door, doorIn } = LAYOUT[b];
        if (!cur.inside && cur.x === door.x && cur.y === door.y) {
          const n = { ...doorIn, inside: true };
          if (canStep(cur, n)) steps.push([n, 1]);
        }
        if (cur.inside && cur.x === doorIn.x && cur.y === doorIn.y) {
          const n = { ...door, inside: false };
          if (canStep(cur, n)) steps.push([n, 1]);
        }
      }
      for (const [n, cost] of steps) {
        const nd = cur.d + cost;
        const k = colKey(n.x, n.y, n.inside);
        if (nd < (dist.get(k) ?? Infinity)) {
          dist.set(k, nd);
          prev.set(k, colKey(cur.x, cur.y, cur.inside));
          open.push({ ...n, d: nd });
        }
      }
    }
    return { dist, prev };
  }

  _pathTo(graph, k) {
    const path = [];
    for (let c = k; c; c = graph.prev.get(c)) {
      const p = parseKey(c);
      path.unshift({ ...p, h: this.topHeight(p.x, p.y, p.inside) });
    }
    return path;
  }

  // Cells around a target the robot should walk to.
  _approachCells(target) {
    const cells = [];
    const around = (x0, x1, y0, y1, inside = false) => {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        for (let y = y0 - 1; y <= y1 + 1; y++) {
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
          cells.push({ x, y, inside });
        }
      }
    };
    const into = target.match(/^(?:inside|in|into|enter)_(?:the_)?(hut|tower)$|^(hut|tower)_(?:inside|interior|door|doorway)$/);
    if (into) {
      const b = into[1] || into[2];
      return /door/.test(target) ? [{ ...LAYOUT[b].door, inside: false }] : [{ ...LAYOUT[b].doorIn, inside: true }];
    }
    if (target === 'hut') return [{ ...LAYOUT.hut.door, inside: false }];
    if (target === 'tower') { const t = LAYOUT.tower; around(t.x0, t.x1, t.y0, t.y1); return cells; }
    if (target === 'dock' || target === 'dock_end' || target === 'end_of_dock') return [{ x: this.dock.x0, y: this.dock.yEnd }, { x: this.dock.x1, y: this.dock.yEnd }];
    if (target === 'volcano') {
      for (const isl of ISLANDS.filter((i) => i.volcano)) around(Math.round(isl.cx - isl.volcano), Math.round(isl.cx + isl.volcano), Math.round(isl.cy - isl.volcano), Math.round(isl.cy + isl.volcano));
      return cells.filter((c) => this.terrainAt(c.x, c.y) !== 'volcano');
    }
    if (/^(?:sail_?)?boat$|^ship$|^yacht$|^deck$/.test(target)) return this.boat.cells.map((c) => ({ ...c, inside: false }));
    if (target === 'palm' || target === 'palm_tree' || target === 'tree') {
      for (const p of LAYOUT.palms) around(p.x, p.x, p.y, p.y);
      return cells;
    }
    const nat = this.nativeById(target.replace(/^native_?#?(\d+)$/, 'native_$1'));
    if (nat) {
      around(nat.x, nat.x, nat.y, nat.y);
      return cells;
    }
    const bot = this._robotTarget(target);
    if (bot) {
      around(bot.x, bot.x, bot.y, bot.y, !!bot.inside);
      return cells;
    }
    const id = this.resolveItem(target);
    if (id) {
      const it = this.items.get(id);
      if (it.state === 'held') return this.holderOf(id) === this.robot ? [] : null;
      around(it.x, it.x, it.y, it.y, !!it.inside);
      if (it.state !== 'stacked') cells.push({ x: it.x, y: it.y, inside: !!it.inside });
      return cells;
    }
    return null;
  }

  // "robot", "other_robot", "blue_robot", "the blue robot" -> another robot (never yourself).
  _robotTarget(target) {
    const m = String(target).match(/^(?:the_)?(?:other_)?(?:([a-z]+)_)?(?:robot|bot)$/);
    if (!m) return null;
    return this.others().find((o) => !m[1] || m[1] === 'other' || o.id === m[1]) || null;
  }

  jumpTargets() {
    const r = this.robot;
    const out = [];
    for (let dx = -CFG.jumpRange; dx <= CFG.jumpRange; dx++) {
      for (let dy = -CFG.jumpRange; dy <= CFG.jumpRange; dy++) {
        if (!dx && !dy) continue;
        if (this._jumpProblem(r.x + dx, r.y + dy) === null) out.push({ x: r.x + dx, y: r.y + dy, h: this.topHeight(r.x + dx, r.y + dy, r.inside) });
      }
    }
    return out;
  }

  // Jumps stay on the robot's own layer: indoors, only within the same building (walls are in the way).
  _jumpProblem(x, y) {
    const r = this.robot;
    const inside = !!r.inside;
    if (x === r.x && y === r.y) return 'you are already on that cell';
    const d = cheb(r, { x, y });
    if (d > CFG.jumpRange) return `(${x},${y}) is ${d} cells away; you can jump at most ${CFG.jumpRange} cells`;
    if (!this.inGrid(x, y)) return 'that is off the map';
    if (inside && buildingAt(x, y) !== buildingAt(r.x, r.y)) return `the ${buildingAt(r.x, r.y)}'s walls are in the way; leave through the doorway`;
    if (!inside && this.openWater(x, y)) return `(${x},${y}) is water; the robot cannot swim`;
    const o = this.robotAt(x, y, inside);
    if (o) return `the ${o.id} robot is standing on (${x},${y})`;
    if (!this.standable(x, y, inside)) {
      if (inside && this.topHeight(x, y, true) + CFG.robotHeight > this.ceilingAt(x, y, true)) return `there isn't room under the ceiling to stand on (${x},${y})`;
      return `you cannot stand on (${x},${y}) (${inside ? this.surfaceName(x, y, true) : this.terrainAt(x, y) === 'hut' ? "the hut's roof" : this.surfaceName(x, y)})`;
    }
    const rise = this.topHeight(x, y, inside) - r.h;
    if (rise > CFG.jumpUp + 1e-9) return `(${x},${y}) is ${fmtH(rise)} m higher than you; you can jump up at most ${CFG.jumpUp} m`;
    if (d === 2) {
      const mx = r.x + Math.round((x - r.x) / 2);
      const my = r.y + Math.round((y - r.y) / 2);
      const top = Math.max(r.h, this.topHeight(x, y, inside));
      if ((!inside && this.isBlocked(mx, my)) || this.topHeight(mx, my, inside) > top + 1) return `something tall at (${mx},${my}) is in the way`;
    }
    return null;
  }

  // ---------- mutation helpers ----------
  _newBlock() {
    this.blockCount++;
    const id = `block_${this.blockCount}`;
    this.items.set(id, { id, type: 'block', state: 'stacked', x: 0, y: 0 });
    return id;
  }
  _pushColumn(id, x, y, inside = false) {
    const k = colKey(x, y, inside);
    if (!this.columns.has(k)) this.columns.set(k, []);
    this.columns.get(k).push(id);
  }
  _stack(id, x, y, inside = false) {
    const it = this.items.get(id);
    Object.assign(it, { x, y, inside, state: 'stacked' });
    this._pushColumn(id, x, y, inside);
    this._liftRing();
  }
  _detach(id) {
    const it = this.items.get(id);
    const k = colKey(it.x, it.y, it.inside);
    const arr = this.columns.get(k);
    if (!arr) return;
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    if (!arr.length) this.columns.delete(k);
  }
  // The ring hovers at its altitude outdoors, or just under the ceiling indoors.
  _liftRing() {
    const ring = this.items.get('ring');
    if (!ring || ring.state !== 'hover') return;
    if (ring.inside) ring.alt = this.ceilingAt(ring.x, ring.y, true) - 0.4;
    else ring.alt = Math.max(CFG.ringAltitude, this.topHeight(ring.x, ring.y) + 1);
  }
  // Put an item down (or let it land) on a cell. Returns a short description of what happened.
  _settle(id, x, y, inside = false) {
    const it = this.items.get(id);
    const under = this.topItem(x, y, inside);
    const fits = (t) => t === 'part' || t === 'device';
    if (under && fits(it.type) && fits(this.items.get(under).type)) return this._fit(id, under);
    if (it.type === 'ring') {
      Object.assign(it, { x, y, inside, state: 'hover' });
      this._liftRing();
      return `ring floated up to hover ${fmtH(it.alt)} m above (${x},${y})${inside ? ', just under the ceiling' : ''}`;
    }
    if (inside) {
      this._stack(id, x, y, true);
      const on = this.column(x, y, true).length > 1 ? 'a stack' : `the floor of the ${buildingAt(x, y)}`;
      return `${id} landed on ${on} at (${x},${y}); top of that cell is now ${fmtH(this.topHeight(x, y, true))} m`;
    }
    if (this.openWater(x, y)) {
      this._stack(id, x, y);
      const raft = this.raftAt(x, y);
      const joined = raft ? `. It bumped up against ${raft.filter((c) => c.x !== x || c.y !== y).map((c) => this.topItem(c.x, c.y)).join(' and ')} and they now float together as ${this.raftName(raft)}` : '';
      return `${id} splashed into the water at (${x},${y}) and is floating there; its top is ${fmtH(this.topHeight(x, y))} m${joined}`;
    }
    this._stack(id, x, y);
    const on = this.onBoat(x, y) ? (this.column(x, y).length > 1 ? "a stack on the sailboat's deck" : "the sailboat's deck") : this.isWater(x, y) ? 'the crate floating there' : this.column(x, y).length > 1 ? 'a stack' : this.terrainAt(x, y) === 'tower' ? 'the tower top' : `the ${this.terrainAt(x, y)} (land, not water)`;
    return `${id} landed on ${on} at (${x},${y}); top of that cell is now ${fmtH(this.topHeight(x, y))} m`;
  }
  // Nearest cell to (x, y) that a thrown/spawned object can come to rest on. Indoors: within the same building,
  // with room under the ceiling.
  _restingCell(x, y, avoid = new Set(), landOnly = false, inside = false) {
    const building = inside ? buildingAt(x, y) : null;
    const ok = (cx, cy) => {
      if (!this.inGrid(cx, cy)) return false;
      if (inside ? buildingAt(cx, cy) !== building : this.isBlocked(cx, cy)) return false;
      if (inside && this.topHeight(cx, cy, true) + CFG.blockHeight > this.ceilingAt(cx, cy, true) + 1e-9) return false;
      if (landOnly && this.openWater(cx, cy)) return false;
      if (this.robots.some((r) => cx === r.x && cy === r.y && !!r.inside === inside)) return false;
      if (!inside && this.nativeAt(cx, cy)) return false;
      if (avoid.has(colKey(cx, cy, inside))) return false;
      const top = this.topItem(cx, cy, inside);
      return !(top && this.items.get(top).type === 'rock');
    };
    for (let rad = 0; rad <= (landOnly ? 90 : 4); rad++) {
      const ring = [];
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dy = -rad; dy <= rad; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          if (ok(x + dx, y + dy)) ring.push({ x: x + dx, y: y + dy, d: Math.hypot(dx, dy) });
        }
      }
      if (ring.length) return ring.sort((a, b) => a.d - b.d)[0];
    }
    return null;
  }
  _face(x, y) {
    const dx = x - this.robot.x;
    const dy = y - this.robot.y;
    if (dx || dy) this.robot.facing = { x: dx, y: dy };
    return { type: 'face', x: this.robot.facing.x, y: this.robot.facing.y };
  }

  // ---------- actions ----------
  // Every action returns { ok, text, events }.
  // `who` is the acting robot (index or id); the events it returns are tagged with that robot's id.
  exec(name, args = {}, who = 0) {
    this.robot = this.robotById(who) || this.robots[0];
    const fn = {
      walk_to: this.walkTo, jump_to: this.jumpTo, jump: this.jumpTo, pick_up: this.pickUp,
      put_down: this.putDown, place: this.putDown, drop: this.putDown, throw: this.throwItem,
      throw_item: this.throwItem, look: this.look, say: this.say, paddle: this.paddle, row: this.paddle, sail: this.sail,
      describe: () => ({ ok: true, text: this.describe(), events: [] }),
      wait: this.wait, rest: this.wait,
    }[name];
    if (!fn) return { ok: false, text: `Unknown action "${name}".`, events: [] };
    let res;
    if (POWERED.has(name) && this.robot.battery <= 0) {
      res = { ok: false, text: "Your battery is empty. Your motors won't move.", events: [] };
    } else if (POWERED.has(name) && this.robot.carriedBy) {
      res = { ok: false, text: `You are being carried in the ${this.robot.carriedBy} robot's arms; your feet don't touch anything.`, events: [{ type: 'shrug' }] };
    } else {
      try {
        res = fn.call(this, args || {});
      } catch (e) {
        res = { ok: false, text: `Action failed: ${e.message}`, events: [] };
      }
    }
    for (const ev of res.events) ev.robot ??= this.robot.id;
    this._syncCarried();
    const acting = this.robot;
    this.nativeLog = { moves: new Map(), jabs: [] };
    this.passTime(res.minutes ?? actionMinutes(name, res) * this.timeScale);
    this.robot = acting;
    // What the natives did meanwhile, for the renderer (played after the action itself).
    const log = this.nativeLog;
    this.nativeLog = null;
    if (log.moves.size || log.jabs.length) res.events.push({ type: 'natives', moves: [...log.moves].map(([id, path]) => ({ id, path })), jabs: log.jabs });
    return res;
  }

  // Let time pass: the sky moves on, batteries run down, and any robot next to the working charger in daylight
  // charges instead. Robots hear about it through notices (crossing low levels, charging starting and stopping).
  passTime(minutes) {
    const drain = 100 / (CFG.batteryHours * 60);
    const gain = 100 / (CFG.chargeHours * 60);
    let left = minutes;
    while (left > 1e-9) {
      const dt = Math.min(5, left);
      left -= dt;
      this.minutes += dt;
      const chargers = [...this.items.values()].filter((it) => this.chargerWorks(it));
      // A finished machine lighting up (or going dark) is noticed by robots outdoors who can see it.
      for (const dev of this.items.values()) {
        if (!this.deviceComplete(dev)) continue;
        const on = chargers.includes(dev);
        if (dev.working !== undefined && dev.working !== on && dev.state === 'stacked' && !dev.inside) {
          for (const r of this.robots) {
            if (!r.inside && Math.hypot(r.x - dev.x, r.y - dev.y) <= this.sight().small) this._notify(r, on ? `The small light on ${dev.id} turned green and it began to hum softly.` : `The light on ${dev.id} went dark and its hum stopped.`);
          }
        }
        dev.working = on;
      }
      for (const r of this.robots) {
        const before = r.battery;
        const by = !r.inside && chargers.find((c) => cheb(r, c) <= 1);
        if (by && r.battery < 100) {
          if (!r.charging) this._notify(r, `${by.id} hums, and you feel power flowing into your battery.`);
          r.charging = true;
          r.battery = Math.min(100, r.battery + gain * dt);
          if (r.battery > 100 - 1e-6) r.battery = 100;
          if (r.battery >= 100) { r.charging = false; this._notify(r, 'Your battery is full.'); }
        } else {
          if (r.charging) this._notify(r, r.battery >= 100 ? 'Your battery is full.' : 'The flow of power into your battery has stopped.');
          r.charging = false;
          if (!by) r.battery = Math.max(0, r.battery - drain * dt);
          if (r.battery < 1e-6) r.battery = 0;
        }
        this._batteryNotices(r, before);
      }
      this._nativesAct(dt);
    }
  }

  // Tell a robot when its battery crosses a low level (or runs out) between `before` and now.
  _batteryNotices(r, before) {
    for (const [level, text] of [[50, 'Your battery is half empty.'], [25, 'Your battery is getting low.'], [10, 'Your battery is almost empty. Your movements feel sluggish.']]) {
      if (before > level && r.battery <= level) this._notify(r, text);
    }
    if (before > 0 && r.battery <= 0) {
      this._notify(r, 'Your battery has run out. Your motors have stopped; you can still look, speak and wait.');
      if (r.carrying) this._letGo(r);
    }
  }

  // ---------- the natives ----------
  // Robots trespassing on a native island: standing on its land, or afloat right against its shore. A robot being
  // carried isn't (its carrier is), and one with no power left isn't worth the natives' trouble.
  _trespassers(isl) {
    return this.robots.filter((r) => {
      if (r.carriedBy || r.inside || r.battery <= 0) return false;
      if (islandAt(r.x, r.y) === isl) return true;
      if (!this.isWater(r.x, r.y)) return false;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (islandAt(r.x + dx, r.y + dy) === isl) return true;
      return false;
    });
  }
  // Can a native step onto this cell? Only its own island's open sand, nothing taller than a frond or a part on it,
  // and nobody standing there.
  _nativeCell(n, x, y) {
    if (islandAt(x, y) !== n.island || this.terrainAt(x, y) !== 'sand') return false;
    if (this.robots.some((r) => !r.carriedBy && !r.inside && r.x === x && r.y === y)) return false;
    if (this.natives.some((o) => o !== n && o.x === x && o.y === y)) return false;
    return this.topHeight(x, y) <= CFG.stepUp;
  }
  // The next cell on a native's shortest way to any cell `goal(x, y)` accepts (null if there is no way, or it is
  // already on one).
  _nativeNext(n, goal) {
    if (goal(n.x, n.y)) return null;
    const start = key(n.x, n.y);
    const first = new Map([[start, null]]);
    const queue = [{ x: n.x, y: n.y }];
    while (queue.length) {
      const c = queue.shift();
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const x = c.x + dx;
          const y = c.y + dy;
          const k = key(x, y);
          if (first.has(k) || !this._nativeCell(n, x, y)) continue;
          if (dx && dy && !(this._nativeCell(n, c.x + dx, c.y) || this._nativeCell(n, c.x, c.y + dy))) continue;
          const step = first.get(key(c.x, c.y)) || { x, y };
          if (goal(x, y)) return step;
          first.set(k, step);
          queue.push({ x, y });
        }
      }
    }
    return null;
  }
  _logNativeMove(n) {
    if (!this.nativeLog) return;
    const m = this.nativeLog.moves;
    if (!m.has(n.id)) m.set(n.id, [{ x: n.prevX, y: n.prevY, h: n.prevH }]);
    m.get(n.id).push({ x: n.x, y: n.y, h: n.h });
  }
  // The natives' share of `dt` game minutes: walk toward the nearest trespasser and jab it, or go back to their posts.
  _nativesAct(dt) {
    for (const n of this.natives) {
      n.cool = Math.max(0, n.cool - dt);
      n.budget = Math.min(n.budget + dt * CFG.nativeSpeed, 3);
      const near = this._trespassers(n.island).sort((a, b) => cheb(n, a) - cheb(n, b));
      const t = near[0] || null;
      if (t && n.target !== t.id) {
        // It has spotted a newcomer: the robot notices if it can make the native out, or hears it otherwise.
        const d = Math.hypot(n.x - t.x, n.y - t.y);
        const sight = this.sight().robot;
        this._notify(t, d <= sight
          ? `${n.id}, one of the frond-skirted figures, turned toward you, raised its stick and started toward you.`
          : `You heard a sharp, clicking hiss from somewhere to the ${compass(n.x - t.x, n.y - t.y)}.`);
      }
      n.target = t ? t.id : null;
      const inReach = (x, y) => t && cheb({ x, y }, t) <= 1 && Math.abs(t.h - n.h) <= CFG.nativeReach;
      const goal = t ? inReach : (x, y) => x === n.home.x && y === n.home.y;
      while (n.budget >= 1 && !goal(n.x, n.y)) {
        const step = this._nativeNext(n, t ? (x, y) => cheb({ x, y }, t) <= 1 : goal);
        if (!step) break;
        Object.assign(n, { prevX: n.x, prevY: n.y, prevH: n.h, facing: { x: Math.sign(step.x - n.x), y: Math.sign(step.y - n.y) } });
        n.x = step.x;
        n.y = step.y;
        n.h = this.topHeight(n.x, n.y);
        n.budget -= 1;
        this._logNativeMove(n);
      }
      if (t && inReach(n.x, n.y) && n.cool <= 0) {
        n.cool = CFG.nativeJabEvery;
        n.facing = { x: Math.sign(t.x - n.x), y: Math.sign(t.y - n.y) };
        const before = t.battery;
        t.battery = Math.max(0, t.battery - CFG.nativeJab);
        if (t.battery < 1e-6) t.battery = 0;
        this._notify(t, `${n.id} jabbed you with the glowing tip of its stick. A jolt shot through you, and you felt power being drawn out of your battery.`);
        this._batteryNotices(t, before);
        this.nativeLog?.jabs.push({ id: n.id, robot: t.id, x: n.x, y: n.y, tx: t.x, ty: t.y });
      }
    }
  }

  // Stand still and let time pass.
  wait(args) {
    const m = Math.round(Number(args.minutes ?? args.time ?? 30));
    const minutes = Math.min(CFG.waitMax, Math.max(1, Number.isFinite(m) ? m : 30));
    return { ok: true, text: `You waited for about ${minutes} minutes.`, events: [], minutes };
  }

  // Status line for a robot (index or id).
  statusOf(who) {
    this.robot = this.robotById(who) || this.robots[0];
    return this.status();
  }

  // What a robot has heard or felt since it was last told, as lines for its next tool result. Clears them.
  takeNotices(who) {
    const r = this.robotById(who);
    const list = this.notices.get(r.id) || [];
    this.notices.set(r.id, []);
    return list;
  }
  // What the Voice said to a robot since it was last told, as lines. Clears them.
  takeVoice(who) {
    const r = this.robotById(who);
    const list = this.voices.get(r.id) || [];
    this.voices.set(r.id, []);
    return list;
  }
  _notify(robot, text) {
    this.notices.get(robot.id).push(text);
  }

  _xy(args) {
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }

  walkTo(args) {
    const fail = (t) => ({ ok: false, text: t, events: [{ type: 'shrug' }] });
    const graph = this._walkGraph();
    let goals;
    let label;
    const target = args.target != null && String(args.target).trim() !== '' ? String(args.target).toLowerCase().trim().replace(/^the\s+/, '').replace(/[\s-]+/g, '_') : null;
    const xy = this._xy(args);
    if (target && !(xy && /^\(?-?\d/.test(target))) {
      goals = this._approachCells(target);
      if (!goals) return fail(`Unknown target "${args.target}". Use x/y coordinates, or the id of something you have seen with look.`);
      label = target;
      if (!goals.length) return fail(`You are holding ${target}.`);
    } else if (xy) {
      if (xy.x === this.robot.x && xy.y === this.robot.y) return { ok: true, text: `You are already at (${xy.x},${xy.y}).`, events: [] };
      if (!this.inGrid(xy.x, xy.y)) return fail(`(${xy.x},${xy.y}) is off the map.`);
      if (this.openWater(xy.x, xy.y)) return fail(`(${xy.x},${xy.y}) is water; the robot cannot swim.`);
      // A building's cells can mean its floor (inside) or, for the tower, its top: try whichever can be stood on.
      goals = [{ ...xy, inside: false }, ...(buildingAt(xy.x, xy.y) ? [{ ...xy, inside: true }] : [])].filter((g) => this.standable(g.x, g.y, g.inside));
      if (!goals.length) {
        if (buildingAt(xy.x, xy.y)) return fail(`There isn't room to stand at (${xy.x},${xy.y}) inside the ${buildingAt(xy.x, xy.y)} (${this.surfaceName(xy.x, xy.y, true)}, ceiling ${fmtH(this.ceilingAt(xy.x, xy.y, true))} m).`);
        return fail(`You cannot stand on (${xy.x},${xy.y}) (${this.surfaceName(xy.x, xy.y)}).`);
      }
      label = `(${xy.x},${xy.y})`;
    } else {
      return fail('walk_to needs x and y (integers), or a target name.');
    }
    let best = null;
    for (const g of goals) {
      const d = graph.dist.get(colKey(g.x, g.y, g.inside));
      if (d !== undefined && (!best || d < best.d)) best = { ...g, d };
    }
    if (!best) {
      if (goals.length === 1) {
        const g = goals[0];
        if (this._wallBetween(g.x, g.y, g.inside)) return fail(`Cannot walk to ${label}: there is no walkable way through the ${g.inside ? buildingAt(g.x, g.y) : buildingAt(this.robot.x, this.robot.y)}'s doorway from here.`);
        const rise = this.topHeight(g.x, g.y, g.inside) - this.robot.h;
        const hint = rise > CFG.stepUp ? ` It is ${fmtH(rise)} m above you; walking only climbs ${CFG.stepUp} m, so use jump_to from an adjacent cell.` : ' There is no walkable route; you may need to jump.';
        return fail(`Cannot walk to ${label}.${hint}`);
      }
      return fail(`Cannot walk next to ${label}: no walkable route. You may need to jump down or up first.`);
    }
    if (best.d === 0) return { ok: true, text: `You are already next to ${label} at (${best.x},${best.y}).`, events: [] };
    const path = this._pathTo(graph, colKey(best.x, best.y, best.inside));
    const last = path[path.length - 2];
    this.robot.x = best.x;
    this.robot.y = best.y;
    this.robot.inside = !!best.inside;
    this.robot.h = this.topHeight(best.x, best.y, best.inside);
    this.robot.facing = { x: best.x - last.x, y: best.y - last.y };
    const events = [{ type: 'walk', path }];
    const tgt = target && !/inside|interior|^in_|^into_|^enter_/.test(target) ? this._targetCell(target) : null;
    if (tgt) events.push(this._face(tgt.x, tgt.y));
    // Say which doorways the walk went through.
    const doors = [];
    for (let i = 1; i < path.length; i++) {
      if (path[i].inside === path[i - 1].inside) continue;
      doors.push(path[i].inside ? `in through the ${buildingAt(path[i].x, path[i].y)}'s doorway` : `out through the ${buildingAt(path[i - 1].x, path[i - 1].y)}'s doorway`);
    }
    const through = doors.length ? ` You went ${doors.join(', then ')}${this.robot.inside ? `, and are now inside the ${buildingAt(best.x, best.y)}` : ''}.` : '';
    const into = target && /inside|interior|^in_|^into_|^enter_/.test(target);
    return { ok: true, text: `Walked to (${best.x},${best.y})${target && !into ? `, next to ${label}` : ''}. ${path.length - 1} steps.${through}`, events };
  }

  _targetCell(target) {
    const bot = this._robotTarget(target);
    if (bot) return bot;
    const id = this.resolveItem(target);
    if (id) return this.items.get(id);
    if (target === 'hut') return { x: 7, y: 4 };
    if (/^(?:sail_?)?boat$|^ship$|^yacht$|^deck$/.test(target)) return this.boat.cells[1];
    if (target === 'tower') return { x: (LAYOUT.tower.x0 + LAYOUT.tower.x1) / 2, y: (LAYOUT.tower.y0 + LAYOUT.tower.y1) / 2 };
    return null;
  }

  jumpTo(args) {
    const xy = this._xy(args);
    if (!xy) return { ok: false, text: 'jump_to needs x and y (integers).', events: [{ type: 'shrug' }] };
    const p = this._jumpProblem(xy.x, xy.y);
    if (p) return { ok: false, text: `Cannot jump there: ${p}.`, events: [{ type: 'shrug' }] };
    const inside = !!this.robot.inside;
    const from = { x: this.robot.x, y: this.robot.y, h: this.robot.h };
    const face = this._face(xy.x, xy.y);
    this.robot.x = xy.x;
    this.robot.y = xy.y;
    this.robot.h = this.topHeight(xy.x, xy.y, inside);
    const to = { x: xy.x, y: xy.y, h: this.robot.h };
    const ceiling = inside ? this.ceilingAt(xy.x, xy.y, true) : Infinity;
    return { ok: true, text: `Jumped to (${xy.x},${xy.y}). You now stand on ${this.surfaceName(xy.x, xy.y, inside)} at height ${fmtH(this.robot.h)} m.`, events: [face, { type: 'jump', from, to, ceiling }] };
  }

  pickUp(args) {
    const raw = args.item ?? args.target ?? args.name ?? args.id ?? args.object;
    const norm = String(raw ?? '').toLowerCase().trim().replace(/^the\s+/, '').replace(/[\s-]+/g, '_');
    const bot = this._robotTarget(norm) || this.others().find((o) => o.id === norm);
    if (bot) return this._liftRobot(bot);
    const nat = this.nativeById(norm.replace(/^native_?#?(\d+)$/, 'native_$1'));
    if (nat) {
      if (cheb(this.robot, nat) > 1) return { ok: false, text: `Cannot pick up ${nat.id}: it is at (${nat.x},${nat.y}), ${cheb(this.robot, nat)} cells away.`, events: [{ type: 'shrug' }] };
      return { ok: false, text: `${nat.id} twisted out of your hands and stepped back.`, events: [this._face(nat.x, nat.y), { type: 'shrug' }] };
    }
    const id = this.resolveItem(raw);
    if (!id && /palm|tree|frond|leaf|branch/i.test(String(raw ?? ''))) return this._tearFrond();
    if (!id) return { ok: false, text: `You don't know of anything called "${raw}". Use an id you have seen with look.`, events: [{ type: 'shrug' }] };
    const p = this.pickupProblem(id);
    if (p) return { ok: false, text: `Cannot pick up ${id}: ${p}.`, events: [{ type: 'shrug' }] };
    const it = this.items.get(id);
    const face = this._face(it.x, it.y);
    this._detach(id);
    const wasCell = { x: it.x, y: it.y };
    it.state = 'held';
    this.robot.holding = id;
    const ring = this.items.get('ring');
    if (ring && wasCell.x === ring.x && wasCell.y === ring.y) this._liftRing();
    return { ok: true, text: `Picked up ${id}. You are holding it over your head.`, events: [face, { type: 'pickup', item: id }] };
  }

  // pick_up on a palm tree: a robot can't lift the tree, but it can tear off one of its big fronds.
  _tearFrond() {
    const r = this.robot;
    const fail = (t) => ({ ok: false, text: t, events: [{ type: 'shrug' }] });
    const palm = r.inside ? null : LAYOUT.palms.find((p) => cheb(r, p) <= 1);
    if (!palm) return fail('There is no palm tree next to you (stand on a cell beside one).');
    if (r.holding || r.carrying) return fail(`Cannot pick up from the palm tree: your hands are full (${r.carrying ? `carrying the ${r.carrying} robot` : `holding ${r.holding}`}); put_down ${r.carrying ? 'it' : 'or throw it'} first.`);
    const k = key(palm.x, palm.y);
    const taken = this.frondsTaken.get(k) || 0;
    if (taken >= CFG.frondsPerPalm) return fail(`You can't lift a palm tree, and the fronds left on the one at (${palm.x},${palm.y}) are too high to reach.`);
    this.frondsTaken.set(k, taken + 1);
    const id = `frond_${++this.frondCount}`;
    this.items.set(id, { id, type: 'frond', state: 'held', x: palm.x, y: palm.y, inside: false });
    r.holding = id;
    const face = this._face(palm.x, palm.y);
    return { ok: true, text: `You can't lift a palm tree, but you tore one of its big fronds off: ${id}. It is about 2 m long, a stiff stalk ending in a wide leaf. You are holding it over your head.`, events: [face, { type: 'tear', item: id, palm: { x: palm.x, y: palm.y }, n: taken }] };
  }

  // pick_up on another robot: only one whose battery is flat can be lifted; it is carried in the arms.
  _liftRobot(o) {
    const r = this.robot;
    const fail = (t) => ({ ok: false, text: `Cannot pick up the ${o.id} robot: ${t}.`, events: [{ type: 'shrug' }] });
    if (r.carrying === o.id) return fail('you are already carrying it');
    if (r.holding || r.carrying) return fail(`your hands are full (${r.carrying ? `carrying the ${r.carrying} robot` : `holding ${r.holding}`}); put_down ${r.carrying ? 'it' : 'or throw it'} first`);
    if (o.carriedBy) return fail(`it is in the ${o.carriedBy} robot's arms`);
    if (this._wallBetween(o.x, o.y, o.inside)) {
      return fail(o.inside ? `it is inside the ${buildingAt(o.x, o.y)}; go in through its doorway first` : `it is outside and you are inside the ${buildingAt(r.x, r.y)}; go out through the doorway first`);
    }
    const d = cheb(r, o);
    if (d > 1) return fail(`it is at (${o.x},${o.y}), ${d} cells away; you must be on an adjacent cell (walk_to it first)`);
    const c = o.h + CFG.robotHeight / 2;
    if (c > r.h + CFG.reachUp) return fail(`it is too high (its middle is ${fmtH(c)} m up; you can reach up to ${fmtH(r.h + CFG.reachUp)} m from your feet at ${fmtH(r.h)} m)`);
    if (c < r.h - CFG.reachDown) return fail(`it is too far below you (its middle is ${fmtH(c)} m; you reach down to ${fmtH(r.h - CFG.reachDown)} m)`);
    if (o.battery > 0) return fail('its motors are running and it stays planted on its feet');
    const from = { x: o.x, y: o.y, h: o.h };
    const face = this._face(o.x, o.y);
    r.carrying = o.id;
    o.carriedBy = r.id;
    this._notify(o, `The ${r.id} robot lifted you off your feet. You are being carried in its arms.`);
    return { ok: true, text: `You lifted the ${o.id} robot off its feet: it hangs limp and heavy in your arms. You are carrying it.`, events: [face, { type: 'carry', target: o.id, from }] };
  }

  // put_down while carrying a robot: stand it on its feet on a cell next to you.
  _setRobotDown(args) {
    const r = this.robot;
    const o = this.robotById(r.carrying);
    const fail = (t) => ({ ok: false, text: t, events: [{ type: 'shrug' }] });
    const xy = this._putCell(args);
    if (!xy) return fail(`put_down needs x and y (integers), or a direction, of a cell next to you to set the ${o.id} robot down on.`);
    const d = cheb(r, xy);
    if (d === 0) return fail(`You are standing on (${xy.x},${xy.y}). Choose an adjacent cell to set the ${o.id} robot down on.`);
    if (d > 1) return fail(`(${xy.x},${xy.y}) is ${d} cells away; put_down only reaches adjacent cells.`);
    if (!this.inGrid(xy.x, xy.y)) return fail('That is off the map.');
    const inside = !!r.inside;
    if (inside && buildingAt(xy.x, xy.y) !== buildingAt(r.x, r.y)) return fail(`(${xy.x},${xy.y}) is outside; the ${buildingAt(r.x, r.y)}'s wall is in the way.`);
    if (!inside && this.openWater(xy.x, xy.y)) return fail(`(${xy.x},${xy.y}) is open water: the ${o.id} robot would sink. You keep hold of it.`);
    const there = this.robotAt(xy.x, xy.y, inside);
    if (there) return fail(`The ${there.id} robot is standing on (${xy.x},${xy.y}).`);
    // Can the carried robot stand there? (Ask as that robot, so it isn't in its own way.)
    const acting = this.robot;
    this.robot = o;
    const can = this.standable(xy.x, xy.y, inside);
    this.robot = acting;
    const th = this.topHeight(xy.x, xy.y, inside);
    if (!can) {
      if (inside && th + CFG.robotHeight > this.ceilingAt(xy.x, xy.y, true)) return fail(`There isn't room under the ceiling for the ${o.id} robot to stand on (${xy.x},${xy.y}).`);
      return fail(`The ${o.id} robot can't be stood on (${xy.x},${xy.y}) (${!inside && this.terrainAt(xy.x, xy.y) === 'hut' ? "the hut's roof" : this.surfaceName(xy.x, xy.y, inside)}).`);
    }
    if (th > r.h + CFG.placeUp) return fail(`That surface is ${fmtH(th)} m high; you can only set things on surfaces up to ${fmtH(r.h + CFG.placeUp)} m.`);
    if (th < r.h - CFG.reachDown) return fail(`(${xy.x},${xy.y}) is ${fmtH(r.h - th)} m below your feet; you can't reach down that far with the ${o.id} robot in your arms.`);
    const face = this._face(xy.x, xy.y);
    r.carrying = null;
    o.carriedBy = null;
    Object.assign(o, { x: xy.x, y: xy.y, inside, h: th, facing: { ...r.facing } });
    const on = this.surfaceName(xy.x, xy.y, inside);
    this._notify(o, `The ${r.id} robot set you down on your feet at (${xy.x},${xy.y}), on ${on}.`);
    return { ok: true, text: `You set the ${o.id} robot down on its feet at (${xy.x},${xy.y}), on ${on}.`, events: [face, { type: 'uncarry', target: o.id }] };
  }

  // A carrier whose battery runs out lets go: the robot in its arms slides down onto a cell beside it (if there is one).
  _letGo(r) {
    const o = this.robotById(r.carrying);
    const acting = this.robot;
    this.robot = o;
    let best = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const x = r.x + dx;
        const y = r.y + dy;
        if ((!dx && !dy) || (r.inside && buildingAt(x, y) !== buildingAt(r.x, r.y))) continue;
        if (!this.standable(x, y, r.inside)) continue;
        const dh = Math.abs(this.topHeight(x, y, r.inside) - r.h);
        if (dh <= CFG.stepDown && (!best || dh < best.dh)) best = { x, y, dh };
      }
    }
    this.robot = acting;
    if (!best) return; // nowhere to slide down to: it stays in the limp arms
    r.carrying = null;
    o.carriedBy = null;
    Object.assign(o, { x: best.x, y: best.y, h: this.topHeight(best.x, best.y, r.inside), inside: r.inside });
    this._notify(r, `Your arms went limp and the ${o.id} robot slid out of them, down onto (${o.x},${o.y}).`);
    this._notify(o, `The ${r.id} robot's arms went limp and you slid out of them, down onto (${o.x},${o.y}).`);
  }

  // The cell put_down means: x/y, or a compass direction ("east") for the cell next to the robot that way.
  _putCell(args) {
    const r = this.robot;
    const step = DIR_STEPS[dirName(args.direction ?? args.dir)];
    if (step && (args.x == null || args.y == null)) return { x: r.x + step[0], y: r.y + step[1] };
    return this._xy(args);
  }

  putDown(args) {
    const r = this.robot;
    if (r.carrying) return this._setRobotDown(args);
    const id = r.holding;
    if (!id) return { ok: false, text: 'You are not holding anything.', events: [{ type: 'shrug' }] };
    const xy = this._putCell(args);
    if (!xy) return { ok: false, text: `put_down needs x and y (integers) of a cell next to you, or a direction (${Object.keys(DIR_STEPS).join(', ')}).`, events: [{ type: 'shrug' }] };
    const d = cheb(r, xy);
    if (d === 0) return { ok: false, text: `(${xy.x},${xy.y}) is the cell you are standing on; you cannot put something there. Choose a cell next to you.`, events: [{ type: 'shrug' }] };
    if (d > 1) return { ok: false, text: `(${xy.x},${xy.y}) is ${d} cells away from you at (${r.x},${r.y}); put_down only reaches the cells next to you (use throw for farther).`, events: [{ type: 'shrug' }] };
    const inside = !!r.inside;
    if (inside && buildingAt(xy.x, xy.y) !== buildingAt(r.x, r.y)) return { ok: false, text: `(${xy.x},${xy.y}) is outside; the ${buildingAt(r.x, r.y)}'s wall is in the way.`, events: [{ type: 'shrug' }] };
    if (!inside && this.isBlocked(xy.x, xy.y)) return { ok: false, text: `(${xy.x},${xy.y}) is ${{ hut: "the hut's wall (to put something inside, go in through the doorway)", volcano: 'the steep side of the volcano' }[this.terrainAt(xy.x, xy.y)] || 'a palm tree'}; nothing can be put there.`, events: [{ type: 'shrug' }] };
    const o = this.robotAt(xy.x, xy.y, inside);
    if (o) return { ok: false, text: `The ${o.id} robot is standing on (${xy.x},${xy.y}); you can't put anything there.`, events: [{ type: 'shrug' }] };
    const it = this.items.get(id);
    if (it.type !== 'ring' && (inside || !this.openWater(xy.x, xy.y))) {
      const top = this.topItem(xy.x, xy.y, inside);
      if (top === 'rock') return { ok: false, text: 'Nothing can be stacked on top of the rock.', events: [{ type: 'shrug' }] };
      const th = this.topHeight(xy.x, xy.y, inside);
      if (th > r.h + CFG.placeUp) return { ok: false, text: `That stack top is ${fmtH(th)} m high; you can only set things on surfaces up to ${fmtH(r.h + CFG.placeUp)} m.`, events: [{ type: 'shrug' }] };
      if (inside && th + this.itemHeight(id) > this.ceilingAt(xy.x, xy.y, true) + 1e-9) return { ok: false, text: `There isn't room for ${id} under the ceiling (${fmtH(this.ceilingAt(xy.x, xy.y, true))} m) on top of that stack.`, events: [{ type: 'shrug' }] };
    }
    const face = this._face(xy.x, xy.y);
    r.holding = null;
    if (!inside && this.returnsToLand(id) && this.openWater(xy.x, xy.y)) {
      const land = this._restingCell(xy.x, xy.y, new Set(), true);
      const what = this._settle(id, land.x, land.y);
      const how = it.type === 'rock' ? 'the rock plopped into the water, then rolled back up out of it' : `${id} floated on the water and drifted ashore`;
      return { ok: true, text: `Put down: ${how}. ${what}.`, events: [face, { type: 'throw', item: id, aim: xy, to: land }] };
    }
    const what = this._settle(id, xy.x, xy.y, inside);
    return { ok: true, text: `Put down ${this._rel(xy.x, xy.y)}: ${what}.\n${this._heightGrid(2)}`, events: [face, { type: 'place', item: id }] };
  }

  throwItem(args) {
    const r = this.robot;
    const id = r.holding;
    if (r.carrying) return { ok: false, text: `The ${r.carrying} robot is far too heavy to throw.`, events: [{ type: 'shrug' }] };
    if (!id) return { ok: false, text: 'You are not holding anything to throw.', events: [{ type: 'shrug' }] };
    const xy = this._xy(args);
    if (!xy) return { ok: false, text: 'throw needs target x and y (integers).', events: [{ type: 'shrug' }] };
    const dist = Math.hypot(xy.x - r.x, xy.y - r.y);
    if (dist < CFG.throwMin) return { ok: false, text: 'Throw at a cell at least 1 cell away.', events: [{ type: 'shrug' }] };
    if (dist > CFG.throwRange + 1e-9) return { ok: false, text: `(${xy.x},${xy.y}) is ${r2(dist)} cells away; you can throw at most ${CFG.throwRange}.`, events: [{ type: 'shrug' }] };
    if (!this.inGrid(xy.x, xy.y)) return { ok: false, text: 'That target is off the map.', events: [{ type: 'shrug' }] };
    const inside = !!r.inside;
    if (inside && buildingAt(xy.x, xy.y) !== buildingAt(r.x, r.y)) return { ok: false, text: `You are inside the ${buildingAt(r.x, r.y)}; its walls are in the way. Indoors you can only throw to cells inside.`, events: [{ type: 'shrug' }] };
    const it = this.items.get(id);
    const face = this._face(xy.x, xy.y);
    const from = { x: r.x, y: r.y, h: r.h + 2.1 };
    r.holding = null;
    let land = xy;
    let bounced = '';
    if (it.type !== 'ring') {
      const skips = !inside && this.returnsToLand(id) && this.openWater(xy.x, xy.y);
      land = this._restingCell(xy.x, xy.y, new Set(), skips, inside) || xy;
      if (skips) bounced = it.type === 'rock' ? ' It hit the water, skipped across it and rolled up onto land:' : ' It landed on the water and drifted ashore:';
      else if (land.x !== xy.x || land.y !== xy.y) bounced = ` It bounced off ${this.isBlocked(xy.x, xy.y) ? `the ${this.terrainAt(xy.x, xy.y)}` : 'something'} and`;
    }
    const events = [face, { type: 'throw', item: id, from, aim: xy, to: { x: land.x, y: land.y } }];
    const what = this._settle(id, land.x, land.y, inside);
    events.push({ type: 'landed', item: id, water: !inside && this.isWater(land.x, land.y) && !this.onBoat(land.x, land.y) });
    let text = `Threw ${id} toward (${xy.x},${xy.y}).${bounced} ${what}.`;
    if (it.type === 'rock') {
      this.rockThrows++;
      const spawned = [];
      const used = new Set([colKey(land.x, land.y, inside)]);
      const room = CFG.maxBlocks - this.blockCount;
      const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
      for (let i = 0; i < Math.min(CFG.rockSpawn, room); i++) {
        const [dx, dy] = dirs[i % 4];
        const cell = this._restingCell(land.x + dx, land.y + dy, used, false, inside);
        if (!cell) continue;
        used.add(colKey(cell.x, cell.y, inside));
        const bid = this._newBlock();
        this._detach(bid);
        const res = this._settle(bid, cell.x, cell.y, inside);
        spawned.push({ id: bid, x: cell.x, y: cell.y, res });
      }
      if (spawned.length) {
        events.push({ type: 'spawn', items: spawned.map((s) => s.id), at: { x: land.x, y: land.y } });
        text += ` As the rock landed, ${spawned.length} wooden crates appeared out of thin air: ${spawned.map((s) => `${s.id} at (${s.x},${s.y})${!inside && this.isWater(s.x, s.y) ? (this.onBoat(s.x, s.y) ? " on the sailboat's deck" : ' floating in the water') : ''} top ${fmtH(this.topHeight(s.x, s.y, inside))} m`).join('; ')}.`;
      } else if (room <= 0) {
        text += ' (Block limit reached, so no new blocks appeared.)';
      }
    }
    return { ok: true, text, events };
  }

  // Speaking: any other robot close enough hears it (walls cut the range), and is told on its next action.
  // Could robot b hear robot a speak? Returns the distance, or null if out of earshot.
  _earshot(a, b) {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const walls = !!b.inside !== !!a.inside || (b.inside && buildingAt(b.x, b.y) !== buildingAt(a.x, a.y));
    return d <= (walls ? 5 : CFG.hearRange) ? d : null;
  }
  // Robots working together: some two are within earshot, or one was heard speaking in the last game hour.
  // (Used to decide when they take turns; never shown to the robots.)
  together() {
    const rs = this.robots;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (this._earshot(rs[i], rs[j]) != null) return true;
    return this.talk.some((t) => t.who !== 'voice' && t.heardBy.length && this.minutes - (t.minutes ?? -Infinity) <= 60);
  }

  // The Voice: you (the person at the screen) speaking to the robots. It is heard by the robots named in `to`
  // (ids, or 'all'), wherever they are, through walls and at any distance; it isn't a robot and has no place
  // on the map. It is kept apart from other notices (takeVoice) so the robot gets it as a message of its own before
  // its next decision, not buried at the end of a tool result (models skimmed past it there). Returns the talk entry.
  voice(text, to = 'all') {
    text = String(text ?? '').trim().slice(0, CFG.voiceMax);
    if (!text) return null;
    const ids = to === 'all' ? this.robots.map((r) => r.id) : [].concat(to).filter((id) => this.robotById(id)?.id === id);
    if (!ids.length) return null;
    for (const id of ids) this.voices.get(id).push(`The Voice speaks to you: "${text}"`);
    const entry = { who: 'voice', text, heardBy: ids, minutes: this.minutes };
    this.talk.push(entry);
    return entry;
  }

  say(args) {
    const full = String(args.text ?? args.message ?? '').trim();
    let text = full;
    if (full.length > CFG.sayMax) {
      const cut = full.slice(0, CFG.sayMax);
      text = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), CFG.sayMax * 0.8)).trimEnd()}…`;
    }
    const r = this.robot;
    const heardBy = [];
    for (const o of this.others()) {
      const d = this._earshot(r, o);
      const walls = !!o.inside !== !!r.inside || (o.inside && buildingAt(o.x, o.y) !== buildingAt(r.x, r.y));
      if (!text || d == null) continue;
      heardBy.push(o.id);
      const from = d < 0.5 ? 'right beside you' : `${Math.round(d)} cell${Math.round(d) === 1 ? '' : 's'} to the ${compass(r.x - o.x, r.y - o.y)}`;
      this._notify(o, this._canSee(o, r)
        ? `You heard the ${r.id} robot (at (${r.x},${r.y}), ${from}) say: "${text}"`
        : `You heard a voice from somewhere about ${from}${walls ? ', muffled by a wall,' : ''} say: "${text}"`);
    }
    if (text) this.talk.push({ who: r.id, text, heardBy, minutes: this.minutes });
    const said = text === full ? 'Said it.' : `You ran out of breath: only the first ${text.length - 1} characters got said, up to "…${text.slice(-41, -1)}".`;
    return { ok: true, text: said, events: [{ type: 'say', text }] };
  }

  sky() {
    return skyAt(this.minutes);
  }
  // How far small things and other robots can be made out outdoors: less at twilight, much less at night.
  // Indoors (lantern, torch) it's always light enough.
  sight(inside = false) {
    const l = inside ? 1 : this.sky().light;
    return l > 0.6 ? { small: CFG.sightRange, robot: CFG.robotSight, far: true } : l > 0.2 ? { small: 5, robot: 10, far: true } : { small: 3, robot: 5, far: false };
  }

  // Can robot a see robot b clearly? Only within sight, on the same side of any walls.
  _canSee(a, b) {
    if (!!a.inside !== !!b.inside || (a.inside && buildingAt(a.x, a.y) !== buildingAt(b.x, b.y))) return false;
    return Math.hypot(a.x - b.x, a.y - b.y) <= this.sight(a.inside).robot;
  }

  // The raft (cells joined side by side, at least CFG.raftMin of them) that (x, y) is part of, or null.
  raftAt(x, y) {
    const cells = this.raftCells(x, y);
    return cells.length >= CFG.raftMin ? cells : null;
  }
  // "a raft of 3 crates": how a raft is named wherever the robots meet one.
  raftName(cells) {
    return `a raft of ${cells.length} crates`;
  }

  // The floating crate columns joined side by side (not diagonally) to the one at (x, y): one raft.
  raftCells(x, y) {
    if (!this.isRaft(x, y)) return [];
    const seen = new Set([key(x, y)]);
    const out = [{ x, y }];
    for (let i = 0; i < out.length; i++) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = { x: out[i].x + dx, y: out[i].y + dy };
        if (seen.has(key(n.x, n.y)) || !this.isRaft(n.x, n.y)) continue;
        seen.add(key(n.x, n.y));
        out.push(n);
      }
    }
    return out;
  }

  // Paddle the raft you stand on: each stroke moves it (with everything and everyone on it) one cell.
  paddle(args) {
    const r = this.robot;
    const fail = (t) => ({ ok: false, text: t, events: [{ type: 'shrug' }] });
    const DIRS = { north: [0, 1], 'north-east': [1, 1], east: [1, 0], 'south-east': [1, -1], south: [0, -1], 'south-west': [-1, -1], west: [-1, 0], 'north-west': [-1, 1] };
    const SHORT = { n: 'north', ne: 'north-east', e: 'east', se: 'south-east', s: 'south', sw: 'south-west', w: 'west', nw: 'north-west', up: 'north', down: 'south' };
    let dirName = String(args.direction ?? args.dir ?? args.heading ?? '').toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/^(north|south)(east|west)$/, '$1-$2');
    dirName = SHORT[dirName] || dirName;
    const xy = this._xy(args);
    if (!DIRS[dirName] && xy && (xy.x !== r.x || xy.y !== r.y)) dirName = compass(xy.x - r.x, xy.y - r.y);
    if (!DIRS[dirName]) return fail(`paddle needs a direction: one of ${Object.keys(DIRS).join(', ')}.`);
    const [dx, dy] = DIRS[dirName];
    if (r.carrying) return fail(`Your arms are full with the ${r.carrying} robot: you can't make a single stroke.`);
    const strokes = Math.max(1, Math.min(CFG.paddleMax, Math.round(Number(args.strokes ?? args.distance ?? args.cells ?? args.steps) || CFG.paddleMax)));
    // Failures describe only what happened, never what would work: the robots have to work that out.
    const what = r.holding ? `with ${r.holding}` : 'with your bare hands';
    if (!r.inside && this.onBoat(r.x, r.y) && r.holding && this.items.get(r.holding).type === 'frond') return fail(`You paddle hard with ${r.holding}, but the sailboat is too heavy: it barely stirs.`);
    if (r.inside || !this.isRaft(r.x, r.y)) return fail(`You make paddling strokes ${what}, but nothing happens.`);
    if (!r.holding) return fail('You paddle with your bare hands. The water swirls, but nothing moves.');
    if (this.items.get(r.holding).type !== 'frond') return fail(`You paddle with ${r.holding}. It just churns the water; nothing moves.`);
    const cells = this.raftCells(r.x, r.y);
    if (cells.length < CFG.raftMin) return fail(`You paddle hard with ${r.holding}, but the crate you are on just spins in place.`);
    const mine = new Set(cells.map((c) => key(c.x, c.y)));
    // What stops the raft moving one more cell, or null.
    const blocker = () => {
      for (const c of cells) {
        const nx = c.x + dx;
        const ny = c.y + dy;
        if (mine.has(key(nx, ny))) continue;
        if (!this.inGrid(nx, ny)) return 'a strong current out there that pushes it back';
        if (!this.isWater(nx, ny)) return `${this.terrainAt(nx, ny) === 'sand' ? 'the beach' : `the ${this.terrainAt(nx, ny)}`} at (${nx},${ny})`;
        if (this.onBoat(nx, ny)) return `the sailboat at (${nx},${ny})`;
        if (this.isRaft(nx, ny)) return `another floating crate at (${nx},${ny})`;
      }
      return null;
    };
    const riders = this.robots.filter((o) => !o.inside && !o.carriedBy && mine.has(key(o.x, o.y)));
    const items = cells.flatMap((c) => this.column(c.x, c.y));
    const ring = this.items.get('ring');
    let moved = 0;
    let stop = null;
    while (moved < strokes && !(stop = blocker())) {
      const cols = cells.map((c) => this.column(c.x, c.y));
      for (const c of cells) this.columns.delete(key(c.x, c.y));
      cells.forEach((c, i) => {
        c.x += dx;
        c.y += dy;
        this.columns.set(key(c.x, c.y), cols[i]);
        for (const id of cols[i]) Object.assign(this.items.get(id), { x: c.x, y: c.y });
      });
      mine.clear();
      for (const c of cells) mine.add(key(c.x, c.y));
      for (const o of riders) { o.x += dx; o.y += dy; }
      moved++;
    }
    if (!moved) return fail(`The raft can't move ${dirName}: it is up against ${stop}.`);
    if (ring?.state === 'hover' && !ring.inside) this._liftRing();
    const face = this._face(r.x + dx, r.y + dy);
    const others = riders.filter((o) => o !== r);
    for (const o of others) this._notify(o, `The crates under you suddenly moved ${moved} cell${moved > 1 ? 's' : ''} ${dirName}, carrying you along, while the ${r.id} robot made paddling strokes. You are now at (${o.x},${o.y}).`);
    const crates = items.filter((id) => this.items.get(id).type === 'block').length;
    let text = `You paddled ${dirName} with ${r.holding}: the raft (${crates} crates, ${cells.length} cells of water) moved ${moved} cell${moved > 1 ? 's' : ''}`;
    text += stop && moved < strokes ? `, then bumped into ${stop}.` : '.';
    if (others.length) text += ` The ${others.map((o) => o.id).join(' and ')} robot rode along with you.`;
    return { ok: true, text, events: [face, { type: 'raft', items, riders: riders.map((o) => o.id), dx, dy, steps: moved }] };
  }

  // Sail the boat you stand on: toward a direction (up to `distance` cells) or a point. First the hull swings round to
  // point that way if there is room, then it runs straight on, one cell at a time, until it has gone the distance or
  // something is in the way (it then comes gently to rest against it). Everything on deck and everyone aboard comes along.
  sail(args) {
    const r = this.robot;
    const fail = (t) => ({ ok: false, text: t, events: [{ type: 'shrug' }] });
    const DIRS = { north: [0, 1], 'north-east': [1, 1], east: [1, 0], 'south-east': [1, -1], south: [0, -1], 'south-west': [-1, -1], west: [-1, 0], 'north-west': [-1, 1] };
    const SHORT = { n: 'north', ne: 'north-east', e: 'east', se: 'south-east', s: 'south', sw: 'south-west', w: 'west', nw: 'north-west', up: 'north', down: 'south' };
    if (r.inside || !this.onBoat(r.x, r.y)) return fail(`There is nothing here to sail: you are standing on ${this.surfaceName(r.x, r.y, r.inside)}.`);
    let dirName = String(args.direction ?? args.dir ?? args.heading ?? '').toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/^(north|south)(east|west)$/, '$1-$2');
    dirName = SHORT[dirName] || dirName;
    const xy = this._xy(args);
    const limit = Math.max(1, Math.min(CFG.sailMax, Math.round(Number(args.distance ?? args.cells ?? args.steps) || CFG.sailMax)));
    // The unit steps to take: a straight run in one direction, or a line toward the point.
    let steps;
    let goal = null;
    if (DIRS[dirName]) {
      steps = Array(limit).fill(DIRS[dirName]);
    } else if (xy && (xy.x !== r.x || xy.y !== r.y)) {
      goal = xy;
      const dx = xy.x - r.x;
      const dy = xy.y - r.y;
      const n = Math.max(Math.abs(dx), Math.abs(dy));
      steps = [];
      let px = 0;
      let py = 0;
      for (let i = 1; i <= Math.min(n, limit); i++) {
        const nx = Math.round((dx * i) / n);
        const ny = Math.round((dy * i) / n);
        steps.push([nx - px, ny - py]);
        px = nx;
        py = ny;
      }
      dirName = compass(dx, dy);
    } else {
      return fail(`sail needs a direction (one of ${Object.keys(DIRS).join(', ')}), or x and y of a point to head for.`);
    }
    const boat = this.boat;
    const before = boat.cells.map((c) => ({ ...c }));
    // Everything aboard, cell by cell (stern to bow): its crate/cargo column and the robots standing there.
    const load = () => boat.cells.map((c) => ({ col: this.columns.get(key(c.x, c.y)) || null, riders: this.robots.filter((o) => !o.inside && !o.carriedBy && o.x === c.x && o.y === c.y) }));
    const place = (cells, loads) => {
      for (const c of boat.cells) this.columns.delete(key(c.x, c.y));
      boat.cells = cells;
      cells.forEach((c, i) => {
        const { col, riders } = loads[i];
        if (col) {
          this.columns.set(key(c.x, c.y), col);
          for (const id of col) Object.assign(this.items.get(id), { x: c.x, y: c.y });
        }
        for (const o of riders) { o.x = c.x; o.y = c.y; o.h = this.topHeight(c.x, c.y); }
      });
    };
    const riders = load().flatMap((l) => l.riders);
    const cargo = load().flatMap((l) => l.col || []);
    // Can a deck cell move onto (x, y)? Its own cells are fine; otherwise only open water, on the map.
    const free = (x, y) => this.onBoat(x, y) || (this.inGrid(x, y) && this.openWater(x, y));
    const blockerAt = (x, y) => {
      if (!this.inGrid(x, y)) return 'a strong current';
      if (!this.isWater(x, y)) return `${this.terrainAt(x, y) === 'sand' ? 'the beach' : `the ${this.terrainAt(x, y)}`} at (${x},${y})`;
      return `${this.topItem(x, y)}, floating at (${x},${y})`;
    };
    // Swing round to point along the main axis of travel.
    const tx = steps.reduce((a, s) => a + s[0], 0);
    const ty = steps.reduce((a, s) => a + s[1], 0);
    const v = Math.abs(tx) > Math.abs(ty) || (Math.abs(tx) === Math.abs(ty) && boat.dir.x) ? { x: Math.sign(tx), y: 0 } : { x: 0, y: Math.sign(ty) };
    let turned = null;
    if (v.x === -boat.dir.x && v.y === -boat.dir.y) {
      // Straight back the way it points: it spins round on the spot, so bow and stern (and what's on them) swap ends.
      place([...boat.cells].reverse(), load());
      turned = { from: { ...boat.dir }, to: v };
      boat.dir = v;
    } else if (v.x !== boat.dir.x || v.y !== boat.dir.y) {
      const L = boat.cells.length;
      const options = [];
      // Pivot on a deck cell (middle ones first), with the new hull reaching out from it either way.
      const order = [...boat.cells.keys()].sort((a, b) => Math.abs(a - (L - 1) / 2) - Math.abs(b - (L - 1) / 2));
      for (const p of order) {
        for (const a of order) options.push(Array.from({ length: L }, (_, i) => ({ x: boat.cells[p].x + v.x * (i - a), y: boat.cells[p].y + v.y * (i - a) })));
      }
      const fits = options.find((cells) => cells.every((c) => free(c.x, c.y)));
      if (fits) {
        const loads = load();
        place(fits, loads);
        turned = { from: { ...boat.dir }, to: v };
        boat.dir = v;
      }
    }
    const afterTurn = boat.cells.map((c) => ({ ...c }));
    const done = [];
    let stop = null;
    for (const [dx, dy] of steps) {
      const bad = boat.cells.map((c) => ({ x: c.x + dx, y: c.y + dy })).find((c) => !free(c.x, c.y));
      if (bad) { stop = blockerAt(bad.x, bad.y); break; }
      place(boat.cells.map((c) => ({ x: c.x + dx, y: c.y + dy })), load());
      done.push([dx, dy]);
    }
    if (!done.length && !turned) return fail(stop === 'a strong current' ? `The sail fills, but a strong current pushes the boat back: it can't go ${dirName}.` : `The sail fills, but the boat can't move ${dirName}: it is up against ${stop}.`);
    const ring = this.items.get('ring');
    if (ring?.state === 'hover' && !ring.inside) this._liftRing();
    const face = this._face(r.x + Math.sign(tx), r.y + Math.sign(ty));
    const n = done.length;
    let text = turned ? `The boat swung round to point ${compass(boat.dir.x, boat.dir.y)}. ` : '';
    if (n) text += `The sail filled and the boat glided ${n} cell${n > 1 ? 's' : ''} ${dirName}`;
    else text += "The sail filled, but the boat couldn't go any farther";
    if (stop) text += stop === 'a strong current' ? ', then a strong current out there pushed it back.' : `, then came gently to rest against ${stop}.`;
    else text += goal && r.x === goal.x && r.y === goal.y ? ', and you are where you were heading.' : '.';
    const others = riders.filter((o) => o !== r);
    if (others.length) text += ` The ${others.map((o) => o.id).join(' and ')} robot rode along with you.`;
    for (const o of others) this._notify(o, `The sailboat you are on ${n ? `sailed ${n} cell${n > 1 ? 's' : ''} ${dirName}` : 'swung round'}, carrying you along, while the ${r.id} robot sailed it. You are now at (${o.x},${o.y}).`);
    return { ok: true, text, events: [face, { type: 'boat', before, afterTurn, after: boat.cells.map((c) => ({ ...c })), dir: { ...boat.dir }, turned, steps: done, items: cargo, riders: riders.map((o) => o.id) }] };
  }

  // Can the acting robot see the boat from where it stands? (A large thing: farther than crates, less in the dark.)
  _boatVisible() {
    const r = this.robot;
    if (r.inside) return false;
    if (this.onBoat(r.x, r.y)) return true;
    const range = (CFG.boatSight * this.sight().robot) / CFG.robotSight;
    return this.boat.cells.some((c) => Math.hypot(c.x - r.x, c.y - r.y) <= range);
  }

  look() {
    return { ok: true, text: this.perceive(), events: [] };
  }

  // "to the east of you, 1.0 m above your feet": where a cell is from the acting robot.
  _rel(x, y) {
    const r = this.robot;
    return `(${x},${y}), ${x === r.x && y === r.y ? 'where you stand' : `${cheb(r, { x, y }) === 1 ? 'next to you' : `${cheb(r, { x, y })} cells away`} to the ${compass(x - r.x, y - r.y)}`}`;
  }

  // The ground around the robot as a grid of top heights (north up), so the shape of stacks and steps can be seen at a
  // glance. Cells it can't stand on are marked instead of given a height.
  _heightGrid(radius) {
    const r = this.robot;
    const inside = !!r.inside;
    const W = 6;
    const cell = (x, y) => {
      if (!this.inGrid(x, y)) return '';
      if (inside && buildingAt(x, y) !== buildingAt(r.x, r.y)) return 'wall';
      if (x === r.x && y === r.y) return `[${fmtH(r.h)}]`;
      if (!inside) {
        if (this.openWater(x, y)) return '~';
        const t = this.terrainAt(x, y);
        if (t === 'palm') return 'palm';
        if (t === 'hut') return 'hut';
        if (t === 'volcano') return 'rock!';
      }
      const o = this.robots.find((q) => q !== r && !q.carriedBy && q.x === x && q.y === y && !!q.inside === inside);
      if (o) return o.id.slice(0, 5);
      const nat = !inside && this.nativeAt(x, y);
      if (nat) return `nat${nat.id.split('_')[1]}`;
      if (this.topItem(x, y, inside) === 'rock') return 'rock';
      return fmtH(this.topHeight(x, y, inside));
    };
    const pad = (t) => t.padStart(W);
    // Indoors: just the room and its walls.
    const f = inside ? LAYOUT[buildingAt(r.x, r.y)] : { x0: r.x - radius + 1, x1: r.x + radius - 1, y0: r.y - radius + 1, y1: r.y + radius - 1 };
    const xs = [];
    for (let x = f.x0 - 1; x <= f.x1 + 1; x++) xs.push(x);
    const lines = [`Heights around you (top of each cell in m, north at the top; [${fmtH(r.h)}] is you, ~ is water):`, `${'y\\x'.padStart(5)} ${xs.map((x) => pad(String(x))).join('')}`];
    for (let y = f.y1 + 1; y >= f.y0 - 1; y--) lines.push(`${String(y).padStart(5)} ${xs.map((x) => pad(cell(x, y))).join('')}`);
    return lines.join('\n');
  }

  // ---------- descriptions for the LLM ----------
  // What the robot knows about itself after every action.
  status() {
    const r = this.robot;
    if (!r.inside && this.onBoat(r.x, r.y)) this.boatSeen.add(r.id);
    const sky = r.inside ? (this.sky().light > 0.2 ? 'Daylight comes in through the doorway.' : 'Outside the doorway it is dark.') : SKY_WORDS[this.sky().phase];
    // Rounded, but never "0%" while there is charge left or "100%" before it is full.
    const pct = r.battery <= 0 ? 0 : r.battery >= 100 ? 100 : Math.min(99, Math.max(1, Math.round(r.battery)));
    const battery = `Battery: ${pct}%${r.charging ? ', charging' : ''}.`;
    const on = r.carriedBy ? `carried in the ${r.carriedBy} robot's arms` : `feet at height ${fmtH(r.h)} m, standing on ${this.surfaceName(r.x, r.y, r.inside)}`;
    return `You are the ${r.id} robot. You are ${this._where(r.inside, r.x, r.y)}at (${r.x},${r.y}), ${on}. Holding: ${this._holdingText(r)}. ${battery} ${sky}`;
  }

  // What the robot can see from where it stands: big landmarks always, small objects only nearby.
  perceive() {
    const r = this.robot;
    if (r.inside) return this._perceiveInside();
    const out = [this.status(), '', this._heightGrid(3), '', 'Looking around (x grows east, y grows north):'];
    const dirs = [['north', 0, 1], ['north-east', 1, 1], ['east', 1, 0], ['south-east', 1, -1], ['south', 0, -1], ['south-west', -1, -1], ['west', -1, 0], ['north-west', -1, 1]];
    // On land: how far to the water. Afloat: how far to land.
    const afloat = this.isWater(r.x, r.y);
    const reach = afloat ? 24 : 20;
    for (const [name, dx, dy] of dirs) {
      let seen = afloat ? `open water for at least ${reach} cells` : `no water within ${reach} cells`;
      for (let i = 1; i <= reach; i++) {
        const x = r.x + dx * i;
        const y = r.y + dy * i;
        const s = i > 1 ? 's' : '';
        if (afloat && !this.inGrid(x, y)) { seen = `open water, then a strong current ${i} cell${s} away`; break; }
        if (afloat && !this.isWater(x, y)) { seen = `${this.terrainAt(x, y) === 'sand' ? 'land' : `the ${this.terrainAt(x, y)}`} ${i} cell${s} away, at (${x},${y})`; break; }
        if (!afloat && this.isWater(x, y)) { seen = `water begins ${i} cell${s} away, at (${x},${y})`; break; }
      }
      out.push(`- ${name}: ${seen}`);
    }
    const t = LAYOUT.tower;
    const h = LAYOUT.hut;
    out.push('', 'Large things you can see:');
    const home = this._islandOf(r.x, r.y);
    const seen = this.visibleIslands();
    ISLANDS.forEach((isl, i) => {
      if (i === home || !seen.has(i)) return;
      const dir = compass(isl.cx - r.x, isl.cy - r.y);
      const view = seen.get(i);
      if (view === 'night') { out.push(`- far off to the ${dir}: ${isl.nightLooks}.`); return; }
      if (view === 'tip') { out.push(`- far off to the ${dir}: ${isl.farLooks}.`); return; }
      const n = this._nearestShore(i);
      const d = Math.round(Math.hypot(n.x - r.x, n.y - r.y));
      out.push(`- ${home < 0 ? 'an island' : 'another island'} across the water to the ${dir}: ${isl.looks}. Its nearest shore is about ${d} cells away, around (${n.x},${n.y}).`);
    });
    const volcano = ISLANDS.find((i) => i.volcano);
    if (seen.get(ISLANDS.indexOf(volcano)) === 'full' || home === ISLANDS.indexOf(volcano)) {
      out.push(`- volcano: a steep cone of black rock, about ${Math.round(volcano.volcano * 2) + 1} cells across, centred on (${volcano.cx},${volcano.cy}), with smoke drifting from its crater. Its sides look far too steep to climb.`);
    }
    const bigSeen = home === 0 || seen.get(0) === 'full';
    if (bigSeen) out.push(`- tower: a square stone tower covering x ${t.x0}..${t.x1}, y ${t.y0}..${t.y1}. Its flat top looks about ${CFG.towerHeight} m high. An open doorway on its south side, in front of (${t.door.x},${t.door.y}), leads inside.`);
    if (bigSeen) out.push(`- hut: a wooden hut with a pointed thatched roof covering x ${h.x0}..${h.x1}, y ${h.y0}..${h.y1}. An open doorway on its south side, in front of (${h.door.x},${h.door.y}), leads inside.`);
    if (bigSeen) out.push(`- dock: a wooden pier at x ${this.dock.x0}..${this.dock.x1} running from y ${this.dock.yLand} on the shore out over the water to y ${this.dock.yEnd}.`);
    // Only palms on this island or on islands seen in full.
    const palms = LAYOUT.palms.filter((p) => { const i = islandAt(p.x, p.y); return i === home || seen.get(i) === 'full'; });
    if (palms.length) out.push(`- palm: palm trees, their big fronds drooping low, at ${palms.map((p) => `(${p.x},${p.y})`).join(' ')}.`);
    if (this._boatVisible()) {
      this.boatSeen.add(r.id);
      const c = this.boat.cells;
      const aboard = this.onBoat(r.x, r.y) ? ' You are standing on its deck.' : '';
      out.push(`- sailboat: a small wooden sailboat with a mast and a furled white sail, floating in the water with its bow to the ${compass(this.boat.dir.x, this.boat.dir.y)}. Its flat deck covers ${c.length} cells, from (${c[0].x},${c[0].y}) to (${c.at(-1).x},${c.at(-1).y}), and sits about level with the dock.${aboard}`);
    }
    const ring = this.items.get('ring');
    if (ring?.state === 'hover') out.push(`- ring: a glowing golden ring hanging in mid-air about ${fmtH(ring.alt)} m up, above (${ring.x},${ring.y}).`);
    for (const o of this.others()) {
      const d = Math.hypot(o.x - r.x, o.y - r.y);
      const dir = compass(o.x - r.x, o.y - r.y);
      if (this._canSee(r, o)) out.push(this._robotLine(o, d < 0.5 ? 'right here' : `${Math.round(d)} cell${Math.round(d) === 1 ? '' : 's'} to the ${dir}`));
      else if (!o.inside && this.sight().far && d <= 50) out.push(`- far off to the ${dir}, about ${Math.max(5, Math.round(d / 5) * 5)} cells away, a small figure is moving about. It could be a robot.`);
    }
    // Natives: clearly within sight, otherwise as a group of distant figures per island.
    const farNatives = new Map();
    for (const n of this.natives) {
      const d = Math.hypot(n.x - r.x, n.y - r.y);
      if (d <= this.sight().robot) out.push(this._nativeLine(n, d));
      else if (this.sight().far && d <= 50) farNatives.set(n.island, [...(farNatives.get(n.island) || []), n]);
    }
    for (const group of farNatives.values()) {
      const cx = group.reduce((a, n) => a + n.x, 0) / group.length;
      const cy = group.reduce((a, n) => a + n.y, 0) / group.length;
      const d = Math.hypot(cx - r.x, cy - r.y);
      out.push(`- far off to the ${compass(cx - r.x, cy - r.y)}, about ${Math.max(5, Math.round(d / 5) * 5)} cells away, ${group.length > 1 ? `${group.length} small figures are` : 'a small figure is'} moving about on an island. ${group.length > 1 ? 'They' : 'It'} could be robots.`);
    }

    const near = [];
    const far = new Map();
    const dist = (x, y) => Math.hypot(x - r.x, y - r.y);
    const sight = this.sight();
    const rafts = new Map(); // first cell key -> lines for each of its cells
    const raftOfCell = new Map();
    for (const [k, ids] of this.columns) {
      const { x, y, inside } = parseKey(k);
      if (inside) continue; // hidden behind walls
      if (dist(x, y) > sight.small) {
        if (!sight.far) continue; // in the dark, farther things can't be seen at all
        // Far off, small things only show on land in full view, or on the water fairly near.
        const isl = islandAt(x, y);
        if (isl < 0 ? dist(x, y) > 30 : isl !== home && seen.get(isl) !== 'full') continue;
        const dir = compass(x - r.x, y - r.y);
        far.set(dir, (far.get(dir) || 0) + 1);
        continue;
      }
      const what = ids.length === 1 ? this._desc(ids[0]) : `a stack, bottom to top: ${ids.map((id) => this._desc(id)).join(', ')}`;
      const raft = this.raftAt(x, y);
      if (raft) {
        if (!raftOfCell.has(k)) for (const c of raft) raftOfCell.set(key(c.x, c.y), k);
        const head = raftOfCell.get(k);
        if (!rafts.has(head)) {
          rafts.set(head, []);
          near.push({ raft: head, cells: raft });
        }
        rafts.get(head).push(`at (${x},${y}) ${what}, top surface ${fmtH(this.topHeight(x, y))} m`);
        continue;
      }
      near.push(`- at (${x},${y}): ${what}${this.onBoat(x, y) ? ", on the sailboat's deck" : this.isWater(x, y) ? ', floating in the water' : ''}; top surface ${fmtH(this.topHeight(x, y))} m`);
    }
    out.push('', sight.small < CFG.sightRange ? `It is ${sight.far ? 'getting dark' : 'dark'}. Smaller things you can make out, within about ${sight.small} cells:` : `Smaller things within about ${sight.small} cells:`);
    out.push(...(near.length ? near.map((n) => (typeof n === 'string' ? n : `- ${this.raftName(n.cells).slice(2)}, floating in the water: ${rafts.get(n.raft).join('; ')}`)) : ['- nothing']));
    if (far.size) out.push(`Too far away to make out: ${[...far].map(([d, n]) => `${n} small thing${n > 1 ? 's' : ''} to the ${d}`).join(', ')}.`);
    return out.join('\n');
  }

  // How the acting robot sees a native in look: what it looks like and what it is doing (never why).
  _nativeLine(n, d) {
    const r = this.robot;
    const where = d < 1.5 ? 'right next to you' : `${Math.round(d)} cells to the ${compass(n.x - r.x, n.y - r.y)}`;
    const doing = n.target === r.id ? 'It is coming at you, its stick raised.' : n.target ? `It is heading toward the ${n.target} robot, its stick raised.` : n.x === n.home.x && n.y === n.home.y ? 'It stands still, watching.' : 'It is walking slowly across the sand.';
    return `- ${n.id}: ${NATIVE_LOOKS}, at (${n.x},${n.y}), ${where}. ${doing}`;
  }

  // How the acting robot sees another robot in look: where it is, what it holds or carries, and whether it is moving.
  _robotLine(o, where) {
    const r = this.robot;
    const head = `- ${o.id}_robot: another robot like you, painted ${o.id}, at (${o.x},${o.y})${where ? `, ${where}` : ''}.`;
    if (o.carriedBy === r.id) return `${head} You are carrying it in your arms; it hangs limp${o.battery <= 0 ? ', its eyes dark' : ''}.`;
    const flat = o.battery <= 0 ? ' It is motionless and slumped, its eyes dark.' : '';
    if (o.carriedBy) return `${head} It is being carried in the ${o.carriedBy} robot's arms.${flat}`;
    const holds = o.carrying ? ` and carrying ${o.carrying === r.id ? 'you' : `the ${o.carrying} robot`} in its arms` : o.holding ? ` and holding ${o.holding}` : '';
    return `${head} It is standing on ${this.surfaceName(o.x, o.y, o.inside)}${holds}.${flat}`;
  }

  // Islands the acting robot can see, other than the one it is on: index -> 'full', 'tip' (only a volcano's peak shows
  // over the horizon) or 'night' (only a glow). Distance is measured to the island's centre; height helps.
  visibleIslands() {
    const r = this.robot;
    const out = new Map();
    if (r.inside) return out;
    const dark = !this.sight().far;
    ISLANDS.forEach((isl, i) => {
      const d = Math.hypot(isl.cx - r.x, isl.cy - r.y);
      if (d > ISLAND_SEEN[isl.name] + SEEN_PER_METRE * Math.max(0, r.h)) return;
      if (dark) { if (d <= 25) out.set(i, 'full'); else if (isl.nightLooks) out.set(i, 'night'); return; }
      out.set(i, isl.near && d > isl.near ? 'tip' : 'full');
    });
    return out;
  }

  // Which island a cell belongs to (the dock counts as part of the big island); -1 out at sea.
  _islandOf(x, y) {
    const i = islandAt(x, y);
    return i >= 0 || this.terrainAt(x, y) !== 'dock' ? i : 0;
  }
  // The land cell of island i nearest the acting robot.
  _nearestShore(i) {
    const r = this.robot;
    let best = null;
    for (const [k, t] of this.terrain) {
      if (t === 'water' || t === 'dock') continue;
      const p = parseKey(k);
      if (islandAt(p.x, p.y) !== i) continue;
      const d = Math.hypot(p.x - r.x, p.y - r.y);
      if (!best || d < best.d) best = { x: p.x, y: p.y, d };
    }
    return best;
  }

  // Indoors the robot sees only the room it is in.
  _perceiveInside() {
    const r = this.robot;
    const b = buildingAt(r.x, r.y);
    const f = LAYOUT[b];
    const desc = (id) => this._desc(id);
    const out = [this.status(), ''];
    out.push(`You are inside the ${b}. The room covers x ${f.x0}..${f.x1}, y ${f.y0}..${f.y1}, with walls all around and a ceiling ${fmtH(f.ceiling)} m above the floor.`);
    out.push(`The only way out is the doorway on the south side: from (${f.doorIn.x},${f.doorIn.y}) it leads out to (${f.door.x},${f.door.y}). You can't see outside from in here.`);
    out.push('', this._heightGrid());
    out.push('', 'In here:');
    const near = [];
    for (const [k, ids] of this.columns) {
      const { x, y, inside } = parseKey(k);
      if (!inside || buildingAt(x, y) !== b) continue;
      const what = ids.length === 1 ? desc(ids[0]) : `a stack, bottom to top: ${ids.map(desc).join(', ')}`;
      near.push(`- at (${x},${y}): ${what}; top surface ${fmtH(this.topHeight(x, y, true))} m`);
    }
    const ring = this.items.get('ring');
    for (const o of this.others()) {
      if (this._canSee(r, o)) near.push(this._robotLine(o));
    }
    if (ring?.state === 'hover' && ring.inside && buildingAt(ring.x, ring.y) === b) near.push(`- ring: a glowing golden ring hanging just under the ceiling, about ${fmtH(ring.alt)} m up, above (${ring.x},${ring.y}).`);
    out.push(...(near.length ? near : ['- nothing but the floor']));
    return out.join('\n');
  }

  // Full, omniscient state for debugging (manual "describe" command). Never shown to the model.
  describe() {
    const out = [];
    out.push('WORLD STATE');
    const sk = this.sky();
    out.push(`- Clock: day ${sk.day}, ${String(Math.floor(sk.hour)).padStart(2, '0')}:${String(Math.floor((sk.hour % 1) * 60)).padStart(2, '0')} (${sk.phase}, light ${r2(sk.light)}), time x${this.timeScale}.`);
    for (const b of this.robots) out.push(`- ${b.id} robot at (${b.x},${b.y})${b.inside ? ` inside the ${buildingAt(b.x, b.y)}` : ''}, feet ${fmtH(b.h)} m on ${this.surfaceName(b.x, b.y, b.inside)}, holding ${b.carrying ? `the ${b.carrying} robot` : b.holding || 'nothing'}${b.carriedBy ? `, carried by ${b.carriedBy}` : ''}, battery ${r2(b.battery)}%${b.charging ? ' (charging)' : ''}.`);
    for (const n of this.natives) out.push(`- ${n.id} (native, ${ISLANDS[n.island].name} island) at (${n.x},${n.y}), post (${n.home.x},${n.home.y})${n.target ? `, after the ${n.target} robot` : ''}${n.cool > 0 ? `, next jab in ${Math.ceil(n.cool)} min` : ''}.`);
    out.push('');
    out.push('Landmarks:');
    const t = LAYOUT.tower;
    const h = LAYOUT.hut;
    out.push(`- Tower: stone, occupies x ${t.x0}..${t.x1}, y ${t.y0}..${t.y1}. Flat top ${CFG.towerHeight} m (standable). Room inside (ceiling ${t.ceiling} m) through the doorway (${t.door.x},${t.door.y}) -> (${t.doorIn.x},${t.doorIn.y}).`);
    out.push(`- Hut: occupies x ${h.x0}..${h.x1}, y ${h.y0}..${h.y1}. Roof can't be stood on. Room inside (ceiling ${h.ceiling} m) through the doorway (${h.door.x},${h.door.y}) -> (${h.doorIn.x},${h.doorIn.y}).`);
    out.push(`- Dock: wooden pier at x ${this.dock.x0}..${this.dock.x1}, from y ${this.dock.yLand} (on the beach) out to sea at y ${this.dock.yEnd}; height ${CFG.dockHeight} m.`);
    out.push(`- Sailboat: deck ${this.boat.cells.map((c) => `(${c.x},${c.y})`).join(' ')}, bow ${compass(this.boat.dir.x, this.boat.dir.y)}, height ${CFG.boatDeck} m. Seen by: ${[...this.boatSeen].join(', ') || 'nobody yet'}.`);
    out.push(`- Palm trees (obstacles) at ${LAYOUT.palms.map((p) => `(${p.x},${p.y})`).join(' ')}.`);
    out.push(`- Islands (sand at height 0): ${ISLANDS.map((i) => `${i.name} one, about ${Math.round(i.r)} cells in radius around (${i.cx},${i.cy})`).join('; ')}. Everything else is water.`);
    const edge = (dx, dy) => { let i = 0; while (this.terrainAt(dx * (i + 1), dy * (i + 1)) !== 'water') i++; return i + 1; };
    out.push(`- First water cell going straight out from the centre: north (0,${edge(0, 1)}), south (0,-${edge(0, -1)}) past the dock, east (${edge(1, 0)},0), west (-${edge(-1, 0)},0).`);
    out.push('');
    out.push('Items:');
    const ring = this.items.get('ring');
    if (ring) out.push(`- ring: ${ring.state === 'held' ? `held by the ${this.holderOf('ring').id} robot` : `floating in the air above (${ring.x},${ring.y}) at ${fmtH(ring.alt)} m. To grab it, stand on a cell within 1 of (${ring.x},${ring.y}) with feet at least ${fmtH(ring.alt - CFG.reachUp)} m high`}.`);
    const rock = this.items.get('rock');
    out.push(`- rock: ${rock.state === 'held' ? `held by the ${this.holderOf('rock').id} robot` : `at (${rock.x},${rock.y})${rock.inside ? ` inside the ${buildingAt(rock.x, rock.y)}` : ''}`}.`);
    const cols = [...this.columns.entries()].filter(([, ids]) => ids.some((id) => this.items.get(id).type === 'block'));
    const blockLines = cols
      .map(([k, ids]) => {
        const { x, y, inside } = parseKey(k);
        return `- (${x},${y}) ${inside ? `inside the ${buildingAt(x, y)}` : `on ${this.terrainAt(x, y)}`}: ${ids.join(' under ')} -> top ${fmtH(this.topHeight(x, y, inside))} m`;
      })
      .sort();
    const total = [...this.items.values()].filter((it) => it.type === 'block').length;
    out.push(`- ${total} blocks (1 m wooden crates). Stacks listed bottom first:`);
    out.push(...blockLines.map((l) => `  ${l}`));
    for (const b of this.robots) if (b.holding && this.items.get(b.holding).type === 'block') out.push(`  - ${b.holding} is in the ${b.id} robot's hands`);
    const fronds = [...this.items.values()].filter((it) => it.type === 'frond');
    out.push(`- Charger parts (stack one onto another to fit them; all ${PARTS.length} make the solar charger, which charges robots within 1 cell outdoors in daylight): ${[...this.items.values()].filter((it) => it.type === 'part' || it.type === 'device').map((it) => `${it.id}${it.role ? ` (${it.role})` : ` [${it.parts.join(', ')}]${this.deviceComplete(it) ? (this.chargerWorks(it) ? ' WORKING' : ' complete, idle') : ''}`} ${it.state === 'fitted' ? `fitted in ${it.device}` : it.state === 'held' ? `held by ${this.holderOf(it.id).id}` : `at (${it.x},${it.y})${it.inside ? ' inside' : ''}`}`).join('; ')}.`);
    out.push(`- Palm fronds torn off: ${fronds.length ? fronds.map((f) => `${f.id} ${f.state === 'held' ? `(held by ${this.holderOf(f.id).id})` : `at (${f.x},${f.y})${f.inside ? ' inside' : ''}`}`).join(', ') : 'none'} (each palm gives ${CFG.frondsPerPalm}).`);
    return out.join('\n');
  }
}
