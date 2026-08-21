// lib/highlight.js — lightweight JavaScript tokenizer (per-line, no cross-line state)

/** @type {Set<string>} */
const KEYWORDS = new Set([
  "abstract", "arguments", "async", "await", "break", "case", "catch",
  "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "from",
  "function", "get", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "of", "package", "private", "protected",
  "public", "return", "set", "static", "super", "switch", "this", "throw",
  "true", "try", "typeof", "undefined", "var", "void", "while", "with",
  "yield",
]);

/** @type {RegExp} */
const TOKEN_RE = new RegExp(
  [
    "(//[^\\n]*)",
    "(/\\*[\\s\\S]*?(?:\\*/|$))",
    "('(?:\\\\.|[^'\\\\])*'?)",
    '("(?:\\\\.|[^"\\\\])*"?)',
    "(`(?:\\\\.|[^`\\\\])*`?)",
    "(\\b0[xX][0-9a-fA-F]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)",
    "([A-Za-z_$][A-Za-z0-9_$]*)",
    "(\\s+)",
    "([{}()\\[\\];,.:?=+\\-*/%<>!&|^~@]+)",
    "([\\s\\S])",
  ].join("|"),
  "g"
);

/**
 * Tokenize a single line of JavaScript.
 * @param {string} line
 * @returns {Array<{type: string, value: string}>}
 */
export const tokenizeLine = (line) => {
  const tokens = [];
  if (!line) return tokens;

  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    if (m[1] || m[2]) tokens.push({ type: "comment", value: m[0] });
    else if (m[3] || m[4]) tokens.push({ type: "string", value: m[0] });
    else if (m[5]) tokens.push({ type: "template", value: m[0] });
    else if (m[6]) tokens.push({ type: "number", value: m[0] });
    else if (m[7]) {
      const value = m[7];
      if (KEYWORDS.has(value)) tokens.push({ type: "keyword", value });
      else {
        // Identifier followed (ignoring spaces) by "(" → function call/def.
        const rest = line.slice(TOKEN_RE.lastIndex);
        const isCall = /^\s*\(/.test(rest);
        tokens.push({ type: isCall ? "function" : "text", value });
      }
    } else if (m[8]) tokens.push({ type: "ws", value: m[0] });
    else if (m[9]) tokens.push({ type: "punct", value: m[0] });
    else tokens.push({ type: "text", value: m[0] });

    if (m.index === TOKEN_RE.lastIndex) TOKEN_RE.lastIndex++;
  }
  return tokens;
};

