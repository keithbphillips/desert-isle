// Desert Isle server: serves the static client and proxies the Ollama API so the browser never
// needs CORS access to Ollama. Zero dependencies beyond Node itself (three.js is served from node_modules).
// Optionally, models on an OpenAI-compatible server (llama.cpp, LM Studio, vLLM, …) are offered too, as "openai/<id>",
// when OPENAI_URL is set (off by default: out of the box only Ollama is used).
//
//   PORT=8765 HOST=127.0.0.1 OLLAMA_URL=http://127.0.0.1:11434 [OPENAI_URL=http://127.0.0.1:8080] node server.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '127.0.0.1';
const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OPENAI = (process.env.OPENAI_URL || '').replace(/\/$/, '');
const OPENAI_PREFIX = 'openai/';
const STATIC = [
  { prefix: '/vendor/three/', dir: path.join(ROOT, 'node_modules/three') },
  { prefix: '/', dir: path.join(ROOT, 'public') },
];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  for (const { prefix, dir } of STATIC) {
    if (!urlPath.startsWith(prefix)) continue;
    let rel = decodeURIComponent(urlPath.slice(prefix.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir + path.sep)) break;
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound(res);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
  notFound(res);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// ---------- Optional OpenAI-compatible server ----------
// Its models are listed next to Ollama's as "openai/<id>". A chat with one of them is translated from Ollama's
// /api/chat (NDJSON) to the server's /v1/chat/completions (SSE) and back, so the client only ever speaks Ollama.

async function openaiModels() {
  if (!OPENAI) return [];
  try {
    const r = await fetch(`${OPENAI}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return [];
    return ((await r.json()).data || []).map((m) => ({
      name: OPENAI_PREFIX + m.id, model: OPENAI_PREFIX + m.id, backend: 'openai',
      details: { parameter_size: 'OpenAI API', context_length: m.meta?.n_ctx },
      capabilities: ['completion', 'tools', 'thinking'],
    }));
  } catch { return []; }
}

async function tags(res) {
  const [ollama, openai] = await Promise.all([
    fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch((e) => ({ error: e.cause?.code || e.message })),
    openaiModels(),
  ]);
  const models = [...openai, ...(ollama.models || [])];
  if (!models.length) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `No models: Ollama at ${OLLAMA}: ${ollama.error || 'none'}; OpenAI-compatible server: ${OPENAI || 'off (OPENAI_URL not set)'}` }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify({ models }));
}

// Ollama messages -> OpenAI messages. Ollama tool results carry only tool_name, so they are matched to the
// preceding assistant message's calls in order. Ids are derived from positions, so the conversation renders
// identically every turn (a server's prompt cache can reuse it).
function toOpenAIMessages(messages) {
  const out = [];
  let pending = []; // ids of the latest assistant calls not yet answered
  const answerRest = () => { for (const id of pending) out.push({ role: 'tool', tool_call_id: id, content: 'Not run.' }); pending = []; };
  messages.forEach((m, i) => {
    if (m.role === 'tool') {
      const id = pending.shift();
      if (id) out.push({ role: 'tool', tool_call_id: id, content: String(m.content ?? '') });
      else out.push({ role: 'user', content: `[${m.tool_name || 'tool'} result] ${m.content ?? ''}` });
      return;
    }
    answerRest();
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const tool_calls = m.tool_calls.map((c, j) => ({
        id: c.id || `call_${i}_${j}`, type: 'function',
        function: { name: c.function?.name, arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments || {}) },
      }));
      pending = tool_calls.map((c) => c.id);
      out.push({ role: 'assistant', content: m.content || '', tool_calls });
    } else out.push({ role: m.role, content: String(m.content ?? '') });
  });
  answerRest();
  return out;
}

async function openaiChat(req, res, ollamaReq) {
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  const body = {
    model: ollamaReq.model.slice(OPENAI_PREFIX.length),
    messages: toOpenAIMessages(ollamaReq.messages || []),
    tools: ollamaReq.tools,
    stream: true,
    stream_options: { include_usage: true },
    ...(ollamaReq.options?.temperature != null ? { temperature: ollamaReq.options.temperature } : {}),
  };
  // Think: false = off, true = the server's default effort, 'low' | 'medium' | 'high' = that effort.
  const think = ollamaReq.think;
  if (think === false) body.chat_template_kwargs = { enable_thinking: false };
  else if (typeof think === 'string') body.reasoning_effort = think;
  const line = (o) => res.write(JSON.stringify(o) + '\n');
  try {
    const up = await fetch(`${OPENAI}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!up.ok) {
      let err = `${up.status} ${up.statusText}`;
      try { const j = await up.json(); err = j.error?.message || j.error || err; } catch { /* keep status */ }
      res.writeHead(up.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `OpenAI-compatible server: ${err}` }));
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    const calls = [];
    let finish = null, usage = null, buf = '';
    const dec = new TextDecoder();
    const handle = (data) => {
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
      if (chunk.usage) usage = chunk.usage;
      const ch = chunk.choices?.[0];
      if (!ch) return;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      const thinking = d.reasoning_content || d.reasoning || '';
      if (d.content || thinking) line({ message: { role: 'assistant', content: d.content || '', ...(thinking ? { thinking } : {}) }, done: false });
      for (const t of d.tool_calls || []) {
        const c = (calls[t.index ?? calls.length] ??= { id: '', name: '', args: '' });
        if (t.id) c.id = t.id;
        if (t.function?.name) c.name += t.function.name;
        if (t.function?.arguments) c.args += t.function.arguments;
      }
    };
    for await (const part of up.body) {
      buf += dec.decode(part, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (l.startsWith('data:') && l.slice(5).trim() !== '[DONE]') handle(l.slice(5).trim());
      }
    }
    const tool_calls = [];
    for (const c of calls.filter(Boolean)) {
      let args;
      try { args = c.args.trim() ? JSON.parse(c.args) : {}; } catch {
        return res.end(JSON.stringify({ error: `error parsing tool call: invalid character in arguments of ${c.name}: ${c.args.slice(0, 200)}` }) + '\n');
      }
      tool_calls.push({ id: c.id || undefined, function: { name: c.name, arguments: args } });
    }
    if (tool_calls.length) line({ message: { role: 'assistant', content: '', tool_calls }, done: false });
    line({ message: { role: 'assistant', content: '' }, done: true, done_reason: finish === 'length' ? 'length' : 'stop', prompt_eval_count: usage?.prompt_tokens, eval_count: usage?.completion_tokens });
    res.end();
  } catch (e) {
    if (ctrl.signal.aborted) return;
    const error = `OpenAI-compatible server at ${OPENAI}: ${e.cause?.code || e.message}`;
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error })); }
    res.end(JSON.stringify({ error }) + '\n');
  }
}

