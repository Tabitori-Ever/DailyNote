/** 顶栏布局与图标验收 */
const T = [];
const log = (ok, label, extra = "") => { T.push(ok); console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? "  → " + extra : ""}`); };

export default async function run(api, { url }) {
  const { goto, inject, shot, sleep } = api;

  await goto(url);
  await sleep(1500);

  const bar = await inject(`
    const b = document.querySelector('.bar');
    const r = b.getBoundingClientRect();
    const kids = [...b.children].map(k => {
      const kr = k.getBoundingClientRect();
      return { cls: k.className.split(' ')[0], left: Math.round(kr.left), right: Math.round(kr.right), w: Math.round(kr.width) };
    });
    return {
      barW: Math.round(r.width),
      barH: Math.round(r.height),
      kids,
      overflow: b.scrollWidth > b.clientWidth + 1,
      scrollW: b.scrollWidth,
      clientW: b.clientWidth,
      docHScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  `);
  log(!bar.overflow, "顶栏无内容溢出", `scrollW=${bar.scrollW} clientW=${bar.clientW}`);
  log(!bar.docHScroll, "页面无横向滚动");
  log(bar.barH >= 50 && bar.barH <= 60, "顶栏高度正常", bar.barH + "px");

  const acts = await inject(`
    const a = document.querySelector('.bar__acts');
    const btns = [...a.querySelectorAll('.btn')].map(b => {
      const r = b.getBoundingClientRect();
      return { id: b.id, title: b.title, w: Math.round(r.width), visible: r.width > 0 && r.height > 0 };
    });
    return { btns, total: Math.round(a.getBoundingClientRect().width) };
  `);
  log(acts.btns.length >= 4, "顶栏动作按钮齐全", acts.btns.map(b => b.id).join(", "));
  log(acts.btns.every(b => b.visible), "所有按钮可见");
  const quit = acts.btns.find(b => b.id === "btnQuit");
  log(!!quit && quit.visible, "退出按钮在顶栏可见", quit ? `${quit.w}px` : "缺失");

  /* 退出按钮不遮挡其它控件 */
  const clash = await inject(`
    const ids = ['btnPick','btnNew','btnTheme','btnQuit'];
    const rects = ids.map(id => { const el = document.getElementById(id); return el ? el.getBoundingClientRect() : null; });
    const bad = [];
    for (let i = 0; i < rects.length; i++) for (let j = i+1; j < rects.length; j++) {
      if (!rects[i] || !rects[j]) continue;
      const ox = Math.min(rects[i].right, rects[j].right) - Math.max(rects[i].left, rects[j].left);
      const oy = Math.min(rects[i].bottom, rects[j].bottom) - Math.max(rects[i].top, rects[j].top);
      if (ox > 1 && oy > 1) bad.push(ids[i] + '∩' + ids[j]);
    }
    return bad;
  `);
  log(clash.length === 0, "按钮之间不重叠", JSON.stringify(clash));

  /* 动态导入的图标尺寸 */
  const icon = await inject(`
    (async () => {
      const out = {};
      const ico = await fetch('/assets/icons/diary.ico');
      out.icoOk = ico.ok;
      out.icoType = ico.headers.get('content-type');
      out.icoBytes = (await ico.blob()).size;
      const links = [...document.querySelectorAll('link[rel*="icon"]')].map(l => l.href);
      out.links = links;
      // 逐个试探图标是否真的能加载
      out.loadable = await Promise.all(links.map(href => new Promise(res => {
        const i = new Image();
        i.onload = () => res({ href: href.split('/').pop(), ok: true });
        i.onerror = () => res({ href: href.split('/').pop(), ok: false });
        i.src = href;
      })));
      return out;
    })()
  `);
  log(icon.icoOk && icon.icoBytes > 1000, "ICO 可加载", icon.icoBytes + " bytes");
  log(icon.loadable.every(l => l.ok), "所有图标链接可加载", JSON.stringify(icon.loadable));

  await shot("14-toolbar.png");
  await inject(`document.querySelector('#btnTheme').click(); return null;`);
  await sleep(500);
  await shot("15-toolbar-dark.png");

  const fail = T.filter(x => !x).length;
  console.log(`\n通过 ${T.length - fail} · 失败 ${fail}`);
  if (fail) process.exitCode = 1;
}
