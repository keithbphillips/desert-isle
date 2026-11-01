import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, CFG, LAYOUT, PARTS, ISLANDS, isLandAt, islandAt, skyAt } from '../public/js/world.js';
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
import { parseTextToolCalls, TOOLS, Agent, MEMORY_NUDGE } from '../public/js/agent.js';
import { Diary, DIARY_LIMIT, REWRITE_MAX } from '../public/js/diary.js';

const ok = (w, name, args) => {
  const r = w.exec(name, args);
  assert.ok(r.ok, `${name} ${JSON.stringify(args)} failed: ${r.text}`);
  return r;
};
const fails = (w, name, args, re) => {
  const r = w.exec(name, args);
  assert.equal(r.ok, false, `${name} should fail`);
  if (re) assert.match(r.text, re);
  return r;
};

test('initial island has the requested contents', () => {
  const w = new World();
  const blocks = [...w.items.values()].filter((i) => i.type === 'block');
  assert.equal(blocks.length, 12 + LAYOUT.blocks2.length + LAYOUT.blocks3.length + LAYOUT.blocks4.length);
  assert.equal(w.items.get('rock').state, 'stacked');
  assert.equal(w.items.has('ring'), !!LAYOUT.ring);
  for (const p of [...LAYOUT.palms, ...(LAYOUT.ring ? [LAYOUT.ring] : []), LAYOUT.rock, LAYOUT.robot]) assert.ok(isLandAt(p.x, p.y), `(${p.x},${p.y}) on land`);
  assert.equal(w.terrainAt(w.dock.x0, w.dock.yEnd), 'dock');
  assert.ok(!isLandAt(w.dock.x0, w.dock.yEnd), 'dock end is over water');
  assert.ok([...w.terrain.values()].includes('water'));
});

test('walking cannot climb a block but jumping can', () => {
  const w = new World();
  ok(w, 'walk_to', { x: 1, y: -4 });
  fails(w, 'walk_to', { x: 2, y: -4 }, /jump_to/);
  ok(w, 'jump_to', { x: 2, y: -4 });
  assert.equal(w.robot.h, 1);
  fails(w, 'jump_to', { x: 5, y: -4 }, /cells away/);
  ok(w, 'jump_to', { x: 2, y: -2 }); // jump down
  assert.equal(w.robot.h, 0);
});

test('only the top block of a stack can be picked up, and stacking raises the top', () => {
  const w = new World();
  ok(w, 'walk_to', { target: 'block_7' });
  fails(w, 'pick_up', { item: 'block_7' }, /under block_8/);
  ok(w, 'pick_up', { item: 'Block 8' });
  fails(w, 'pick_up', { item: 'block_7' }, /hands are full/);
  const r = w.robot;
  const cell = { x: r.x + (r.x === 5 ? 1 : 0), y: r.y + (r.x === 5 ? 0 : 1) };
  ok(w, 'put_down', cell);
  assert.equal(w.topHeight(cell.x, cell.y), 1);
  fails(w, 'put_down', { x: r.x, y: r.y }, /not holding/);
});

test('cannot put a block on your own cell or far away', () => {
  const w = new World();
  ok(w, 'walk_to', { target: 'block_1' });
  ok(w, 'pick_up', { item: 'block_1' });
  fails(w, 'put_down', { x: w.robot.x, y: w.robot.y }, /standing on/);
  fails(w, 'put_down', { x: w.robot.x + 3, y: w.robot.y }, /throw/);
});

test('thrown rock spawns 4 blocks and stays reusable; in the sea it skips back to land', () => {
  const w = new World();
  ok(w, 'walk_to', { target: 'rock' });
  ok(w, 'pick_up', { item: 'rock' });
  const r = ok(w, 'throw', { x: -2, y: -8 });
  assert.match(r.text, /4 wooden crates appeared/);
  assert.equal([...w.items.values()].filter((i) => i.type === 'block').length, 16 + LAYOUT.blocks2.length + LAYOUT.blocks3.length + LAYOUT.blocks4.length);
  assert.ok(r.events.some((e) => e.type === 'spawn'));
  const rock = w.items.get('rock');
  assert.equal(rock.state, 'stacked');
  ok(w, 'walk_to', { target: 'rock' });
  ok(w, 'pick_up', { item: 'rock' });
  ok(w, 'walk_to', { x: 0, y: -14 });
  const r2 = ok(w, 'throw', { x: 6, y: -20 });
  assert.match(r2.text, /skipped/);
  assert.equal(rock.state, 'stacked');
  assert.equal(w.isWater(rock.x, rock.y), false);
  assert.equal([...w.items.values()].filter((i) => i.type === 'block').length, 20 + LAYOUT.blocks2.length + LAYOUT.blocks3.length + LAYOUT.blocks4.length);
  ok(w, 'walk_to', { target: 'rock' });
  ok(w, 'pick_up', { item: 'rock' }); // still reusable
  ok(w, 'walk_to', { x: 0, y: w.dock.yEnd });
  ok(w, 'put_down', { x: -1, y: w.dock.yEnd });
  assert.equal(w.isWater(rock.x, rock.y), false);
});

test('look only reveals small things within sight; status gives no hints', () => {
  const w = new World();
  const seen = w.exec('look').text;
  assert.match(seen, /tower/);
  assert.match(seen, /block_1 /);
  assert.doesNotMatch(seen, /block_12 /); // (2,6) is beyond sight from (0,-2)
  assert.match(seen, /Too far away to make out/);
  assert.doesNotMatch(w.status(), /pick up|jump/i);
  ok(w, 'walk_to', { x: 1, y: 4 });
  assert.match(w.exec('look').text, /block_12 /);
});

test('diary keeps entries and reads them back', async () => {
  const { Diary } = await import('../public/js/diary.js');
  let saved = null;
  const d = new Diary({ load: () => null, save: (e) => { saved = e; } });
  assert.match(d.read(), /empty/);
  assert.equal(d.write('Crates stack.'), 1);
  assert.equal(d.write('   '), null);
  d.write('The rock makes crates.');
  assert.equal(saved.length, 2);
  assert.match(d.read(), /#2 .*rock makes crates/);
  const d2 = new Diary({ load: () => saved, save: () => {} });
  assert.equal(d2.entries.length, 2);
});

test('blocks float in water, can be fished out, and can be stood on as a raft', () => {
  const w = new World();
  const yEnd = w.dock.yEnd;
  ok(w, 'walk_to', { target: 'block_1' });
  ok(w, 'pick_up', { item: 'block_1' });
  ok(w, 'walk_to', { x: 0, y: yEnd });
  fails(w, 'jump_to', { x: -1, y: yEnd }, /cannot swim/);
  ok(w, 'put_down', { x: -1, y: yEnd });
  assert.ok(w.isRaft(-1, yEnd));
  assert.ok(Math.abs(w.topHeight(-1, yEnd) - CFG.dockHeight) < 1e-9, 'a floating crate is level with the dock');
  ok(w, 'pick_up', { item: 'block_1' }); // fish it back out
  ok(w, 'put_down', { x: -1, y: yEnd });
  ok(w, 'walk_to', { x: -1, y: yEnd }); // level with the dock, so you can step onto it
  assert.equal(w.robot.x, -1);
  ok(w, 'jump_to', { x: 0, y: yEnd });
  ok(w, 'jump_to', { x: -1, y: yEnd });
  fails(w, 'pick_up', { item: 'block_1' }, /standing on/);
  // More crates stack on the raft.
  ok(w, 'jump_to', { x: 0, y: yEnd });
  ok(w, 'walk_to', { target: 'block_2' });
  ok(w, 'pick_up', { item: 'block_2' });
  ok(w, 'walk_to', { x: 0, y: yEnd });
  ok(w, 'put_down', { x: -1, y: yEnd });
  assert.ok(Math.abs(w.topHeight(-1, yEnd) - (CFG.dockHeight + 1)) < 1e-9);
  ok(w, 'jump_to', { x: -1, y: yEnd });
  // The rock lands on a raft instead of skipping back to shore.
  ok(w, 'jump_to', { x: 0, y: yEnd });
  ok(w, 'walk_to', { target: 'rock' });
  ok(w, 'pick_up', { item: 'rock' });
  ok(w, 'walk_to', { x: 0, y: yEnd + 1 });
  const r = ok(w, 'throw', { x: -1, y: yEnd });
  assert.doesNotMatch(r.text, /skipped/);
  assert.equal(w.topItem(-1, yEnd), 'rock');
  assert.match(w.exec('look').text, /floating in the water/);
});

test('the ring needs a 3-block staircase and floats back up when released', { skip: !LAYOUT.ring && 'the ring is switched off' }, () => {
  const w = new World();
  const ring = w.items.get('ring');
  ok(w, 'walk_to', { target: 'ring' });
  fails(w, 'pick_up', { item: 'ring' }, /too high/);
  // Build stacks of 1, 2, 3 at (-1,6), (-2,6)... directly by test helper, then climb.
  const place = (x, y, n) => { for (let i = 0; i < n; i++) w._stack(w._newBlock(), x, y); };
  place(0, 6, 1); place(-1, 6, 2); place(-2, 6, 3);
  ok(w, 'walk_to', { x: 1, y: 6 });
  ok(w, 'jump_to', { x: 0, y: 6 });
  ok(w, 'jump_to', { x: -1, y: 6 });
  ok(w, 'jump_to', { x: -2, y: 6 });
  assert.equal(w.robot.h, 3);
  ok(w, 'pick_up', { item: 'the ring' });
  ok(w, 'jump_to', { x: -2, y: 4 });
  ok(w, 'put_down', { x: -3, y: 4 });
  assert.equal(ring.state, 'hover');
  assert.equal(ring.alt, CFG.ringAltitude);
});

test('a 3-block staircase reaches the tower top', () => {
  const w = new World();
  const t = LAYOUT.tower;
  const place = (x, y, n) => { for (let i = 0; i < n; i++) w._stack(w._newBlock(), x, y); };
  const y = t.y0;
  place(t.x1 + 3, y, 1); place(t.x1 + 2, y, 2); place(t.x1 + 1, y, 3);
  ok(w, 'walk_to', { x: t.x1 + 4, y });
  for (let dx = 3; dx >= 1; dx--) ok(w, 'jump_to', { x: t.x1 + dx, y });
  ok(w, 'jump_to', { x: t.x1, y });
  assert.equal(w.robot.h, CFG.towerHeight);
  ok(w, 'jump_to', { x: t.x1 + 2, y: y - 2 }); // jump all the way down is fine
});

test('throwing at the hut bounces to a free cell', () => {
  const w = new World();
  ok(w, 'walk_to', { target: 'block_11' });
  ok(w, 'pick_up', { item: 'block_11' });
  const r = ok(w, 'throw', { x: 7, y: 5 });
  assert.match(r.text, /bounced/);
  const b = w.items.get('block_11');
  assert.notEqual(w.terrainAt(b.x, b.y), 'hut');
});

test('text tool calls are recovered', () => {
  const calls = parseTextToolCalls('I will go. {"name": "walk_to", "arguments": {"x": 3, "y": 4}}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'walk_to');
  assert.deepEqual(calls[0].function.arguments, { x: 3, y: 4 });
});

test('compact shortens old tool results but keeps the start and the recent turns', async () => {
  const { compact } = await import('../public/js/agent.js');
  const big = 'x'.repeat(4000);
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'instruction' }];
  for (let i = 0; i < 40; i++) msgs.push({ role: 'assistant', content: '' }, { role: 'tool', content: `look ${i}\n${big}` });
  const cut = compact(msgs, 16384);
  assert.ok(cut > 0);
  assert.equal(msgs[1].content, 'instruction');
  assert.match(msgs[3].content, /shortened/);
  assert.equal(msgs.at(-1).content.length, big.length + 'look 39\n'.length);
  assert.equal(compact([{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }], 16384), 0);
});

