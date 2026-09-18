#!/usr/bin/env node
/**
 * test-expr.mjs — 记账算式输入的回归测试
 *
 *   node _tools/test-expr.mjs
 *
 * 覆盖：服务端解析、front matter 往返、账本同步、以及边界与非法输入。
 * 用 1999-01-01 作为测试日期，跑完自动清理。
 */
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const TEST_DATE = "1999-01-01";

let pass = 0, fail = 0;
const ok = (c, label, extra = "") => {
  if (c) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (extra ? "  → " + extra : "")); }
};

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body !== undefined ? { "content-type": "application/json; charset=utf-8" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

console.log("记账算式测试 →", BASE, "\n");

/* ── 1. 日记里写算式 ── */
{
  console.log("1. 日记 front matter 里的算式");
  const r = await api("POST", "/api/entries/" + TEST_DATE, {
    title: "算式测试",
    tags: [],
    body: "## 事件\n\n测试。\n",
    income: "1200+300.5",
    expense: "5+10.6+11.6+6.9"
  });
  ok(r.status === 200 && r.json?.ok, "POST 接受算式字符串");

  const e = (await api("GET", "/api/entries/" + TEST_DATE)).json;
  ok(e.income === 1500.5, "收入算式解析为 1500.5", String(e.income));
  ok(e.expense === 34.1, "★ 支出算式 5+10.6+11.6+6.9 解析为 34.1", String(e.expense));
  ok(e.incomeExpr === "1200+300.5", "保留了收入原式", JSON.stringify(e.incomeExpr));
  ok(e.expenseExpr === "5+10.6+11.6+6.9", "★ 保留了支出原式", JSON.stringify(e.expenseExpr));
}

/* ── 2. 原式真的写进文件了吗 ── */
{
  const e = (await api("GET", "/api/entries/" + TEST_DATE)).json;
  const res = await fetch(BASE + "/" + e.file);
  const md = await res.text();
  const fm = md.split("---")[1] || "";
  ok(/income:\s*"?1200\+300\.5"?/.test(fm), "文件里 income 存的是原式", fm.match(/income:.*/)?.[0]);
  ok(/expense:\s*"?5\+10\.6\+11\.6\+6\.9"?/.test(fm), "文件里 expense 存的是原式", fm.match(/expense:.*/)?.[0]);
}

/* ── 3. 账本同步 ── */
{
  const led = (await api("GET", "/api/ledger")).json;
  const rec = led.records.find(x => x.id === "entry:" + TEST_DATE);
  ok(!!rec, "账本里生成了对应记录");
  ok(rec?.income === 1500.5 && rec?.expense === 34.1, "账本数值是解析后的结果", JSON.stringify({ i: rec?.income, e: rec?.expense }));
  ok(rec?.expenseExpr === "5+10.6+11.6+6.9", "账本里也留了原式");
}

/* ── 4. 各种算式形式 ── */
{
  console.log("\n2. 算式写法覆盖");
  const cases = [
    ["5+10.6+11.6+6.9", 34.1, "多段加法"],
    ["100-30-15.5", 54.5, "减法"],
    ["3*4.5", 13.5, "乘法"],
    ["100/4", 25, "除法"],
    ["(5+5)*3", 30, "括号"],
    ["2^3", 8, "幂"],
    ["-50", -50, "负数"],
    ["20+(-5)", 15, "括号内负数"],
    ["5＋10.6＋11.6", 27.2, "全角加号"],
    ["5+10．6", 15.6, "全角小数点"],
    ["  7 + 3  ", 10, "带空格"],
    ["1,000+500", 1500, "千分位逗号"],
    ["200*0.85", 170, "打折"],
    ["12.5", 12.5, "纯数字"],
    ["", 0, "空串按 0"]
  ];
  for (const [input, expect, label] of cases) {
    await api("PUT", "/api/entries/" + TEST_DATE, {
      title: "算式测试", tags: [], body: "x\n", income: 0, expense: input
    });
    const e = (await api("GET", "/api/entries/" + TEST_DATE)).json;
    const got = e.expense;
    ok(got === expect, `${label}：${JSON.stringify(input)} = ${expect}`, "得到 " + got);
  }
}

/* ── 5. 非法算式不能静默变 0 ── */
{
  console.log("\n3. 非法输入的处理");
  const bad = ["5+", "abc", "(5+3", "5/0", "5++*3", "5+3)"];
  for (const input of bad) {
    await api("PUT", "/api/entries/" + TEST_DATE, {
      title: "算式测试", tags: [], body: "x\n", income: 0, expense: input
    });
    const e = (await api("GET", "/api/entries/" + TEST_DATE)).json;
    // 服务端算不出来就按 0 处理，但原式要保留，方便前端提示用户
    ok(e.expense === 0 && e.expenseExpr === input,
       `非法输入 ${JSON.stringify(input)} 记为 0 且保留原文`,
       JSON.stringify({ v: e.expense, x: e.expenseExpr }));
  }
}

/* ── 6. 手动记一笔（账本接口直接收算式） ── */
{
  console.log("\n4. 账本接口收算式");
  const before = (await api("GET", "/api/ledger")).json;
  const keep = before.records.filter(r => r.kind !== "manual");
  const r = await api("PUT", "/api/ledger", {
    records: [...keep, {
      id: "manual:test-expr", date: TEST_DATE, kind: "manual",
      income: "0", expense: "5+10.6+11.6+6.9", note: "手动算式"
    }]
  });
  ok(r.status === 200 && r.json?.ok, "PUT /api/ledger 接受算式");
  const after = (await api("GET", "/api/ledger")).json;
  const rec = after.records.find(x => x.id === "manual:test-expr");
  ok(rec?.expense === "5+10.6+11.6+6.9", "★ 手动记录原样保留算式", JSON.stringify(rec?.expense));
  ok(ledgerMoney(rec?.expense) === 34.1, "算式可被解析为 34.1", String(ledgerMoney(rec?.expense)));

  // 纯数字应存成数字，账本保持整洁
  await api("PUT", "/api/ledger", {
    records: [...keep, { id: "manual:test-expr", date: TEST_DATE, kind: "manual", income: "88", expense: "12.5", note: "手动算式" }]
  });
  const rec2 = (await api("GET", "/api/ledger")).json.records.find(x => x.id === "manual:test-expr");
  ok(rec2?.income === 88 && rec2?.expense === 12.5, "纯数字仍存成数字而非字符串",
     JSON.stringify({ i: rec2?.income, e: rec2?.expense }));
}

/** 测试内取值辅助：只处理加减，够验证本用例 */
function ledgerMoney(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return Number(s);
  return s.split("+").map(Number).reduce((a, b) => a + b, 0);
}

/* ── 5. 往返：读出来再存回去，原式不能丢 ── */
{
  console.log("\n4.5 往返保存（回归：原式曾被数值覆盖）");
  await api("DELETE", "/api/entries/" + TEST_DATE);
  await api("POST", "/api/entries/" + TEST_DATE, {
    title: "往返测试", tags: [], body: "x\n",
    income: "1200+300.5", expense: "5+10.6+11.6+6.9"
  });
  for (let i = 1; i <= 3; i++) {
    const e = (await api("GET", "/api/entries/" + TEST_DATE)).json;
    // 客户端的回存方式：金额取解析后的数字，同时也带上原式（编辑器就是这么发的）
    await api("PUT", "/api/entries/" + TEST_DATE, {
      title: e.title, tags: e.tags, body: e.body,
      income: e.income, expense: e.expense,
      incomeExpr: e.incomeExpr, expenseExpr: e.expenseExpr,
      checksum: e.checksum
    });
    const md = await (await fetch(BASE + "/" + e.file)).text();
    const fm = md.split("---")[1] || "";
    const kept = /income:\s*"?1200\+300\.5"?/.test(fm) && /expense:\s*"?5\+10\.6\+11\.6\+6\.9"?/.test(fm);
    ok(kept, `第 ${i} 次往返后原式仍在文件里`, fm.match(/income:.*/)?.[0] + " / " + fm.match(/expense:.*/)?.[0]);
  }

  // 只发数值、不提原式（第三方调用）：数值原样生效，不会从上一篇串味
  {
    await api("PUT", "/api/entries/" + TEST_DATE, {
      title: "往返测试", tags: [], body: "x\n", income: 77, expense: 12.5
    });
    const e = (await api("GET", "/api/entries/" + TEST_DATE)).json;
    const md = await (await fetch(BASE + "/" + e.file)).text();
    const fm = md.split("---")[1] || "";
    ok(e.income === 77 && e.expense === 12.5, "只发数值时金额正确（不继承旧算式）",
       JSON.stringify({ i: e.income, x: e.incomeExpr, e: e.expense }));
    ok(!/1200\+300\.5/.test(fm), "旧算式没有被带过来", fm.match(/income:.*/)?.[0]);
  }

  // 编辑器清空输入 → 发空串 → 金额归零，旧算式删除
  {
    const e = (await api("GET", "/api/entries/" + TEST_DATE)).json;
    await api("PUT", "/api/entries/" + TEST_DATE, {
      title: e.title, tags: [], body: e.body, income: 0, expense: 0,
      incomeExpr: "", expenseExpr: "", checksum: e.checksum
    });
    const md2 = await (await fetch(BASE + "/" + e.file)).text();
    const fm2 = md2.split("---")[1] || "";
    ok(/income:\s*$/m.test(fm2.replace(/^income:\s*0\s*$/m, "income:")) || /income:\s*0/.test(fm2),
       "★ 显式清空后金额归零", fm2.match(/income:.*/)?.[0]);
  }
}

/* ── 6. 老数据（纯数字）不受影响 ── */
{
  console.log("\n5. 向后兼容");
  await api("PUT", "/api/entries/" + TEST_DATE, {
    title: "算式测试", tags: [], body: "x\n", income: 88, expense: 12.5
  });
  const e = (await api("GET", "/api/entries/" + TEST_DATE)).json;
  ok(e.income === 88 && e.expense === 12.5, "纯数字照常工作");
  ok(e.incomeExpr === "" && e.expenseExpr === "", "纯数字不产生多余的 expr 字段");
  const res = await fetch(BASE + "/" + e.file);
  const fm = (await res.text()).split("---")[1] || "";
  ok(/income:\s*88\s*$/m.test(fm), "文件里是裸数字，没有多余引号", fm.match(/income:.*/)?.[0]);
}

/* ── 8. 清理 ── */
{
  console.log("\n6. 清理");
  await api("DELETE", "/api/entries/" + TEST_DATE);
  const led = (await api("GET", "/api/ledger")).json;
  const keep = led.records.filter(r => r.id !== "manual:test-expr");
  await api("PUT", "/api/ledger", { records: keep });
  const after = (await api("GET", "/api/ledger")).json;
  ok(!after.records.some(r => r.id === "entry:" + TEST_DATE), "日记记录已清理");
  ok(!after.records.some(r => r.id === "manual:test-expr"), "手动记录已清理");
  ok((await api("GET", "/api/entries/" + TEST_DATE)).status === 404, "测试日记已删除");
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
