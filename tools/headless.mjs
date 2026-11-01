// Run the robots without a browser: prints each model turn and tool result, tagged with the robot.
//   node tools/headless.mjs "Explore this place." [model] [--no-think] [--think=low] [--robots=orange,blue] [--lockstep=together|always|never]
//     [--voice=TURN:text ...]  the Voice says text to every robot once the first robot reaches that turn
// Needs the server running (npm start) or BASE=http://host:port/ pointing at one.
import { World } from '../public/js/world.js';
import { Agent } from '../public/js/agent.js';
import { Diary } from '../public/js/diary.js';
import fs from 'node:fs';

const args = process.argv.slice(2);
const instruction = args[0] || 'Explore this place. Find out what is here and how things behave, and write what you learn in your diary.';
// Default: the first openai/ model the server lists (only when OPENAI_URL is set), else qwen3.8:27b on Ollama.
const tags = await fetch(`${process.env.BASE || 'http://127.0.0.1:8765/'}api/tags`).then((r) => r.json()).catch(() => ({}));
const model = args.find((a, i) => i > 0 && !a.startsWith('--'))
  || tags.models?.find((m) => m.backend === 'openai')?.name
  || 'qwen3.8:27b';
// Context: CTX=n, else an openai/ model's full context (its server's size), else 65536 for Ollama.
const modelCtx = tags.models?.find((m) => m.name === model && m.backend === 'openai')?.details?.context_length;
const numCtx = Number(process.env.CTX) || modelCtx || 65536;
const think = args.includes('--no-think') ? false : (args.find((a) => a.startsWith('--think='))?.slice(8) || true);
const robots = (args.find((a) => a.startsWith('--robots='))?.slice(9) || 'orange,blue').split(',');
const world = new World();
const voices = args.filter((a) => a.startsWith('--voice=')).map((a) => { const m = a.slice(8).match(/^(\d+):(.*)$/s); return { turn: Number(m[1]), text: m[2] }; });
// Each robot's diary persists in a JSON file between runs: .diary.json (orange) and .diary-<id>.json for the others
// (DIARY=path changes the orange one; --clear-diary starts them all fresh).
const diaryFile = (id) => (id === 'orange' ? process.env.DIARY || new URL('../.diary.json', import.meta.url).pathname : new URL(`../.diary-${id}.json`, import.meta.url).pathname);
const t0 = Date.now();
const agents = robots.map((id) => {
  const file = diaryFile(id);
  const diary = new Diary({
    load: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []),
    save: (entries) => fs.writeFileSync(file, JSON.stringify(entries, null, 2)),
  });
  if (args.includes('--clear-diary')) diary.clear();
  const tag = id.padEnd(6);
  return new Agent(world, diary, {
    baseUrl: process.env.BASE || 'http://127.0.0.1:8765/',
    play: async () => {},
    settings: () => ({ model, think, temperature: 0.3, numCtx, maxSteps: Number(process.env.STEPS || 200), lockstep: args.find((a) => a.startsWith('--lockstep='))?.slice(11) || 'together' }),
    onEvent(type, d) {
      if (type === 'thinking') for (const v of voices) if (!v.sent && d.step >= v.turn) { v.sent = true; world.voice(v.text); console.log(`        THE VOICE: ${v.text}`); }
      const s = `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${tag}`;
      if (type === 'reply') console.log(`${s} [turn ${d.step}] ${d.thinking ? `(thought ${d.thinking.length} chars) ` : ''}${d.cutOff ? '[CUT OFF] ' : ''}${(d.content || '').trim().slice(0, 300)}`);
      if (type === 'call') console.log(`${s}   ${d.ok ? 'OK ' : 'ERR'} ${d.name}(${JSON.stringify(d.args)}) -> ${d.text.split('\n')[0].slice(0, 220)}`);
      if (type === 'heard') for (const line of d) console.log(`${s}   HEARD ${line}`);
      if (type === 'restart') console.log(`${s} --- robot stopped; restarting with the intro prompt (session ${d.session}) ---`);
      if (type === 'error') console.log(`${s} ERROR: ${d}`);
      if (type === 'note') console.log(`${s} NOTE: ${d}`);
    },
  }, id);
});
console.log(`Instruction: ${instruction}\nModel: ${model} think=${think} context=${numCtx} robots=${robots.join(',')}\n`);
await Promise.all(agents.map((a) => a.run(instruction)));
console.log('\nFinal:');
for (const a of agents) console.log(world.statusOf(a.who));
for (const a of agents) console.log(`\n${a.who}: ${a.diary.read()}`);
