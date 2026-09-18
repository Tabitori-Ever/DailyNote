#!/usr/bin/env node
/**
 * server.mjs — 日记系统本地服务
 *
 *   node server.mjs                  # http://127.0.0.1:8787
 *   node server.mjs 9000             # 指定端口
 *   node server.mjs --open           # 启动后自动打开浏览器
 *   node server.mjs 8787 --open      # 组合使用
 *   node server.mjs --stop           # 停掉正在运行的服务（读 data/server.json）
 *
 * 职责：
 *   · 静态托管 index.html / entries / assets
 *   · 日记文件读写（entries/YYYY/YYYY-MM-DD.md，带乐观并发校验）
 *   · 图片上传（assets/YYYY/MM/）
 *   · 记账库、应用配置（data/*.json，原子写入）
 *   · Git 备份（status / commit / push），令牌只保存在 .git/config
 *   · 进程管理（写 data/server.json，供启动器判重与关闭）
 *
 * 依赖：仅 Node 内置模块。
 */
import { createServer } from "node:http";
import { readFile, writeFile, rename, stat, mkdir, readdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn, exec } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ARGS = process.argv.slice(2);
const FLAGS = new Set(ARGS.filter(a => a.startsWith("--")));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(ARGS.find(a => /^\d+$/.test(a)) || process.env.PORT || 8787);
const ENTRIES_DIR = path.join(ROOT, "entries");
const ASSETS_DIR = path.join(ROOT, "assets");
const DATA_DIR = path.join(ROOT, "data");
const INDEX_FILE = path.join(ENTRIES_DIR, "index.json");
const LEDGER_FILE = path.join(DATA_DIR, "ledger.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const RUNTIME_FILE = path.join(DATA_DIR, "server.json");

/* ───────────────────────── helpers ───────────────────────── */

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".avif": "image/avif", ".bmp": "image/bmp"
};

const pad2 = n => String(n).padStart(2, "0");
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const sha1 = s => createHash("sha1").update(s, "utf8").digest("hex").slice(0, 12);

/** 解析到 ROOT 之下，阻断 ../ 穿越 */
function safeJoin(rel) {
  const full = path.resolve(ROOT, "." + (rel.startsWith("/") ? rel : "/" + rel));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

function send(res, code, body, headers = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  res.writeHead(code, { "content-length": data.length, ...headers });
  res.end(data);
}
const sendJson = (res, code, obj) =>
  send(res, code, JSON.stringify(obj), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });

async function readJsonBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 原子写入：先写临时文件再改名，避免中途崩溃留下半截文件 */
async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

/* ───────────────────────── front matter ───────────────────────── */

/** 极简 YAML front matter（只支持本项目用到的平铺键值 + 行内数组） */
export function parseFrontMatter(text) {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text.replace(/\r\n?/g, "\n") };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) {
      v = v.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else if (v === "" ) {
      v = "";
    } else {
      v = v.replace(/^["']|["']$/g, "");
    }
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length).replace(/\r\n?/g, "\n") };
}

function scalar(v) {
  const s = String(v == null ? "" : v);
  return /^[\[\]{},:#&*!|>'"%@`]|:\s|\s$|^$/.test(s) ? JSON.stringify(s) : s;
}

function buildFrontMatter(meta) {
  const order = ["title", "date", "created", "updated", "tags", "mood", "anniversary", "income", "expense"];
  const keys = [...new Set([...order.filter(k => meta[k] !== undefined && meta[k] !== "" && !(Array.isArray(meta[k]) && !meta[k].length)),
                            ...Object.keys(meta)])];
  const lines = [];
  for (const k of keys) {
    const v = meta[k];
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) { if (v.length) lines.push(`${k}: [${v.map(x => String(x).trim()).join(", ")}]`); }
    else if (typeof v === "number") lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${scalar(v)}`);
  }
  return "---\n" + lines.join("\n") + "\n---\n\n";
}

const countWords = s => (String(s).match(/[\u4e00-\u9fff]|[A-Za-z]+|\d+/g) || []).length;

/** 从正文提取时间线用的关键词：优先一级/二级标题，其次首个短句 */
export function extractKeyword(body) {
  const hs = [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1].trim()).filter(Boolean);
  if (hs.length) return hs[0].slice(0, 18);
  const first = body.split(/\n\s*\n/).map(s => s.replace(/[#>*`_\-\[\]()]/g, " ").replace(/\s+/g, " ").trim()).find(s => s.length > 1);
  if (!first) return "";
  const cut = first.split(/[。！？!?.,，；;]/)[0].trim();
  return (cut || first).slice(0, 18);
}

