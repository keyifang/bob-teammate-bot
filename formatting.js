// Turns markdown-ish model output into Telegram-safe HTML.
//
// Telegram parses messages (and captions) with HTML, so every character that
// could open a tag must be escaped before any tag we intend is inserted, and
// every tag we emit must be balanced - Telegram rejects the whole message with
// 400 "can't parse entities" otherwise, so the user would see nothing at all.
//
// Telegram has no native table rendering, so tables become fixed-width text
// inside <pre>. The pipe character is referenced via String.fromCharCode(124)
// so it never appears as a literal in this source file.

const PIPE = String.fromCharCode(124);
const BULLET = String.fromCharCode(8226); // U+2022, plain text, safe in HTML mode

const VOID_TAGS = new Set();

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith(PIPE)) trimmed = trimmed.slice(1);
  if (trimmed.endsWith(PIPE)) trimmed = trimmed.slice(0, -1);
  return trimmed.split(PIPE).map((c) => c.trim());
}

function isSeparatorRow(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function looksLikeTableRow(line) {
  return line.includes(PIPE);
}

function looksLikeTableStart(lines, i) {
  if (!looksLikeTableRow(lines[i])) return false;
  const next = lines[i + 1];
  if (next === undefined) return false;
  if (!looksLikeTableRow(next)) return false;
  return isSeparatorRow(next);
}

function renderTable(lines) {
  const rows = lines.filter((l) => !isSeparatorRow(l)).map(splitTableRow);
  if (!rows.length) return lines.join("\n");

  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = [];
  for (let i = 0; i < colCount; i++) {
    widths.push(Math.max(...rows.map((r) => (r[i] ?? "").length)));
  }

  const rendered = rows
    .map((r) => {
      const cells = [];
      for (let i = 0; i < colCount; i++) {
        cells.push((r[i] ?? "").padEnd(widths[i]));
      }
      return cells.join("  ").replace(/\s+$/, "");
    })
    .join("\n");

  return `<pre>${escapeHtml(rendered)}</pre>`;
}

// Inline styles applied to ALREADY-ESCAPED text. Runs are kept on one line and
// are not allowed to straddle a space at the start (so a lone '*' used as a
// bullet or a multiplication sign is left alone).
function renderInline(escaped) {
  return escaped
    .replace(/`([^`\n]+?)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    .replace(/__([^_\n]+?)__/g, "<b>$1</b>");
}

