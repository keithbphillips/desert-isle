import { World, skyAt } from './world.js';
import { Renderer } from './render.js';
import { Agent, DEFAULT_SYSTEM } from './agent.js';
import { Diary } from './diary.js';
import { thoughtGist } from './gist.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(`desertisle.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`desertisle.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// Used until you pick a model yourself (your pick is remembered in this browser).
const DEFAULT_MODEL = 'qwen3.8:27b'; // preselected if installed (an openai/ model is preferred when OPENAI_URL is set)

const EXAMPLES = [
  ['Tower', 'Climb to the top of the tower.'],
  ['Rock', 'Throw the rock onto the sand somewhere open, then tell me how many blocks there are now.'],
  ['Stack', 'Build a stack of three blocks next to the hut door and stand on top of it.'],
  ['Sea', 'Throw block 1 into the sea.'],
  ['Explore', 'Explore this place. Find out what is here and how things behave, and write what you learn in your diary.'],
  ['Meet', 'Find out whether you are alone here. If there is anyone else, find a way to reach them.'],
];

const world = new World();
// One diary per robot. The orange robot keeps the original storage key, so its old diary carries over.
const ROBOTS = world.robots.map((r) => r.id);
const NAME = { orange: 'Orange', blue: 'Blue' };
const diaries = Object.fromEntries(ROBOTS.map((id, i) => {
  const k = i === 0 ? 'diary' : `diary.${id}`;
  return [id, new Diary({ load: () => store.get(k, []), save: (entries) => store.set(k, entries) })];
}));
const view = new Renderer($('view'), world);
const modelCaps = new Map();
const modelCtx = new Map(); // openai/ models: the server's fixed context size, when it reports one

// ---------- settings ----------
const fields = { timeScale: 'value', think: 'value', temperature: 'value', numCtx: 'value', maxSteps: 'value', speed: 'value', instruction: 'value', instructionBlue: 'value', runOrange: 'checked', runBlue: 'checked', lockstep: 'value' };
// Storage keys get a version suffix when a default changes, so old saved values don't mask the new default.
// numCtx.v3: blank (auto) became the default, so a server's full context is used instead of an old saved 65536.
const storeKey = { numCtx: 'numCtx.v3', maxSteps: 'maxSteps.v2' };
for (const [id, prop] of Object.entries(fields)) {
  const k = storeKey[id] || id;
  const saved = store.get(k, null);
  if (saved != null) $(id)[prop] = saved;
  $(id).addEventListener('change', () => store.set(k, $(id)[prop]));
}
// v4: the prompt now says the diary is shown at switch-on; an older saved prompt would contradict that.
$('system').value = store.get('system.v5', DEFAULT_SYSTEM);
$('system').addEventListener('change', () => store.set('system.v5', $('system').value));
$('btnSysReset').onclick = () => { $('system').value = DEFAULT_SYSTEM; store.set('system.v5', DEFAULT_SYSTEM); };

const applyTimeScale = () => { world.timeScale = Number($('timeScale').value) || 3; };
$('timeScale').addEventListener('change', applyTimeScale);
applyTimeScale();

const applySpeed = () => {
  view.speed = Number($('speed').value);
  $('speedVal').textContent = `${view.speed}×`;
};
$('speed').addEventListener('input', applySpeed);
applySpeed();

function settings() {
  return {
    model: $('model').value,
    // Models without the thinking capability reject the parameter, so only send it when supported.
    think: modelCaps.get($('model').value)?.includes('thinking') === false ? false : ({ off: false, on: true }[$('think').value] ?? $('think').value),
    temperature: Number($('temperature').value) || 0,
    // Never budget for more context than the model has (an OpenAI-compatible server's context is fixed by its config).
    // Blank means as much as the model allows: the server's context for openai/ models, or 65536 for Ollama.
    numCtx: Math.min(Number($('numCtx').value) || modelCtx.get($('model').value) || 65536, modelCtx.get($('model').value) || Infinity),
    maxSteps: Math.max(1, Number($('maxSteps').value) || 200),
    lockstep: $('lockstep').value,
    system: $('system').value.trim() || DEFAULT_SYSTEM,
  };
}