/* ───────────────────────── entries ───────────────────────── */

const entryPath = date => path.join(ENTRIES_DIR, date.slice(0, 4), `${date}.md`);

async function readEntry(date) {
  const file = entryPath(date);
  let raw;
  try { raw = await readFile(file, "utf8"); }
  catch { return null; }
  const st = await stat(file);
  const { meta, body } = parseFrontMatter(raw);
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  return {
    date,
    title: String(meta.title || "").trim(),
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    mood: meta.mood ? String(meta.mood) : "",
    anniversary: meta.anniversary ? String(meta.anniversary) : "",
    income: Number(meta.income || 0) || 0,
    expense: Number(meta.expense || 0) || 0,
    created: meta.created ? String(meta.created) : st.birthtime.toISOString(),
    updated: meta.updated ? String(meta.updated) : st.mtime.toISOString(),
    mtime: st.mtime.toISOString(),
    words: countWords(body),
    keyword: extractKeyword(body),
    excerpt: body.replace(/[#>*`_\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 110),
    body,
    file: rel,
    checksum: sha1(raw)
  };
}

async function writeEntry(date, meta, body, { creating = false } = {}) {
  const file = entryPath(date);
  let created = meta.created;
  if (creating || !created) {
    const prev = await readEntry(date).catch(() => null);
    created = (prev && prev.created) || new Date().toISOString();
  }
  const full = {
    title: meta.title !== undefined ? meta.title : (await readEntry(date).catch(() => null))?.title || "",
    date,
    created,
    updated: new Date().toISOString(),
    tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? String(meta.tags).split(",").map(s => s.trim()).filter(Boolean) : []),
    mood: meta.mood || "",
    anniversary: meta.anniversary || "",
    income: Number(meta.income || 0) || 0,
    expense: Number(meta.expense || 0) || 0
  };
  const text = buildFrontMatter(full) + String(body || "").replace(/\r\n?/g, "\n").replace(/\s+$/, "") + "\n";
  await atomicWrite(file, text);
  return readEntry(full.date);
}

async function listEntries() {
  const out = [];
  let years = [];
  try { years = await readdir(ENTRIES_DIR, { withFileTypes: true }); } catch { return out; }
  for (const y of years) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    let files = [];
    try { files = await readdir(path.join(ENTRIES_DIR, y.name)); } catch { continue; }
    for (const f of files) {
      const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f);
      if (!m) continue;
      const e = await readEntry(m[1]);
      if (e) out.push(e);
    }
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out;
}

/* ───────────────────────── derived data ───────────────────────── */

async function buildIndex() {
  const entries = await listEntries();
  const tags = {};
  for (const e of entries) for (const t of e.tags) tags[t] = (tags[t] || 0) + 1;

  const index = {
    generatedAt: new Date().toISOString(),
    generator: "diary/server.mjs",
    count: entries.length,
    stats: {
      totalWords: entries.reduce((a, e) => a + e.words, 0),
      firstDate: entries.length ? entries[entries.length - 1].date : null,
      lastDate: entries.length ? entries[0].date : null,
      tags
    },
    // 清单只放「轻量摘要」：正文仍以内联种子 / 单篇 .md 为准
    entries: entries.map(e => ({
      date: e.date, title: e.title, tags: e.tags, mood: e.mood,
      anniversary: e.anniversary, words: e.words, keyword: e.keyword,
      excerpt: e.excerpt, file: e.file, created: e.created, updated: e.updated
    }))
  };

  // 内容没变就不重写：否则每次启动服务都会只因为 generatedAt 变一下
  // 就把工作区弄脏，Git 历史里全是噪音
  const prevText = await readFile(INDEX_FILE, "utf8").catch(() => null);
  if (prevText) {
    try {
      const prev = JSON.parse(prevText);
      if (JSON.stringify(prev.entries) === JSON.stringify(index.entries) &&
          JSON.stringify(prev.stats) === JSON.stringify(index.stats) &&
          prev.count === index.count) {
        return prev;
      }
    } catch { /* 旧文件坏了，直接重写 */ }
  }

  await atomicWrite(INDEX_FILE, JSON.stringify(index, null, 2) + "\n");
  return index;
}

