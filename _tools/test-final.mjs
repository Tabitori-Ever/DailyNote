/** 最终验收：时间线刻度 + 默认阅读宽度 + 移动端 */
const T = [];
const log = (ok, label, extra = "") => { T.push(ok); console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? "  → " + extra : ""}`); };

export default async function run(api, { url }) {
  const { goto, inject, click, shot, sleep, send } = api;

  await goto(url);
  await sleep(1200);
  // 恢复默认阅读器设置
  await inject(`
    (async () => {
      await fetch('/api/config', { method:'PUT', headers:{'content-type':'application/json'},
        body: JSON.stringify({ reader: { fontSize: 18, lineHeight: 1.9, width: 960, serif: false }, anniversaries: [] }) });
      localStorage.clear();
      return null;
    })()
  `);
  await goto(url);
  await sleep(1800);

  /* 默认阅读宽度 */
  const def = await inject(`
    const doc = document.querySelector('.doc');
    const inner = document.querySelector('.reader__inner');
    const view = document.querySelector('#view-diary');
    return {
      size: getComputedStyle(doc).fontSize,
      lh: getComputedStyle(doc).lineHeight,
      innerW: Math.round(inner.getBoundingClientRect().width),
      viewW: Math.round(view.getBoundingClientRect().width),
      ratio: +(inner.getBoundingClientRect().width / view.getBoundingClientRect().width).toFixed(3),
      charsPerLine: Math.round(inner.getBoundingClientRect().width / parseFloat(getComputedStyle(doc).fontSize))
    };
  `);
  log(def.size === "18px", "默认字号 18px", def.size);
  log(def.innerW >= 900, "默认阅读栏 ≥900px", def.innerW + "px");
  log(def.ratio >= 0.68, "正文占阅读区比例 ≥68%", (def.ratio * 100).toFixed(1) + "%");
  log(def.charsPerLine >= 45, "每行可容纳约 45+ 字", def.charsPerLine + " 字宽");

  /* 时间线刻度 */
  await click('.tab[data-nav="timeline"]');
  await sleep(900);
  const tl = await inject(`
    const m = [...document.querySelectorAll('#corridorTrack .tl__mcell')];
    const vis = m.filter(x => { const r = x.getBoundingClientRect(); return r.width > 0 && r.right > 0 && r.left < innerWidth; });
    const yl = [...document.querySelectorAll('.tlrow--year .tlrow__label')].map(x => x.textContent.trim());
    const sticky = getComputedStyle(document.querySelector('.tlrow__label')).position;
    const cells = [...document.querySelectorAll('#corridorTrack .tlcell.has')];
    return {
      monthCells: m.length,
      visibleMonths: vis.map(x => x.textContent.trim()).slice(0, 6),
      yearLabels: yl, sticky,
      cellCount: cells.length,
      hasMonthPrefix: cells.some(c => /\\d+\\/\\d+/.test(c.textContent)),
      sampleCell: cells[0] ? cells[0].textContent.trim() : null
    };
  `);
  log(tl.monthCells >= 12, "有月份刻度行", tl.monthCells + " 格");
  log(tl.visibleMonths.length > 0, "滚动位置能看到月份", JSON.stringify(tl.visibleMonths));
  log(tl.sticky === "sticky", "年份标签粘性定位（滚动时保持可见）", tl.sticky);
  log(tl.yearLabels.length >= 1, "年份标签存在", JSON.stringify(tl.yearLabels));
  await shot("09-timeline-final.png");

  /* 放大后带日期前缀 */
  await inject(`const z=document.querySelector('#tlZoom'); z.value='4'; z.dispatchEvent(new Event('input')); return null;`);
  await sleep(700);
  const tl4 = await inject(`return {
    sample: [...document.querySelectorAll('#corridorTrack .tlcell.has')].map(c=>c.textContent.trim()),
    mdPrefix: [...document.querySelectorAll('#corridorTrack .tlcell.has .md')].map(x=>x.textContent)
  };`);
  log(tl4.mdPrefix.length > 0, "放大后节点带「月/日」前缀", JSON.stringify(tl4.mdPrefix));
  await shot("10-timeline-zoom4.png");

  /* 移动端 */
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await goto(url);
  await sleep(1600);
  const mob = await inject(`
    return {
      hasHScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
      sidebarOffscreen: document.querySelector('.side').getBoundingClientRect().right <= 1,
      docSize: getComputedStyle(document.querySelector('.doc')).fontSize,
      readerW: Math.round(document.querySelector('.reader__inner').getBoundingClientRect().width),
      tabs: [...document.querySelectorAll('.tab:not([hidden])')].map(t=>t.textContent)
    };
  `);
  log(!mob.hasHScroll, "移动端无横向溢出", `${mob.scrollW}/${mob.clientW}`);
  log(mob.sidebarOffscreen, "移动端侧栏默认收起");
  log(mob.readerW >= 340, "移动端正文占满宽度", mob.readerW + "px");
  await shot("11-mobile.png");

  const fail = T.filter(x => !x).length;
  console.log(`\n通过 ${T.length - fail} · 失败 ${fail}`);
  if (fail) process.exitCode = 1;
}
