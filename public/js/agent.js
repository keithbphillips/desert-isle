// The robot's "brain": an Ollama chat loop with tool calling. Each tool call is executed in the
// World, animated by the Renderer, and its result (plus a fresh status) is fed back to the model.
import { REWRITE_MAX, REWRITE_OFFER, FULL_WARN } from './diary.js';

export const DEFAULT_SYSTEM = `You control a robot. You act ONLY by calling tools.

You have just been switched on somewhere you know nothing about. Nobody will tell you what is here or how things behave: find out by looking around, experimenting and paying close attention to the results of your actions. The world may hold surprises.

YOUR SENSES AND BODY
- Positions are integer grid cells (x, y), 1 m apart: x increases to the east, y increases to the north. Heights are in metres.
- After every action you are told your position, your height, what you are holding and how much charge is left in your battery. Your battery runs down as time passes.
- look shows what you can see from where you stand. Small things far away cannot be made out, so move around to see more.
- walk_to, jump_to, pick_up, put_down, throw and paddle act on the world. The id of anything you have seen (from look) can be used as a target.
- wait stands still while time passes.
- say speaks aloud: anyone near enough can hear you. Anything you hear is reported to you after your next action.

YOUR DIARY
- write_diary and read_diary give you a diary. It is your only long-term memory: it survives between tasks and when the world is reset, while everything else you know is forgotten.
- Whenever you are switched on, your diary is shown to you. Read it again (read_diary) whenever you need to remember something. Write down what you learn: what things are and where, how they behave, what you can and cannot do (with numbers when you learn them), what failed and why, and tricks that worked. Keep entries short and factual.

HOW TO WORK
- Call one tool at a time and base each decision on what you have actually observed.
- "OK" means an action worked. "FAILED" explains why, and nothing changed: learn from it rather than repeating it.
- Keep your diary up to date as you go: write lessons down as soon as you learn them.`;

export const TOOLS = [
  tool('look', 'Look around: what you can see from where you stand.', {}, []),
  tool('walk_to', 'Walk to a cell, or to stand next to something you have seen. Give x and y, or target.', {
    x: { type: 'integer', description: 'destination x (east)' },
    y: { type: 'integer', description: 'destination y (north)' },
    target: { type: 'string', description: 'instead of x/y: the id of something you have seen' },
  }, []),
  tool('jump_to', 'Jump to a nearby cell, possibly onto something higher.', {
    x: { type: 'integer' }, y: { type: 'integer' },
  }, ['x', 'y']),
  tool('pick_up', 'Pick up something within reach, by its id.', {
    item: { type: 'string', description: 'the id of the thing, as given by look' },
  }, ['item']),
  tool('put_down', 'Put what you are holding down on a cell next to you. Give x and y, or direction.', {
    x: { type: 'integer' }, y: { type: 'integer' },
    direction: { type: 'string', description: 'instead of x/y: the cell next to you that way (north, north-east, east, south-east, south, south-west, west or north-west)' },
  }, []),
  tool('throw', 'Throw what you are holding at a cell.', {
    x: { type: 'integer' }, y: { type: 'integer' },
  }, ['x', 'y']),
  tool('paddle', 'Make paddling strokes toward a direction.', {
    direction: { type: 'string', description: 'north, north-east, east, south-east, south, south-west, west or north-west' },
    strokes: { type: 'integer', description: 'how many strokes, 1 to 6' },
  }, ['direction']),
  // Only offered once the robot has seen the sailboat (World.boatSeen): see Agent.tools().
  tool('sail', 'Sail toward a direction, or toward a point.', {
    direction: { type: 'string', description: 'north, north-east, east, south-east, south, south-west, west or north-west' },
    distance: { type: 'integer', description: 'how far, in cells (1 to 30)' },
    x: { type: 'integer', description: 'instead of a direction: x of a point to head for' },
    y: { type: 'integer', description: 'instead of a direction: y of a point to head for' },
  }, []),
  tool('wait', 'Stand still and let time pass.', { minutes: { type: 'integer', description: 'how long, 1 to 60 minutes' } }, []),
  tool('say', 'Say something out loud.', { text: { type: 'string' } }, ['text']),
  tool('write_diary', 'Add an entry to your diary (your long-term memory).', { text: { type: 'string', description: 'what you want to remember' } }, ['text']),
  tool('read_diary', 'Read everything you have written in your diary.', {}, []),
  // Only offered once the diary is half full: see Agent.tools().
  tool('rewrite_diary', 'Replace your whole diary with a new, shorter version: one entry that keeps what still matters. Anything you leave out is forgotten for good.', {
    text: { type: 'string', description: `the complete new diary, at most ${REWRITE_MAX} characters` },
  }, ['text']),
];

