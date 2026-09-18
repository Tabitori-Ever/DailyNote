#!/usr/bin/env node
/**
 * new-entry.mjs — 新建一篇今天的日记
 *
 *   node _tools/new-entry.mjs                 # 今天的日期
 *   node _tools/new-entry.mjs 2026-09-19      # 指定日期（补记过去）
 *   node _tools/new-entry.mjs --force         # 已存在则覆盖
 *
 * 会自动写入 entries/YYYY/YYYY-MM-DD.md 模板，并刷新 entries/index.json。
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2).filter(a => a !== "--force");
const force = process.argv.includes("--force");

const pad2 = n => String(n).padStart(2, "0");
const now = new Date();
const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
const date = args[0] || today;

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("✗ 日期格式应为 YYYY-MM-DD，收到：" + date);
  process.exit(1);
}
const [y, m, d] = date.split("-");
const dir = path.join(ROOT, "entries", y);
const file = path.join(dir, `${date}.md`);

if (existsSync(file) && !force) {
  console.error(`✗ 已存在：entries/${y}/${date}.md（要覆盖请加 --force）`);
  process.exit(1);
}

// 如果已有日记，给出上一篇的日期，方便回忆「上次写到哪」
let prevHint = "";
try {
  const idx = JSON.parse(await readFile(path.join(ROOT, "entries", "index.json"), "utf8"));
  const prev = (idx.entries || []).filter(e => e.date < date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (prev) prevHint = `\n> 上一篇：${prev.date}　${prev.title}\n`;
} catch { /* 首次使用没有 index.json，忽略 */ }

const weekday = ["日", "一", "二", "三", "四", "五", "六"][new Date(date + "T00:00:00").getDay()];

const template = `---
title: ${y} 年 ${+m} 月 ${+d} 日 星期${weekday}
date: ${date}
tags: []
---
${prevHint}
## 事件

## 爱好

## 生活

`;

await mkdir(dir, { recursive: true });
await writeFile(file, template, "utf8");
console.log(`✓ 已创建 entries/${y}/${date}.md`);
if (prevHint) console.log("  已附上上一篇的提示，便于回忆上下文");

try {
  const { stdout } = await run(process.execPath, [path.join(ROOT, "_tools", "build-index.mjs")], { cwd: ROOT });
  process.stdout.write(stdout);
} catch (err) {
  console.error("⚠ index.json 刷新失败，请手动运行 node _tools/build-index.mjs");
  console.error(String(err.stdout || err.message));
}
