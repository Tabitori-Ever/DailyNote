/** 界面验收：风格 / 阅读区 / 侧栏无弹窗切换 / 各标签页 / 编辑器 */
const T = [];
const log = (ok, label, extra = "") => {
  T.push({ ok, label });
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? "  → " + extra : ""}`);
};

export default async function run(api, { url }) {
  const { goto, inject, click, shot, sleep, sendKey } = api;

  await goto(url);
  await sleep(1200);
  await inject(`localStorage.clear(); return null;`);
  await goto(url);
  await sleep(1600);

  /* ── 1. 基础渲染 ── */
  const base = await inject(`
    const doc = document.querySelector('.doc');
    const cs = doc ? getComputedStyle(doc) : null;
    return {
      title: document.querySelector('.masthead__title')?.textContent,
      date: document.querySelector('.masthead__date')?.textContent,
      meta: document.querySelector('.masthead__meta')?.textContent.replace(/\\s+/g,' ').trim(),
      docFontSize: cs?.fontSize, docLineHeight: cs?.lineHeight, docFontFamily: cs?.fontFamily?.slice(0,30),
      readerWidth: Math.round(document.querySelector('.reader__inner')?.getBoundingClientRect().width || 0),
      viewWidth: Math.round(document.querySelector('#view-diary')?.getBoundingClientRect().width || 0),
      sidebarWidth: Math.round(document.querySelector('.side')?.getBoundingClientRect().width || 0),
      docText: doc?.textContent.replace(/\\s+/g,' ').trim().slice(0, 90),
      hasMigration: /迁移说明/.test(document.body.textContent),
      hasOneNote: /OneNote/.test(document.body.textContent),
      strongCount: doc?.querySelectorAll('strong').length ?? -1,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      barBorder: getComputedStyle(document.querySelector('.bar')).borderBottomColor
    };
  `);
  log(base.title === "网空与信支宣讲会 · 保研复试" || !!base.title, "读到日记标题", base.title);
  log(parseFloat(base.docFontSize) >= 17, "正文字号已放大（≥17px）", base.docFontSize);
  log(base.readerWidth >= 900, "阅读栏已加宽（≥900px）", base.readerWidth + "px / 视图 " + base.viewWidth);
  log(base.sidebarWidth > 0 && base.sidebarWidth <= 280, "侧栏收窄给正文让位", base.sidebarWidth + "px");
  log(!base.hasMigration && !base.hasOneNote, "正文区不再有迁移说明 / OneNote 字样");
  log(base.strongCount === 0, "不再自作主张加粗（strong 数 = 0）", "strong=" + base.strongCount);

  /* ── 2. 无渐变 + 直角 + 单一强调色 ── */
  const style = await inject(`
    const bad = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundImage;
      if (bg && bg !== 'none' && /gradient/i.test(bg)) bad.push(el.tagName + '.' + (el.className||'').toString().slice(0,30));
      if (cs.backgroundImage && /radial-gradient|conic-gradient/i.test(cs.backgroundImage)) bad.push('radial:' + el.tagName);
    }
    const radii = new Set();
    for (const el of document.querySelectorAll('.btn, .panel, .inp, .tab, .cal__c')) {
      radii.add(getComputedStyle(el).borderRadius);
    }
    return { gradients: [...new Set(bad)].slice(0, 12), gradientCount: bad.length, radii: [...radii] };
  `);
  log(style.gradientCount === 0, "全站没有渐变背景", JSON.stringify(style.gradients));
  log(style.radii.every(r => parseFloat(r) <= 4), "直角风格（圆角 ≤4px）", JSON.stringify(style.radii));

  /* ── 3. 侧栏日历：不弹窗直接切换日期 ── */
  const before = await inject(`return document.querySelector('.masthead__date')?.textContent || '';`);
  await inject(`
    // 切到 2025-09 并点 9 号
    S.sideY = 2025; S.sideM = 9; renderSideCal();
    const c = document.querySelector('[data-scal="2025-09-09"]');
    c.click();
    return null;
  `);
  await sleep(900);
  const after = await inject(`
    return {
      date: document.querySelector('.masthead__date')?.textContent,
      title: document.querySelector('.masthead__title')?.textContent,
      pickOpen: !document.querySelector('#mPick').hidden,
      editOpen: !document.querySelector('#mEdit').hidden
    };
  `);
  log(after.date && after.date.startsWith("2025-09-09"), "侧栏点击直接切换日记", after.date);
  log(after.title === "桑榆下", "切换到了正确的那一篇", after.title);
  log(!after.pickOpen && !after.editOpen, "★ 侧栏切换不触发任何弹窗");

  /* ── 4. 点无记录日期：也不弹窗，只提示 ── */
  await inject(`
    S.sideY = 2025; S.sideM = 9; renderSideCal();
    document.querySelector('[data-scal="2025-09-20"]').click();
    return null;
  `);
  await sleep(400);
  const noRec = await inject(`return {
    pickOpen: !document.querySelector('#mPick').hidden,
    toast: document.querySelector('#toastHost')?.textContent.trim(),
    dateUnchanged: (document.querySelector('.masthead__date')||{}).textContent
  };`);
  log(!noRec.pickOpen, "★ 点无记录日期同样不弹窗");
  log(/没有日记/.test(noRec.toast || ""), "给出文字提示", noRec.toast);
  log((noRec.dateUnchanged || "").startsWith("2025-09-09"), "正文保持在原来那篇");

  /* ── 5. 只有顶栏按钮打开日期检索弹窗 ── */
  await click("#btnPick");
  await sleep(700);
  const pick = await inject(`
    const g = document.querySelectorAll('#pkGrid .pick__c');
    const no = [...g].filter(x => x.classList.contains('no'));
    const has = [...g].filter(x => x.classList.contains('has'));
    return {
      open: !document.querySelector('#mPick').hidden && document.querySelector('#mPick').classList.contains('open'),
      label: document.querySelector('#pkLabel')?.textContent,
      sub: document.querySelector('#mPickS')?.textContent,
      total: g.length, noCount: no.length, hasCount: has.length,
      noCursor: no[0] ? getComputedStyle(no[0]).cursor : null,
      hasDates: has.map(x => x.dataset.pk)
    };
  `);
  log(pick.open, "顶栏「日期检索」打开弹窗");
  log(pick.hasCount >= 1 && pick.noCount > 20, "有记录 / 无记录日期区分", `has=${pick.hasCount} no=${pick.noCount}`);
  log(pick.noCursor === "not-allowed", "无记录日期不可选（not-allowed）", pick.noCursor);
  await shot("01-pick.png");

  /* 键盘导航 */
  const c0 = await inject(`return S.pickCursor || '';`);
  await sendKey("ArrowRight");
  await sleep(200);
  const c1 = await inject(`return S.pickCursor || '';`);
  log(c1 && c1 !== c0, "日期弹窗方向键可移动", `${c0} → ${c1}`);
  await sendKey("Escape");
  await sleep(400);
  log(await inject(`return document.querySelector('#mPick').hidden;`), "Esc 关闭弹窗");

  /* ── 6. 时间线走廊 ── */
  await click('.tab[data-nav="timeline"]');
  await sleep(900);
  const tl = await inject(`
    const cells = [...document.querySelectorAll('#corridorTrack .tlcell.has')];
    const rows = [...document.querySelectorAll('#corridorTrack .tlrow--year')];
    const labels = [...document.querySelectorAll('#corridorTrack .tlrow__label')].map(x=>x.textContent).filter(Boolean);
    const box = document.querySelector('#corridor');
    return {
      visible: !document.querySelector('#view-timeline').hidden,
      cellCount: cells.length, rowCount: rows.length, labels,
      scrollWidth: box.scrollWidth, clientWidth: box.clientWidth,
      scrollLeft: box.scrollLeft,
      cursor: getComputedStyle(box).cursor,
      cellTexts: cells.map(c => c.textContent.trim())
    };
  `);
  log(tl.visible && tl.cellCount >= 2, "时间线渲染出节点", `${tl.cellCount} 节点 / ${tl.rowCount} 年`);
  log(tl.scrollWidth > tl.clientWidth, "走廊可横向滚动", `${tl.scrollWidth} > ${tl.clientWidth}`);
  log(tl.scrollLeft > 0, "自动居中到当前日期", "scrollLeft=" + tl.scrollLeft);
  log(tl.cursor === "grab", "可拖动（grab 光标）", tl.cursor);
  await shot("02-timeline.png");

  /* 缩放 */
  await inject(`const z=document.querySelector('#tlZoom'); z.value='3'; z.dispatchEvent(new Event('input')); return null;`);
  await sleep(600);
  const tl2 = await inject(`return {
    texts: [...document.querySelectorAll('#corridorTrack .tlcell.has')].map(c=>c.textContent.trim()),
    scrollWidth: document.querySelector('#corridor').scrollWidth
  };`);
  log(tl2.texts.some(t => t.length > 3), "放大后显示关键词", JSON.stringify(tl2.texts));
  await shot("03-timeline-zoom.png");

  /* ── 7. 记账子系统（默认隐藏 → 开启） ── */
  const ledHidden = await inject(`return document.querySelector('.tab[data-nav="ledger"]').hidden;`);
  log(ledHidden === true, "记账默认在顶栏隐藏");
  await click('.tab[data-nav="settings"]');
  await sleep(600);
  await click("#setLedger");
  await sleep(700);
  const ledShown = await inject(`return document.querySelector('.tab[data-nav="ledger"]').hidden;`);
  log(ledShown === false, "设置里可开启记账入口");

  await click('.tab[data-nav="ledger"]');
  await sleep(700);
  const led = await inject(`
    return {
      visible: !document.querySelector('#view-ledger').hidden,
      label: document.querySelector('#ledLabel').textContent,
      sumIn: document.querySelector('#sumIn').textContent,
      allTime: document.querySelector('#ledAllTime').textContent,
      rows: document.querySelectorAll('#ledBody tr').length
    };
  `);
  log(led.visible, "记账页可打开", led.label);
  log(/累计/.test(led.allTime || ""), "显示累计收支", led.allTime);
  await shot("04-ledger.png");
  await click('.tab[data-nav="settings"]');
  await sleep(500);
  await click("#setLedger");
  await sleep(600);

  /* ── 8. 编辑器 ── */
  await click("#btnNew");
  await sleep(700);
  const ed = await inject(`
    return {
      open: !document.querySelector('#mEdit').hidden,
      title: document.querySelector('#mEditT').textContent,
      date: document.querySelector('#edDate').value,
      body: document.querySelector('#edBody').value,
      tools: [...document.querySelectorAll('#edTools .btn')].map(b=>b.title),
      moods: document.querySelectorAll('#edMoods .mood').length,
      templates: [...document.querySelectorAll('#edTpl .btn')].map(b=>b.textContent)
    };
  `);
  log(ed.open, "编辑器可打开", ed.title);
  log(/事件/.test(ed.body) && /爱好/.test(ed.body) && /生活/.test(ed.body), "默认套用「事件/爱好/生活」模板");
  log(ed.tools.length >= 10, "工具栏含完整 MD 功能", ed.tools.length + " 项");
  log(ed.moods >= 6, "有心情表情可选", ed.moods + " 个");
  log(ed.templates.length >= 1, "模板列表可用", JSON.stringify(ed.templates));

  /* 实际写一篇并验证落盘 */
  const testDate = "1998-12-31";
  await inject(`
    document.querySelector('#edDate').value = '${testDate}';
    document.querySelector('#edTitle').value = '界面自测条目';
    document.querySelector('#edBody').value = '## 事件\\n\\n这是 **加粗** 与 <u>下划线</u>。\\n\\n- 一\\n- 二\\n';
    Ed.tags.push('自测'); Ed.mood = S.moods[0]; Ed.renderTags(); Ed.renderMoods();
    return null;
  `);
  await click("#edSave");
  await sleep(1800);
  const saved = await inject(`
    return {
      editClosed: document.querySelector('#mEdit').hidden,
      title: document.querySelector('.masthead__title')?.textContent,
      date: document.querySelector('.masthead__date')?.textContent,
      mood: document.querySelector('.masthead__mood')?.textContent,
      hasStrong: !!document.querySelector('.doc strong'),
      hasUnderline: !!document.querySelector('.doc u'),
      meta: document.querySelector('.masthead__meta')?.textContent.replace(/\\s+/g,' ').trim()
    };
  `);
  log(saved.editClosed, "保存后编辑器关闭");
  log(saved.title === "界面自测条目" && saved.date.startsWith(testDate), "新日记已写入并跳转", saved.date);
  log(saved.hasStrong && saved.hasUnderline, "加粗与下划线渲染正确");
  log(/写于 /.test(saved.meta || ""), "显示创建时间", saved.meta);

  /* 收藏夹：验证文件真的存在 */
  const fileCheck = await fetch(url.replace(/\/$/, "") + "/api/entries/" + testDate).then(r => r.json());
  log(fileCheck.title === "界面自测条目", "服务端文件已落盘", fileCheck.title);
  log(!!fileCheck.created && !!fileCheck.updated, "created / updated 已记录");

  /* 编辑已有：时间戳应更新 */
  await sleep(1100);
  await click("#dayEdit");
  await sleep(600);
  await inject(`document.querySelector('#edTitle').value='界面自测条目v2'; return null;`);
  await click("#edSave");
  await sleep(1600);
  const v2 = await fetch(url.replace(/\/$/, "") + "/api/entries/" + testDate).then(r => r.json());
  log(v2.title === "界面自测条目v2", "编辑已有日记生效");
  log(new Date(v2.updated) > new Date(fileCheck.updated), "最后编辑时间已刷新");

  /* 删除：真正走界面按钮（confirm 先打桩），并验证游标不残留 */
  await inject(`window.confirm = () => true; return null;`);
  const delBefore = await inject(`return { date: S.currentDate, inList: S.entries.some(e => e.date === '${testDate}') };`);
  await click("#dayEdit");
  await sleep(600);
  await click("#edDelete");
  await sleep(1800);
  const delAfter = await inject(`
    return {
      stillInList: S.entries.some(e => e.date === '${testDate}'),
      currentDate: S.currentDate,
      currentIsNull: S.current === null,
      staleCell: !!document.querySelector('[data-scal="${testDate}"].cur'),
      readerBlank: !!document.querySelector('.blank')
    };
  `);
  log(delBefore.inList && !delAfter.stillInList, "界面删除生效", `${delBefore.date} 已移除`);
  log(delAfter.currentDate === "" && delAfter.currentIsNull, "★ 删除后清空当前游标", JSON.stringify(delAfter));
  log(!delAfter.staleCell, "日历不再把已删日期标为当前");
  const delApi = await fetch(url.replace(/\/$/, "") + "/api/entries/" + testDate).then(r => r.status);
  log(delApi === 404, "文件已从磁盘删除");

  /* ── 9. 设置：阅读器即时生效 ── */
  // 上一步删掉了测试日记，先重新打开一篇真实日记，否则没有正文可测
  await inject(`
    (async () => { if (!S.current && S.entries.length) await openEntry(S.entries[0].date); return null; })()
  `);
  await sleep(800);
  await click('.tab[data-nav="settings"]');
  await sleep(600);
  await inject(`
    const s = document.querySelector('#setSize');
    s.value = '24'; s.dispatchEvent(new Event('input'));
    const w = document.querySelector('#setWidth');
    w.value = '1200'; w.dispatchEvent(new Event('input'));
    const l = document.querySelector('#setLh');
    l.value = '2.4'; l.dispatchEvent(new Event('input'));
    return null;
  `);
  await sleep(400);
  await click('.tab[data-nav="diary"]');
  await sleep(700);
  const rd = await inject(`
    const doc = document.querySelector('.doc');
    const cs = doc ? getComputedStyle(doc) : null;
    return { size: cs?.fontSize, lh: cs?.lineHeight, width: Math.round(document.querySelector('.reader__inner').getBoundingClientRect().width) };
  `);
  log(rd.size === "24px", "阅读器字号可调", rd.size);
  log(Math.abs(parseFloat(rd.lh) - 2.4 * 24) < 2, "行距可调", rd.lh);
  log(rd.width >= 1100, "栏宽可调", rd.width + "px");

  /* 衬线 */
  await click('.tab[data-nav="settings"]'); await sleep(400);
  await click("#setSerif"); await sleep(500);
  await click('.tab[data-nav="diary"]'); await sleep(600);
  const serif = await inject(`return getComputedStyle(document.querySelector('.doc')).fontFamily;`);
  log(/^"?Source Han Serif/i.test(serif), "衬线正文字体可切换", serif.slice(0, 34));

  /* ── 10. 纪念日特殊显示（走真实流程：写配置 → reloadAll → 渲染） ── */
  const annivAdded = await inject(`
    (async () => {
      // 先把光标切到 2026-09-18 这一篇，纪念日就挂在它上面
      const hasFirst = S.entries.some(e => e.date === '2026-09-18');
      const key = hasFirst ? '2026-09-18' : S.entries[0].date;
      await openEntry(key);
      const anns = [{ id:'test-anniv', title:'自测纪念日', date: key, repeat:'yearly' }];
      await fetch('/api/config', { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ anniversaries: anns }) });
      await reloadAll();
      await openEntry(key);
      const d = new Date(key + 'T00:00:00');
      S.sideY = d.getFullYear(); S.sideM = d.getMonth() + 1;
      renderSideCal();
      const c = document.querySelector('[data-scal="' + key + '"]');
      return {
        key,
        cls: c ? c.className : null,
        title: c ? c.title : null,
        masthead: (document.querySelector('.masthead__anniv')||{}).textContent || null,
        sidebar: document.querySelector('#sideAnniv').textContent.trim(),
        annivOn: JSON.stringify(annivOn(key))
      };
    })()
  `);
  log(/anniv/.test(annivAdded.cls || ""), "★ 纪念日在侧栏日历特殊标记", `${annivAdded.key} → ${annivAdded.cls}`);
  log(/自测纪念日/.test(annivAdded.title || ""), "纪念日出现在日历提示里");
  log(/自测纪念日/.test(annivAdded.sidebar || ""), "纪念日出现在侧栏列表");
  log(/自测纪念日/.test(annivAdded.masthead || ""), "日记页标题栏显示纪念日", annivAdded.masthead);

  /* 清理纪念日配置 */
  await inject(`
    (async () => {
      await fetch('/api/config', { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ anniversaries: [] }) });
      await reloadAll();
    })()
  `);
  await sleep(500);

  await inject(`S.sideY=2026; S.sideM=9; renderSideCal(); return null;`);
  await sleep(400);
  await shot("05-calendar-anniv.png");

  /* ── 11. 明暗主题 ── */
  await click("#btnTheme");
  await sleep(500);
  const dark = await inject(`return { dark: document.documentElement.dataset.dark === '1', bg: getComputedStyle(document.body).backgroundColor };`);
  log(dark.dark === true, "深色主题可切换", dark.bg);
  await shot("06-dark.png");
  await click("#btnTheme");
  await sleep(400);

  /* ── 12. 复原测试期间改动的配置，并收尾截图 ── */
  await inject(`
    (async () => {
      await fetch('/api/config', { method:'PUT', headers:{'content-type':'application/json'},
        body: JSON.stringify({
          reader: { fontSize: 18, lineHeight: 1.9, width: 960, serif: false },
          anniversaries: [],
          ledgerEnabled: false
        }) });
      await reloadAll();
      S.sideY=2026; S.sideM=9; renderSideCal();
      if (!S.current && S.entries.length) await openEntry(S.entries[0].date);
      return null;
    })()
  `);
  await sleep(800);
  await shot("07-final-reader.png");

  const restored = await inject(`
    const r = S.reader;
    return { size: r.fontSize, lh: r.lineHeight, width: r.width, serif: r.serif,
             anniv: S.anniversaries.length,
             ledgerHidden: document.querySelector('.tab[data-nav="ledger"]').hidden,
             docSize: document.querySelector('.doc') ? getComputedStyle(document.querySelector('.doc')).fontSize : null };
  `);
  log(restored.size === 18 && restored.width === 960 && !restored.serif, "测试后阅读器配置已复原", JSON.stringify(restored));
  log(restored.anniv === 0, "测试后纪念日配置已清空");
  log(restored.ledgerHidden === true, "测试后记账入口复原为隐藏");

  const fail = T.filter(x => !x.ok).length;
  console.log(`\n通过 ${T.length - fail} · 失败 ${fail}`);
  if (fail) process.exitCode = 1;
}