// The robot can never be done. A reply with no tool call (or a made-up "done"-style call) means the model has
// decided to stop: it writes its diary, then starts a fresh session with the intro prompt again.
const STOP_NAMES = new Set(['done', 'finish', 'finished', 'stop', 'end', 'complete', 'task_complete']);

// Memory reminders: after this many turns without reading / writing the diary, the next tool result says so.
export const MEMORY_NUDGE = { read: 30, write: 20 };

function tool(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

// Rough size of a conversation in characters; divided by characters per token (about 3.5 for this kind of text,
// corrected from Ollama's real counts as the run goes) it estimates tokens.
const chars = (messages) => messages.reduce((n, m) => n + (m.content?.length || 0) + JSON.stringify(m.tool_calls || '').length, 0);
const TOOLS_CHARS = () => JSON.stringify(TOOLS).length;

// Keep the conversation inside the model's context: shorten the oldest bulky tool results (look, read_diary)
// first, leaving the system prompt, the instruction and the most recent exchanges intact. Returns how many were cut.
// reserve: tokens left free for the reply and its thinking (a thinking model can write 10k+ tokens in one turn).
export function compact(messages, numCtx, { reserve = 8192, charsPerToken = 3.5, extraChars = 0 } = {}) {
  const limit = Math.max(numCtx * 0.5, numCtx - reserve);
  const tokens = () => (chars(messages) + extraChars) / charsPerToken;
  let cut = 0;
  for (let i = 2; i < messages.length - 16 && tokens() > limit; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || m.trimmed || m.content.length < 300) continue;
    m.content = `${m.content.split('\n')[0].slice(0, 200)} … [older result shortened to save memory]`;
    m.trimmed = true;
    cut++;
  }
  return cut;
}

const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));
const DIARY_ONLY = TOOLS.filter((t) => t.function.name === 'write_diary');

// Some models write the call as JSON text instead of a real tool call. Recover those.
export function parseTextToolCalls(text) {
  if (!text) return [];
  const calls = [];
  const blobs = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) || [];
  for (const blob of blobs) {
    try {
      const o = JSON.parse(blob);
      const name = o.name || o.tool || o.function || o.action;
      const args = o.arguments || o.args || o.parameters || o.input || {};
      if (typeof name === 'string' && TOOL_NAMES.has(name)) calls.push({ function: { name, arguments: typeof args === 'string' ? JSON.parse(args) : args } });
    } catch { /* not JSON */ }
  }
  return calls;
}

// Ollama couldn't decode a tool call the model wrote (e.g. qwen's XML-style calls with a broken tag).
// That's a slip by the model, not a fatal error: the turn can be retried.
export class ToolCallError extends Error {
  constructor(detail) {
    super(`Ollama: ${detail}`);
    this.detail = detail;
  }
}
const ollamaError = (err) => (/tool call|XML syntax|parsing (failed|tool)|unexpected end of JSON|invalid character/i.test(err) ? new ToolCallError(err) : new Error(`Ollama: ${err}`));

// Several robots share one world. Their models think at the same time, but their actions (and the animations
// that show them) take turns, so one robot's move never lands in the middle of another's.
let actionQueue = Promise.resolve();
function serial(fn) {
  const run = actionQueue.then(fn);
  actionQueue = run.catch(() => {});
  return run;
}