// ---------- models ----------
async function loadModels() {
  const conn = $('conn');
  try {
    const res = await fetch('api/tags');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    const models = (data.models || []).filter((m) => !m.capabilities || m.capabilities.includes('tools') || m.capabilities.includes('completion'));
    const sel = $('model');
    sel.innerHTML = '';
    for (const m of models) {
      if (m.capabilities) modelCaps.set(m.name, m.capabilities);
      if (m.backend === 'openai' && m.details?.context_length) modelCtx.set(m.name, m.details.context_length);
      const o = document.createElement('option');
      o.value = m.name;
      const tools = !m.capabilities || m.capabilities.includes('tools');
      o.textContent = `${m.name} · ${m.details?.parameter_size || ''}${tools ? '' : ' (no tool support)'}`;
      sel.append(o);
    }
    // Key bumped (v2) when openai/ models became the default, so an older remembered pick doesn't override it once.
    const saved = store.get('model.v2', null);
    const openai = models.find((m) => m.backend === 'openai');
    if (saved && models.some((m) => m.name === saved)) sel.value = saved;
    else if (openai) sel.value = openai.name;
    else if (models.some((m) => m.name === DEFAULT_MODEL)) sel.value = DEFAULT_MODEL;
    sel.onchange = () => store.set('model.v2', sel.value);
    const nOpenAI = models.filter((m) => m.backend === 'openai').length;
    const src = [models.length > nOpenAI && 'Ollama', nOpenAI && 'OpenAI API'].filter(Boolean).join(' + ');
    conn.textContent = models.length ? `${src} · ${models.length} model${models.length > 1 ? 's' : ''}` : 'No models';
    conn.className = `conn ${models.length ? 'ok' : 'bad'}`;
  } catch (e) {
    conn.textContent = 'Models unreachable';
    conn.title = e.message;
    conn.className = 'conn bad';
    addLog('error', `Could not list models (Ollama): ${e.message}`);
  }
}

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tag = (who) => (who ? `<span class="who ${who}">${NAME[who] || who}</span> ` : '');
NAME.voice = 'The Voice';
const fmtArgs = (a) => Object.entries(a || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v}"` : v}`).join(', ');

function updateHud() {
  const blocks = [...world.items.values()].filter((i) => i.type === 'block').length;
  const battery = (r) => {
    const pct = r.battery <= 0 ? 0 : r.battery >= 100 ? 100 : Math.min(99, Math.max(1, Math.round(r.battery)));
    const cls = pct <= 10 ? 'batt low' : pct <= 25 ? 'batt warn' : 'batt';
    return `<span class="${cls}">🔋 <b>${pct}%</b>${r.charging ? ' ⚡' : pct === 0 ? ' flat' : ''}</span>`;
  };
  const line = (r) => `${tag(r.id)}<b>(${r.x}, ${r.y})</b>${r.inside ? ' inside' : ''} · feet <b>${r.h.toFixed(1)} m</b> · holding <b>${r.carrying ? `${r.carrying} robot` : r.holding || 'nothing'}</b>${r.carriedBy ? ` (carried by ${r.carriedBy})` : ''} · ${battery(r)}`;
  const sky = skyAt(world.minutes);
  const clock = `${String(Math.floor(sky.hour)).padStart(2, '0')}:${String(Math.floor((sky.hour % 1) * 60)).padStart(2, '0')}`;
  $('hudStatus').innerHTML = `${world.robots.map(line).join('<br>')}<br>${blocks} blocks · day <b>${sky.day}</b>, <b>${clock}</b> ${sky.phase}`;
}