const DEFAULT_CONFIG = {
  templates: [
    { id: "default", name: "事件 / 爱好 / 生活", sections: ["事件", "爱好", "生活"], builtin: true }
  ],
  anniversaries: [],
  reader: { fontSize: 18, lineHeight: 1.95, width: 940, serif: false },
  moods: ["😊", "🙂", "😐", "😔", "😣", "😤", "😴", "🥳", "😭", "😰", "🤔", "😌"],
  ledgerEnabled: false,
  ui: { sidebar: true }
};

async function readConfig() {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
const writeConfig = cfg => atomicWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");

const EMPTY_LEDGER = { version: 1, updatedAt: null, records: [] };
async function readLedger() {
  try { return { ...EMPTY_LEDGER, ...JSON.parse(await readFile(LEDGER_FILE, "utf8")) }; }
  catch { return { ...EMPTY_LEDGER, records: [] }; }
}
/**
 * 写账本。changed=false 时保留原 updatedAt —— 否则每跑一次写操作都会
 * 产生一个只有时间戳变化的 diff，把 Git 历史弄得全是噪音。
 */
const writeLedger = (l, changed = true) => {
  l.updatedAt = changed ? new Date().toISOString() : (l.updatedAt || null);
  return atomicWrite(LEDGER_FILE, JSON.stringify(l, null, 2) + "\n");
};

/** 日记里的收支同步进记账库：每篇日记一条记录，反复保存只更新不重复 */
async function syncLedgerFromEntry(entry) {
  if (!entry) return;
  const ledger = await readLedger();
  const id = "entry:" + entry.date;
  const idx = ledger.records.findIndex(r => r.id === id);
  const income = Number(entry.income) || 0;
  const expense = Number(entry.expense) || 0;

  if (!income && !expense) {
    // 清零 / 本来就没记账，且账本里也没有这条：不必写文件
    //（否则每次保存日记都会刷新 updatedAt，产生无意义的改动）
    if (idx < 0) return;
    ledger.records.splice(idx, 1);
  } else {
    const rec = {
      id, date: entry.date, kind: "diary",
      income, expense,
      note: entry.title || entry.date,
      updated: new Date().toISOString()
    };
    if (idx >= 0) {
      const old = ledger.records[idx];
      // 金额没变就不动，避免只因为 note 或时间戳变化而重写账本
      if (old.income === income && old.expense === expense && old.note === rec.note) return;
      ledger.records[idx] = rec;
    } else {
      ledger.records.push(rec);
    }
  }
  ledger.records.sort((a, b) => (a.date < b.date ? 1 : -1));
  await writeLedger(ledger);
}

/* ───────────────────────── git ───────────────────────── */

function git(args, { timeout = 120000 } = {}) {
  return new Promise(resolve => {
    const p = spawn("git", args, { cwd: ROOT, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let out = "", err = "";
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", d => (err += d));
    const t = setTimeout(() => p.kill(), timeout);
    p.on("close", code => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); });
    p.on("error", e => { clearTimeout(t); resolve({ code: -1, out: "", err: String(e.message) }); });
  });
}

const isGitRepo = async () => (await git(["rev-parse", "--is-inside-work-tree"])).out === "true";

async function gitStatus() {
  if (!(await isGitRepo())) return { repo: false };
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).out;
  const remote = (await git(["remote", "get-url", "origin"])).out;
  const st = await git(["status", "--porcelain"]);
  const ahead = (await git(["rev-list", "--count", "@{u}..HEAD"])).out;
  const behind = (await git(["rev-list", "--count", "HEAD..@{u}"])).out;
  const last = (await git(["log", "-1", "--format=%h|%ad|%s", "--date=format:%Y-%m-%d %H:%M"])).out;
  return {
    repo: true, branch, remote,
    dirty: st.out ? st.out.split("\n").length : 0,
    files: st.out ? st.out.split("\n").slice(0, 60) : [],
    ahead: ahead === "" ? null : Number(ahead),
    behind: behind === "" ? null : Number(behind),
    lastCommit: last ? { hash: last.split("|")[0], date: last.split("|")[1], subject: last.split("|").slice(2).join("|") } : null
  };
}

