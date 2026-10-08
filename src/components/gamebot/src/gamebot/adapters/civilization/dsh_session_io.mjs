// Read and append one DSH session log. stdout is JSON only.
import { readFileSync, appendFileSync, openSync, closeSync, unlinkSync, constants } from "node:fs";
import { gunzipSync, inflateSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";

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

function withLock(file, fn) {
  const lock = `${file}.civlock`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let fd = -1;
    try {
      fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      closeSync(fd);
      fd = -1;
      try {
        return fn();
      } finally {
        try {
          unlinkSync(lock);
        } catch {
          /* another writer already cleared it */
        }
      }
    } catch (err) {
      if (fd >= 0) closeSync(fd);
      if (err && err.code !== "EEXIST") throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  throw new Error("session log is busy");
}

function tail(file, limit) {
  const events = decode(readFileSync(file));
  const rows = messagesOf(events);
  return { ok: true, messages: rows.slice(-limit) };
}

function append(file, payload) {
  return withLock(file, () => {
    const events = decode(readFileSync(file));
    let seq = 0;
    let turn = 0;
    for (const event of events) {
      if (typeof event.seq === "number" && event.seq > seq) seq = event.seq;
      const data = event.data || {};
      if (typeof data.turn === "number" && data.turn > turn) turn = data.turn;
    }
    turn += 1;
    const user = String(payload.user || "").slice(0, 4000);
    const assistant = String(payload.assistant || "").slice(0, 4000);
    const provider = String(payload.provider || "civ6");
    const model = String(payload.model || "companion");
    const userId = `civ6-user-${turn}`;
    const assistantId = `civ6-assistant-${turn}`;
    const next = [
      { type: "turn/start", data: { turn } },
      { type: "step/start", data: { turn, step: 1 } },
      {
        type: "user/message",
        surfaceOp: "append",
        data: { content: [{ type: "text", text: user }], source: { kind: "user" }, role: "user", id: userId },
      },
      {
        type: "assistant/message",
        surfaceOp: "append",
        data: {
          turn,
          step: 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: assistant }],
            source: { kind: "model", provider, model },
            id: assistantId,
          },
        },
      },
      { type: "step/end", data: { turn, step: 1 } },
      { type: "turn/end", data: { turn, reason: { kind: "completed" } } },
    ].map((event) => ({ ...event, seq: (seq += 1) }));
    const body = `${next.map((event) => JSON.stringify(event)).join("\n")}\n`;
    appendFileSync(file, zstdCompressSync(Buffer.from(body)));
    return { ok: true, turn, seq };
  });
}

const [op, file, extra] = process.argv.slice(2);
if (!file) {
  process.stdout.write(JSON.stringify({ ok: false, error: "missing session file" }));
  process.exit(1);
}
try {
  if (op === "tail") {
    process.stdout.write(JSON.stringify(tail(file, Number(extra || 8))));
  } else if (op === "append") {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    process.stdout.write(JSON.stringify(append(file, payload)));
  } else {
    throw new Error(`unknown op ${op}`);
  }
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
  process.exit(1);
}
