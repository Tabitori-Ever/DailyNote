#!/usr/bin/env node
/**
 * build-index.mjs — 扫描 entries/**\/*.md，生成 entries/index.json（检索清单）
 *
 *   node _tools/build-index.mjs            # 生成 / 更新清单
 *   node _tools/build-index.mjs --check    # 只检查，不写入（列出与清单不一致的项）
 *
 * 约定：日记正文文件名为 YYYY-MM-DD.md，放在 entries/YYYY/ 下。
 * front matter（可省略）：
 *   ---
 *   title: 标题
 *   date:  2026-09-18        # 省略则取文件名
 *   tags:  [标签A, 标签B]
 *   ---
 */
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ENTRIES = path.join(ROOT, "entries");
const OUT = path.join(ENTRIES, "index.json");
const CHECK = process.argv.includes("--check");

/** 极简 front matter 解析（与网页端实现保持一致） */
function splitFrontMatter(text) {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) {
      v = v.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, "");
    }
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

const countWords = (s) => (s.match(/[\u4e00-\u9fff]|[A-Za-z]+|\d+/g) || []).length;

async function walk(dir, acc = []) {
  let items;
  try { items = await readdir(dir, { withFileTypes: true }); }
  catch { return acc; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) await walk(full, acc);
    else if (it.isFile() && it.name.toLowerCase().endsWith(".md")) acc.push(full);
  }
  return acc;
}

function pct(list, p) {
  if (!list.length) return 0;
  const i = Math.min(list.length - 1, Math.max(0, Math.round((list.length - 1) * p)));
  return list[i];
}

const files = await walk(ENTRIES);
const entries = [];
const problems = [];

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const text = await readFile(file, "utf8");
  const { meta, body } = splitFrontMatter(text);

  const fromName = /(\d{4}-\d{2}-\d{2})/.exec(path.basename(file));
  const date = String(meta.date || (fromName ? fromName[1] : "")).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    problems.push(`${rel}: 无法确定日期（文件名或 front matter 需含 YYYY-MM-DD）`);
    continue;
  }
  const clean = body.trim();
  if (!clean) problems.push(`${rel}: 正文为空`);

  entries.push({
    id: date,
    date,
    title: String(meta.title || "").trim() || `${date.slice(0, 4)} 年 ${+date.slice(5, 7)} 月 ${+date.slice(8, 10)} 日`,
    tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []),
    source: meta.source ? String(meta.source) : "",
    words: countWords(clean),
    excerpt: clean.replace(/[#>*`_\-\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90),
    file: rel
  });
}

// 重复日期检查
const seen = new Map();
for (const e of entries) {
  if (seen.has(e.date)) problems.push(`重复日期 ${e.date}：${seen.get(e.date)} 与 ${e.file}`);
  seen.set(e.date, e.file);
}

entries.sort((a, b) => (a.date < b.date ? 1 : -1));

const words = entries.map(e => e.words).sort((a, b) => a - b);
const tags = new Map();
for (const e of entries) for (const t of e.tags) tags.set(t, (tags.get(t) || 0) + 1);

const index = {
  generatedAt: new Date().toISOString(),
  generator: "diary/build-index.mjs",
  count: entries.length,
  stats: {
    totalWords: words.reduce((a, b) => a + b, 0),
    medianWords: pct(words, 0.5),
    p90Words: pct(words, 0.9),
    firstDate: entries.length ? entries[entries.length - 1].date : null,
    lastDate: entries.length ? entries[0].date : null,
    tags: Object.fromEntries([...tags.entries()].sort((a, b) => b[1] - a[1]))
  },
  entries
};

if (problems.length) {
  console.log("⚠ 发现 " + problems.length + " 个问题：");
  for (const p of problems) console.log("  · " + p);
} else {
  console.log("✓ 未发现问题");
}

if (CHECK) {
  const prevExists = existsSync(OUT);
  if (!prevExists) { console.log("entries/index.json 不存在，需要生成"); process.exitCode = 1; }
  else {
    const prev = JSON.parse(await readFile(OUT, "utf8"));
    const same = prev.count === index.count &&
      prev.entries.every((e, i) => index.entries[i] && e.date === index.entries[i].date);
    console.log(same ? "✓ index.json 已是最新" : "✗ index.json 与 entries/ 不一致，请重新生成");
    if (!same) process.exitCode = 1;
  }
} else {
  await writeFile(OUT, JSON.stringify(index, null, 2) + "\n", "utf8");
  const st = await stat(OUT);
  console.log(`✓ 已写入 entries/index.json —— ${index.count} 篇 · ${index.stats.totalWords} 字 · ${Math.round(st.size / 1024)} KB`);
  if (index.stats.firstDate) console.log(`  区间 ${index.stats.firstDate} → ${index.stats.lastDate}`);
}
