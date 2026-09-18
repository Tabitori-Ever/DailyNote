/** 验证：长算式在输入框内是否完全可见 */
const T = [];
const log = (ok, label, extra = "") => { T.push(ok); console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? "  → " + extra : ""}`); };

export default async function run(api, { url }) {
  const { goto, inject, send, sleep, shot } = api;

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

  const SAMPLE = "5+10.6+11.6+6.9";

  /* 输入框宽度 vs 文本宽度（编辑器要先打开弹窗，否则量到 0） */
  await inject(`Ed.open(null, TODAY); return null;`);
  await sleep(700);
  const fit = await inject(`
    function textWidth(text, el) {
      const cs = getComputedStyle(el);
      const c = document.createElement('canvas').getContext('2d');
      c.font = cs.font || (cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily);
      return c.measureText(text).width;
    }
    const out = {};
    for (const id of ['ledIn','ledEx','edIn','edEx']) {
      const el = document.getElementById(id);
      if (!el) { out[id] = { missing: true }; continue; }
      const cs = getComputedStyle(el);
      const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
                    - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      el.value = '${SAMPLE}';
      out[id] = {
        boxWidth: Math.round(el.getBoundingClientRect().width),
        textArea: Math.round(inner),
        textWidth: Math.round(textWidth('${SAMPLE}', el)),
        scrollW: el.scrollWidth,
        clientW: el.clientWidth
      };
      out[id].fits = out[id].textWidth <= out[id].textArea;
      out[id].noScroll = el.scrollWidth <= el.clientWidth + 1;
    }
    return out;
  `);
  for (const [id, v] of Object.entries(fit)) {
    if (v.missing) { log(false, `${id} 不存在`); continue; }
    log(v.fits, `${id}：算式完整可见（文字 ${v.textWidth}px ≤ 可用 ${v.textArea}px）`,
        `框宽 ${v.boxWidth}px`);
    log(v.noScroll, `${id}：输入后不产生横向滚动（文本没被推到视野外）`,
        `scrollW=${v.scrollW} clientW=${v.clientW}`);
  }

  /* 逐字输入时，框内始终能看见完整内容 */
  await inject(`Modal.close('mEdit'); document.querySelector('#ledIn').value=''; document.querySelector('#ledIn').focus(); return null;`);
  await sleep(400);
  const invisible = [];
  for (let i = 0; i < SAMPLE.length; i++) {
    await send("Input.insertText", { text: SAMPLE[i] });
    await sleep(60);
    const st = await inject(`
      const el = document.querySelector('#ledIn');
      return { v: el.value, atEnd: el.scrollWidth <= el.clientWidth + 1 };
    `);
    if (!st.atEnd) invisible.push(`"${st.v}"（已超出可见宽度）`);
  }
  log(invisible.length === 0, "★ 逐字输入全程都在可见范围内", invisible.join(" | ") || "17 个字符全程可见");

  /* 提示文案：未写完时不该报红 */
  const states = await inject(`
    const el = document.querySelector('#ledIn');
    const out = document.querySelector('#ledInCalc');
    const res = [];
    for (const v of ['5+', '5+10.', '5+10.6+11.', '5+10.6+11.6', 'abc', '(5+3', '5/0', '']) {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      res.push({ v, text: out.textContent, cls: out.className });
    }
    return res;
  `);
  console.log("\n  各种输入状态：");
  for (const s of states) console.log(`    "${s.v}" → "${s.text}"  [${s.cls}]`);

  const partial = states.find(s => s.v === "5+10.6+11.");
  log(/继续输入/.test(partial.text) && /partial/.test(partial.cls),
      "★ 未写完的算式提示「继续输入…」而不是报错", `${partial.text} [${partial.cls}]`);
  const done = states.find(s => s.v === "5+10.6+11.6");
  log(done.text === "= 27.20", "写完立即显示结果", done.text);
  const badOne = states.find(s => s.v === "abc");
  log(/无法解析/.test(badOne.text) && /bad/.test(badOne.cls), "真正的非法输入才报错", badOne.text);
  const empty = states.find(s => s.v === "");
  log(empty.text === "", "清空后无提示残留", JSON.stringify(empty.text));

  await shot("18-ledger-wide.png");

  /* 收尾 */
  await inject(`
    (async () => {
      const el = document.querySelector('#ledIn'); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true}));
      await fetch('/api/config', { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ ledgerEnabled: false }) });
      await reloadAll();
      return null;
    })()
  `);

  const fail = T.filter(x => !x).length;
  console.log(`\n通过 ${T.length - fail} · 失败 ${fail}`);
  if (fail) process.exitCode = 1;
}