// Forward /api/<x> to Ollama's /api/<x>, streaming the response back and aborting upstream if the browser goes away.
async function proxy(req, res, apiPath) {
  const allowed = { 'chat': 'POST', 'tags': 'GET', 'show': 'POST', 'version': 'GET' };
  if (allowed[apiPath] !== req.method) {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `${req.method} /api/${apiPath} is not proxied` }));
  }
  if (apiPath === 'tags') return tags(res);
  if (apiPath === 'chat') {
    let parsed;
    try { parsed = JSON.parse(await readBody(req)); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `bad request: ${e.message}` }));
    }
    if (OPENAI && parsed.model?.startsWith(OPENAI_PREFIX)) return openaiChat(req, res, parsed);
    req.parsedBody = Buffer.from(JSON.stringify(parsed));
  }
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  try {
    const body = req.parsedBody || (req.method === 'POST' ? await readBody(req) : undefined);
    const up = await fetch(`${OLLAMA}/api/${apiPath}`, { method: req.method, body, headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal });
    res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-cache' });
    for await (const chunk of up.body) res.write(chunk);
    res.end();
  } catch (e) {
    if (ctrl.signal.aborted) return;
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Could not reach Ollama at ${OLLAMA}: ${e.cause?.code || e.message}` }));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4e6) { reject(new Error('request too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Desert Isle has no service worker. If another app that once ran on this origin left one behind, it would
// serve stale cached files; answering its update check with this script makes it clear its caches and remove itself.
const SW_KILL = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
})()));`;

http
  .createServer((req, res) => {
    const urlPath = new URL(req.url, 'http://x').pathname;
    if (/^\/(sw|service-worker)\.js$/.test(urlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return res.end(SW_KILL);
    }
    const api = urlPath.match(/^\/api\/([a-z]+)$/);
    if (api) return proxy(req, res, api[1]);
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
    serveStatic(req, res, urlPath);
  })
  .listen(PORT, HOST, () => console.log(`Desert Isle on http://${HOST}:${PORT}/  (Ollama: ${OLLAMA}, OpenAI-compatible: ${OPENAI || 'off'})`));
