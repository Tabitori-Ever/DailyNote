#!/usr/bin/env node
/**
 * test-lifecycle.mjs — 验证「关掉浏览器就自动停服务」
 *
 *   node _tools/test-lifecycle.mjs
 *
 * 全程用独立端口 8791，不碰你正在用的服务。
 */
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const IDLE_MIN = 1;                        // 用 1 分钟宽限期跑测试

let pass = 0, fail = 0;
const ok = (c, label, extra = "") => {
  if (c) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (extra ? "  → " + extra : "")); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function alive() {
  try {
    const r = await fetch(BASE + "/api/health", { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}

const { spawn } = await import("node:child_process");
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function startServer(extraArgs = []) {
  const p = spawn("node", [
    path.join(ROOT, "_tools", "server.mjs"),
    String(PORT), "--idle=" + IDLE_MIN, ...extraArgs
  ], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  p.stdout.on("data", d => (out += d));
  p.stderr.on("data", d => (out += d));
  return { proc: p, getOut: () => out };
}

console.log("日记服务生命周期测试（端口 %d，宽限期 %d 分钟）\n", PORT, IDLE_MIN);

/* ── 场景 A：没人打开页面 → 应该在宽限期 x3 后退出，而不是一直挂着 ── */
{
  console.log("A. 启动后没人连接");
  const s = startServer();
  await sleep(2000);
  ok(await alive(), "服务已起来");

  const r = await fetch(BASE + "/api/heartbeat", { method: "POST" });
  const beat = await r.json();
  ok(beat.ok === true && beat.idleMinutes === IDLE_MIN, "心跳接口返回 idleMinutes", JSON.stringify(beat));

  const h = await (await fetch(BASE + "/api/health")).json();
  ok(h.idleMinutes === IDLE_MIN, "health 暴露 idleMinutes");
  ok(typeof h.everConnected === "boolean", "health 暴露 everConnected");

  s.proc.kill();
  await sleep(600);
  console.log("");
}

/* ── 场景 B：页面持续心跳 → 服务必须活着 ── */
{
  console.log("B. 页面持续心跳（模拟浏览器开着）");
  const s = startServer();
  await sleep(2000);

  const beatTimer = setInterval(() => {
    fetch(BASE + "/api/heartbeat", { method: "POST" }).catch(() => {});
  }, 2000);

  // 宽限期是 1 分钟；持续心跳下必须远超这个时间仍然存活
  await sleep(75000);
  clearInterval(beatTimer);
  ok(await alive(), "持续心跳 75 秒后服务仍存活（不会被误杀）");

  /* ── 场景 C：停止心跳 → 宽限期后自动退出 ── */
  console.log("\nC. 停止心跳后（模拟关掉浏览器）");
  const t0 = Date.now();
  let goneAfter = null;
  for (let i = 0; i < 90; i++) {                 // 最多等 90 秒
    await sleep(1000);
    if (!(await alive())) { goneAfter = Math.round((Date.now() - t0) / 1000); break; }
  }
  ok(goneAfter !== null, "服务在宽限期后自动退出了", goneAfter === null ? "90 秒内没有退出" : goneAfter + " 秒");
  if (goneAfter !== null) {
    ok(goneAfter >= 55 && goneAfter <= 85, "退出时机接近设定的 1 分钟宽限期", goneAfter + " 秒（约应为 60-75 秒）");
  }
  ok(/浏览器已关闭/.test(s.getOut()), "退出日志说明了原因", JSON.stringify(s.getOut().trim().split("\n").pop()));
  console.log("");
}

/* ── 场景 D：退出接口立即生效 ── */
{
  console.log("D. 网页退出按钮走 /api/quit");
  const s = startServer();
  await sleep(2000);
  await fetch(BASE + "/api/heartbeat", { method: "POST" });
  ok(await alive(), "服务已起来且有页面连着");

  const r = await fetch(BASE + "/api/quit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "测试退出" })
  });
  const j = await r.json();
  ok(r.ok && j.ok, "/api/quit 返回成功");

  await sleep(1200);
  ok(!(await alive()), "服务已立即退出（不用等宽限期）");
  ok(/测试退出/.test(s.getOut()), "退出日志带上了原因", JSON.stringify(s.getOut().trim().split("\n").pop()));

  // 运行时文件应被清理，否则启动器会读到过期端口
  const fs = await import("node:fs/promises");
  let leftover = null;
  try { leftover = await fs.readFile(path.join(ROOT, "data", "server.json"), "utf8"); } catch { /* 已清理 */ }
  if (leftover) {
    const rt = JSON.parse(leftover);
    ok(rt.pid !== s.proc.pid, "运行时文件没有残留本进程的信息", "残留 pid=" + rt.pid);
  } else {
    ok(true, "运行时文件已清理");
  }
  s.proc.kill();
}

/* ── 场景 E：常驻模式（--idle 缺省）不该自己退出 ── */
{
  console.log("\nE. 常驻模式（不加 --idle）");
  const p = spawn("node", [path.join(ROOT, "_tools", "server.mjs"), String(PORT)], {
    cwd: ROOT, stdio: "ignore", windowsHide: true
  });
  await sleep(2500);
  ok(await alive(), "常驻模式已启动");
  const h = await (await fetch(BASE + "/api/health")).json();
  ok(h.idleMinutes === 0, "常驻模式 idleMinutes 为 0", "idleMinutes=" + h.idleMinutes);
  p.kill();
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
