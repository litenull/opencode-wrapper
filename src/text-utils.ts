const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export function sanitizeText(text: string): string {
  if (!text) return "";
  text = text.replace(ANSI_RE, "");
  text = text.replace(/\r/g, "");
  text = [...text].filter((ch) => ch === "\n" || ch === "\t" || ch.charCodeAt(0) >= 32).join("");
  return text;
}

export function extractDelta(prev: string, cur: string): string {
  if (cur === prev) return "";

  const maxPrefix = Math.min(prev.length, cur.length);
  let prefixLen = 0;
  while (prefixLen < maxPrefix && prev[prefixLen] === cur[prefixLen]) {
    prefixLen++;
  }

  const maxSuffix = Math.min(prev.length - prefixLen, cur.length - prefixLen);
  let suffixLen = 0;
  while (suffixLen < maxSuffix && prev[prev.length - 1 - suffixLen] === cur[cur.length - 1 - suffixLen]) {
    suffixLen++;
  }

  const end = suffixLen > 0 ? cur.length - suffixLen : cur.length;
  return cur.slice(prefixLen, Math.max(prefixLen, end));
}

export function appendUnique(emitted: string, chunk: string): [string, string] {
  chunk = sanitizeText(chunk);
  if (!chunk) return ["", emitted];

  if (emitted.slice(-4000).includes(chunk)) return ["", emitted];

  const maxOverlap = Math.min(emitted.length, chunk.length, 2000);
  let overlap = 0;
  for (let i = maxOverlap; i > 0; i--) {
    if (emitted.slice(-i) === chunk.slice(0, i)) {
      overlap = i;
      break;
    }
  }

  const unique = chunk.slice(overlap);
  if (!unique) return ["", emitted];
  return [unique, emitted + unique];
}

export function normalizeSpace(text: string): string {
  return (text ?? "").split(/\s+/).join(" ").trim();
}

export function isPromptEcho(chunk: string, prompt: string): boolean {
  const c = normalizeSpace(chunk);
  const p = normalizeSpace(prompt);
  if (!c || !p) return false;
  if (c === p) return true;
  if (c === `> ${p}`) return true;
  if (c === `[user] ${p}`) return true;
  if (c.endsWith(`> ${p}`)) return true;
  return false;
}

function isUiNoiseLine(stripped: string): boolean {
  if (!stripped) return false;
  if (stripped.includes("? for shortcuts")) return true;
  if (stripped.includes("Contemplating")) return true;
  if (stripped.includes("esc to interrupt")) return true;
  if (stripped.startsWith("[Pasted text #")) return true;
  if (/^[\-─_]+$/.test(stripped)) return true;
  return false;
}

export function extractLatestAssistantText(pane: string): string {
  const text = sanitizeText(pane);
  const lines = text.split("\n");
  const blocks: string[][] = [];
  let current: string[] | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const stripped = line.trim();

    const bulletIdx = line.lastIndexOf("● ");
    if (bulletIdx !== -1) {
      if (current) blocks.push(current);
      current = [line.slice(bulletIdx + 2).trim()];
      continue;
    }

    if (isUiNoiseLine(stripped)) continue;

    if (/^\s*>/.test(line)) {
      if (current) {
        blocks.push(current);
        current = null;
      }
      continue;
    }

    if (current === null) continue;

    if (/^\s{2,}/.test(line) || line.startsWith("\t")) {
      if (stripped) {
        current.push(stripped);
      } else if (current.length > 0 && current[current.length - 1] !== "") {
        current.push("");
      }
      continue;
    }

    if (stripped === "") {
      if (current.length > 0 && current[current.length - 1] !== "") {
        current.push("");
      }
      continue;
    }

    blocks.push(current);
    current = null;
  }

  if (current) blocks.push(current);

  if (blocks.length === 0) return "";

  const last = blocks[blocks.length - 1];
  const out: string[] = [];
  let prevBlank = false;

  for (const part of last) {
    const s = part.trim();
    if (!s) {
      if (!prevBlank) out.push("");
      prevBlank = true;
      continue;
    }
    out.push(s);
    prevBlank = false;
  }

  return out.join("\n").trim();
}

export function buildMessagesPrompt(
  messages: { role: string; content: string | { text?: string }[] }[],
  promptMode: "last_user" | "full"
): string {
  function contentToText(content: string | { text?: string }[]): string {
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === "object" && part !== null ? part.text ?? "" : String(part)))
        .join("\n");
    }
    return String(content ?? "");
  }

  if (promptMode !== "full") {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        return contentToText(messages[i].content).trim();
      }
    }
    if (messages.length > 0) {
      return contentToText(messages[messages.length - 1].content).trim();
    }
    return "";
  }

  const lines = messages.map((msg) => {
    const role = msg.role ?? "user";
    const content = contentToText(msg.content);
    return `[${role}] ${content}`;
  });
  return lines.join("\n").trim();
}
