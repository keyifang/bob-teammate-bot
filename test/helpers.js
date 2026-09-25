// Shared checks used by the formatting tests.
//
// checkHtmlBalance() is itself verified by a negative control in
// formatting.test.js ("the balance checker must reject known-bad input") -
// without that, a checker that always returns { balanced: true } would make
// every other assertion in this suite pass for the wrong reason.

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)>/g;

export function checkHtmlBalance(html) {
  const stack = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html)) !== null) {
    const name = m[2].toLowerCase();
    if (m[1] === "/") {
      if (stack.length === 0) {
        return { balanced: false, reason: `closing </${name}> with no open tag` };
      }
      const top = stack.pop();
      if (top !== name) {
        return { balanced: false, reason: `</${name}> closes <${top}>` };
      }
    } else {
      stack.push(name);
    }
  }
  if (stack.length) {
    return { balanced: false, reason: `unclosed: <${stack.join(">, <")}>` };
  }
  return { balanced: true };
}

export function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, "");
}

export function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function collapse(str) {
  return String(str).replace(/\s+/g, " ").trim();
}