test('thought bubble keeps the main thought and drops world details', async () => {
  const { thoughtGist } = await import('../public/js/gist.js');
  assert.equal(thoughtGist("The hut's door is at (7,3). I'm at (0,-2). Let me walk there."), 'Let me walk there.');
  assert.equal(thoughtGist('Let me walk to block_5 at (-3,2).', { final: true }), 'Let me walk to a crate there.');
  assert.equal(thoughtGist('The ring is at (-3,7), 5.6 m up.\n- block_4 at (-2,2)\n- block_5 at (-3,2)', { final: true }), null);
  assert.equal(thoughtGist('Let me walk to (-3,3) or (-2,2) which is adjacent.', { final: true }), null);
  assert.equal(thoughtGist('Maybe I can stack crates. Let me try picking'), 'Maybe I can stack crates.'); // ignores the unfinished sentence
  assert.equal(thoughtGist('I need to stand above 3.0 m to reach it.'), 'I need to stand above 3.0 m to reach it.');
  assert.equal(thoughtGist('Let me check. I need to stand at a height of 3.'), 'Let me check.'); // "3." may become "3.0 m"
  assert.equal(thoughtGist('The task says "go there." So I should walk now.'), 'So I should walk now.');
});

test('the robot is never done: stopping means a diary turn, then the intro prompt again', async () => {
  const { Agent } = await import('../public/js/agent.js');
  const { Diary } = await import('../public/js/diary.js');
  const call = (name, args = {}) => ({ tool_calls: [{ function: { name, arguments: args } }] });
  const script = [
    { content: "I'm finished." },                // decides to stop (no tool call)
    call('write_diary', { text: 'lesson 1' }),    // diary-only turn
    call('look'),                                 // fresh session
    call('done', { summary: 'all done' }),        // a made-up done call also means stopping
    { content: 'nothing to add' },                // diary-only turn, writes nothing
    call('look'),                                 // third session; this is the last allowed turn
    call('write_diary', { text: 'out of time' }), // diary turn at the turn limit
  ];
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push(body);
    const m = script[requests.length - 1];
    return new Response(`${JSON.stringify({ message: { role: 'assistant', content: m.content || '', tool_calls: m.tool_calls } })}\n${JSON.stringify({ done: true, done_reason: 'stop' })}\n`);
  };
  try {
    const diary = new Diary({ load: () => [], save: () => {} });
    const events = [];
    const agent = new Agent(new World(), diary, {
      play: async () => {},
      settings: () => ({ model: 'm', think: false, temperature: 0, numCtx: 16384, maxSteps: 6 }),
      onEvent: (t, d) => events.push([t, d]),
    });
    await agent.run('Explore.');
    assert.equal(requests.length, 7);
    assert.deepEqual(requests[1].tools.map((t) => t.function.name), ['write_diary']);
    assert.equal(requests[2].messages.length, 2, 'session 2 starts from the intro prompt only');
    assert.match(requests[2].messages[1].content, /^INSTRUCTION: Explore\./);
    assert.match(requests[2].messages[1].content, /YOUR DIARY[\s\S]*lesson 1/);
    assert.equal(requests[5].messages.length, 2, 'session 3 starts fresh too');
    assert.ok(!requests[0].tools.some((t) => t.function.name === 'done'), 'there is no done tool');
    assert.deepEqual(events.filter(([t]) => t === 'restart').map(([, d]) => d.session), [2, 3]);
    assert.deepEqual(diary.entries.map((e) => e.text), ['lesson 1', 'out of time']);
    assert.ok(agent.canContinue);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the hut can be entered through its doorway, and its walls block everything else', () => {
  const w = new World();
  const hut = LAYOUT.hut;
  ok(w, 'walk_to', { target: 'block_11' });
  ok(w, 'pick_up', { item: 'block_11' });
  const r = ok(w, 'walk_to', { x: 8, y: 5 }); // a cell inside the hut
  assert.match(r.text, /went in through the hut's doorway/);
  assert.equal(w.robot.inside, true);
  const path = r.events.find((e) => e.type === 'walk').path;
  const door = path.findIndex((p) => p.inside);
  assert.deepEqual([path[door - 1].x, path[door - 1].y, path[door].x, path[door].y], [hut.door.x, hut.door.y, hut.doorIn.x, hut.doorIn.y], 'enters only via the doorway');
  assert.match(w.exec('look').text, /You are inside the hut/);
  assert.doesNotMatch(w.exec('look').text, /block_1 /, "can't see outside");
  ok(w, 'walk_to', { x: 9, y: 6 });
  fails(w, 'put_down', { x: 10, y: 7 }, /wall is in the way/); // adjacent, but outside
  ok(w, 'walk_to', { x: 8, y: 5 });
  fails(w, 'throw', { x: 2, y: 2 }, /walls are in the way/);
  ok(w, 'put_down', { x: 9, y: 5 });
  assert.equal(w.items.get('block_11').inside, true);
  assert.equal(w.topHeight(9, 5, true), 1);
  // Headroom: the hut ceiling is 2.8 m, so the robot (1.7 m) can stand on one crate but not two.
  ok(w, 'jump_to', { x: 9, y: 5 });
  assert.equal(w.robot.h, 1);
  ok(w, 'jump_to', { x: 8, y: 5 });
  // Outside, the crate can't be seen or reached through the wall.
  ok(w, 'walk_to', { x: 10, y: 5 });
  assert.equal(w.robot.inside, false);
  fails(w, 'pick_up', { item: 'block_11' }, /inside the hut; go in/);
  fails(w, 'put_down', { x: 9, y: 5 }, /not holding/);
  assert.doesNotMatch(w.exec('look').text, /block_11/);
  fails(w, 'jump_to', { x: 9, y: 5 }, /hut's roof/);
});

test('the tower has a room inside and a separate roof on top', () => {
  const w = new World();
  const t = LAYOUT.tower;
  ok(w, 'walk_to', { x: -8, y: -5 });
  assert.equal(w.robot.inside, true, 'walking to a tower cell from the ground goes inside, not onto the roof');
  assert.equal(w.robot.h, 0);
  ok(w, 'walk_to', { target: 'tower_door' });
  assert.equal(w.robot.inside, false);
  ok(w, 'walk_to', { target: 'inside_tower' });
  assert.deepEqual([w.robot.x, w.robot.y, w.robot.inside], [t.doorIn.x, t.doorIn.y, true]);
  // Something on the roof and something inside the same cell are separate.
  w._stack(w._newBlock(), -8, -5, false);
  assert.equal(w.topHeight(-8, -5, false), CFG.towerHeight + 1);
  assert.equal(w.topHeight(-8, -5, true), 0);
  assert.doesNotMatch(w.exec('look').text, /block_13/);
});

test('the ring can be carried indoors, where it floats just under the ceiling', { skip: !LAYOUT.ring && 'the ring is switched off' }, () => {
  const w = new World();
  const ring = w.items.get('ring');
  w.robot.holding = 'ring';
  ring.state = 'held';
  ok(w, 'walk_to', { x: 7, y: 5 });
  ok(w, 'put_down', { x: 8, y: 5 });
  assert.equal(ring.inside, true);
  assert.ok(Math.abs(ring.alt - (CFG.hutHeight - 0.4)) < 1e-9);
  ok(w, 'pick_up', { item: 'ring' }); // within reach indoors
});

test("a tool call Ollama can't decode is retried instead of ending the run", async () => {
  const { Agent } = await import('../public/js/agent.js');
  const { Diary } = await import('../public/js/diary.js');
  const xmlError = { error: 'XML syntax error on line 4: element <function> closed by </parameter>' };
  const call = (name, args = {}) => ({ tool_calls: [{ function: { name, arguments: args } }] });
  const script = [
    xmlError,                                   // turn 1: garbled call...
    call('look'),                               // ...retried, and works
    { content: 'I am finished.' },              // stops -> diary turn
    xmlError, xmlError, xmlError,               // diary turn fails 3 times -> skipped, run goes on
    call('look'),                               // fresh session, last turn
    call('write_diary', { text: 'ok' }),        // out-of-turns diary turn
  ];
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    requests.push(JSON.parse(opts.body));
    const m = script[requests.length - 1];
    if (m.error) return new Response(`${JSON.stringify({ error: m.error })}\n`);
    return new Response(`${JSON.stringify({ message: { role: 'assistant', content: m.content || '', tool_calls: m.tool_calls } })}\n${JSON.stringify({ done: true, done_reason: 'stop' })}\n`);
  };
  try {
    const diary = new Diary({ load: () => [], save: () => {} });
    const events = [];
    const agent = new Agent(new World(), diary, {
      play: async () => {},
      settings: () => ({ model: 'm', think: false, temperature: 0, numCtx: 16384, maxSteps: 4 }),
      onEvent: (t, d) => events.push([t, d]),
    });
    await agent.run('Explore.');
    assert.equal(requests.length, script.length);
    assert.match(requests[1].messages.at(-1).content, /could not be read/);
    assert.ok(!events.some(([t, d]) => t === 'error' && /XML/.test(d)), 'no fatal error');
    assert.ok(events.some(([t, d]) => t === 'note' && /skipped/.test(d)));
    assert.deepEqual(events.filter(([t]) => t === 'restart').map(([, d]) => d.session), [2]);
    assert.deepEqual(diary.entries.map((e) => e.text), ['ok']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------- second island, second robot, rafts and paddles ----------

test('the small island holds the blue robot, crates and palms, across open water', () => {
  const w = new World();
  const blue = w.robotById('blue');
  assert.equal(islandAt(blue.x, blue.y), 1);
  for (const [x, y] of LAYOUT.blocks2) assert.equal(islandAt(x, y), 1);
  assert.ok(LAYOUT.palms.some((p) => islandAt(p.x, p.y) === 1));
  // No land between the islands along y = 1, and the gap is wider than a throw.
  let gap = 0;
  for (let x = 0; x < blue.x; x++) if (!isLandAt(x, 1) && w.terrainAt(x, 1) === 'water') gap++;
  assert.ok(gap > CFG.throwRange, `gap ${gap}`);
  assert.match(w.exec('look', {}, 'blue').text, /another island across the water to the west/);
  assert.match(w.exec('look', {}, 'blue').text, /You are the blue robot/);
});

test('robots block each other and see each other up close', () => {
  const w = new World();
  const blue = w.robotById('blue');
  Object.assign(blue, { x: 2, y: -2 });
  fails(w, 'walk_to', { x: 2, y: -2 }, /cannot stand/i);
  fails(w, 'jump_to', { x: 2, y: -2 }, /blue robot is standing/);
  w._detach('block_1');
  w.items.get('block_1').state = 'held';
  w.robot.holding = 'block_1';
  Object.assign(w.robot, { x: 1, y: -2 });
  fails(w, 'put_down', { x: 2, y: -2 }, /blue robot is standing/);
  fails(w, 'pick_up', { item: 'block_2' }, /2 cells away|hands are full/);
  const seen = w.exec('look').text;
  assert.match(seen, /blue_robot: another robot like you, painted blue, at \(2,-2\)/);
  ok(w, 'walk_to', { target: 'blue robot' });
  assert.ok(Math.max(Math.abs(w.robot.x - 2), Math.abs(w.robot.y + 2)) <= 1);
});

test('speech carries to a robot in range and is reported once', () => {
  const w = new World();
  ok(w, 'say', { text: 'hello?' });
  assert.deepEqual(w.takeNotices('blue'), [], 'too far to hear');
  Object.assign(w.robotById('blue'), { x: 10, y: -2 });
  ok(w, 'say', { text: 'hello?' });
  const heard = w.takeNotices('blue');
  assert.equal(heard.length, 1);
  assert.match(heard[0], /orange robot .* say: "hello\?"/);
  assert.deepEqual(w.takeNotices('blue'), []);
  Object.assign(w.robotById('blue'), { x: 0, y: 15 });
  ok(w, 'say', { text: 'anyone?' });
  assert.match(w.takeNotices('blue')[0], /a voice from somewhere/);
});

test('a frond is torn off an adjacent palm, washes ashore and runs out', () => {
  const w = new World();
  const palm = LAYOUT.palms[0];
  fails(w, 'pick_up', { item: 'palm' }, /no palm tree next to you/);
  ok(w, 'walk_to', { target: 'palm' });
  const r = ok(w, 'pick_up', { item: 'palm tree' });
  const torn = `frond_${LAYOUT.fronds.length + 1}`;
  assert.match(r.text, new RegExp(torn));
  assert.equal(w.robot.holding, torn);
  ok(w, 'put_down', { x: w.robot.x + (w.robot.x === palm.x ? 1 : 0), y: w.robot.y + (w.robot.x === palm.x ? 0 : 1) });
  ok(w, 'pick_up', { item: 'frond' });
  ok(w, 'walk_to', { x: 0, y: w.dock.yEnd });
  ok(w, 'throw', { x: 6, y: w.dock.yEnd });
  const f = w.items.get(torn);
  assert.equal(w.isWater(f.x, f.y), false, 'frond washed ashore');
  ok(w, 'walk_to', { target: 'palm' });
  const near = LAYOUT.palms.find((p) => Math.max(Math.abs(p.x - w.robot.x), Math.abs(p.y - w.robot.y)) <= 1);
  w.frondsTaken.set(`${near.x},${near.y}`, CFG.frondsPerPalm);
  fails(w, 'pick_up', { item: 'frond from the palm' }, /too high to reach/);
});

// Builds a raft of two crates off the end of the dock with the orange robot on it holding a frond.
function raftOffDock() {
  const w = new World();
  const d = w.dock;
  const put = (id, x, y) => { w._detach(id); w._stack(id, x, y); };
  put('block_1', d.x0, d.yEnd - 1);
  put('block_2', d.x1, d.yEnd - 1);
  w.items.set('frond_99', { id: 'frond_99', type: 'frond', state: 'held', x: 0, y: 0 });
  w.frondCount = 1;
  Object.assign(w.robot, { x: d.x0, y: d.yEnd - 1, h: w.topHeight(d.x0, d.yEnd - 1), holding: 'frond_99' });
  return w;
}

test('paddling needs a frond, a raft of two crates and open water', () => {
  const w = raftOffDock();
  fails(w, 'paddle', { direction: 'north' }, /up against the dock/);
  fails(w, 'paddle', {}, /needs a direction/);
  w.robot.holding = null;
  fails(w, 'paddle', { direction: 'south' }, /bare hands/);
  w.robot.holding = 'frond_99';
  w._detach('block_2');
  fails(w, 'paddle', { direction: 'south' }, /just spins in place/);
  const w2 = new World();
  w2.items.set('frond_99', { id: 'frond_99', type: 'frond', state: 'held', x: 0, y: 0 });
  w2.robot.holding = 'frond_99';
  fails(w2, 'paddle', { direction: 'east' }, /nothing happens/);
});

test('a raft carries its crates, its load and a passenger, and stops at the shore', () => {
  const w = raftOffDock();
  const d = w.dock;
  const blue = w.robotById('blue');
  Object.assign(blue, { x: d.x1, y: d.yEnd - 1, h: w.topHeight(d.x1, d.yEnd - 1) });
  const r = ok(w, 'paddle', { direction: 'south', strokes: 3 });
  assert.match(r.text, /moved 3 cells/);
  assert.deepEqual([w.robot.x, w.robot.y], [d.x0, d.yEnd - 4]);
  assert.deepEqual([blue.x, blue.y], [d.x1, d.yEnd - 4]);
  assert.deepEqual(w.column(d.x1, d.yEnd - 4), ['block_2']);
  assert.equal(w.column(d.x1, d.yEnd - 1).length, 0);
  assert.match(w.takeNotices('blue')[0], /crates under you suddenly moved 3 cells south/);
  // West with the default strokes, out to the edge of the map (east now runs into the natives' south island).
  let last;
  for (let i = 0; i < 20; i++) {
    last = w.exec('paddle', { direction: 'west' });
    if (!last.ok || /bumped/.test(last.text)) break;
  }
  assert.ok(/bumped|up against/.test(last.text), last.text);
  assert.match(last.text, /strong current/);
  assert.match(w.exec('look').text, /then a strong current/);
  // Paddle by naming a cell: the direction toward it.
  const w2 = raftOffDock();
  ok(w2, 'paddle', { x: w2.robot.x + 5, y: w2.robot.y - 5, strokes: 1 });
  assert.equal(w2.robot.x, w2.dock.x0 + 1);
});

test('a raft can reach the other island and the robot can walk ashore', () => {
  const w = raftOffDock();
  ok(w, 'paddle', { direction: 'south', strokes: 1 });
  for (let i = 0; i < 12 && w.robot.y < 1; i++) ok(w, 'paddle', { direction: 'north-east' });
  for (let i = 0; i < 12; i++) {
    const r = w.exec('paddle', { direction: 'east' });
    if (!r.ok) break;
  }
  const blue = w.robotById('blue');
  const r = ok(w, 'walk_to', { target: 'blue_robot' });
  assert.equal(islandAt(w.robot.x, w.robot.y), 1, r.text);
  assert.ok(Math.hypot(w.robot.x - blue.x, w.robot.y - blue.y) < 2);
});

test('with the ring switched off, nothing mentions it', () => {
  if (LAYOUT.ring) return;
  const w = new World();
  assert.doesNotMatch(w.exec('look').text, /\bring\b/i);
  assert.doesNotMatch(w.exec('describe').text, /- ring/);
  fails(w, 'pick_up', { item: 'ring' }, /don't know of anything called/);
});

test('nothing the robots read hints at how to cross the water', () => {
  const w = new World();
  const hint = /paddle with|\braft|floating crate|broad|flat blade|beside it|sharing a side|something long|while standing on/i;
  assert.doesNotMatch(w.exec('look').text, hint);
  assert.doesNotMatch(w.exec('look', {}, 'blue').text, hint);
  const paddleTool = TOOLS.find((t) => t.function.name === 'paddle');
  assert.doesNotMatch(JSON.stringify(paddleTool), /standing|holding|raft|float|cell/i);
  assert.equal(w.resolveItem('paddle'), null);
  // Failures say what happened, not what would work.
  w.items.set('frond_99', { id: 'frond_99', type: 'frond', state: 'held', x: 0, y: 0 });
  w.robot.holding = 'frond_99';
  assert.doesNotMatch(w.exec('paddle', { direction: 'east' }).text, hint);
  ok(w, 'walk_to', { target: 'palm' });
  w.robot.holding = null;
  w.items.delete('frond_99');
  assert.doesNotMatch(ok(w, 'pick_up', { item: 'palm' }).text, hint);
});

test('a robot is switched on with its diary, and reminded when it neglects it', () => {
  const w = new World();
  const diary = new Diary({ load: () => [], save: () => {} });
  const agent = new Agent(w, diary, { onEvent() {} }, 'blue');
  agent.instruction = 'Explore.';
  assert.match(agent.intro({}).at(-1).content, /Your diary is empty/);
  diary.write('Crates float in the water.');
  const intro = agent.intro({}).at(-1).content;
  assert.match(intro, /You are the blue robot/);
  assert.match(intro, /YOUR DIARY[\s\S]*Crates float in the water/);
  let read = '';
  let wrote = '';
  for (let i = 1; i <= MEMORY_NUDGE.read; i++) {
    const n = agent.memoryNudge(['look']);
    if (/read_diary/.test(n)) read ||= `${i}`;
    if (/written in your diary/.test(n)) wrote ||= `${i}`;
  }
  assert.equal(read, `${MEMORY_NUDGE.read}`);
  assert.equal(wrote, `${MEMORY_NUDGE.write}`);
  assert.equal(agent.memoryNudge(['read_diary', 'write_diary']), '');
});

test('time passes with every action and the sun crosses the sky from east to west', () => {
  const w = new World();
  const t0 = w.minutes;
  ok(w, 'look');
  assert.ok(w.minutes > t0);
  const m = w.minutes;
  ok(w, 'walk_to', { x: 0, y: 8 });
  assert.ok(w.minutes - m > 2 * w.timeScale, 'walking takes time, more for longer walks');
  assert.ok(skyAt(8 * 60).dir.x > 0 && skyAt(8 * 60).dir.h > 0, 'morning sun in the east, above the horizon');
  assert.ok(skyAt(16 * 60).dir.x < 0, 'afternoon sun in the west');
  assert.ok(skyAt(12 * 60).dir.y < 0, 'midday sun to the south');
  assert.equal(skyAt(0).light, 0);
  assert.equal(skyAt(12 * 60).light, 1);
  assert.equal(skyAt(24 * 60 + 60).day, 2);
  const phases = new Set();
  for (let h = 0; h < 24; h += 0.25) phases.add(skyAt(h * 60).phase);
  assert.deepEqual([...phases].sort(), ['afternoon', 'dawn', 'dusk', 'midday', 'morning', 'night']);
});

test('the robot perceives the sky in words only, and sees less in the dark', () => {
  const w = new World();
  for (const h of [3, 6, 8, 12, 16, 18.2]) {
    w.minutes = h * 60;
    const sky = w.status().split(/Battery: \d+%\. /)[1];
    assert.ok(sky && !/\d/.test(sky), `sky words without numbers at ${h}h: ${sky}`);
  }
  w.minutes = 12 * 60;
  assert.match(w.exec('look').text, /block_1 /); // 2-3 cells away
  assert.match(w.exec('look').text, /\(-5,-2\)/); // ~5 cells away
  w.minutes = 23 * 60;
  const dark = w.exec('look').text;
  assert.match(dark, /It is dark/);
  assert.match(dark, /block_1 /);
  assert.doesNotMatch(dark, /\(-5,-2\)/);
  assert.doesNotMatch(dark, /small figure/);
  assert.doesNotMatch(dark, /Too far away to make out/);
  Object.assign(w.robotById('blue'), { x: 8, y: -2 });
  assert.doesNotMatch(w.exec('look').text, /blue_robot/, 'another robot 8 cells away is lost in the dark');
  w.minutes = 12 * 60;
  assert.match(w.exec('look').text, /blue_robot/);
});

test('the volcano island: hidden from the ground, its tip seen from the tower, whole when near, and reachable', () => {
  const w = new World();
  const ground = w.exec('look').text;
  assert.doesNotMatch(ground, /volcano/i);
  assert.doesNotMatch(ground, /\(-16,72\)|\(-3,79\)/, 'its palms are not listed');
  // From the tower top: only the tip.
  Object.assign(w.robot, { x: -8, y: -5, h: CFG.towerHeight });
  const tower = w.exec('look').text;
  assert.match(tower, /tip of a volcano/);
  assert.doesNotMatch(tower, /- volcano:|\(-16,72\)/);
  w.minutes = 23 * 60;
  assert.match(w.exec('look').text, /red glow on the horizon/);
  w.minutes = 12 * 60;
  // Out on the water, closer: the whole island.
  Object.assign(w.robot, { x: -8, y: 45, h: 0.3 });
  const near = w.exec('look').text;
  assert.match(near, /an island with a tall volcano/);
  assert.match(near, /- volcano: a steep cone/);
  assert.match(near, /\(-16,72\)/);
  // On the island: the volcano is an obstacle, the sand around it is walkable.
  Object.assign(w.robot, { x: -10, y: 64, h: 0 });
  assert.equal(islandAt(-10, 64), 2);
  fails(w, 'walk_to', { x: -10, y: 75 }, /cannot stand/i);
  ok(w, 'walk_to', { target: 'volcano' });
  ok(w, 'walk_to', { x: -10, y: 84 }); // round the volcano to the far side
});

test('fallen fronds lie under the palms, in plain sight', () => {
  const w = new World();
  for (const [i, p] of LAYOUT.fronds.entries()) assert.deepEqual(w.column(p.x, p.y), [`frond_${i + 1}`]);
  ok(w, 'walk_to', { x: 4, y: 8 });
  assert.match(w.exec('look').text, /frond_1 \(a palm frond\)/);
  assert.match(w.exec('look').text, /palm trees, their big fronds drooping low/);
  ok(w, 'pick_up', { item: 'frond_1' });
  assert.equal(w.robot.holding, 'frond_1');
});

test('compact leaves more room when asked to, and counts the tool list', async () => {
  const { compact } = await import('../public/js/agent.js');
  const make = () => {
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'instruction' }];
    for (let i = 0; i < 40; i++) msgs.push({ role: 'assistant', content: '' }, { role: 'tool', content: `look ${i}\n${'x'.repeat(4000)}` });
    return msgs;
  };
  // ~46k estimated tokens in a 64k context: fine with 8k spare, too much when a thinking model needs 20k.
  assert.equal(compact(make(), 65536), 0);
  assert.ok(compact(make(), 65536, { reserve: 20000 }) > 0);
  assert.ok(compact(make(), 65536, { charsPerToken: 2.5 }) > 0);
  assert.ok(compact(make(), 65536, { extraChars: 80000 }) > 0);
});

test('crates joined in the water are called a raft; a lone floating crate is not', () => {
  const w = new World();
  const d = w.dock;
  const put = (id, x, y) => { w._detach(id); w._stack(id, x, y); };
  put('block_1', d.x0, d.yEnd - 1);
  Object.assign(w.robot, { x: d.x1, y: d.yEnd, h: w.topHeight(d.x1, d.yEnd), holding: null });
  assert.doesNotMatch(w.exec('look').text, /raft/);
  w._detach('block_2');
  w.items.get('block_2').state = 'held';
  w.robot.holding = 'block_2';
  const r = ok(w, 'put_down', { x: d.x1, y: d.yEnd - 1 });
  assert.match(r.text, /bumped up against block_1 and they now float together as a raft of 2 crates/);
  assert.match(w.exec('look').text, /- raft of 2 crates, floating in the water: at \(\d+,-?\d+\) block_1 .*; at \(\d+,-?\d+\) block_2/);
  Object.assign(w.robot, { x: d.x0, y: d.yEnd - 1, h: w.topHeight(d.x0, d.yEnd - 1) });
  assert.match(w.statusOf('orange'), /standing on block_1, part of a raft of 2 crates/);
});

// Hand a robot an item as if it had picked it up (wherever it was).
const give = (w, r, id) => {
  w._detach(id);
  w.items.get(id).state = 'held';
  r.holding = id;
};

test('five charger parts: two on the small island, in the hut, in the tower and on its roof', () => {
  const w = new World();
  const at = PARTS.map((p, i) => w.items.get(`part_${i + 1}`));
  assert.deepEqual(at.map((it) => [it.x, it.y, it.inside]), [[46, 2, false], [9, 6, true], [-9, -4, true], [38, -1, false], [-7, -4, false]]);
  assert.equal(w.topHeight(-7, -4), CFG.towerHeight + CFG.partHeight);
  assert.match(w.exec('look', {}, 'blue').text, /part_1 \(a folding metal stand/);
  Object.assign(w.robotById('orange'), { x: 7, y: 4, inside: true });
  assert.match(w.exec('look').text, /part_2 \(a short metal arm/);
  assert.match(w.statusOf('orange'), /Battery: 99%\./, 'a few actions take a little off a full battery');
  // What the parts are for is for the robots to find out.
  const all = [w.exec('look', {}, 'blue').text, w.exec('look').text, JSON.stringify(TOOLS)].join('\n');
  assert.doesNotMatch(all, /solar|charger|recharg|assembl|sunlight/i);
});

test('stacking parts fits them together; all five make a charger that works only in daylight', () => {
  const w = new World();
  const r = w.robot;
  Object.assign(r, { x: 2, y: 0, h: 0, inside: false });
  w._detach('part_1');
  w._stack('part_1', 3, 0);
  give(w, r, 'part_2');
  const first = ok(w, 'put_down', { x: 3, y: 0 });
  assert.match(first.text, /part_2 clicked into place on part_1: they are now fitted together as device_1 \(2 parts\)/);
  assert.match(first.text, /It looks unfinished: 3 fittings are still empty \(an empty square socket, a box-shaped gap with loose plugs in it and a wide empty frame mount on top\)/);
  assert.deepEqual(w.column(3, 0), ['device_1']);
  assert.match(w.exec('look').text, /device_1 \(2 parts fitted together: a folding metal stand.*It looks unfinished: 3 fittings are still empty/);
  assert.match(fails(w, 'pick_up', { item: 'part_1' }).text, /fitted into device_1/);
  // Two more fitted elsewhere, then that group onto the first one.
  w._detach('part_3');
  w._stack('part_3', 1, 1);
  give(w, r, 'part_4');
  ok(w, 'put_down', { x: 1, y: 1 });
  ok(w, 'pick_up', { item: 'device_2' });
  assert.match(ok(w, 'put_down', { x: 3, y: 0 }).text, /device_1, which now has 4 parts.*1 fitting is still empty \(a wide empty frame mount on top\)/);
  assert.equal(w.items.has('device_2'), false);
  w.minutes = 23 * 60; // night: the last part goes in, but nothing happens
  give(w, r, 'part_5');
  assert.match(ok(w, 'put_down', { x: 3, y: 0 }).text, /last empty fitting: the machine looks complete, but it stays dark and silent/);
  assert.match(w.exec('look').text, /Every fitting is filled; nothing is missing\. Its light is dark/);
  assert.equal(w.chargerWorks(w.items.get('device_1')), false);
  w.minutes = 12 * 60;
  assert.equal(w.chargerWorks(w.items.get('device_1')), true);
  assert.match(w.exec('look').text, /green light glows/);
  // Covered over, it stops working.
  w._stack(w._newBlock(), 3, 0);
  assert.equal(w.chargerWorks(w.items.get('device_1')), false);
});

// A finished charger at (3,0), with the orange robot beside it.
function charged() {
  const w = new World();
  const dev = { id: 'device_1', type: 'device', state: 'stacked', x: 3, y: 0, inside: false, parts: [] };
  w.items.set('device_1', dev);
  PARTS.forEach((p, i) => { w._detach(`part_${i + 1}`); w._fitPart(dev, `part_${i + 1}`); });
  w._pushColumn('device_1', 3, 0);
  Object.assign(w.robot, { x: 2, y: 0, h: 0 });
  return w;
}

test('batteries run down over time and charge beside the charger in daylight', () => {
  const w = charged();
  const blue = w.robotById('blue');
  w.minutes = 10 * 60;
  w.robot.battery = 10;
  ok(w, 'wait', { minutes: 60 });
  assert.ok(Math.abs(w.robot.battery - 60) < 1e-6, `half charged after an hour: ${w.robot.battery}`);
  assert.match(w.takeNotices('orange').join(' '), /power flowing into your battery/);
  assert.match(w.statusOf('orange'), /Battery: 60%, charging\./);
  ok(w, 'wait', { minutes: 60 });
  assert.equal(w.robot.battery, 100);
  assert.match(w.takeNotices('orange').join(' '), /battery is full/);
  // Meanwhile the blue robot, far away, has been running down.
  assert.ok(Math.abs(blue.battery - (100 - (120 / (CFG.batteryHours * 60)) * 100)) < 1e-6);
  // At night nothing flows.
  w.minutes = 22 * 60;
  w.robot.battery = 50;
  ok(w, 'wait', { minutes: 60 });
  assert.ok(w.robot.battery < 50);
});

test('a flat battery stops the motors, but a robot can still look, speak and wait', () => {
  const w = new World();
  w.robot.battery = 1;
  ok(w, 'wait', { minutes: 60 });
  assert.equal(w.robot.battery, 0);
  assert.match(w.takeNotices('orange').join(' '), /battery has run out/);
  fails(w, 'walk_to', { x: 3, y: 0 }, /battery is empty/);
  fails(w, 'pick_up', { item: 'rock' }, /battery is empty/);
  ok(w, 'look');
  ok(w, 'say', { text: 'help' });
  ok(w, 'wait', { minutes: 5 });
  // Over a whole battery's life a robot that only waits runs flat.
  const w2 = new World();
  for (let i = 0; i < CFG.batteryHours; i++) w2.exec('wait', { minutes: 60 });
  assert.equal(w2.robotById('blue').battery, 0);
});

test('charger parts never stay in the sea, and a carried device keeps its parts', () => {
  const w = charged();
  const r = w.robot;
  ok(w, 'pick_up', { item: 'device_1' });
  Object.assign(r, { x: w.dock.x0, y: w.dock.yEnd, h: CFG.dockHeight });
  const t = ok(w, 'throw', { x: w.dock.x0, y: w.dock.yEnd - 6 });
  const dev = w.items.get('device_1');
  assert.notEqual(w.terrainAt(dev.x, dev.y), 'water', t.text);
  assert.equal(dev.parts.length, 5);
  assert.equal(w.resolveItem('panel'), 'part_5');
});

// Two robots whose "models" answer at different speeds, scripted instead of calling Ollama.
function scripted(w, lockstep, plan) {
  const order = [];
  const prompts = { orange: [], blue: [] };
  const agents = Object.entries(plan).map(([who, { delay, calls }]) => {
    const diary = new Diary({ load: () => [], save: () => {} });
    const a = new Agent(w, diary, { onEvent() {}, play: async () => {}, settings: () => ({ maxSteps: calls.length, numCtx: 65536, lockstep }) }, who);
    let n = 0;
    a.chatRetry = async (messages) => {
      prompts[who].push(messages.at(-1).content);
      await new Promise((r) => setTimeout(r, delay));
      const call = calls[n++];
      order.push(who);
      return { role: 'assistant', content: '', tool_calls: [{ function: call }] };
    };
    a.diaryTurn = async () => {};
    return a;
  });
  return { order, prompts, run: () => Promise.all(agents.map((a) => a.run('Explore.'))) };
}

test('taking turns keeps a fast robot in step with a slow one, and speech arrives before the next decision', async () => {
  const look = { name: 'look', arguments: {} };
  const w = new World();
  Object.assign(w.robotById('blue'), { x: 4, y: -2 }); // within earshot
  const fast = { delay: 1, calls: [look, look, look, look] };
  const slow = { delay: 150, calls: [{ name: 'say', arguments: { text: 'hello orange' } }, look, look, look] };
  const s = scripted(w, 'always', { orange: fast, blue: slow });
  await s.run();
  // Never more than one turn apart.
  let lead = 0;
  for (const who of s.order) { lead += who === 'orange' ? 1 : -1; assert.ok(Math.abs(lead) <= 1, s.order.join(' ')); }
  // Blue spoke in round 1; orange's very next decision (round 2) already has it.
  assert.match(s.prompts.orange[1], /hello orange/);
  // Without taking turns the fast robot races through all its turns first.
  const w2 = new World();
  Object.assign(w2.robotById('blue'), { x: 4, y: -2 });
  const s2 = scripted(w2, 'never', { orange: fast, blue: slow });
  await s2.run();
  assert.deepEqual(s2.order.slice(0, 4), ['orange', 'orange', 'orange', 'orange']);
});

test("'when together': robots take turns only within earshot or after talking", async () => {
  const look = { name: 'look', arguments: {} };
  const fast = { delay: 1, calls: [look, look, look, look] };
  const slow = { delay: 150, calls: [look, look, look, look] };
  // Far apart (on their own islands) and silent: each at its own pace.
  const apart = scripted(new World(), 'together', { orange: fast, blue: slow });
  await apart.run();
  assert.deepEqual(apart.order.slice(0, 4), ['orange', 'orange', 'orange', 'orange']);
  // Within earshot: in step.
  const w = new World();
  Object.assign(w.robotById('blue'), { x: 6, y: -2 });
  assert.equal(w.together(), true);
  const near = scripted(w, 'together', { orange: fast, blue: slow });
  await near.run();
  let lead = 0;
  for (const who of near.order) { lead += who === 'orange' ? 1 : -1; assert.ok(Math.abs(lead) <= 1, near.order.join(' ')); }
  // Talking keeps them together for a game hour after they part.
  const w2 = new World();
  assert.equal(w2.together(), false);
  Object.assign(w2.robotById('blue'), { x: 6, y: -2 });
  w2.exec('say', { text: 'see you' }, 'orange');
  Object.assign(w2.robotById('blue'), { x: 42, y: 1 });
  assert.equal(w2.together(), true);
  w2.exec('wait', { minutes: 60 });
  w2.exec('wait', { minutes: 5 });
  assert.equal(w2.together(), false);
});

test('speech is not cut short; a very long speech is cut at a word and the speaker is told', () => {
  const w = new World();
  Object.assign(w.robotById('blue'), { x: 4, y: -2 });
  const long = 'I found a metal box with a dial near the volcano and a panel on the tower roof. '.repeat(4).trim(); // ~330 chars
  assert.equal(ok(w, 'say', { text: long }).text, 'Said it.');
  assert.ok(w.takeNotices('blue')[0].endsWith(`${long}"`));
  assert.equal(w.talk.at(-1).text, long);
  const huge = 'word '.repeat(400).trim();
  const r = ok(w, 'say', { text: huge });
  assert.match(r.text, /ran out of breath: only the first \d+ characters got said/);
  const said = w.talk.at(-1).text;
  assert.ok(said.length <= CFG.sayMax + 1 && said.endsWith('word…'), said.slice(-20));
});

test('robots nearby notice the finished machine light up in the morning and go dark at dusk', () => {
  const w = charged();
  w.minutes = 4 * 60;
  w.robot.battery = 100;
  w.exec('wait', { minutes: 5 });
  w.takeNotices('orange');
  for (let i = 0; i < 3; i++) w.exec('wait', { minutes: 60 }); // through dawn
  assert.match(w.takeNotices('orange').join(' '), /light on device_1 turned green/);
  w.minutes = 17 * 60;
  for (let i = 0; i < 3; i++) w.exec('wait', { minutes: 60 });
  assert.match(w.takeNotices('orange').join(' '), /went dark and its hum stopped/);
  assert.equal(w.takeNotices('blue').length, 0, 'blue is far away on its island');
});

// ---------- the sailboat on the volcano island ----------
// Put a robot on the volcano island's north beach, next to the boat.
function nearBoat() {
  const w = new World();
  Object.assign(w.robotById('orange'), { x: -9, y: 86, h: 0 });
  Object.assign(w.robotById('blue'), { x: -7, y: 85, h: 0 });
  return w;
}

test('the sailboat is moored off the volcano island, out of sight until a robot is near it', () => {
  const w = new World();
  const { cells } = w.boat;
  assert.equal(cells.length, CFG.boatLength);
  for (const c of cells) {
    assert.ok(w.isWater(c.x, c.y) && w.onBoat(c.x, c.y) && !w.isRaft(c.x, c.y));
    assert.equal(w.topHeight(c.x, c.y), CFG.boatDeck);
  }
  assert.ok(cells.some((c) => [[0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => islandAt(c.x + dx, c.y + dy) === 2)), 'moored against the volcano island');
  assert.doesNotMatch(w.exec('look').text, /boat/i);
  // Arriving on the volcano island's south beach it's still hidden; on the north beach it's in plain view.
  Object.assign(w.robot, { x: -10, y: 64, h: 0 });
  assert.ok(isLandAt(-10, 64));
  assert.doesNotMatch(w.exec('look').text, /boat/i);
  assert.equal(w.boatSeen.size, 0);
  const n = nearBoat();
  assert.match(n.exec('look').text, /- sailboat: a small wooden sailboat .* deck covers 4 cells/);
  assert.ok(n.boatSeen.has('orange') && !n.boatSeen.has('blue'));
});

test('the sail tool is only offered once a robot has seen the boat, and says nothing about how', () => {
  const w = nearBoat();
  const agent = new Agent(w, new Diary({ load: () => [], save: () => {} }), { onEvent() {} }, 'orange');
  const notes = [];
  const emit = (type, text) => notes.push(text);
  assert.ok(!agent.tools(emit).some((t) => t.function.name === 'sail'));
  w.exec('look');
  assert.ok(agent.tools(emit).some((t) => t.function.name === 'sail'));
  assert.equal(notes.length, 1);
  const sailTool = TOOLS.find((t) => t.function.name === 'sail');
  assert.doesNotMatch(JSON.stringify(sailTool), /standing|deck|aboard|boat|holding|raft/i);
});

test('both robots and cargo ride the sailboat; it turns, sails far and stops at the beach', () => {
  const w = nearBoat();
  fails(w, 'sail', { direction: 'north' }, /nothing here to sail/);
  ok(w, 'walk_to', { target: 'boat' });
  assert.ok(w.onBoat(w.robot.x, w.robot.y));
  assert.match(w.status(), /standing on the sailboat's deck/);
  const blue = w.robotById('blue');
  const rb = w.exec('walk_to', { target: 'sailboat' }, 'blue');
  assert.ok(rb.ok, rb.text);
  assert.ok(w.onBoat(blue.x, blue.y));
  // Cargo: a crate on the deck (not a raft, not floating).
  w.statusOf('orange'); // the acting robot is orange again
  w.items.set('block_99', { id: 'block_99', type: 'block', state: 'held', x: 0, y: 0 });
  w.robot.holding = 'block_99';
  const free = w.boat.cells.find((c) => !w.robots.some((r) => r.x === c.x && r.y === c.y) && Math.max(Math.abs(c.x - w.robot.x), Math.abs(c.y - w.robot.y)) === 1);
  assert.match(ok(w, 'put_down', free).text, /sailboat's deck/);
  assert.equal(w.topHeight(free.x, free.y), CFG.boatDeck + CFG.blockHeight);
  // Out to sea, then south toward the big island: two sail actions get it there.
  const r1 = ok(w, 'sail', { direction: 'east', distance: 10 });
  assert.match(r1.text, /glided 10 cells east.*blue robot rode along/);
  assert.match(w.takeNotices('blue').join(' '), /sailboat you are on sailed 10 cells east/);
  let r;
  // Sailing straight at something stops against it: here the volcano island's own east shore is in the way.
  assert.match(ok(w, 'sail', { x: 1, y: 0 }).text, /rest against the beach/);
  assert.ok(w.boat.cells.some((c) => [[0, -1], [-1, 0], [1, 0]].some(([dx, dy]) => islandAt(c.x + dx, c.y + dy) === 2)));
  ok(w, 'sail', { direction: 'north', distance: 3 });
  ok(w, 'sail', { direction: 'east', distance: 8 });
  for (let i = 0; i < 4 && !/rest against the beach/.test(r?.text || ''); i++) r = ok(w, 'sail', { x: 4, y: 0 });
  assert.match(r.text, /rest against the beach/);
  assert.equal(islandAt(w.robot.x, w.robot.y), -1);
  assert.ok(w.onBoat(w.robot.x, w.robot.y) && w.onBoat(blue.x, blue.y));
  const crate = w.items.get('block_99');
  assert.ok(w.onBoat(crate.x, crate.y));
  assert.ok(w.boat.cells.some((c) => [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => islandAt(c.x + dx, c.y + dy) === 0)), 'beached at the big island');
  // Step ashore.
  const land = [[0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0], [0, 1]].map(([dx, dy]) => ({ x: w.robot.x + dx, y: w.robot.y + dy })).find((c) => isLandAt(c.x, c.y));
  if (land) ok(w, 'jump_to', land);
});

test('the sailboat swings round in place and blocks rafts; it cannot be paddled', () => {
  const w = nearBoat();
  ok(w, 'walk_to', { target: 'boat' });
  const before = w.boat.cells.map((c) => `${c.x},${c.y}`).sort().join(' ');
  const where = w.boat.cells.findIndex((c) => c.x === w.robot.x && c.y === w.robot.y);
  // Pointing back the other way: it spins on the spot (south is the beach, so it can't move far).
  const r = w.exec('sail', { direction: 'west', distance: 1 });
  assert.ok(r.ok, r.text);
  assert.match(r.text, /swung round to point west/);
  assert.equal(w.boat.dir.x, -1);
  const after = w.boat.cells.map((c) => `${c.x - -1},${c.y}`).sort().join(' ');
  assert.equal(after, before, 'spun in place then moved one cell west');
  assert.equal(w.boat.cells.findIndex((c) => c.x === w.robot.x && c.y === w.robot.y), where, 'the robot stays on the same part of the deck');
  // Paddling it with a frond doesn't work.
  w.items.set('frond_99', { id: 'frond_99', type: 'frond', state: 'held', x: 0, y: 0 });
  w.robot.holding = 'frond_99';
  fails(w, 'paddle', { direction: 'north' }, /too heavy/);
  // A battery-flat robot can't sail.
  w.robot.battery = 0;
  fails(w, 'sail', { direction: 'north' }, /battery is empty/);
  w.robot.battery = 100;
  // The map edge stops it.
  w.robot.holding = null;
  const edge = w.exec('sail', { direction: 'north' });
  assert.ok(edge.ok, edge.text);
  assert.match(edge.text, /strong current/);
  fails(w, 'sail', { direction: 'north' }, /strong current/);
  // The rock thrown onto the deck stays there (it doesn't skip back ashore like it does from open water).
  const deck = w.boat.cells.find((c) => !w.robots.some((o) => o.x === c.x && o.y === c.y) && Math.max(Math.abs(c.x - w.robot.x), Math.abs(c.y - w.robot.y)) === 1);
  const rock = w.items.get('rock');
  w._detach('rock');
  rock.state = 'held';
  w.robot.holding = 'rock';
  const thrown = ok(w, 'put_down', deck);
  assert.match(thrown.text, /sailboat's deck/);
  assert.ok(w.onBoat(rock.x, rock.y));
});

test('a paddled raft bumps into the sailboat', () => {
  const w = nearBoat();
  for (const x of [-6, -5]) w._stack(w._newBlock(), x, 87);
  Object.assign(w.robot, { x: -6, y: 87, h: w.topHeight(-6, 87) });
  w.items.set('frond_99', { id: 'frond_99', type: 'frond', state: 'held', x: 0, y: 0 });
  w.robot.holding = 'frond_99';
  const r = ok(w, 'paddle', { direction: 'west', strokes: 4 });
  assert.match(r.text, /moved 1 cell, then bumped into the sailboat at \(-8,87\)/);
  assert.ok(!w.isRaft(-8, 87));
});

test('a robot with a flat battery can be carried to the charger and set down beside it', () => {
  const w = charged();
  w.minutes = 10 * 60;
  const orange = w.robot;
  const blue = w.robotById('blue');
  Object.assign(blue, { x: -3, y: 0, h: 0, battery: 50 });
  ok(w, 'walk_to', { target: 'blue_robot' });
  // A robot that is running can't be lifted.
  fails(w, 'pick_up', { item: 'blue robot' }, /motors are running/);
  blue.battery = 0;
  assert.match(w.exec('look', {}, 'orange').text, /blue_robot: .*motionless and slumped, its eyes dark/);
  const lift = ok(w, 'pick_up', { item: 'the blue robot' });
  assert.match(lift.text, /carrying it/);
  assert.ok(lift.events.some((e) => e.type === 'carry' && e.target === 'blue'));
  assert.equal(orange.carrying, 'blue');
  assert.equal(blue.carriedBy, 'orange');
  assert.match(w.takeNotices('blue').join(' '), /lifted you off your feet/);
  assert.match(w.statusOf('orange'), /Holding: the blue robot, in your arms\./);
  assert.match(w.statusOf('blue'), /carried in the orange robot's arms/);
  // Arms full: nothing else can be picked up, and a robot is too heavy to throw.
  fails(w, 'pick_up', { item: 'block_4' }, /arms are full/);
  fails(w, 'throw', { x: -3, y: 5 }, /too heavy to throw/);
  fails(w, 'paddle', { direction: 'east' }, /arms are full/);
  // The carried robot goes wherever its carrier goes.
  ok(w, 'walk_to', { x: 1, y: 1 });
  assert.deepEqual([blue.x, blue.y, blue.h], [1, 1, 0]);
  assert.equal(blue.battery, 0, 'two cells from the charger nothing flows');
  fails(w, 'put_down', { x: 1, y: 1 }, /standing on/);
  fails(w, 'put_down', { x: 4, y: 3 }, /cells away/);
  ok(w, 'put_down', { x: 2, y: 1 });
  assert.equal(orange.carrying, null);
  assert.equal(blue.carriedBy, null);
  assert.deepEqual([blue.x, blue.y, blue.h], [2, 1, 0]);
  // Beside the working charger in daylight, the rescued robot starts charging at once, and can move again.
  const told = w.takeNotices('blue').join(' ');
  assert.match(told, /set you down on your feet at \(2,1\)/);
  assert.match(told, /power flowing into your battery/);
  ok(w, 'wait', { minutes: 60 });
  const putDownMinutes = 2 * w.timeScale;
  assert.ok(Math.abs(blue.battery - (60 + putDownMinutes) * (100 / (CFG.chargeHours * 60))) < 1e-6, `charging since it was set down: ${blue.battery}`);
  assert.ok(w.exec('walk_to', { x: 4, y: 3 }, 'blue').ok);
});

test('a carried robot cannot act, is never set down in the sea, and is let go when the carrier runs flat', () => {
  const w = new World();
  const orange = w.robot;
  const blue = w.robotById('blue');
  Object.assign(orange, { x: 0, y: w.dock.yEnd, h: CFG.dockHeight });
  Object.assign(blue, { x: 1, y: w.dock.yEnd, h: CFG.dockHeight, battery: 0 });
  ok(w, 'pick_up', { item: 'robot' });
  // Charged while carried, it still can't walk off: its feet don't touch anything.
  blue.battery = 40;
  const r = w.exec('walk_to', { x: 0, y: 0 }, 'blue');
  assert.equal(r.ok, false);
  assert.match(r.text, /being carried/);
  assert.ok(w.exec('say', { text: 'put me down' }, 'blue').ok);
  assert.match(w.takeNotices('orange').join(' '), /right beside you/);
  blue.battery = 0;
  fails(w, 'put_down', { x: 0, y: w.dock.yEnd - 1 }, /open water: the blue robot would sink/);
  assert.equal(orange.carrying, 'blue');
  // The carrier's own battery runs out: its arms go limp and the robot it held slides onto the dock beside it.
  orange.battery = 0.001;
  ok(w, 'wait', { minutes: 5 });
  assert.equal(orange.carrying, null);
  assert.equal(blue.carriedBy, null);
  assert.ok(w.terrainAt(blue.x, blue.y) === 'dock' && (blue.x !== orange.x || blue.y !== orange.y));
  assert.match(w.takeNotices('orange').join(' '), /arms went limp/);
  assert.match(w.takeNotices('blue').join(' '), /slid out of them/);
});

test('look and put_down show the ground around the robot as a grid of heights', () => {
  const w = new World();
  ok(w, 'walk_to', { x: 1, y: -4 });
  ok(w, 'pick_up', { item: 'block_1' }); // from (2,-4)
  const put = ok(w, 'put_down', { direction: 'north' });
  assert.match(put.text, /^Put down \(1,-3\), next to you to the north: block_1 landed/);
  const rows = Object.fromEntries(put.text.split('\n').filter((l) => /^\s+-?\d+ /.test(l)).map((l) => { const [y, ...c] = l.trim().split(/\s+/); return [y, c]; }));
  assert.deepEqual(rows['-3'], ['0.0', '0.0', '1.0', '0.0', '0.0'], 'the new crate shows north of the robot');
  assert.deepEqual(rows['-4'], ['0.0', '0.0', '[0.0]', '0.0', '1.0']);
  ok(w, 'pick_up', { item: 'block_1' });
  fails(w, 'put_down', { direction: 'sideways' }, /needs x and y .* or a direction/);
  ok(w, 'put_down', { direction: 'ne' });
  assert.equal(w.topHeight(2, -3), 1);
  const look = w.exec('look').text;
  assert.match(look, /Heights around you/);
  assert.match(look, /\n\s+-3 +0\.0 +0\.0 +0\.0 +0\.0 +1\.0 +0\.0 +0\.0\n/);
  // At the dock's end the water shows; inside the hut the walls frame the room.
  Object.assign(w.robot, { x: 0, y: w.dock.yEnd, h: CFG.dockHeight });
  assert.match(w.exec('look').text, / ~ /);
  ok(w, 'walk_to', { target: 'inside_hut' });
  const hut = w.exec('look').text.split('\n').filter((l) => /^\s+-?\d+ /.test(l));
  assert.equal(hut.length, LAYOUT.hut.y1 - LAYOUT.hut.y0 + 3);
  assert.match(hut[0], /^\s+7( +wall){6}$/);
});

test('the Voice reaches the chosen robots anywhere, and does not count as the robots being together', () => {
  const w = new World();
  w.robots[1].inside = false;
  const e = w.voice('  Hello robots.  ', 'all');
  assert.deepEqual(e.heardBy, ['orange', 'blue']);
  assert.equal(w.talk.at(-1).who, 'voice');
  for (const id of ['orange', 'blue']) {
    assert.deepEqual(w.takeNotices(id), [], 'kept apart from other sounds');
    const heard = w.takeVoice(id);
    assert.equal(heard.length, 1);
    assert.match(heard[0], /The Voice .*"Hello robots\."/);
  }
  assert.equal(w.together(), false, 'the Voice talking is not the robots talking');
  assert.deepEqual(w.voice('Only you.', 'blue').heardBy, ['blue']);
  assert.deepEqual(w.takeVoice('orange'), []);
  assert.equal(w.takeVoice('blue').length, 1);
  assert.equal(w.voice('   ', 'all'), null);
  assert.equal(w.voice('hi', 'nobody'), null);
  assert.equal(w.voice('x'.repeat(5000)).text.length, CFG.voiceMax);
});

test('the Voice reaches the model as a message of its own, before its next decision (also when idle)', async () => {
  const w = new World();
  w.voice('Welcome.', 'orange');
  let sent;
  const a = new Agent(w, new Diary({ load: () => [], save: () => {} }), {
    settings: () => ({ model: 'm', think: false, temperature: 0, numCtx: 65536, maxSteps: 1, lockstep: 'never' }),
    onEvent: () => {}, play: async () => {},
  }, 'orange');
  a.chat = async (messages) => { sent = messages.map((m) => ({ ...m })); a.running = false; return { role: 'assistant', content: '' }; };
  await a.run('Explore.');
  assert.match(sent.at(-1).content, /\n\nThe Voice speaks to you: "Welcome\."$/);
  w.voice('Over here.', 'orange');
  assert.equal(a.voice(), 'The Voice speaks to you: "Over here."');
  assert.equal(a.voice(), '', 'told once');
});

test('rewrite_diary replaces the diary with one entry and keeps the old entries out of the model\'s sight', () => {
  let saved = [{ at: '2026-10-30T10:00:00.000Z', text: 'old one' }, { at: '2026-10-30T11:00:00.000Z', text: 'old two' }]; // pre-rewrite format
  const d = new Diary({ load: () => saved, save: (e) => { saved = e; } });
  assert.equal(d.entries.length, 2);
  assert.equal(d.rewrite('  ').ok, false);
  assert.match(d.rewrite('x'.repeat(REWRITE_MAX + 1)).text, /at most 6000/);
  assert.equal(d.entries.length, 2, 'a failed rewrite changes nothing');
  assert.ok(d.rewrite('Summary: hut at (7,4).').ok);
  assert.deepEqual(d.entries.map((e) => e.text), ['Summary: hut at (7,4).']);
  assert.equal(d.archived.length, 2);
  assert.doesNotMatch(d.read(), /old one/);
  assert.match(d.read(), /rewritten diary\): Summary/);
  d.write('new lesson');
  assert.equal(d.entries.length, 2);
  const d2 = new Diary({ load: () => saved, save: () => {} });
  assert.equal(d2.entries.length, 2, 'survives reload');
  assert.match(d2.toText(), /old two/, 'Save as text keeps the replaced entries');
  d2.clear();
  assert.equal(d2.all.length, 0);
});

test('rewrite_diary is offered from half full, and the robot is told when its diary is nearly full', async () => {
  const w = new World();
  const diary = new Diary({ load: () => [], save: () => {} });
  const a = new Agent(w, diary, { onEvent() {} }, 'orange');
  const has = () => a.tools().some((t) => t.function.name === 'rewrite_diary');
  assert.equal(has(), false);
  assert.equal(a.diaryFull(), '');
  while (diary.fullness() < 0.5) diary.write('y'.repeat(1400));
  assert.equal(has(), true);
  while (diary.fullness() < 0.8) diary.write('y'.repeat(1400));
  assert.match(a.diaryFull(), /\d+% full.*rewrite_diary/);
  while (diary.fullness() < 1.1) diary.write('y'.repeat(1400));
  assert.match(a.diaryFull(), /full: its oldest entries are no longer shown/);
  assert.ok(diary.read().length <= DIARY_LIMIT + 200);
  diary.rewrite('short');
  assert.equal(has(), false, 'withdrawn again once it is small');
});

test('the agent runs rewrite_diary and reports the result to the model', async () => {
  const w = new World();
  const diary = new Diary({ load: () => [], save: () => {} });
  for (let i = 0; i < 6; i++) diary.write('z'.repeat(1400));
  const replies = [
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'rewrite_diary', arguments: { text: 'All I need.' } } }] },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'look', arguments: {} } }] },
  ];
  let seen;
  const a = new Agent(w, diary, {
    settings: () => ({ model: 'm', think: false, temperature: 0, numCtx: 65536, maxSteps: 2, lockstep: 'never' }),
    onEvent() {}, play: async () => {},
  }, 'orange');
  a.chat = async (messages, s, p, tools) => { seen = messages; if (!replies.length) a.running = false; return replies.shift() || { role: 'assistant', content: '' }; };
  await a.run('Explore.');
  assert.deepEqual(diary.entries.map((e) => e.text), ['All I need.']);
  assert.ok(seen.some((m) => m.role === 'tool' && /^OK: your diary now holds only this rewritten version/.test(m.content)));
});

// Put the orange robot somewhere directly (no walking), outdoors on the ground or on a stack.
const place = (w, x, y) => Object.assign(w.robotById('orange'), { x, y, inside: false, h: w.topHeight(x, y) });

test('natives live on their own two islands and stay home while nobody trespasses', () => {
  const w = new World();
  assert.equal(w.natives.length, 6);
  const isl = new Set(w.natives.map((n) => ISLANDS[n.island].name));
  assert.deepEqual([...isl].sort(), ['north', 'south']);
  for (const n of w.natives) assert.equal(w.terrainAt(n.x, n.y), 'sand');
  const before = w.natives.map((n) => [n.x, n.y]);
  ok(w, 'wait', { minutes: 60 });
  assert.deepEqual(w.natives.map((n) => [n.x, n.y]), before);
  assert.equal(w.robot.battery > 95, true);
});

test('a trespasser is chased and jabbed: 5% a jab, then the natives go back to their posts when it leaves', () => {
  const w = new World();
  place(w, 30, -23); // east beach of the south island
  const r = w.robot;
  const b0 = r.battery;
  const res = ok(w, 'wait', { minutes: 30 });
  const heard = w.takeNotices('orange').join('\n');
  assert.match(heard, /native_\d, one of the frond-skirted figures, turned toward you/);
  assert.match(heard, /jabbed you with the glowing tip of its stick/);
  const ev = res.events.find((e) => e.type === 'natives');
  assert.ok(ev.moves.length > 0 && ev.jabs.length > 0, 'the renderer is told who moved and who jabbed');
  const jabs = ev.jabs.length;
  const drift = 30 * (100 / (CFG.batteryHours * 60));
  assert.ok(Math.abs(b0 - r.battery - jabs * CFG.nativeJab - drift) < 0.5, `lost ${b0 - r.battery} for ${jabs} jabs`);
  // Natives never leave their island.
  for (const n of w.natives) assert.equal(n.island, islandAt(n.x, n.y));
  // Gone (back home on the big island): they return to their posts and nothing more is drained.
  place(w, 0, -2);
  ok(w, 'wait', { minutes: 60 });
  for (const n of w.natives) assert.deepEqual([n.x, n.y], [n.home.x, n.home.y]);
  assert.doesNotMatch(w.takeNotices('orange').join('\n'), /jabbed/);
});

test('natives cannot reach a robot high on a stack, and leave a flat robot alone', () => {
  const w = new World();
  // Two crates stacked on the south island: 2 m up, out of the sticks' reach.
  const [a, b] = ['block_1', 'block_2'];
  w._detach(a); w._detach(b);
  w._stack(a, 30, -22); w._stack(b, 30, -22);
  place(w, 30, -22);
  assert.equal(w.robot.h, 2);
  const b0 = w.robot.battery;
  ok(w, 'wait', { minutes: 40 });
  assert.doesNotMatch(w.takeNotices('orange').join('\n'), /jabbed/);
  assert.ok(b0 - w.robot.battery < 1);
  assert.ok(w.natives.some((n) => cheb(n, w.robot) <= 1), 'they gather round below');
  // A flat robot on their sand is ignored.
  const w2 = new World();
  place(w2, 30, -23);
  w2.robot.battery = 0;
  w2.exec('wait', { minutes: 30 });
  assert.ok(w2.natives.every((n) => n.target === null));
});

test('natives block cells and show up in look without saying what they are for', () => {
  const w = new World();
  const n = w.natives[0];
  place(w, n.x + 2, n.y);
  const look = w.exec('look').text;
  assert.match(look, new RegExp(`${n.id}: a robot unlike you: .*skirt of palm fronds.*stick`));
  assert.match(look, new RegExp(`nat${n.id.split('_')[1]}`), 'shown in the height grid');
  assert.doesNotMatch(look, /hostile|attack|enemy|trespass|guard|drain|steal|danger|power/i);
  fails(w, 'jump_to', { x: n.x, y: n.y }, /standing on/);
  fails(w, 'pick_up', { item: n.id });
  // From home, the south island's natives are distant figures.
  const w2 = new World();
  place(w2, 1, -20);
  assert.match(w2.exec('look').text, /3 small figures are moving about on an island/);
});