function renderLine(line) {
  let l = line;

  // Headings -> bold
  const heading = l.match(/^\s{0,3}#{1,6}\s+(.*)$/);
  if (heading) return `<b>${renderInline(escapeHtml(heading[1].trim()))}</b>`;

  // Task list items keep their checkbox as text
  const task = l.match(/^\s*[-*+]\s*\[([ xX])\]\s*(.*)$/);
  if (task) {
    const box = task[1].toLowerCase() === "x" ? "[x]" : "[ ]";
    return `${box} ${renderInline(escapeHtml(task[2]))}`;
  }

  // Plain bullets: normalise the marker so it can never be read as emphasis
  const bullet = l.match(/^\s*[-*+]\s+(.*)$/);
  if (bullet) return `${BULLET} ${renderInline(escapeHtml(bullet[1]))}`;

  return renderInline(escapeHtml(l));
}

export function formatForTelegram(raw) {
  const lines = String(raw).split("\n");
  const out = [];
  let tableBuffer = [];

  const flushTable = () => {
    if (tableBuffer.length) {
      out.push(renderTable(tableBuffer));
      tableBuffer = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!tableBuffer.length && looksLikeTableStart(lines, i)) {
      tableBuffer.push(line);
      continue;
    }
    if (tableBuffer.length) {
      if (looksLikeTableRow(line)) {
        tableBuffer.push(line);
        continue;
      }
      flushTable();
    }

    out.push(renderLine(line));
  }
  flushTable();

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Chunking
//
// Model output is bounded in tokens but a long table or list can still exceed
// Telegram's 4096-code-unit message limit. Reopening/closing tags at a boundary
// is not optional: an unbalanced tag makes Telegram reject the whole message
// with 400 "can't parse entities", so the user sees nothing rather than an
// awkwardly split answer.
// ---------------------------------------------------------------------------

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)>/g;

function tagName(rawTag) {
  const m = rawTag.match(/^<([a-zA-Z][a-zA-Z0-9-]*)/);
  return m ? m[1].toLowerCase() : "b";
}

function closersFor(stack) {
  return stack
    .slice()
    .reverse()
    .map((t) => `</${tagName(t)}>`)
    .join("");
}

/**
 * A single logical line can exceed the whole budget on its own (a <pre> table
 * row, a long URL). Cut at a safe boundary: whitespace where possible, never
 * inside a tag, never between the two halves of a surrogate pair.
 */
function splitLongLine(line, budget) {
  const pieces = [];
  let rest = line;

  while (rest.length > budget) {
    let cut = rest.lastIndexOf(" ", budget);
    if (cut <= 0) cut = budget;

    const openTag = rest.lastIndexOf("<", cut);
    if (openTag !== -1 && rest.indexOf(">", openTag) >= cut) cut = openTag;

    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // lone high surrogate

    if (cut <= 0) {
      // No safe boundary at all (a single oversized tag): emit raw and stop.
      pieces.push(rest.slice(0, budget));
      rest = rest.slice(budget);
      continue;
    }

    pieces.push(rest.slice(0, cut).replace(/\s+$/, ""));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }

  if (rest) pieces.push(rest);
  return pieces.filter((p) => p.length > 0);
}

/**
 * Splits formatted HTML into Telegram-sized chunks. Each chunk is closed and
 * re-opened so it is valid HTML on its own.
 *
 * Implementation: the HTML is re-serialised as a token stream (tags + text) and
 * then laid out against a per-chunk budget that accounts for the prefix (tags
 * carried in from the chunk start) and the suffix (tags closed at the end).
 * Tracking on the token stream - rather than on raw slices - is what keeps the
 * open/close counts balanced; see test/formatting.test.js.
 */
export function chunkMessage(html, maxLen = 4096) {
  const text = String(html);
  if (text.length <= maxLen) return [text];

  TAG_RE.lastIndex = 0;
  const tokens = [];
  let last = 0;
  let m;
  while ((m = TAG_RE.exec(text)) !== null) {
    if (m.index > last) {
      tokens.push({ type: "text", value: text.slice(last, m.index) });
    }
    const open = m[1] !== "/";
    const name = m[2].toLowerCase();
    if (!VOID_TAGS.has(name)) {
      tokens.push({ type: "tag", open, name, raw: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    tokens.push({ type: "text", value: text.slice(last) });
  }

  const chunks = [];
  let body = []; // strings inside the current chunk, tags included
  let bodyLen = 0;
  let openStack = []; // stack at the current point in the stream
  let startStack = []; // stack as it was when the current chunk began

  // Remaining room in the CURRENT chunk. Must subtract bodyLen: the tags
  // already pushed count against the limit too. Omitting it lets a chunk
  // overshoot by the length of its opening tags (caught by the chunk-size test).
  const budget = () =>
    maxLen -
    startStack.join("").length -
    closersFor(openStack).length -
    bodyLen;

  const flush = () => {
    if (!bodyLen) return;
    chunks.push(startStack.join("") + body.join("") + closersFor(openStack));
    body = [];
    bodyLen = 0;
    startStack = openStack.slice();
  };

  const push = (str) => {
    body.push(str);
    bodyLen += str.length;
  };

  for (const token of tokens) {
    if (token.type === "tag") {
      if (token.open) {
        if (budget() <= token.raw.length + 1 && bodyLen) flush();
        openStack.push(token.raw);
        push(token.raw);
      } else {
        push(`</${token.name}>`);
        for (let i = openStack.length - 1; i >= 0; i--) {
          if (tagName(openStack[i]) === token.name) {
            openStack.splice(i, 1);
            break;
          }
        }
      }
      continue;
    }

    // Text token: emit in pieces that fit the remaining budget.
    let rest = token.value;
    while (rest.length) {
      const room = budget();
      if (room <= 0) {
        const before = bodyLen;
        flush();
        // If flushing bought nothing (prefix+suffix alone exceed maxLen), the
        // only way forward is a raw cut. Losing a little formatting beats
        // looping forever or sending a message Telegram will reject.
        if (bodyLen === 0 && before === 0) {
          chunks.push(rest.slice(0, maxLen));
          rest = rest.slice(maxLen);
        }
        continue;
      }
      if (rest.length <= room) {
        push(rest);
        rest = "";
        continue;
      }
      const pieces = splitLongLine(rest, room);
      push(pieces[0]);
      rest = rest.slice(pieces[0].length).replace(/^\s+/, "");
      flush();
    }
  }

  flush();
  return chunks.filter((c) => c.length > 0);
}
