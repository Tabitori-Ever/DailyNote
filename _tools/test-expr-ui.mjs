/** 记账算式输入的界面测试 */
const T = [];
const log = (ok, label, extra = "") => { T.push(ok); console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? "  → " + extra : ""}`); };

export default async function run(api, { url }) {
  const { goto, inject, click, shot, sleep } = api;
  const TEST_DATE = "1999-02-02";

  await goto(url);
  await sleep(1500);

  /* 确保记账入口打开 */
  await inject(`
    (async () => {
      if (!S.ledgerEnabled) {
        await fetch('/api/config', { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ ledgerEnabled: true }) });
        await reloadAll();
      }
      return null;
    })()
  `);
  await sleep(500);

  /* ── 1. 前端解析器本身 ── */
  const parser = await inject(`
    const cases = [
      ["5+10.6+11.6+6.9", 34.1], ["100-30-15.5", 54.5], ["3*4.5", 13.5],
      ["(5+5)*3", 30], ["2^3", 8], ["-50", -50], ["5＋10.6", 15.6],
      ["1,000+500", 1500], ["12.5", 12.5], ["", 0]
    ];
    const bad = ["5+", "abc", "(5+3", "5/0"];
    return {
      good: cases.map(([i, e]) => ({ i, e, got: parseAmount(i), ok: parseAmount(i) === e })),
      bad: bad.map(i => ({ i, got: String(parseAmount(i)), isNaN: Number.isNaN(parseAmount(i)) }))
    };
  `);
  log(parser.good.every(c => c.ok), "前端解析器：合法算式全部正确",
      parser.good.filter(c => !c.ok).map(c => `${c.i}→${c.got}(期望${c.e})`).join(", ") || "10/10");
  log(parser.bad.every(c => c.isNaN), "前端解析器：非法算式返回 NaN（不会静默变 0）",
      parser.bad.map(c => `${c.i}→${c.got}`).join(", "));

  /* ── 2. 记账页：边打边显示结果 ── */
  await click('.tab[data-nav="ledger"]');
  await sleep(700);
  const typing = await inject(`
    const inp = document.querySelector('#ledIn');
    inp.value = '5+10.6+11.6+6.9';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const out = document.querySelector('#ledInCalc');
    return { text: out.textContent, cls: out.className };
  `);
  log(typing.text === "= 34.10", "★ 输入算式时实时显示 = 34.10", JSON.stringify(typing.text));
  log(/ok/.test(typing.cls), "结果用强调色标出", typing.cls);

  // 未写完的算式：提示继续输入，不算错误（手打时每一步报红会让人以为输不进去）
  const typing2 = await inject(`
    const inp = document.querySelector('#ledIn');
    inp.value = '5+10.6+11.';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const out = document.querySelector('#ledInCalc');
    return { text: out.textContent, cls: out.className };
  `);
  log(/继续输入/.test(typing2.text), "★ 未写完的算式提示「继续输入…」而非报错", JSON.stringify(typing2.text));
  log(/partial/.test(typing2.cls), "未写完用中性样式（不是错误色）", typing2.cls);

  // 真正非法的输入才报错
  const typing3 = await inject(`
    const inp = document.querySelector('#ledIn');
    inp.value = 'abc';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const out = document.querySelector('#ledInCalc');
    return { text: out.textContent, cls: out.className };
  `);
  log(/无法解析/.test(typing3.text), "★ 真正非法的输入明确报错而不是当成 0", JSON.stringify(typing3.text));
  log(/bad/.test(typing3.cls), "非法输入有独立错误样式", typing3.cls);

  const plainNum = await inject(`
    const inp = document.querySelector('#ledIn');
    inp.value = '88.5';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('#ledInCalc').textContent;
  `);
  log(plainNum === "", "纯数字不显示多余的提示", JSON.stringify(plainNum));
  await shot("16-ledger-expr.png");

  /* ── 3. 记一笔并检查账本 ── */
  const added = await inject(`
    (async () => {
      document.querySelector('#ledDate').value = '${TEST_DATE}';
      document.querySelector('#ledNote').value = '算式界面测试';
      const i = document.querySelector('#ledIn'); i.value = '1200+300.5';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      const e = document.querySelector('#ledEx'); e.value = '5+10.6+11.6+6.9';
      e.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#ledAdd').click();
      await new Promise(r => setTimeout(r, 1800));
      const rows = [...document.querySelectorAll('#ledBody tr')];
      const hit = rows.find(r => r.textContent.includes('算式界面测试'));
      return {
        rowText: hit ? hit.textContent.replace(/\\s+/g, ' ').trim() : null,
        rowHtml: hit ? hit.innerHTML.replace(/\\s+/g, ' ').trim().slice(0, 300) : null,
        exprNodes: hit ? hit.querySelectorAll('.expr').length : 0,
        sumIn: document.querySelector('#sumIn').textContent,
        sumEx: document.querySelector('#sumEx').textContent,
        inCleared: document.querySelector('#ledIn').value === '',
        calcCleared: document.querySelector('#ledExCalc').textContent === ''
      };
    })()
  `);
  // 切到 1999-02 才能看到这条
  const inMonth = await inject(`
    S.ledY = 1999; S.ledM = 2; renderLedger();
    const rows = [...document.querySelectorAll('#ledBody tr')];
    const hit = rows.find(r => r.textContent.includes('算式界面测试'));
    return {
      found: !!hit,
      rowText: hit ? hit.textContent.replace(/\\s+/g, ' ').trim() : null,
      exprNodes: hit ? hit.querySelectorAll('.expr').length : 0,
      exprTexts: hit ? [...hit.querySelectorAll('.expr')].map(x => x.textContent) : [],
      sumIn: document.querySelector('#sumIn').textContent,
      sumEx: document.querySelector('#sumEx').textContent,
      sumBal: document.querySelector('#sumBal').textContent
    };
  `);
  log(inMonth.found, "记账页出现了这条记录");
  log(inMonth.exprTexts.includes("1200+300.5") && inMonth.exprTexts.includes("5+10.6+11.6+6.9"),
      "★ 表格里保留了原始算式", JSON.stringify(inMonth.exprTexts));
  log(/1,500\.50/.test(inMonth.rowText || "") && /34\.10/.test(inMonth.rowText || ""),
      "★ 同时也显示了算出来的金额", inMonth.rowText);
  log(inMonth.sumIn === "1,500.50", "本月收入合计用了算式结果", inMonth.sumIn);
  log(inMonth.sumEx === "34.10", "本月支出合计用了算式结果", inMonth.sumEx);
  log(inMonth.sumBal === "1,466.40", "结余计算正确", inMonth.sumBal);
  log(added.inCleared && added.calcCleared, "记完后输入框与提示被清空");
  await shot("17-ledger-rows.png");

  /* ── 4. 刷新后仍然是算式（真的存进去了） ── */
  const afterReload = await inject(`
    (async () => {
      S.ledger = await API.ledger();
      const rec = S.ledger.records.find(r => r.id && r.id.startsWith('manual:') && r.note === '算式界面测试');
      return rec ? { income: rec.income, expense: rec.expense } : null;
    })()
  `);
  log(afterReload && afterReload.income === "1200+300.5", "★ 从服务端读回：收入原样是算式", JSON.stringify(afterReload?.income));
  log(afterReload && afterReload.expense === "5+10.6+11.6+6.9", "★ 从服务端读回：支出原样是算式", JSON.stringify(afterReload?.expense));

  /* 表格对读回来的字符串算式同样显示「原式 = 结果」 */
  const rerender = await inject(`
    S.ledY = 1999; S.ledM = 2; renderLedger();
    const row = [...document.querySelectorAll('#ledBody tr')].find(r => r.textContent.includes('算式界面测试'));
    return {
      exprs: row ? [...row.querySelectorAll('.expr')].map(x => x.textContent) : [],
      text: row ? row.textContent.replace(/\\s+/g, ' ').trim() : null
    };
  `);
  log(rerender.exprs.includes("1200+300.5") && rerender.exprs.includes("5+10.6+11.6+6.9"),
      "★ 重渲染后表格仍显示原式", JSON.stringify(rerender.exprs));
  log(/1,500\.50/.test(rerender.text || "") && /34\.10/.test(rerender.text || ""),
      "重渲染后金额正确", rerender.text);

  /* ── 5. 编辑器里的收支 ── */
  await click('.tab[data-nav="diary"]');
  await sleep(500);
  const ed = await inject(`
    (async () => {
      Ed.open(null, '${TEST_DATE}');
      await new Promise(r => setTimeout(r, 400));
      const i = document.querySelector('#edIn');
      i.value = '300+45.5+8';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      return {
        calc: document.querySelector('#edInCalc').textContent,
        hint: document.querySelector('#edMoneyHint').textContent
      };
    })()
  `);
  log(ed.calc === "= 353.50", "★ 编辑器里也实时显示算式结果", JSON.stringify(ed.calc));
  log(/353\.50/.test(ed.hint), "提示行显示将写入账本的金额", ed.hint);

  const edSaved = await inject(`
    (async () => {
      document.querySelector('#edTitle').value = '算式编辑器测试';
      const e = document.querySelector('#edEx');
      e.value = '12.5+7.5';
      e.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#edSave').click();
      await new Promise(r => setTimeout(r, 2500));
      const got = await fetch('/api/entries/${TEST_DATE}').then(r => r.json());
      return { income: got.income, expense: got.expense, incomeExpr: got.incomeExpr, expenseExpr: got.expenseExpr };
    })()
  `);
  log(edSaved.income === 353.5 && edSaved.expense === 20, "编辑器保存的算式被解析", JSON.stringify(edSaved));
  log(edSaved.incomeExpr === "300+45.5+8" && edSaved.expenseExpr === "12.5+7.5", "★ 编辑器也保留了原式");

  /* 重新打开编辑器，输入框应回填原式 */
  const edReopen = await inject(`
    (async () => {
      const e = await API.get('${TEST_DATE}');
      Ed.open(e);
      await new Promise(r => setTimeout(r, 400));
      const out = { inVal: document.querySelector('#edIn').value, exVal: document.querySelector('#edEx').value,
                    inCalc: document.querySelector('#edInCalc').textContent };
      Modal.close('mEdit');
      return out;
    })()
  `);
  log(edReopen.inVal === "300+45.5+8", "★ 重新打开时回填的是原式而不是结果", JSON.stringify(edReopen));
  log(edReopen.inCalc === "= 353.50", "回填后仍显示解析结果", edReopen.inCalc);

  /* ── 6. 清理：把测试造的日记与账目一并抹掉，别留在仓库里 ── */
  await inject(`
    (async () => {
      const list = await API.list();
      for (const e of list.entries) {
        if (e.date >= '1999-01-01' && e.date <= '1999-12-31') {
          await fetch('/api/entries/' + e.date, { method: 'DELETE' });
        }
      }
      const led = await API.ledger();
      await fetch('/api/ledger', { method: 'PUT', headers: {'content-type':'application/json'},
        body: JSON.stringify({ records: led.records.filter(r => !String(r.id||'').startsWith('manual:')) }) });
      await fetch('/api/config', { method: 'PUT', headers: {'content-type':'application/json'},
        body: JSON.stringify({ ledgerEnabled: false }) });
      await reloadAll();
      return null;
    })()
  `);
  await sleep(800);
  const cleaned = await inject(`
    (async () => {
      const list = await fetch('/api/entries').then(r => r.json());
      const led = await fetch('/api/ledger').then(r => r.json());
      return {
        entries: list.count,
        leftovers: list.entries.filter(e => e.date.startsWith('1999')).map(e => e.date),
        dates: list.entries.map(e => e.date),
        manualLeft: led.records.filter(r => String(r.id||'').startsWith('manual:')).length
      };
    })()
  `);
  log(cleaned.leftovers.length === 0, "测试日记已清理", JSON.stringify(cleaned.leftovers));
  // 不写死篇数：这里是用户真实的日记目录，随时可能多出新的
  log(!cleaned.dates.some(d => d.startsWith("1999")), "正式日记未被测试波及",
      "现存: " + cleaned.dates.join(", "));
  log(cleaned.manualLeft === 0, "测试账目已清理");

  const fail = T.filter(x => !x).length;
  console.log(`\n通过 ${T.length - fail} · 失败 ${fail}`);
  if (fail) process.exitCode = 1;
}
