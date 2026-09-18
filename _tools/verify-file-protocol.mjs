#!/usr/bin/env node
/**
 * verify-file-protocol.mjs — 用无头 Chrome 验证「双击 index.html」场景
 * 用法: node _tools/verify-file-protocol.mjs
 * 通过 TCP 调试端口驱动（不依赖命名管道）。
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = pathToFileURL(path.join(ROOT, "index.html")).href;
const PORT = 9788;
const profile = await mkdtemp(path.join(tmpdir(), "diary-verify-"));

const chrome = spawn(process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
  "--window-size=1600,1000", `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`, "about:blank"
], { stdio: "ignore", windowsHide: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = (list.find(t => t.type === "page") || {}).webSocketDebuggerUrl || null;
  } catch { /* retry */ }
  if (!wsUrl) await sleep(150);
}
if (!wsUrl) { chrome.kill(); throw new Error("CDP 未就绪"); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });

let seq = 0;
const pending = new Map();
const failures = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  } else if (m.method === "Runtime.exceptionThrown") {
    failures.push("JS 异常: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
    failures.push("控制台错误: " + m.params.entry.text);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

const evalIn = async expr => {
  const src = expr.trim().startsWith("(") ? expr : `(() => { ${expr} })()`;
  const r = await send("Runtime.evaluate", { expression: src, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.navigate", { url: target });
await sleep(2600);

const report = await evalIn(`(() => {
  const e = [...document.querySelectorAll('.entry')];
  return {
    protocol: location.protocol,
    entries: e.length,
    titles: e.map(x => x.querySelector('.entry__title').textContent),
    bodyLens: e.map(x => x.querySelector('.entry__content').innerHTML.length),
    words: [...document.querySelectorAll('.entry__sub')].map(s => s.textContent.replace(/\\s+/g,' ').trim()),
    outline: [...document.querySelectorAll('.outline__item')].map(o => o.textContent),
    stats: [...document.querySelectorAll('.stat')].map(s => s.textContent.trim()),
    heat: document.querySelectorAll('#heat .heat__c.l3').length,
    miniDots: document.querySelectorAll('#miniGrid .mini__cell.has-entry').length,
    glass: getComputedStyle(document.querySelector('.glass')).backdropFilter
  };
})()`);

// 打开日历，验证灰化与不可选
await evalIn(`document.querySelector('#btnPickDate').click(); return null;`);
await sleep(1000);
const cal = await evalIn(`(() => {
  const days = [...document.querySelectorAll('#calGrid .day')];
  const empty = days.filter(d => d.classList.contains('is-empty'));
  return {
    open: document.querySelector('#dlg').classList.contains('is-open'),
    label: document.querySelector('#calLabel').textContent,
    total: days.length,
    empty: empty.length,
    hasEntry: days.filter(d => d.classList.contains('has-entry')).map(d => d.dataset.day),
    emptyOpacity: getComputedStyle(empty[0]).opacity,
    emptyCursor: getComputedStyle(empty[0]).cursor
  };
})()`);
await evalIn(`document.querySelector('#calGrid .day.is-empty:not(.is-blank)').click(); return null;`);
await sleep(320);
const disabled = await evalIn(`({ stillOpen: document.querySelector('#dlg').classList.contains('is-open'), toast: document.querySelector('#toast').textContent })`);

console.log("目标:", target);
console.log(JSON.stringify({ ...report, calendar: cal, disabledClick: disabled }, null, 1));
console.log(failures.length ? "\n问题:\n" + failures.join("\n") : "\n无 JS 异常 / 控制台错误");

const ok = report.entries === 2
  && report.bodyLens.every(n => n > 100)
  && report.outline.length >= 3
  && cal.hasEntry.length >= 1
  && cal.empty > 20
  && disabled.stillOpen === true
  && failures.length === 0;
console.log("\n结论: " + (ok ? "file:// 场景通过 ✓" : "file:// 场景有问题 ✗"));

ws.close(); chrome.kill();
await sleep(300);
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exitCode = ok ? 0 : 1;
