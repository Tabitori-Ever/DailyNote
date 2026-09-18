#!/usr/bin/env node
/**
 * server.mjs — 日记系统本地服务
 *
 *   node server.mjs             # http://127.0.0.1:8787
 *   node server.mjs 9000        # 指定端口
 *
 * 职责：
 *   · 静态托管 index.html / entries / assets
 *   · 日记文件读写（entries/YYYY/YYYY-MM-DD.md，带乐观并发校验）
 *   · 图片上传（assets/YYYY/MM/）
 *   · 记账库、应用配置（data/*.json，原子写入）
 *   · Git 备份（status / commit / push），令牌只保存在 .git/config
 *
 * 依赖：仅 Node 内置模块。
 */
import { createServer } from "node:http";
import { readFile, writeFile, rename, stat, mkdir, readdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const ENTRIES_DIR = path.join(ROOT, "entries");
const ASSETS_DIR = path.join(ROOT, "assets");
const DATA_DIR = path.join(ROOT, "data");
const INDEX_FILE = path.join(ENTRIES_DIR, "index.json");
const LEDGER_FILE = path.join(DATA_DIR, "ledger.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

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
const writeLedger = l => { l.updatedAt = new Date().toISOString(); return atomicWrite(LEDGER_FILE, JSON.stringify(l, null, 2) + "\n"); };

/** 日记里的收支同步进记账库：每篇日记一条记录，反复保存只更新不重复 */
async function syncLedgerFromEntry(entry) {
  if (!entry) return;
  const ledger = await readLedger();
  const id = "entry:" + entry.date;
  const idx = ledger.records.findIndex(r => r.id === id);
  if (!entry.income && !entry.expense) {
    if (idx >= 0) ledger.records.splice(idx, 1);        // 清零则移除
  } else {
    const rec = {
      id, date: entry.date, kind: "diary",
      income: Number(entry.income) || 0,
      expense: Number(entry.expense) || 0,
      note: entry.title || entry.date,
      updated: new Date().toISOString()
    };
    if (idx >= 0) ledger.records[idx] = rec; else ledger.records.push(rec);
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
    return sendJson(res, 200, { ok: true, root: ROOT, node: process.version, git: await isGitRepo() });
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
      await writeLedger({ version: 1, records: clean });
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
await buildIndex();

server.listen(PORT, "127.0.0.1", () => {
  console.log("日记 · 桑榆下 —— 本地服务");
  console.log("  目录: " + ROOT);
  console.log("  地址: http://127.0.0.1:" + PORT + "/");
  console.log("  停止: Ctrl + C");
});

export { server, ROOT, buildIndex, readConfig, writeConfig, readLedger, writeLedger };
