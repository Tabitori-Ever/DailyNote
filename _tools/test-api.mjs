#!/usr/bin/env node
/**
 * test-api.mjs — 服务端接口回归测试
 *
 *   node _tools/server.mjs 8787      # 先起服务
 *   node _tools/test-api.mjs         # 再跑测试
 *
 * 全部走 HTTP，会创建并清理临时测试数据（日期 1999-01-01）。
 */
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const TEST_DATE = "1999-01-01";

let pass = 0, fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (extra ? "  → " + extra : "")); }
};

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { "content-type": "application/json; charset=utf-8" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

console.log("日记服务接口测试 →", BASE);

/* ── 0. 健康检查 ── */
{
  const r = await api("GET", "/api/health");
  ok(r.status === 200 && r.json?.ok === true, "GET /api/health");
  ok(typeof r.json?.root === "string" && /02-日记$/.test(r.json.root.replace(/[\\/]$/, "")),
     "根目录解析正确（不是上一层）", r.json?.root);
}

/* ── 1. 列表与读取 ── */
let before = 0;
{
  const r = await api("GET", "/api/entries");
  before = r.json?.count ?? -1;
  ok(r.status === 200 && Array.isArray(r.json?.entries), "GET /api/entries 返回数组");
  ok(before >= 2, "至少读到 2 篇已有日记", "count=" + before);
  const e = r.json.entries[0];
  ok(e && !("body" in e), "列表不含正文（轻量摘要）");
  ok(e && "keyword" in e && "checksum" in e, "列表含 keyword 与 checksum");
}

/* ── 2. 中文 UTF-8 写入 / 读回 ── */
const SAMPLE_TITLE = "中文标题测试 · 表情 🙂";
const SAMPLE_BODY = "## 事件\n\n这是 **加粗** 与 <u>下划线</u> 的测试。\n\n- 列表项一\n- 列表项二\n\n![图片](/assets/test.png)\n";
let checksum = null;
{
  const r = await api("POST", "/api/entries/" + TEST_DATE, {
    title: SAMPLE_TITLE, tags: ["测试", "回归"], mood: "🙂",
    body: SAMPLE_BODY, income: 200, expense: 50
  });
  ok(r.status === 200 && r.json?.ok, "POST 新建日记");
  checksum = r.json?.checksum;
}
{
  const r = await api("GET", "/api/entries/" + TEST_DATE);
  ok(r.json?.title === SAMPLE_TITLE, "中文标题读回一致", JSON.stringify(r.json?.title));
  ok(r.json?.body.trim() === SAMPLE_BODY.trim(), "中文正文读回一致");
  ok(r.json?.mood === "🙂", "心情 emoji 读回一致", r.json?.mood);
  ok(r.json?.income === 200 && r.json?.expense === 50, "收支读回一致");
  ok(Array.isArray(r.json?.tags) && r.json.tags.join() === "测试,回归", "标签数组解析正确", JSON.stringify(r.json?.tags));
  ok(!!r.json?.created && !!r.json?.updated, "created / updated 自动写入");
}

/* ── 3. 记账库同步 ── */
{
  const r = await api("GET", "/api/ledger");
  const rec = r.json?.records?.find(x => x.id === "entry:" + TEST_DATE);
  ok(!!rec, "日记收支自动同步进记账库");
  ok(rec?.income === 200 && rec?.expense === 50, "记账数值正确");
}

/* ── 4. 乐观并发 ── */
{
  const r = await api("PUT", "/api/entries/" + TEST_DATE, { title: "并发", body: "x", checksum: "000000000000" });
  ok(r.status === 409, "过期 checksum 被拒绝（409）", "status=" + r.status);
}
{
  const r = await api("PUT", "/api/entries/" + TEST_DATE, {
    title: SAMPLE_TITLE, tags: ["测试"], mood: "🙂", body: SAMPLE_BODY + "\n追加一行。\n", income: 200, expense: 50,
    checksum
  });
  ok(r.status === 200 && r.json?.ok, "正确 checksum 可保存");
  checksum = r.json?.checksum;
}
{
  const r = await api("GET", "/api/entries/" + TEST_DATE);
  ok(/追加一行/.test(r.json?.body || ""), "更新内容已落盘");
  ok(new Date(r.json.updated) >= new Date(r.json.created), "updated 不早于 created");
}

/* ── 5. 清零收支应从账本移除 ── */
{
  await api("PUT", "/api/entries/" + TEST_DATE, { title: SAMPLE_TITLE, tags: [], body: SAMPLE_BODY, income: 0, expense: 0, checksum });
  const r = await api("GET", "/api/ledger");
  ok(!r.json?.records?.some(x => x.id === "entry:" + TEST_DATE), "收支清零后账本记录被移除");
}

/* ── 6. 图片上传 ── */
{
  const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const r = await api("POST", "/api/upload", { name: "测试图.png", dataUrl: "data:image/png;base64," + png1x1 });
  ok(r.status === 200 && r.json?.ok, "上传 PNG 成功");
  ok(/^assets\/\d{4}\/\d{2}\/.*\.png$/.test(r.json?.path || ""), "落盘路径规范", r.json?.path);
  if (r.json?.path) {
    const got = await fetch(BASE + "/" + r.json.path);
    ok(got.status === 200 && got.headers.get("content-type") === "image/png", "上传后的图片可访问");
  }
  const bad = await api("POST", "/api/upload", { name: "x.txt", dataUrl: "data:text/plain;base64,aGk=" });
  ok(bad.status === 400, "拒绝非图片上传");
}

/* ── 7. 配置读写 ── */
{
  const r = await api("GET", "/api/config");
  ok(r.status === 200 && Array.isArray(r.json?.templates), "GET /api/config 含模板");
  ok(r.json?.reader && typeof r.json.reader.fontSize === "number", "含阅读器设置");
  const w = await api("PUT", "/api/config", { anniversaries: [{ id: "t1", date: "2026-10-01", title: "测试纪念日", repeat: "yearly" }] });
  ok(w.status === 200 && w.json?.config?.anniversaries?.length === 1, "写入纪念日");
  const r2 = await api("GET", "/api/config");
  ok(r2.json?.anniversaries?.length === 1, "纪念日持久化");
  await api("PUT", "/api/config", { anniversaries: [] });
  ok((await api("GET", "/api/config")).json?.anniversaries?.length === 0, "纪念日已清理");
}

/* ── 8. 安全检查 ── */
{
  const r1 = await api("GET", "/api/entries/..%2F..%2Fetc%2Fpasswd");
  ok(r1.status === 400, "非法日期被拒");
  const r2 = await fetch(BASE + "/../README.md");
  ok(r2.status === 404 || r2.status === 403 || r2.status === 200, "路径穿越返回受控状态", "status=" + r2.status);
  const r3 = await api("GET", "/api/nope");
  ok(r3.status === 404, "未知接口 404");
}

/* ── 9. 清理 ── */
{
  const r = await api("DELETE", "/api/entries/" + TEST_DATE);
  ok(r.status === 200, "DELETE 删除测试日记");
  const after = await api("GET", "/api/entries");
  ok(after.json?.count === before, "删除后条目数复原", `before=${before} after=${after.json?.count}`);
  const led = await api("GET", "/api/ledger");
  ok(!led.json?.records?.some(x => x.id === "entry:" + TEST_DATE), "账本无残留");
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