// Taking turns: while in step, robots run in rounds. Each thinks while the others think, but none starts its next
// turn until every other running robot has finished its current one, so a fast model can't race ahead and what one
// robot says reaches the other before its next decision. settings().lockstep: 'always', 'never', or 'together'
// (only while the robots are within earshot or have just talked: World.together()).
const inStep = new Set();
let wakeWaiters = [];
let engaged = false;
function stepMode(s) {
  return s.lockstep === true ? 'always' : s.lockstep === false || s.lockstep == null ? 'never' : s.lockstep;
}
// Whether the robots are taking turns right now. When that starts, everyone's count is levelled so the round
// begins fresh (turns taken apart don't have to be made up).
function checkEngaged(agent, s) {
  const mode = stepMode(s);
  const now = mode === 'always' || (mode === 'together' && agent.world.together());
  if (now !== engaged) {
    engaged = now;
    if (now) {
      const top = Math.max(...[...inStep].map((o) => o.finished));
      for (const o of inStep) o.finished = top;
    }
    if (mode === 'together' && inStep.size > 1) {
      for (const o of inStep) o.hooks.onEvent('note', now ? '🤝 The robots are within earshot: taking turns.' : '↔ The robots are apart: each goes at its own pace.');
    }
    stepChanged();
  }
  return now;
}
function stepChanged() {
  const w = wakeWaiters;
  wakeWaiters = [];
  for (const fn of w) fn();
}
async function waitForTurn(agent, s) {
  while (agent.running && checkEngaged(agent, s) && [...inStep].some((o) => o !== agent && o.running && o.finished < agent.finished)) {
    await new Promise((resolve) => wakeWaiters.push(resolve));
  }
}
function joinSteps(agent) {
  const others = [...inStep].filter((o) => o !== agent);
  agent.finished = others.length ? Math.max(...others.map((o) => o.finished)) : 0;
  inStep.add(agent);
  if (inStep.size === 1) engaged = false;
}
function leaveSteps(agent) {
  inStep.delete(agent);
  stepChanged();
}

export class Agent {
  // hooks: { onEvent(type, data), play(events) -> Promise, settings() -> {...}, baseUrl? }
  // who: which robot this brain drives (the world's robot id or index).
  constructor(world, diary, hooks, who = 0) {
    this.world = world;
    this.diary = diary;
    this.hooks = hooks;
    this.who = who;
    this.running = false;
    this.ctrl = null;
  }

  stop() {
    this.running = false;
    this.ctrl?.abort();
    stepChanged();
  }

  // True when a run has been stopped (by you or the turn limit) and can pick up where it left off.
  get canContinue() {
    return !this.running && !!this.messages;
  }

  // The tools this robot is offered right now: sail only once it has seen the boat, rewrite_diary only once its
  // diary is half full.
  tools(emit) {
    const seen = this.world.boatSeen?.has(this.world.robotById(this.who)?.id);
    if (seen && !this.sailOffered) emit?.('note', '⛵ It has seen the sailboat: the sail tool is now available to it.');
    this.sailOffered = seen;
    const rewrite = this.diary.fullness() >= REWRITE_OFFER;
    if (rewrite && !this.rewriteOffered) emit?.('note', `📓 Its diary is ${Math.round(this.diary.fullness() * 100)}% full: the rewrite_diary tool is now available to it.`);
    this.rewriteOffered = rewrite;
    return TOOLS.filter((t) => (seen || t.function.name !== 'sail') && (rewrite || t.function.name !== 'rewrite_diary'));
  }

  // A line telling the robot how full its diary is, once that matters ('' below FULL_WARN).
  diaryFull() {
    const f = this.diary.fullness();
    if (f < FULL_WARN) return '';
    return f >= 1
      ? '\n(Your diary is full: its oldest entries are no longer shown to you. rewrite_diary replaces it with one shorter version that keeps what still matters.)'
      : `\n(Your diary is ${Math.round(f * 100)}% full. When it is full, its oldest entries stop being shown to you. rewrite_diary replaces it with one shorter version.)`;
  }

  // Forget the current conversation (e.g. after the island is reset).
  forget() {
    this.messages = null;
  }

  // The intro prompt: what the robot is given when it is switched on, and again every time it stops.
  // The diary comes with it, so what earlier sessions learned is there from the first turn.
  intro(s) {
    this.sinceRead = 0;
    this.sinceWrite = 0;
    const memory = this.diary.entries.length ? `\n\nYOUR DIARY, your memory from before:\n${this.diary.read()}${this.diaryFull()}` : '\n\nYour diary is empty.';
    return [
      { role: 'system', content: s.system || DEFAULT_SYSTEM },
      { role: 'user', content: `INSTRUCTION: ${this.instruction}\n\n${this.world.statusOf(this.who)}${this.heard()}${memory}` },
    ];
  }

