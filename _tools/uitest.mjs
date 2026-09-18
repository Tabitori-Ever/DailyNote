#!/usr/bin/env node
/**
 * uitest.mjs — 用 Chrome DevTools Protocol 驱动无头 Chrome 做界面自测
 *   node _tools/uitest.mjs <url> <outDir> <testModule.mjs>
 * 通过 TCP 调试端口通信（不依赖命名管道）。
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , URL_ARG, OUT_DIR, TEST_SCRIPT] = process.argv;
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9400 + (process.pid % 400);
const profile = path.resolve(OUT_DIR, "chrome-profile");

await mkdir(profile, { recursive: true });
await mkdir(path.resolve(OUT_DIR), { recursive: true });

const child = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--force-device-scale-factor=1", "--hide-scrollbars",
  "--window-size=1600,1000", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  "about:blank"
], { stdio: "ignore", windowsHide: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error("CDP 端点未就绪");
}

const ws = new WebSocket(await getWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });

let seq = 0;
const pending = new Map();
const problems = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method === "Runtime.exceptionThrown") {
    problems.push("JS 异常: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
    const t = m.params.entry.text || "";
    if (!/favicon/i.test(t)) problems.push("控制台错误: " + t);
  } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    problems.push("console.error: " + m.params.args.map(a => a.value ?? a.description).join(" "));
  }
};

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const evalRaw = async (expression, returnByValue = true) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return returnByValue ? r.result.value : r.result;
};
const inject = src => {
  const t = String(src).trim();
  return evalRaw(t.startsWith("(") || t.startsWith("async") ? t : `(() => { ${src} })()`);
};

const goto = async url => { await send("Page.navigate", { url }); await sleep(1300); };
const click = sel => inject(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.click(); return true; })()`);
const shot = async file => {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(path.resolve(OUT_DIR, file), Buffer.from(r.data, "base64"));
  return file;
};

const KEYMAP = {
  ArrowLeft: [37, "ArrowLeft"], ArrowRight: [39, "ArrowRight"], ArrowUp: [38, "ArrowUp"], ArrowDown: [40, "ArrowDown"],
  Enter: [13, "Enter"], Escape: [27, "Escape"], PageUp: [33, "PageUp"], PageDown: [34, "PageDown"]
};
async function sendKey(name) {
  const [code, key] = KEYMAP[name] || [];
  if (!code) throw new Error("unknown key " + name);
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: code, key, code: key });
  await send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: code, key, code: key });
}

const api = { send, goto, inject, evalRaw, click, shot, sendKey, sleep, problems, close: async () => { ws.close(); child.kill(); } };

try {
  const mod = await import(pathToFileURL(path.resolve(TEST_SCRIPT)).href);
  await mod.default(api, { url: URL_ARG, outDir: path.resolve(OUT_DIR) });
} catch (err) {
  console.error("测试失败:", err?.stack || err);
  process.exitCode = 1;
} finally {
  if (problems.length) {
    console.log("\n--- 页面问题 ---");
    for (const p of [...new Set(problems)].slice(0, 30)) console.log("  " + p);
  }
  await api.close();
}
