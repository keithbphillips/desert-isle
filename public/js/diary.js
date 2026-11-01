// The robot's diary: its only long-term memory. It survives island resets and new instructions.
// Storage is pluggable: localStorage in the browser, a JSON file in the headless runner.
//
// The model is shown at most DIARY_LIMIT characters of it (newest entries first), so a diary that keeps growing
// would silently lose its oldest entries. Once it is half full the robot is offered rewrite_diary, which replaces
// it with one shorter entry. The entries it replaced are kept in storage (marked `old`) so nothing is ever really
// lost: the model never sees them again, but "Save as text" in the UI still includes them.

const MAX_ENTRY = 1500;
export const DIARY_LIMIT = 12000; // characters of diary the model is shown
export const REWRITE_MAX = 6000; // a rewrite may use at most half, leaving room to keep writing
export const REWRITE_OFFER = 0.5; // fullness at which rewrite_diary is offered
export const FULL_WARN = 0.75; // fullness at which the robot is told how full its diary is

export class Diary {
  // storage: { load() -> entries[] | null, save(entries) }
  constructor(storage) {
    this.storage = storage;
    this.all = []; // every entry ever written, including ones a rewrite replaced ({ old: true })
    try { this.all = storage.load() || []; } catch { this.all = []; }
    this.listeners = new Set();
  }

  // The current entries: what the robot remembers.
  get entries() {
    return this.all.filter((e) => !e.old);
  }
  // Entries replaced by a rewrite (kept for you, never shown to the model).
  get archived() {
    return this.all.filter((e) => e.old);
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  _changed() {
    try { this.storage.save(this.all); } catch { /* storage unavailable: keep in memory */ }
    for (const fn of this.listeners) fn(this.entries);
  }

  write(text) {
    const t = String(text ?? '').trim().slice(0, MAX_ENTRY);
    if (!t) return null;
    this.all.push({ at: new Date().toISOString(), text: t });
    this._changed();
    return this.entries.length;
  }

  // Replace the whole diary with one entry. Returns { ok, text } (text explains a failure).
  rewrite(text) {
    const t = String(text ?? '').trim();
    if (!t) return { ok: false, text: 'the new version was empty, so your diary was left as it was.' };
    if (t.length > REWRITE_MAX) return { ok: false, text: `the new version is ${t.length} characters; it can be at most ${REWRITE_MAX}. Your diary was left as it was.` };
    const at = new Date().toISOString();
    for (const e of this.all) if (!e.old) { e.old = true; e.replacedAt = at; }
    this.all.push({ at, text: t, rewrite: true });
    this._changed();
    return { ok: true, text: t };
  }

  clear() {
    this.all = [];
    this._changed();
  }

  _lines() {
    return this.entries.map((e, i) => `#${i + 1} (${e.at.slice(0, 16).replace('T', ' ')}${e.rewrite ? ', rewritten diary' : ''}): ${e.text}`);
  }
  // How full the diary is, 0..1+ (characters the model would be shown / DIARY_LIMIT).
  fullness() {
    return this._lines().reduce((n, l) => n + l.length + 1, 0) / DIARY_LIMIT;
  }

  // Text for the model: newest entries kept if the whole diary is too long.
  read() {
    if (!this.entries.length) return 'Your diary is empty.';
    const lines = this._lines();
    let total = 0;
    let first = lines.length;
    while (first > 0 && total + lines[first - 1].length < DIARY_LIMIT) total += lines[--first].length + 1;
    const head = first > 0 ? [`(${first} older entr${first === 1 ? 'y' : 'ies'} not shown: diary too long)`] : [];
    return [`Your diary (${this.entries.length} entr${this.entries.length === 1 ? 'y' : 'ies'}):`, ...head, ...lines.slice(first)].join('\n');
  }

  toText() {
    const cur = this.entries.map((e, i) => `#${i + 1}  ${e.at}${e.rewrite ? '  (rewritten diary)' : ''}\n${e.text}\n`).join('\n');
    const old = this.archived;
    if (!old.length) return cur;
    return `${cur}\n\n===== Older entries, replaced when the robot rewrote its diary =====\n\n${old.map((e) => `${e.at}  (replaced ${e.replacedAt})\n${e.text}\n`).join('\n')}`;
  }
}