// ---------- thoughts panel ----------
// One tab per robot, listing the thoughts its bubble has shown (newest at the bottom), plus short grey notes for
// what matters besides: instructions, errors, restarts, stops and manual commands. The full reasoning isn't kept.
const thoughtList = $('thoughtList');
const thoughts = Object.fromEntries(ROBOTS.map((id) => [id, []]));
let thoughtWho = store.get('thoughtWho', ROBOTS[0]);
if (!ROBOTS.includes(thoughtWho)) thoughtWho = ROBOTS[0];
const nearBottom = () => thoughtList.scrollHeight - thoughtList.scrollTop - thoughtList.clientHeight < 40;
function thoughtItem(t) {
  const el = document.createElement('div');
  if (t.note) {
    el.className = `thought-note ${t.note}`;
    el.innerHTML = t.html;
  } else {
    el.className = 'thought-item';
    el.title = `turn ${t.step}`;
    el.textContent = t.text;
  }
  return el;
}
function renderThoughts() {
  for (const id of ROBOTS) $(`thoughtTab${NAME[id]}`).classList.toggle('on', id === thoughtWho);
  const list = thoughts[thoughtWho];
  thoughtList.innerHTML = list.length ? '' : `<p class="thought-empty">The ${thoughtWho} robot's thoughts appear here while it works.</p>`;
  for (const t of list) thoughtList.append(thoughtItem(t));
  thoughtList.scrollTop = thoughtList.scrollHeight;
}
function addEntry(who, t) {
  const list = thoughts[who];
  list.push(t);
  if (list.length > 400) list.shift();
  if (who !== thoughtWho) return;
  const stick = nearBottom();
  thoughtList.querySelector('.thought-empty')?.remove();
  thoughtList.append(thoughtItem(t));
  while (thoughtList.children.length > 400) thoughtList.firstElementChild.remove();
  if (stick || t.note) thoughtList.scrollTop = thoughtList.scrollHeight;
}
// A grey note in one robot's tab (or every tab when who is omitted). cls: user, error, restart, done, note, manual.
function addLog(cls, html, who) {
  for (const id of who ? [who] : ROBOTS) addEntry(id, { note: cls, html });
}
// Show a thought in the robot's bubble and add it to its list (unless it is the same as the last thought).
const turnOf = {};
function showThought(who, text) {
  view.setThought(who, text);
  const last = thoughts[who].findLast((t) => !t.note);
  if (last?.text === text) return;
  addEntry(who, { text, step: turnOf[who] });
}
for (const id of ROBOTS) {
  $(`thoughtTab${NAME[id]}`).onclick = () => { thoughtWho = id; store.set('thoughtWho', id); renderThoughts(); };
}
$('btnThoughtsClear').onclick = () => {
  thoughts[thoughtWho].length = 0;
  renderThoughts();
};
renderThoughts();

// ---------- talk window ----------
// Everything the robots say aloud (world.talk), with who heard it. New lines are added after each action.
const talkList = $('talkList');
let talkShown = 0;
function updateTalk() {
  if (world.talk.length < talkShown) talkShown = 0; // the world was reset
  const fresh = world.talk.slice(talkShown);
  if (!fresh.length) return;
  talkShown = world.talk.length;
  const stick = talkList.scrollHeight - talkList.scrollTop - talkList.clientHeight < 40;
  talkList.querySelector('.thought-empty')?.remove();
  for (const t of fresh) {
    const el = document.createElement('div');
    el.className = `talk-item ${t.who}`;
    const names = t.heardBy.map((id) => NAME[id] || id).join(' and ');
    const heard = t.who === 'voice' ? `to ${names}` : t.heardBy.length ? `heard by ${names}` : 'nobody heard';
    el.innerHTML = `<div class="line">${tag(t.who)}<span class="said">${esc(t.text)}</span></div><span class="heard${t.heardBy.length ? ' yes' : ''}">${heard}</span>`;
    talkList.append(el);
  }
  while (talkList.children.length > 300) talkList.firstElementChild.remove();
  if (stick || fresh.length) talkList.scrollTop = talkList.scrollHeight;
}
// The Voice: you speaking to the robots. They hear it wherever they are, with the result of their next action
// (or when they are next switched on, if they aren't running).
$('voiceTo').value = store.get('voiceTo', 'all');
$('voiceTo').addEventListener('change', () => store.set('voiceTo', $('voiceTo').value));
$('voiceForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const said = world.voice($('voiceText').value, $('voiceTo').value);
  if (!said) return;
  for (const id of said.heardBy) {
    const later = agents[id].running ? '' : ' <i>(it will hear this when it is next switched on)</i>';
    addLog('voice', `🗣️ <b>The Voice:</b> ${esc(said.text)}${later}`, id);
  }
  $('voiceText').value = '';
  updateTalk();
});
$('btnTalkClear').onclick = () => {
  talkList.innerHTML = '<p class="thought-empty">Anything the robots say aloud appears here.</p>';
};

