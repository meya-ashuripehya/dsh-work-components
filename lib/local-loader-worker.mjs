/* dsh-workbench. Original code: MIT, Copyright (c) 2026 dsh-workbench contributors. See LICENSE.
 * Bundled portions of @deepseek-ai/dsh-tools, @deepseek-ai/dsh-util-values, and HarnessError
 * from @deepseek-ai/dsh-llm: Copyright (c) 2026 DeepSeek, MIT. See vendor/dsh-tools/LICENSE and NOTICE.
 */
import { createRequire as __mmCreateRequire } from 'node:module'; const require = __mmCreateRequire(import.meta.url);

// src/components/local-loader-worker.mjs
import { existsSync as existsSync2 } from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/connect-lib.mjs
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
var NET_TIMEOUT_MS = 800;
var IS_WIN = process.platform === "win32";
function run(cmd, args, timeout = 5e3) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}
async function listProcesses() {
  const names = /* @__PURE__ */ new Set();
  if (IS_WIN) {
    const out = await run("tasklist", ["/FO", "CSV", "/NH"]);
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)"/.exec(line);
      if (m) names.add(m[1].toLowerCase().replace(/\.exe$/, ""));
    }
  } else {
    const out = await run("ps", ["-A", "-o", "comm="]);
    for (const line of out.split("\n")) {
      const p = line.trim();
      if (p) names.add(p.split("/").pop().toLowerCase());
    }
  }
  return names;
}
function tcpOpen(host, port, timeout = NET_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeout);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}
function unityPing(port, timeout = NET_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    let buf = Buffer.alloc(0);
    let stage = "hello";
    const done = (ok) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeout);
    sock.once("error", () => done(false));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "hello") {
        const text = buf.toString("latin1");
        if (!text.includes("FRAMING=1")) {
          if (text.includes("\n") || buf.length > 256) done(false);
          return;
        }
        stage = "pong";
        buf = Buffer.alloc(0);
        const header = Buffer.alloc(8);
        header.writeBigUInt64BE(4n);
        sock.write(Buffer.concat([header, Buffer.from("ping")]));
        return;
      }
      if (buf.length < 8) return;
      const len = Number(buf.readBigUInt64BE(0));
      if (len > 1e4) return done(false);
      if (buf.length < 8 + len) return;
      done(buf.subarray(8, 8 + len).toString("utf8").includes('"message":"pong"'));
    });
  });
}
async function httpJson(url, timeout = 1500) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function httpStatus(url, timeout = 1500) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}
function profileLocked(dir) {
  if (!dir) return false;
  if (IS_WIN) {
    const p = join(dir, "lockfile");
    if (!existsSync(p)) return false;
    try {
      closeSync(openSync(p, "r+"));
      return false;
    } catch (error) {
      return error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES";
    }
  }
  try {
    const target = readlinkSync(join(dir, "SingletonLock"));
    const pid = Number(target.split("-").pop());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
var defaultEnv = { processes: listProcesses, tcpOpen, unityPing, httpJson, httpStatus, profileLocked, home: homedir, env: process.env };

// src/components/local-loader-worker.mjs
var SDK_URL = [new URL("./component-sdk.mjs", import.meta.url), new URL("../component-sdk.mjs", import.meta.url)].find((u) => existsSync2(fileURLToPath(u)))?.href || null;
var SDK_HOOKS = `
let sdk = null
export function initialize(data) { sdk = data && data.sdk }
const LEGACY = /(^|\\/)src\\/(components\\/shared|tools|connect-lib)\\.mjs$/
export async function resolve(specifier, context, next) {
  if (sdk && (specifier === 'dsh-work-components/sdk')) return { url: sdk, shortCircuit: true }
  try {
    return await next(specifier, context)
  } catch (err) {
    if (sdk && err && err.code === 'ERR_MODULE_NOT_FOUND' && LEGACY.test(String(specifier).replace(/\\\\/g, '/'))) {
      return { url: sdk, shortCircuit: true }
    }
    throw err
  }
}
`;
if (SDK_URL) {
  try {
    register("data:text/javascript," + encodeURIComponent(SDK_HOOKS), { data: { sdk: SDK_URL } });
  } catch {
  }
}
var mod = null;
var component = null;
var pendingHost = /* @__PURE__ */ new Map();
var nextHostReq = 1;
function send(msg) {
  try {
    process.send?.(msg);
  } catch {
  }
}
function serializeApp(app) {
  if (!app) return null;
  const match = app.match;
  return {
    name: app.name,
    exe: app.exe,
    match: match instanceof RegExp ? { __regexp: true, source: match.source, flags: match.flags } : typeof match === "string" ? { __regexp: true, source: match, flags: "" } : null
  };
}
function serializeMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  return {
    id: meta.id,
    title: meta.title,
    group: meta.group,
    url: meta.url ?? null,
    serverName: meta.serverName,
    summary: meta.summary
  };
}
function safeJson(value) {
  if (value === void 0) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { ok: false, reason: "non-serializable result from local component" };
  }
}
function hostCall(op, args) {
  return new Promise((resolve, reject) => {
    const reqId = nextHostReq++;
    pendingHost.set(reqId, { resolve, reject });
    send({ type: "host-call", reqId, op, args });
  });
}
function hostEvent(op, args) {
  send({ type: "host-event", op, args });
}
function buildToolsProxy(toolNames) {
  const names = Array.isArray(toolNames) ? toolNames : [];
  const visible = new Map(names.map((n) => [n, true]));
  return {
    view: () => ({ visible }),
    schemas: () => names.map((name) => ({ name })),
    get: (fullName) => ({
      execute: async (callArgs = {}) => hostCall("mcpExecute", { fullName, args: callArgs })
    })
  };
}
async function handleCall(op, args = {}) {
  if (!component) throw new Error("component not loaded");
  switch (op) {
    case "launch":
      return component.launch(args.cfg);
    case "installed":
      return typeof component.installed === "function" ? !!component.installed(args.cfg) : false;
    case "spec":
      return typeof component.spec === "function" ? component.spec(args.cfg) : component.spec ?? null;
    case "note":
      return typeof component.note === "function" ? component.note(args.cfg) : null;
    case "install": {
      const task = {
        proxy: args.taskProxy || "",
        step: (text) => hostEvent("task.step", { text: String(text) }),
        log: (line) => hostEvent("task.log", { line: String(line) }),
        live: (line) => hostEvent("task.live", { line: String(line) }),
        progress: (line, percent) => hostEvent("task.progress", { line: String(line), percent }),
        dumpConsole: () => hostEvent("task.dumpConsole", {}),
        clearConsole: () => hostEvent("task.clearConsole", {})
      };
      const hooks = {
        npm: args.hooksNpm ?? void 0,
        beforeReplace: async () => {
          await hostCall("hooks.beforeReplace", {});
        }
      };
      return await component.install(args.cfg, task, hooks);
    }
    case "beforeRemove": {
      if (typeof component.beforeRemove !== "function") return null;
      await component.beforeRemove((line) => hostEvent("task.log", { line: String(line) }));
      return null;
    }
    case "installAddon": {
      if (typeof component.installAddon !== "function") throw new Error("no installAddon");
      const opts = {
        ...args.opts || {},
        log: (line) => hostEvent("task.log", { line: String(line) }),
        procs: async () => {
          if (Array.isArray(args.procs)) return new Set(args.procs);
          return listProcesses();
        }
      };
      return await component.installAddon(args.cfg, args.project, opts);
    }
    case "probe": {
      const probe = mod?.probe;
      if (typeof probe !== "function") return null;
      const ctx = {
        cfg: args.cfg,
        env: args.env || {},
        tools: buildToolsProxy(args.toolNames),
        procs: async () => {
          if (Array.isArray(args.procs)) return new Set(args.procs);
          return listProcesses();
        }
      };
      return await probe.call(component, ctx);
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}
process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;
  try {
    if (msg.type === "shutdown") {
      process.exit(0);
      return;
    }
    if (msg.type === "host-result") {
      const p = pendingHost.get(msg.reqId);
      if (!p) return;
      pendingHost.delete(msg.reqId);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error || "host call failed"));
      return;
    }
    if (msg.type === "load") {
      try {
        const href = pathToFileURL(msg.entryPath).href;
        mod = await import(href);
        component = mod.component ?? mod.default;
        if (!component?.id) {
          send({ type: "load-err", error: "\u672A\u5BFC\u51FA component/default" });
          return;
        }
        if (msg.dirName && component.id !== msg.dirName) {
          send({
            type: "load-err",
            error: `folder "${msg.dirName}" \u4E0E component.id "${component.id}" \u4E0D\u4E00\u81F4`
          });
          return;
        }
        const manifest = {
          id: component.id,
          label: component.label,
          url: component.url ?? null,
          serverName: component.serverName,
          summary: component.summary,
          runtime: component.runtime ?? null,
          keys: Array.isArray(component.keys) ? [...component.keys] : [],
          bin: component.bin ?? null,
          installArgs: Array.isArray(component.installArgs) ? [...component.installArgs] : null,
          hasInstall: typeof component.install === "function",
          hasNote: typeof component.note === "function",
          hasSpec: typeof component.spec === "function",
          hasBeforeRemove: typeof component.beforeRemove === "function",
          hasInstallAddon: typeof component.installAddon === "function",
          hasProbe: typeof mod.probe === "function",
          hasApp: !!mod.app,
          meta: serializeMeta(mod.meta),
          app: serializeApp(mod.app)
        };
        send({ type: "load-ok", manifest });
      } catch (error) {
        send({ type: "load-err", error: String(error?.message ?? error) });
      }
      return;
    }
    if (msg.type === "call") {
      try {
        const value = await handleCall(msg.op, msg.args || {});
        send({ type: "call-ok", reqId: msg.reqId, value: safeJson(value) });
      } catch (error) {
        send({ type: "call-err", reqId: msg.reqId, error: String(error?.message ?? error) });
      }
    }
  } catch (error) {
    if (msg.type === "load") send({ type: "load-err", error: String(error?.message ?? error) });
    else if (msg.type === "call") send({ type: "call-err", reqId: msg.reqId, error: String(error?.message ?? error) });
  }
});
send({ type: "ready" });
process.on("disconnect", () => {
  try {
    process.exit(0);
  } catch {
  }
});
