// Read the tail of one DSH session log (read-only fallback). stdout is JSON only.
// Never writes session files: new lines go through the in-host bridge (dsh_link.py), so the
// live Session keeps ownership of its log, sequence numbers and projections.
import { readFileSync } from "node:fs";
import { gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";

const ZSTD = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GZIP = Buffer.from([0x1f, 0x8b]);
const DEFLATE = Buffer.from([0x78, 0x9c]);

function frames(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const z = buf.indexOf(ZSTD, i);
    const g = buf.indexOf(GZIP, i);
    const d = buf.indexOf(DEFLATE, i);
    const hits = [z, g, d].filter((n) => n >= 0).sort((a, b) => a - b);
    if (!hits.length) break;
    const start = hits[0];
    const nexts = [buf.indexOf(ZSTD, start + 4), buf.indexOf(GZIP, start + 2), buf.indexOf(DEFLATE, start + 2)]
      .filter((n) => n > start)
      .sort((a, b) => a - b);
    const end = nexts.length ? nexts[0] : buf.length;
    out.push(buf.subarray(start, end));
    i = end;
  }
  return out;
}

function decode(buf) {
  if (!buf.length) return [];
  const lines = [];
  for (const frame of frames(buf)) {
    let text = "";
    try {
      if (frame.subarray(0, 4).equals(ZSTD)) text = zstdDecompressSync(frame).toString("utf8");
      else if (frame.subarray(0, 2).equals(GZIP)) text = gunzipSync(frame).toString("utf8");
      else text = inflateSync(frame).toString("utf8");
    } catch {
      text = "";
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        /* skip a damaged line */
      }
    }
  }
  return lines;
}

function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function messagesOf(events) {
  const rows = [];
  for (const event of events) {
    if (event.type === "user/message") {
      const text = textOf(event.data && event.data.content).slice(0, 2000);
      if (text) rows.push({ role: "user", text });
    } else if (event.type === "assistant/message") {
      const message = event.data && event.data.message;
      const text = textOf(message && message.content).slice(0, 2000);
      if (text) rows.push({ role: "assistant", text });
    }
  }
  return rows;
}

function tail(file, limit) {
  const events = decode(readFileSync(file));
  const rows = messagesOf(events);
  return { ok: true, messages: rows.slice(-limit) };
}

const [op, file, extra] = process.argv.slice(2);
if (!file) {
  process.stdout.write(JSON.stringify({ ok: false, error: "missing session file" }));
  process.exit(1);
}
try {
  if (op === "tail") {
    process.stdout.write(JSON.stringify(tail(file, Number(extra || 8))));
  } else {
    throw new Error(`unsupported op ${op} (this tool is read-only)`);
  }
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
  process.exit(1);
}