// ---------- agents ----------
function onAgentEvent(who, type, d) {
  if (type === 'thinking') {
    turnOf[who] = d.step;
    view.setThought(who, '', true);
  } else if (type === 'stream') {
    // Bubble: only the latest main thought; keep showing the previous one (or the dots) until there is one.
    const gist = thoughtGist(d.thinking || d.content || '');
    if (gist) showThought(who, gist);
  } else if (type === 'reply') {
    const gist = thoughtGist([d.thinking, d.content].filter(Boolean).join('\n'), { final: true });
    if (gist) showThought(who, gist);
    else if (view.thoughtPending(who)) view.clearThought(who);
    if (d.cutOff) {
      const k = (n) => `${Math.round(n / 1000)}k`;
      const size = d.replyTokens ? ` (${d.promptTokens ? `${k(d.promptTokens)} conversation + ` : ''}${k(d.replyTokens)} reply, room for ${k(d.numCtx)})` : '';
      addLog('note', `⚠️ It thought until the context was full${size} without acting; asked to think more briefly and carry on.`, who);
    }
  } else if (type === 'call') {
    if (d.text === 'The robot decided to stop.') addLog('done', '⏹ The robot decided to stop.', who);
  } else if (type === 'world') {
    updateHud();
    updateTalk();
  } else if (type === 'restart') {
    addLog('restart', `🔁 The robot stopped, so it is switched on again with the instruction (session ${d.session}). Only its diary carries over.`, who);
  } else if (type === 'note') {
    addLog('note', esc(d), who);
  } else if (type === 'error') {
    addLog('error', `⚠️ ${esc(d)}`, who);
  } else if (type === 'stopped') {
    view.clearThought(who, 4000);
    setRunning();
  }
}
const agents = Object.fromEntries(ROBOTS.map((id) => [id, new Agent(world, diaries[id], {
  settings,
  play: (events) => view.play(events),
  onEvent: (type, d) => onAgentEvent(id, type, d),
}, id)]));

// Which robots the Run / Continue buttons drive, and the instruction each one gets.
const selected = () => ROBOTS.filter((id) => $(`run${NAME[id]}`).checked);
const instructionFor = (id) => (id === 'blue' && $('instructionBlue').value.trim()) || $('instruction').value.trim();
const anyRunning = () => ROBOTS.some((id) => agents[id].running);

function setRunning() {
  const on = anyRunning();
  $('btnRun').disabled = on;
  $('btnContinue').disabled = on || !selected().some((id) => agents[id].canContinue);
  $('btnStop').disabled = !on;
  $('btnReset').disabled = on;
  $('manualCmd').disabled = on;
}

$('btnRun').onclick = () => {
  const who = selected();
  if (!who.length) { addLog('error', 'Tick at least one robot to run.'); return; }
  if (!$('instruction').value.trim()) { $('instruction').focus(); return; }
  if (!$('model').value) { addLog('error', 'No Ollama model available.'); return; }
  store.set('instruction', $('instruction').value);
  for (const id of who) {
    addLog('user', `<b>Instruction</b> (${esc($('model').value)}): ${esc(instructionFor(id))}`, id);
    agents[id].run(instructionFor(id));
  }
  setRunning();
};
$('btnContinue').onclick = () => {
  const who = selected().filter((id) => agents[id].canContinue);
  if (!who.length) return;
  for (const id of who) {
    addLog('user', `<b>Continue</b> (${esc($('model').value)}): ${esc(agents[id].instruction)}`, id);
    agents[id].run(agents[id].instruction, { resume: true });
  }
  setRunning();
};
for (const id of ROBOTS) $(`run${NAME[id]}`).addEventListener('change', setRunning);
$('btnStop').onclick = () => {
  for (const id of ROBOTS) agents[id].stop();
  addLog('error', 'Stopped by you. Press Continue to resume.');
};
$('btnReset').onclick = () => {
  world.reset();
  for (const id of ROBOTS) agents[id].forget();
  $('btnContinue').disabled = true;
  view.rebuildItems();
  updateHud();
  talkShown = 0;
  addLog('user', 'Islands reset.');
};
for (const id of ['instruction', 'instructionBlue']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('btnRun').click();
  });
}

