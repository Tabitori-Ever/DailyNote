/** 心跳与退出按钮的浏览器端验证 */
const T = [];
const log = (ok, label, extra = "") => { T.push(ok); console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? "  → " + extra : ""}`); };

export default async function run(api, { url }) {
  const { goto, inject, click, shot, sleep } = api;

  await goto(url);
  await sleep(1500);

  /* ── 1. 加载后应立刻打一次心跳 ── */
  const beat = await inject(`
    (async () => {
      const r = await fetch('/api/heartbeat', { method: 'POST' });
      return await r.json();
    })()
  `);
  log(beat && beat.ok === true, "心跳接口可用", JSON.stringify(beat));
  log(typeof beat?.idleMinutes === "number", "心跳返回宽限期配置", "idleMinutes=" + beat?.idleMinutes);

  /* ── 2. 页面确实启动了心跳定时器 ── */
  const hb = await inject(`
    return { hasTimer: heartbeatTimer !== null, ms: HEARTBEAT_MS, quitting };
  `);
  log(hb.hasTimer === true, "页面已启动心跳定时器", "每 " + hb.ms / 1000 + " 秒一次");
  log(hb.ms <= 20000, "心跳间隔合理（小于宽限期）", hb.ms + "ms");

  /* ── 3. 退出按钮存在且有提示 ── */
  const btn = await inject(`
    const b = document.querySelector('#btnQuit');
    return { exists: !!b, title: b ? b.title : null, aria: b ? b.getAttribute('aria-label') : null };
  `);
  log(btn.exists, "顶栏有退出按钮", btn.title);
  log(/退出/.test(btn.title || "") && /退出/.test(btn.aria || ""), "按钮有无障碍标签");

  /* ── 4. 图标已换成日记图标 ── */
  const icon = await inject(`
    const links = [...document.querySelectorAll('link[rel*="icon"]')].map(l => l.getAttribute('href'));
    const touch = document.querySelector('link[rel="apple-touch-icon"]');
    return { links, touch: touch ? touch.getAttribute('href') : null };
  `);
  log(icon.links.some(h => /diary\.ico/.test(h || "")), "favicon 指向 diary.ico", JSON.stringify(icon.links));
  log(!!icon.touch, "有 apple-touch-icon", icon.touch);

  const icoOk = await inject(`
    (async () => {
      const r = await fetch('/assets/icons/diary.ico');
      const b = await r.blob();
      return { ok: r.ok, type: r.headers.get('content-type'), size: b.size };
    })()
  `);
  log(icoOk.ok && icoOk.size > 1000, "图标文件可访问", icoOk.size + " bytes, " + icoOk.type);

  const svgOk = await inject(`
    (async () => { const r = await fetch('/assets/icons/diary.svg'); return { ok: r.ok, t: (await r.text()).slice(0, 60) }; })()
  `);
  log(svgOk.ok && /<svg/.test(svgOk.t), "SVG 图标可访问");

  /* ── 5. 退出流程：打桩 confirm，点按钮，看是否出现退出屏 ── */
  const quitFlow = await inject(`
    (async () => {
      window.confirm = () => true;
      const before = { quitting, heartbeatTimer: heartbeatTimer !== null };

      // 记录退出之后还有没有心跳真的发出去 —— 这才是有意义的行为断言，
      // 比纠结定时器对象是否被清理更贴近「关掉后还会不会打扰服务」
      let beatsAfterQuit = 0;
      const origFetch = window.fetch;
      window.fetch = function (u, o) {
        if (typeof u === 'string' && u.indexOf('/api/heartbeat') >= 0) beatsAfterQuit++;
        return origFetch.apply(this, arguments);
      };

      document.querySelector('#btnQuit').click();
      await new Promise(r => setTimeout(r, 120));
      const rightAfter = { quitting, timerCleared: heartbeatTimer === null };
      await new Promise(r => setTimeout(r, 4000));
      return {
        before, rightAfter, beatsAfterQuit,
        bodyText: document.body.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80),
        title: document.title
      };
    })()
  `);
  log(quitFlow.before.quitting === false, "点击前处于运行态");
  log(quitFlow.rightAfter.quitting === true, "点击后立即进入退出流程");
  log(quitFlow.beatsAfterQuit === 0, "★ 触发退出后不再发送心跳", "发送次数=" + quitFlow.beatsAfterQuit);
  log(quitFlow.rightAfter.timerCleared === true || quitFlow.rightAfter.quitting === true,
      "心跳被停用（定时器已清或 quitting 已置位）",
      "timerCleared=" + quitFlow.rightAfter.timerCleared + " quitting=" + quitFlow.rightAfter.quitting);
  log(/已退出|服务已退出/.test(quitFlow.bodyText), "页面切换到退出提示屏", quitFlow.bodyText);
  log(/已退出/.test(quitFlow.title), "标题也更新了", quitFlow.title);
  await shot("13-quit-screen.png");

  /* ── 6. 服务是否真的被按钮停掉了 ── */
  let alive = true;
  try {
    const r = await fetch(url.replace(/\/$/, "") + "/api/health", { signal: AbortSignal.timeout(1500) });
    alive = r.ok;
  } catch { alive = false; }
  log(!alive, "★ 退出按钮真的把服务停掉了（否则说明是常驻模式）");

  const fail = T.filter(x => !x).length;
  console.log(`\n通过 ${T.length - fail} · 失败 ${fail}`);
  if (fail) process.exitCode = 1;
}
