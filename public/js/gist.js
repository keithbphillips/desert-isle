// Picks the robot's "main thought" out of a model's thinking for the thought bubble: the latest sentence that
// expresses intent or reasoning ("Let me try stacking crates."), with world details like coordinates removed.
// Restated observations ("The ring is at (-3,7), 5.6 m up."), lists and plans full of coordinates are skipped.

const COORD = String.raw`\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)`;
const RANGE = String.raw`\bx\s*-?\d+\s*\.\.\s*-?\d+\s*,?\s*y\s*-?\d+\s*\.\.\s*-?\d+`;
const INTENT = /\b(i'll|i will|i'd|let me|let's|i need|i should|i must|i want|i have to|i'm going|i am going|going to|i can try|try|maybe|perhaps|plan|next|first|so i|wait|hmm|actually|i wonder|interesting|i think|i guess|i learned|that means|this means|strategy|idea|oh|aha|seems)\b/i;
const MAX = 120;

function clean(sentence) {
  return sentence
    .replace(new RegExp(String.raw`\b(at|to|on|onto|near|above|around|toward|towards|under)\s+(?:${COORD}|${RANGE})`, 'gi'), '$1 there')
    .replace(new RegExp(String.raw`\s*(?:${COORD}|${RANGE})`, 'g'), '')
    .replace(/\bat there\b/gi, 'there')
    .replace(/\bblock_\d+\b/gi, 'a crate')
    .replace(/\*\*|`/g, '')
    .replace(/^["')\]\s]+/, '')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// final: the text is complete (otherwise the last, still-streaming sentence is ignored).
// Returns null when there is no main thought yet.
export function thoughtGist(text, { final = false } = {}) {
  if (!text) return null;
  const lines = text.split(/\n+/).filter((l) => !/^\s*([-*•]|\d+[.)])\s/.test(l));
  let sentences = lines.flatMap((l) => l.match(/(?:[^.!?]|\.(?=\d))+[.!?]+["')\]]*|(?:[^.!?]|\.(?=\d))+$/g) || []).map((s) => s.trim()).filter(Boolean);
  // While streaming, the last sentence may be unfinished, even if it ends in "3." of a coming "3.0 m".
  if (!final && sentences.length && (!/[.!?]["')\]]*$/.test(sentences.at(-1)) || /\d\.$/.test(text.trimEnd()))) sentences = sentences.slice(0, -1);
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i];
    if (!INTENT.test(s)) continue;
    if ((s.match(new RegExp(COORD, 'g')) || []).length > 1) continue; // a list of places, not a thought
    const c = clean(s);
    if (c.length < 12 || /:$/.test(c)) continue;
    return c.length <= MAX ? c : `${c.slice(0, c.lastIndexOf(' ', MAX - 1))}…`;
  }
  return null;
}