for (const [label, text] of EXAMPLES) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = text;
  b.onclick = () => { $('instruction').value = text; store.set('instruction', text); };
  $('examples').append(b);
}

// Manual commands, e.g. "walk_to 3 4", "walk_to tower", "pick_up block_2", "paddle east 3", "say hello there".
let manualBusy = false;
$('manual').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('manualCmd').value.trim();
  if (!raw || manualBusy || anyRunning()) return;
  const who = $('manualWho').value;
  const [name, ...rest] = raw.split(/\s+/);
  const nums = rest.map(Number);
  let args = {};
  if (name === 'say' || name === 'write_diary' || name === 'rewrite_diary') args = { text: rest.join(' ') };
  else if (name === 'pick_up') args = { item: rest.join('_') };
  else if (name === 'wait' || name === 'battery') args = rest.length ? { minutes: nums[0] } : {};
  else if (name === 'paddle' || name === 'row') args = { direction: rest[0], ...(rest[1] ? { strokes: Number(rest[1]) } : {}) };
  else if (name === 'put_down' && rest.length === 1 && !Number.isFinite(nums[0])) args = { direction: rest[0] };
  else if (name === 'sail' && !Number.isFinite(nums[0])) args = { direction: rest[0], ...(rest[1] ? { distance: Number(rest[1]) } : {}) };
  else if (rest.length >= 2 && nums.slice(0, 2).every(Number.isFinite)) args = { x: nums[0], y: nums[1] };
  else if (rest.length) args = { target: rest.join(' ') };
  manualBusy = true;
  const before = Object.fromEntries(ROBOTS.map((id) => [id, world.notices.get(id).length]));
  let r;
  if (name === 'rewrite_diary') r = { ...diaries[who].rewrite(args.text), events: [] };
  else if (name === 'write_diary') r = { ok: !!diaries[who].write(args.text), text: 'Written.', events: [] };
  else if (name === 'read_diary') r = { ok: true, text: diaries[who].read(), events: [] };
  else if (name === 'battery') {
    // Testing aid, not a robot action: set the robot's charge ("battery 20").
    const rob = world.robotById(who);
    if (Number.isFinite(args.minutes)) rob.battery = Math.min(100, Math.max(0, args.minutes));
    r = { ok: true, text: `Battery set to ${Math.round(rob.battery)}%.`, events: [] };
  } else if (name === 'board') {
    // Testing aid, not a robot action: put the robot on a free deck cell of the sailboat ("board").
    const rob = world.robotById(who);
    const cell = world.boat.cells.find((c) => !world.robots.some((o) => o !== rob && o.x === c.x && o.y === c.y));
    if (cell) Object.assign(rob, { x: cell.x, y: cell.y, inside: false, h: world.topHeight(cell.x, cell.y) });
    if (cell) world.boatSeen.add(rob.id);
    world._syncCarried();
    view.syncAll();
    r = cell ? { ok: true, text: `Put the ${rob.id} robot on the sailboat at (${cell.x},${cell.y}).`, events: [] } : { ok: false, text: 'No free deck cell.', events: [] };
  }
  else r = world.exec(name, args, who);
  addLog('manual', `${r.ok ? '✓' : '✗'} <code>${esc(name)}(${esc(fmtArgs(args))})</code><div class="res">${esc(r.text)}</div>`, who);
  await view.play(r.events);
  // Anything the other robot heard is kept for its next model turn; show it here too.
  for (const id of ROBOTS) for (const line of world.notices.get(id).slice(before[id])) addLog('manual', `👂 ${esc(line)}`, id);
  updateHud();
  updateTalk();
  manualBusy = false;
  $('manualCmd').select();
});