/* ───────────────────────── routes ───────────────────────── */

async function handleApi(req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method.toUpperCase();
  const q = url.searchParams;

  /* ---- health ---- */
  if (seg[0] === "health") {
    return sendJson(res, 200, {
      ok: true, root: ROOT, node: process.version, git: await isGitRepo(),
      idleMinutes: IDLE_MIN, everConnected, pid: process.pid
    });
  }

  /* ---- 生命周期：心跳 / 页面关闭 / 主动退出 ---- */
  if (seg[0] === "heartbeat" && method === "POST") {
    lastSeen = Date.now();
    everConnected = true;
    return sendJson(res, 200, { ok: true, idleMinutes: IDLE_MIN });
  }
  if (seg[0] === "pagehide" && method === "POST") {
    // 页面关闭 beacon：只记录时间，真正的退出交给宽限期判断
    lastSeen = Date.now();
    return sendJson(res, 200, { ok: true });
  }
  if (seg[0] === "quit" && method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    sendJson(res, 200, { ok: true, message: "服务正在退出，可以关闭这个页面了" });
    setTimeout(() => shutdown(body?.reason || "页面上的退出按钮"), 120);
    return;
  }

  /* ---- entries ---- */
  if (seg[0] === "entries") {
    if (seg.length === 1 && method === "GET") {
      const list = await listEntries();
      return sendJson(res, 200, { entries: list.map(({ body, ...rest }) => rest), count: list.length });
    }
    const date = seg[1];
    if (date && !isDate(date)) return sendJson(res, 400, { error: "日期格式应为 YYYY-MM-DD" });

    if (date && method === "GET") {
      const e = await readEntry(date);
      return e ? sendJson(res, 200, e) : sendJson(res, 404, { error: "没有这一天的日记" });
    }
    if (date && (method === "PUT" || method === "POST")) {
      const body = await readJsonBody(req);
      if (body.checksum) {
        const cur = await readEntry(date);
        if (cur && body.checksum !== cur.checksum) {
          return sendJson(res, 409, { error: "文件已被外部修改，请重新载入后再保存", current: { ...cur, body: undefined } });
        }
      }
      const saved = await writeEntry(date, body, body.body, { creating: method === "POST" });
      await syncLedgerFromEntry(saved);
      await buildIndex();
      return sendJson(res, 200, { ok: true, entry: { ...saved, body: undefined }, checksum: saved.checksum });
    }
    if (date && method === "DELETE") {
      const file = entryPath(date);
      try { await unlink(file); } catch { return sendJson(res, 404, { error: "文件不存在" }); }
      const ledger = await readLedger();
      ledger.records = ledger.records.filter(r => r.id !== "entry:" + date);
      await writeLedger(ledger);
      await buildIndex();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: "不支持的方法" });
  }

  /* ---- index rebuild ---- */
  if (seg[0] === "index" && method === "POST") {
    const idx = await buildIndex();
    return sendJson(res, 200, { ok: true, count: idx.count, stats: idx.stats });
  }

  /* ---- upload ---- */
  if (seg[0] === "upload" && method === "POST") {
    const { name, dataUrl } = await readJsonBody(req);
    const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(String(dataUrl || ""));
    if (!m) return sendJson(res, 400, { error: "只接受 data:image/*;base64 格式" });
    const extMap = { jpeg: "jpg", "svg+xml": "svg", "x-icon": "ico" };
    const subtype = m[1].toLowerCase();
    const ext = extMap[subtype] || subtype.replace(/[^a-z0-9]/g, "");
    if (!/^(png|jpg|jpeg|gif|webp|avif|bmp|svg|ico)$/.test(ext)) return sendJson(res, 400, { error: "不支持的图片格式：" + ext });
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 24 * 1024 * 1024) return sendJson(res, 413, { error: "图片超过 24MB" });
    const now = new Date();
    const dirRel = `assets/${now.getFullYear()}/${pad2(now.getMonth() + 1)}`;
    const base = (String(name || "image").replace(/\.[^.]+$/, "").replace(/[^\w\u4e00-\u9fff-]+/g, "-").slice(0, 40) || "image");
    const fileName = `${todayStr(now)}-${sha1(buf.toString("base64") + base)}-${base}.${ext}`;
    const rel = `${dirRel}/${fileName}`;
    await mkdir(path.join(ROOT, dirRel), { recursive: true });
    await writeFile(path.join(ROOT, rel), buf);
    return sendJson(res, 200, { ok: true, path: rel, url: "/" + rel, bytes: buf.length });
  }

  /* ---- ledger ---- */
  if (seg[0] === "ledger") {
    if (method === "GET") return sendJson(res, 200, await readLedger());
    if (method === "PUT" || method === "POST") {
      const body = await readJsonBody(req);
      const records = Array.isArray(body.records) ? body.records : null;
      if (!records) return sendJson(res, 400, { error: "需要 records 数组" });
      const clean = records.map(r => ({
        id: String(r.id || (r.date + ":" + sha1(JSON.stringify(r)))),
        date: isDate(r.date) ? r.date : todayStr(),
        kind: r.kind === "diary" ? "diary" : "manual",
        income: Number(r.income) || 0,
        expense: Number(r.expense) || 0,
        category: String(r.category || ""),
        note: String(r.note || ""),
        updated: new Date().toISOString()
      })).sort((a, b) => (a.date < b.date ? 1 : -1));
      const prev = await readLedger();
      const changed = JSON.stringify(prev.records) !== JSON.stringify(clean);
      await writeLedger({ version: 1, records: clean }, changed);
      return sendJson(res, 200, { ok: true, count: clean.length });
    }
    return sendJson(res, 405, { error: "不支持的方法" });
  }

  /* ---- config ---- */
  if (seg[0] === "config") {
    if (method === "GET") return sendJson(res, 200, await readConfig());
    if (method === "PUT" || method === "POST") {
      const body = await readJsonBody(req);
      const cfg = { ...(await readConfig()), ...body };
      await writeConfig(cfg);
      return sendJson(res, 200, { ok: true, config: cfg });
    }
    return sendJson(res, 405, { error: "不支持的方法" });
  }

  /* ---- git ---- */
  if (seg[0] === "git") {
    const action = seg[1];
    if (action === "status" && method === "GET") return sendJson(res, 200, await gitStatus());

    if (action === "commit" && method === "POST") {
      const { message } = await readJsonBody(req).catch(() => ({}));
      if (!(await isGitRepo())) return sendJson(res, 400, { error: "还没有初始化 Git 仓库（先运行 git init）" });
      await git(["add", "-A"]);
      const msg = String(message || "").trim() || `日记更新 ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      const c = await git(["commit", "-m", msg]);
      if (c.code !== 0 && !/nothing to commit|无文件要提交|working tree clean/i.test(c.out + c.err)) {
        return sendJson(res, 500, { error: c.err || c.out || "提交失败" });
      }
      return sendJson(res, 200, { ok: true, committed: c.code === 0, output: (c.out + "\n" + c.err).trim(), status: await gitStatus() });
    }

    if (action === "push" && method === "POST") {
      if (!(await isGitRepo())) return sendJson(res, 400, { error: "还没有初始化 Git 仓库" });
      const remote = (await git(["remote", "get-url", "origin"])).out;
      if (!remote) return sendJson(res, 400, { error: "还没有配置 origin 远端" });
      const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).out || "main";
      const p = await git(["push", "-u", "origin", branch], { timeout: 180000 });
      if (p.code !== 0) return sendJson(res, 500, { error: (p.err || p.out || "推送失败").slice(0, 1200) });
      return sendJson(res, 200, { ok: true, output: (p.out + "\n" + p.err).trim(), status: await gitStatus() });
    }

    if (action === "pull" && method === "POST") {
      if (!(await isGitRepo())) return sendJson(res, 400, { error: "还没有初始化 Git 仓库" });
      const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).out || "main";
      const p = await git(["pull", "--rebase", "origin", branch], { timeout: 180000 });
      if (p.code !== 0) return sendJson(res, 500, { error: (p.err || p.out || "拉取失败").slice(0, 1200) });
      await buildIndex();
      return sendJson(res, 200, { ok: true, output: (p.out + "\n" + p.err).trim(), status: await gitStatus() });
    }
    return sendJson(res, 404, { error: "未知的 git 操作" });
  }

  return sendJson(res, 404, { error: "未知接口 /api/" + seg.join("/") });
}

/* ───────────────────────── static ───────────────────────── */

async function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel.endsWith("/")) rel += "index.html";
  const full = safeJoin(rel);
  if (!full) return send(res, 403, "403");
  let st;
  try { st = await stat(full); } catch { st = null; }
  if (!st || !st.isFile()) return send(res, 404, "404 Not Found: " + rel, { "content-type": "text/plain; charset=utf-8" });
  const buf = await readFile(full);
  const isAsset = /\.(png|jpe?g|webp|gif|avif|svg|woff2?|ico|bmp)$/i.test(full);
  send(res, 200, buf, {
    "content-type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
    "cache-control": isAsset ? "public, max-age=86400" : "no-store"
  });
}

/* ───────────────────────── 进程管理 ───────────────────────── */

/**
 * 服务生命周期
 *
 * 网页每 HEARTBEAT_MS 往 /api/heartbeat 打一次点，关闭时向 /api/pagehide
 * 发一个 beacon。若 --idle=<分钟> 打开（桌面启动器就是这么起的），
 * 在「无人连接」超过该时长后自动退出 —— 于是关掉浏览器就等于关掉服务。
 *
 * 宽限期不是 0 的原因：刷新页面、跨标签跳转、手机息屏都会短暂没有心跳，
 * 留一段时间可以避免误杀。宽限期内重新打开页面会续上，不会重启服务。
 */
const IDLE_MIN = (() => {
  const m = ARGS.find(a => a.startsWith("--idle="));
  if (m) return Math.max(0, Number(m.split("=")[1]) || 0);
  return FLAGS.has("--idle") ? 3 : 0;          // --idle 不带值默认 3 分钟；0 = 不自动退出
})();
const HEARTBEAT_MS = 15000;
const CHECK_MS = 5000;

let lastSeen = Date.now();                     // 最后一次收到心跳 / 页面关闭通知
let everConnected = false;                     // 是否曾经有页面连上过
let shuttingDown = false;
const startTs = Date.now();                    // 进程启动时刻

async function cleanupRuntime() {
  const rt = await readRuntime();
  if (rt && rt.pid === process.pid) await unlink(RUNTIME_FILE).catch(() => {});
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("日记服务退出：" + reason);
  await cleanupRuntime();
  process.exit(0);
}

/** 打开默认浏览器（静默；Windows 用 rundll32，避免弹出多余窗口） */
function openBrowser(url) {
  try {
    if (process.platform === "win32") spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch { return false; }
}

/** 读运行时信息（端口 / pid），供启动器判重 */
async function readRuntime() {
  try { return JSON.parse(await readFile(RUNTIME_FILE, "utf8")); } catch { return null; }
}

/** 这个端口上跑的到底是不是我们自己？防止误杀别人的服务 */
async function isOurs(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const j = await res.json();
    return j && j.ok === true && typeof j.root === "string" && path.resolve(j.root) === ROOT;
  } catch { return false; }
}

/* --stop：停掉正在运行的服务 */
if (FLAGS.has("--stop")) {
  const rt = await readRuntime();
  const port = rt?.port || PORT;
  if (await isOurs(port)) {
    // 优先让对面自己体面退出，这样运行时文件也会被清掉
    try {
      await fetch(`http://127.0.0.1:${port}/api/quit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "命令行停止" }),
        signal: AbortSignal.timeout(2500)
      });
    } catch { /* 对方可能已经先退出了 */ }
  }

  // 等它真的走掉；没走掉再强杀
  let gone = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (!(await isOurs(port))) { gone = true; break; }
  }
  if (!gone) {
    let killed = false;
    if (rt?.pid) { try { process.kill(rt.pid); killed = true; } catch { /* pid 失效 */ } }
    if (!killed && process.platform === "win32") {
      await new Promise(res => {
        exec(`netstat -ano | findstr LISTENING | findstr :${port}`, (err, out) => {
          const pid = (String(out || "").trim().split(/\s+/).pop() || "").trim();
          if (/^\d+$/.test(pid)) { try { process.kill(Number(pid)); killed = true; } catch { /* ignore */ } }
          res();
        });
      });
    }
    gone = killed;
  }
  await unlink(RUNTIME_FILE).catch(() => {});
  console.log(gone ? `已停止日记服务（端口 ${port}）` : `无法停止端口 ${port} 上的进程，请手动结束`);
  process.exit(gone ? 0 : 1);
}