  // Called once per turn with the tools it used. Returns a reminder line (or '') when the robot hasn't read or
  // written its diary for a while; each reminder restarts its count.
  memoryNudge(names) {
    this.sinceRead = names.includes('read_diary') ? 0 : (this.sinceRead || 0) + 1;
    this.sinceWrite = names.includes('write_diary') || names.includes('rewrite_diary') ? 0 : (this.sinceWrite || 0) + 1;
    const out = [];
    if (this.sinceRead >= MEMORY_NUDGE.read && this.diary.entries.length) {
      out.push(`(It has been ${this.sinceRead} turns since you last read your diary. read_diary shows everything you have written, including what you learned before.)`);
      this.sinceRead = 0;
    }
    if (this.sinceWrite >= MEMORY_NUDGE.write) {
      out.push(`(You haven't written in your diary for ${this.sinceWrite} turns. Whatever you have learned since then will be forgotten unless you write it down.)`);
      this.sinceWrite = 0;
    }
    return out.length ? `\n${out.join('\n')}` : '';
  }

  async run(instruction, { resume = false } = {}) {
    const { world, diary, hooks } = this;
    const s = hooks.settings();
    this.running = true;
    const emit = (type, data) => hooks.onEvent(type, data);
    let messages;
    if (resume && this.messages) {
      messages = this.messages;
      messages.push({ role: 'user', content: `You have been given more time. Carry on with the instruction: ${this.instruction}\n${world.statusOf(this.who)}${this.heard()}` });
    } else {
      this.instruction = instruction;
      this.turn = 0;
      this.session = 1;
      messages = this.intro(s);
    }
    this.messages = messages;
    let outOfTurns = false;
    const stepping = stepMode(s) !== 'never';
    if (stepping) joinSteps(this);
    try {
      for (let i = 1; i <= s.maxSteps && this.running; i++) {
        if (stepping) {
          if (i > 1) {
            this.finished++;
            stepChanged();
          }
          await waitForTurn(this, s);
          if (!this.running) break;
        }
        const step = ++this.turn;
        // Anything heard since the last result is in front of the robot before it decides.
        const news = this.heard();
        if (news) {
          const last = messages.at(-1);
          if (last.role === 'tool' || last.role === 'user') last.content += news;
          else messages.push({ role: 'user', content: news.trim() });
        }
        // The Voice (you, at the screen) comes as a message of its own, so the robot treats it as being spoken to.
        const voice = this.voice();
        if (voice) {
          const last = messages.at(-1);
          if (last.role === 'user') last.content += `\n\n${voice}`;
          else messages.push({ role: 'user', content: voice });
        }
        emit('thinking', { step });
        this.charsPerToken ??= 3.5;
        const reserve = s.think ? 16384 : 4096;
        const trimmed = compact(messages, s.numCtx, { reserve, charsPerToken: this.charsPerToken, extraChars: TOOLS_CHARS() });
        if (trimmed) {
          emit('note', `Conversation near the context limit: shortened ${trimmed} old tool result${trimmed > 1 ? 's' : ''}.`);
          this.sinceRead = MEMORY_NUDGE.read; // older diary reads may be among them: remind it on this turn
        }
        const msg = await this.chatRetry(messages, s, emit, this.tools(emit));
        if (!this.running) break;
        let calls = msg.tool_calls || [];
        const textCalls = calls.length ? [] : parseTextToolCalls(msg.content);
        const cutOff = msg.doneReason === 'length';
        // Learn the real characters-per-token from Ollama's prompt count. Only ever revise it downwards (more
        // tokens than guessed): a cached prompt is reported smaller than it is.
        if (msg.promptTokens > 1000) this.charsPerToken = Math.min(this.charsPerToken, (chars(messages) + TOOLS_CHARS()) / msg.promptTokens);
        emit('reply', { step, thinking: msg.thinking, content: msg.content, recovered: textCalls.length > 0, cutOff, promptTokens: msg.promptTokens, replyTokens: msg.replyTokens, numCtx: s.numCtx });
        if (!calls.length) calls = textCalls;
        // A cut-off reply's text is unfinished rambling: keep only its start so it doesn't fill the context again.
        const content = cutOff && !calls.length ? (msg.content || '').slice(0, 600) : msg.content || '';
        messages.push({ role: 'assistant', content, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
        if (!calls.length && cutOff) {
          // Ran out of room mid-thought: that's not a decision to stop, so ask it to carry on.
          messages.push({ role: 'user', content: `Your last reply was cut off because it ran out of space (context limit) before you called a tool. Think more briefly and call a tool.\n${world.statusOf(this.who)}${this.heard()}` });
          continue;
        }
        let stopping = !calls.length;
        let failedEarlier = false;
        for (const call of calls) {
          if (!this.running) break;
          const name = call.function?.name;
          let args = call.function?.arguments || {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
          let result;
          if (failedEarlier) {
            result = 'SKIPPED: an earlier action in this turn failed, so this one was not attempted.';
            emit('call', { name, args, ok: false, text: result });
          } else if (STOP_NAMES.has(name)) {
            stopping = true;
            emit('call', { name, args, ok: true, text: 'The robot decided to stop.' });
            messages.push({ role: 'tool', tool_name: name, content: 'OK.' });
            break;
          } else if (name === 'write_diary') {
            const n = diary.write(args.text ?? args.entry ?? args.note ?? args.content);
            emit('call', { name, args, ok: !!n, text: n ? `Entry #${n} written.` : 'Nothing to write.' });
            result = n ? `OK: diary entry #${n} written.${this.diaryFull()}` : 'FAILED: the entry was empty.';
          } else if (name === 'rewrite_diary' && this.rewriteOffered) {
            const r = diary.rewrite(args.text ?? args.entry ?? args.content);
            emit('call', { name, args, ok: r.ok, text: r.ok ? `Diary rewritten (${r.text.length} characters).` : r.text });
            if (r.ok) emit('note', `📓 It rewrote its diary as one entry of ${r.text.length} characters. The entries it replaced are kept in "Save as text".`);
            result = r.ok ? `OK: your diary now holds only this rewritten version (${r.text.length} characters). Everything else in it is gone.` : `FAILED: ${r.text}`;
          } else if (name === 'read_diary') {
            emit('call', { name, args, ok: true, text: `${diary.entries.length} entries` });
            result = `OK: ${diary.read()}`;
          } else {
            result = await serial(async () => {
              const r = world.exec(name, args, this.who);
              emit('call', { name, args, ok: r.ok, text: r.text });
              await hooks.play(r.events);
              emit('world', null);
              if (!r.ok) failedEarlier = true;
              return `${r.ok ? 'OK' : 'FAILED'}: ${r.text}${name === 'look' ? '' : `\n${world.statusOf(this.who)}`}`;
            });
          }
          if (this.running) result += this.heard();
          messages.push({ role: 'tool', tool_name: name, content: result });
        }
        // Diary reminders ride on this turn's last tool result.
        const nudge = this.memoryNudge(calls.map((c) => c.function?.name));
        const last = messages.at(-1);
        if (nudge && !stopping && last.role === 'tool') {
          last.content += nudge;
          const what = [nudge.includes('read_diary') && 'read', nudge.includes("haven't written") && 'write in'].filter(Boolean).join(' and ');
          emit('note', `📓 Reminded to ${what} its diary.`);
        }
        if (stopping && this.running) {
          // It decided not to continue: let it write its diary, then switch it on again with the intro prompt.
          if (i < s.maxSteps) {
            i++;
            await this.diaryTurn(messages, s, emit, 'You have stopped working. Before you rest, write in your diary anything you learned that you will want to remember next time.');
          }
          if (!this.running) break;
          this.session++;
          messages = this.messages = this.intro(s);
          if (i >= s.maxSteps) {
            emit('error', `Stopped after ${s.maxSteps} model turns (the Max turns setting). Press Continue to switch the robot on again (session ${this.session}).`);
            break;
          }
          emit('restart', { session: this.session });
          continue;
        }
        if (i === s.maxSteps) {
          emit('error', `Stopped after ${s.maxSteps} model turns (the Max turns setting). Press Continue to give it more.`);
          outOfTurns = true;
        }
      }
      // Out of turns: one last diary-only turn so the lessons of this attempt aren't lost.
      if (outOfTurns && this.running) {
        await this.diaryTurn(messages, s, emit, 'You have run out of time for this task. Write in your diary what you learned that will help you next time: what worked, what failed and why, and what you would try next.');
      }
    } catch (e) {
      if (e.name !== 'AbortError') emit('error', e.message);
    } finally {
      this.running = false;
      this.ctrl = null;
      leaveSteps(this);
      emit('stopped', {});
    }
  }

  // What the robot heard or felt since it was last told (speech, the raft moving under it), as extra lines.
  heard() {
    const lines = this.world.takeNotices(this.who);
    if (lines.length) this.hooks.onEvent('heard', lines);
    return lines.length ? `\n${lines.join('\n')}` : '';
  }

  // What the Voice said to this robot since it was last told, as one message ('' if nothing).
  voice() {
    const lines = this.world.takeVoice(this.who);
    if (lines.length) this.hooks.onEvent('heard', lines);
    return lines.join('\n');
  }

  // A turn where the only thing the model can do is write in its diary.
  async diaryTurn(messages, s, emit, prompt) {
    this.turn++;
    emit('thinking', { step: 'last' });
    messages.push({ role: 'user', content: prompt });
    let msg;
    try {
      msg = await this.chatRetry(messages, s, emit, DIARY_ONLY);
    } catch (e) {
      if (!(e instanceof ToolCallError)) throw e;
      emit('note', 'The diary entry could not be read after several tries, so it was skipped.');
      return;
    }
    emit('reply', { step: 'last', thinking: msg.thinking, content: msg.content });
    messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    const calls = msg.tool_calls?.length ? msg.tool_calls : parseTextToolCalls(msg.content);
    for (const call of calls.filter((c) => c.function?.name === 'write_diary')) {
      let args = call.function.arguments || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      const n = this.diary.write(args.text ?? args.entry ?? args.note ?? args.content);
      emit('call', { name: 'write_diary', args, ok: !!n, text: n ? `Entry #${n} written.` : 'Nothing to write.' });
      messages.push({ role: 'tool', tool_name: 'write_diary', content: n ? `OK: diary entry #${n} written.` : 'FAILED: the entry was empty.' });
    }
  }

  // chat(), but if the model writes a tool call Ollama can't decode, tell the model and let it try again
  // (up to 3 times in a row) instead of ending the run.
  async chatRetry(messages, s, emit, tools = TOOLS) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.chat(messages, s, (partial) => emit('stream', partial), tools);
      } catch (e) {
        if (!(e instanceof ToolCallError) || attempt >= 3 || !this.running) throw e;
        emit('note', `The model wrote a tool call that couldn't be read (${e.detail}); asking it to try again.`);
        messages.push({ role: 'user', content: 'Your last tool call could not be read, so nothing happened. Call the tool again with simple arguments: plain text only, no XML, tags or angle brackets.' });
      }
    }
  }

