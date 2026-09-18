/** 暴力排查：所有金额输入框是否存在任何字符拦截 / 长度上限 */
const T = [];
const log = (ok, label, extra = "") => { T.push(ok); console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? "  → " + extra : ""}`); };

export default async function run(api, { url }) {
  const { goto, inject, send, sleep } = api;

  await goto(url);
  await sleep(1500);
  await inject(`
    (async () => {
      await fetch('/api/config', { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ ledgerEnabled: true }) });
      await reloadAll();
      setNav('ledger');
      return null;
    })()
  `);
  await sleep(700);

  const chars = "0123456789+-*/^().,（）＋－＊／．， \uFF10\uFF11";
  const targets = [
    ["#ledIn", "记账页收入"], ["#ledEx", "记账页支出"],
    ["#ledNote", "记账页备注"]
  ];
  await inject(`Ed.open(null, TODAY); return null;`);
  await sleep(600);
  targets.push(["#edIn", "编辑器收入"], ["#edEx", "编辑器支出"]);

  for (const [sel, label] of targets) {
    await inject(`const e=document.querySelector('${sel}'); e.value=''; e.focus(); return null;`);
    await sleep(120);
    let accepted = 0, rejected = [];
    for (const ch of chars) {
      await inject(`document.querySelector('${sel}').value=''; document.querySelector('${sel}').focus(); return null;`);
      await sleep(30);
      await send("Input.insertText", { text: ch });
      await sleep(35);
      const v = await inject(`return document.querySelector('${sel}').value;`);
      if (v === ch) accepted++; else rejected.push(`${JSON.stringify(ch)}→${JSON.stringify(v)}`);
    }
    log(rejected.length === 0, `${label}：所有字符都可输入`,
        rejected.length ? rejected.join(" ") : `${accepted}/${chars.length}`);

    // 长度上限
    await inject(`document.querySelector('${sel}').value=''; document.querySelector('${sel}').focus(); return null;`);
    await sleep(80);
    await send("Input.insertText", { text: "1".repeat(300) });
    await sleep(250);
    const long = await inject(`return document.querySelector('${sel}').value.length;`);
    log(long === 300, `${label}：可输入 300 个字符（无长度上限）`, "实际 " + long);
  }

  // 完整算式：一次性粘贴
  for (const [sel, label] of targets) {
    if (sel === "#ledNote") continue;
    await inject(`document.querySelector('${sel}').value=''; document.querySelector('${sel}').focus(); return null;`);
    await sleep(80);
    await send("Input.insertText", { text: "5+10.6+11.6+6.9" });
    await sleep(250);
    const v = await inject(`return document.querySelector('${sel}').value;`);
    log(v === "5+10.6+11.6+6.9", `${label}：整段粘贴完整`, JSON.stringify(v));
  }

  // 逐字输入 + 每个字符后都验证（模拟真人手打）
  await inject(`const e=document.querySelector('#ledIn'); e.value=''; e.focus(); return null;`);
  await sleep(120);
  const seq = "5+10.6+11.6+6.9";
  const lost = [];
  for (let i = 0; i < seq.length; i++) {
    await send("Input.insertText", { text: seq[i] });
    await sleep(70);
    const v = await inject(`return document.querySelector('#ledIn').value;`);
    if (v !== seq.slice(0, i + 1)) lost.push(`第${i + 1}字 '${seq[i]}' → "${v}"`);
  }
  log(lost.length === 0, "记账页收入：真人式逐字输入无丢失", lost.join(" | ") || seq);

  // DOM 层面确认没有 maxlength / pattern / 只读
  const domCheck = await inject(`
    return ['ledIn','ledEx','edIn','edEx'].map(id => {
      const el = document.getElementById(id);
      if (!el) return { id, missing: true };
      return {
        id, type: el.type, maxLength: el.maxLength, pattern: el.getAttribute('pattern'),
        readOnly: el.readOnly, disabled: el.disabled,
        hasBeforeInput: typeof el.onbeforeinput,
        cssOverflow: getComputedStyle(el).overflow
      };
    });
  `);
  log(domCheck.every(d => d.maxLength === -1 && !d.pattern && !d.readOnly && !d.disabled),
      "四个金额框都没有 maxlength / pattern / 只读限制", JSON.stringify(domCheck));

  // 输入事件处理器会不会抛异常
  const errs = await inject(`
    const el = document.querySelector('#ledIn');
    el.value = '';
    const seen = [];
    const origErr = console.error;
    window.onerror = (m) => { seen.push(String(m)); };
    for (const v of ['5+', '5+10.', '5+10.6+11.', 'abc', '(5+3', '5/0']) {
      el.value = v;
      try { el.dispatchEvent(new Event('input', { bubbles: true })); }
      catch (e) { seen.push('input handler threw: ' + e.message); }
    }
    window.onerror = null;
    return { errors: seen, calc: document.querySelector('#ledInCalc').textContent };
  `);
  log(errs.errors.length === 0, "输入事件处理器在边界输入下不抛异常", JSON.stringify(errs.errors));

  const fail = T.filter(x => !x).length;
  console.log(`\n通过 ${T.length - fail} · 失败 ${fail}`);
  if (fail) process.exitCode = 1;

  // 收尾：关掉记账入口
  await inject(`
    (async () => {
      await fetch('/api/config', { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ ledgerEnabled: false }) });
      await reloadAll();
      return null;
    })()
  `);
}