/* ───────────────────────── boot ───────────────────────── */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "405");
    await handleStatic(req, res, url);
  } catch (err) {
    sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

await mkdir(DATA_DIR, { recursive: true });
if (!(await readFile(CONFIG_FILE, "utf8").catch(() => null))) await writeConfig(DEFAULT_CONFIG);

// 端口被占：如果占用的就是我们自己，就别再起一个，直接开浏览器走人
server.on("error", async err => {
  if (err.code === "EADDRINUSE") {
    const url = `http://127.0.0.1:${PORT}/`;
    if (await isOurs(PORT)) {
      console.log(`日记服务已经在运行：${url}`);
      if (FLAGS.has("--open")) openBrowser(url);
      process.exit(0);
    }
    console.error(`端口 ${PORT} 被其他程序占用。换一个端口，例如：node _tools/server.mjs 8899`);
    process.exit(1);
  }
  throw err;
});

await buildIndex();

server.listen(PORT, "127.0.0.1", async () => {
  const url = `http://127.0.0.1:${PORT}/`;
  await writeFile(RUNTIME_FILE, JSON.stringify({
    pid: process.pid, port: PORT, url, root: ROOT,
    idleMinutes: IDLE_MIN, startedAt: new Date().toISOString()
  }, null, 2) + "\n", "utf8").catch(() => {});

  console.log("日记 · 桑榆下 —— 本地服务");
  console.log("  目录: " + ROOT);
  console.log("  地址: " + url);
  if (IDLE_MIN > 0) console.log(`  生命周期: 浏览器关闭约 ${IDLE_MIN} 分钟后自动退出（网页里也有退出按钮）`);
  else console.log("  停止: Ctrl + C  或  node _tools/server.mjs --stop");
  if (FLAGS.has("--open")) openBrowser(url);
});

/* 浏览器关闭后自动退出：宽限期内没有心跳就认为不再需要服务 */
if (IDLE_MIN > 0) {
  const graceMs = IDLE_MIN * 60000;
  const timer = setInterval(() => {
    const idle = Date.now() - lastSeen;
    if (everConnected && idle > graceMs) {
      clearInterval(timer);
      shutdown(`浏览器已关闭约 ${IDLE_MIN} 分钟`);
    } else if (!everConnected && Date.now() - startTs > graceMs * 3) {
      // 起了服务却始终没人打开页面（例如误点），也别一直挂着
      clearInterval(timer);
      shutdown("启动后一直没有人连接");
    }
  }, CHECK_MS);
  timer.unref?.();
}

process.on("SIGINT", () => shutdown("收到 Ctrl+C"));
process.on("SIGTERM", () => shutdown("收到终止信号"));

export { server, ROOT, buildIndex, readConfig, writeConfig, readLedger, writeLedger };