  // One streamed /api/chat request. Returns the assembled assistant message.
  async chat(messages, s, onPartial, tools = TOOLS) {
    this.ctrl = new AbortController();
    const body = {
      model: s.model,
      messages: messages.map(({ trimmed, ...m }) => m),
      tools,
      stream: true,
      think: s.think,
      keep_alive: '15m',
      options: { temperature: s.temperature, num_ctx: s.numCtx },
    };
    const res = await fetch(`${this.hooks.baseUrl || ''}api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: this.ctrl.signal });
    if (!res.ok) {
      let err = `${res.status} ${res.statusText}`;
      try { err = (await res.json()).error || err; } catch { /* keep status */ }
      if (s.think && /think/i.test(err)) err += ' (try turning "Think" off for this model)';
      throw ollamaError(err);
    }
    const msg = { role: 'assistant', content: '', thinking: '', tool_calls: [], doneReason: null };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line);
        if (chunk.error) throw ollamaError(chunk.error);
        const m = chunk.message || {};
        if (m.content) msg.content += m.content;
        if (m.thinking) msg.thinking += m.thinking;
        if (m.tool_calls) msg.tool_calls.push(...m.tool_calls);
        if (chunk.done) Object.assign(msg, { doneReason: chunk.done_reason, promptTokens: chunk.prompt_eval_count, replyTokens: chunk.eval_count });
        onPartial({ thinking: msg.thinking, content: msg.content });
      }
    }
    if (!msg.tool_calls.length) delete msg.tool_calls;
    return msg;
  }
}