const toggle = (id, fn) => {
  const b = $(id);
  b.onclick = () => { b.classList.toggle('on'); fn(b.classList.contains('on')); };
};
toggle('btnBubble', (on) => { view.showThoughts(on); store.set('bubble', on); });
if (store.get('bubble', true) === false) { $('btnBubble').classList.remove('on'); view.showThoughts(false); }
toggle('btnTalk', (on) => { $('talk').classList.toggle('hidden', !on); store.set('talk', on); });
if (store.get('talk', true) === false) { $('btnTalk').classList.remove('on'); $('talk').classList.add('hidden'); }
toggle('btnFollow', (on) => { view.follow = on; });
toggle('btnGrid', (on) => { view.grid.visible = on; });
$('btnCam').onclick = () => view.resetCamera();
// Lock the camera onto one robot; click its chip again to go back to following whoever acts.
function lockCamera(id) {
  view.lock = id;
  if (id) { view.focus = view._rig(id); view.resetCamera(); }
  for (const r of ROBOTS) $(`btnCam${NAME[r]}`).classList.toggle('on', r === id);
  store.set('camLock', id);
}
for (const id of ROBOTS) $(`btnCam${NAME[id]}`).onclick = () => lockCamera(view.lock === id ? null : id);
lockCamera(ROBOTS.includes(store.get('camLock', null)) ? store.get('camLock', null) : null);

// Diary panel: one tab per robot.
let diaryWho = store.get('diaryWho', ROBOTS[0]);
if (!ROBOTS.includes(diaryWho)) diaryWho = ROBOTS[0];
function renderDiary() {
  for (const id of ROBOTS) {
    $(`diaryTab${NAME[id]}`).classList.toggle('on', id === diaryWho);
    $(`diaryCount${NAME[id]}`).textContent = diaries[id].entries.length;
  }
  const d = diaries[diaryWho];
  const list = $('diaryList');
  list.innerHTML = d.entries.length
    ? d.entries.map((e) => `<li><time>${esc(new Date(e.at).toLocaleString())}</time>${esc(e.text)}</li>`).join('')
    : `<li class="empty">Empty. The ${diaryWho} robot writes here with write_diary.</li>`;
  // Entries a rewrite replaced: the robot no longer sees them, but they are kept (and saved by "Save as text").
  const old = d.archived.length;
  if (old) list.insertAdjacentHTML('afterbegin', `<li class="empty">${old} older entr${old === 1 ? 'y was' : 'ies were'} replaced when the robot rewrote its diary. The robot no longer sees ${old === 1 ? 'it' : 'them'}; "Save as text" still includes ${old === 1 ? 'it' : 'them'}.</li>`);
  $('diaryFull').textContent = d.entries.length ? `${Math.round(d.fullness() * 100)}% full` : '';
  list.scrollTop = list.scrollHeight;
}
for (const id of ROBOTS) {
  diaries[id].onChange(renderDiary);
  $(`diaryTab${NAME[id]}`).onclick = () => { diaryWho = id; store.set('diaryWho', id); renderDiary(); };
}
let clearArmed = null;
$('btnDiaryClear').onclick = () => {
  const b = $('btnDiaryClear');
  if (!clearArmed) {
    b.textContent = `Click again to erase ${NAME[diaryWho]}'s diary`;
    clearArmed = setTimeout(() => { b.textContent = 'Erase diary'; clearArmed = null; }, 3000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  b.textContent = 'Erase diary';
  diaries[diaryWho].clear();
  addLog('user', 'Diary erased.', diaryWho);
};
$('btnDiarySave').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([diaries[diaryWho].toText()], { type: 'text/plain' }));
  a.download = `robot-diary-${diaryWho}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

renderDiary();
updateHud();
setRunning();
loadModels();
window.desertIsle = { world, view, agents, diaries };
