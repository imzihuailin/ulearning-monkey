// ==UserScript==
// @name         优学院自动刷课助手
// @namespace    local.ulearning-auto
// @version      1.4.0
// @description  自动播放视频课程、自动翻页、自动处理"离开太久"/未完成弹窗。只刷视频与翻页，不答题。
// @author       you
// @match        *://ua.ulearning.cn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * 选择器及数据模型均对照线上代码 (learnCourse, version=2608204) 校验：
 *   pageView.html     : .video-element / .video-info / span[i18nMessageText().finished]（viewProgress>=95% 才渲染）
 *   learnCourse.html  : .btn-tip span[i18nMessageText().nextPage] / i18nMessageText().incompleteChapter[/2]
 *                       button.btn-hollow[click: closeStatPage | text: i18nMsgText().confirmLeave]
 *                       span[i18nMsgText().walkingTooLong] + button.btn-submit[text: i18nMsgText().continueStudy]
 *   mediaelement      : classPrefix = "mejs__"，覆盖层按钮 = div.mejs__overlay-button[role=button][aria-label="播放"]
 *   进度/目录数据      : window.koLearnCourseViewModel.course
 *                       .chapters()[i].sections()[j].pages()[k]；page.record().status() 1=该页已完成
 *                       （learnCourseViewModel.js 里 convertPageId() 就是这么遍历的；pageViewModel.js 也用
 *                        window.koLearnCourseViewModel，说明它挂在 window 上）
 *
 * 倍速为什么能直接提速（pageViewModel.js timeupdateHandler）：
 *   addTime = currentTime - startTime;  viewTime += addTime;  viewProgress = viewTime*100/duration
 *   进度累加的是"播放位置的变化量"，不是真实挂钟 -> 倍速线性生效，拖进度条无效。
 * 倍速上限由平台自己的防拖拽逻辑卡死：
 *   if (currentTime - startTime > 5) { currentTime = startTime; return; }   // 单次 timeupdate 跳跃 >5s 就回退
 *   即 倍速 × timeupdate间隔 必须 < 5s（前台约 0.25s -> 理论 ~20x；浏览器 playbackRate 封顶 16x）。
 *   超过阈值不是变慢而是原地死循环，故本脚本带自适应降速（回退或停滞就自动对半降档）。
 * 判定"已看完"的标准是服务端记录 viewProgress() >= 95%，不是 100%。
 */

(function () {
  'use strict';

  // ================= 配置区 =================
  const CONFIG = {
    playbackRate: 8,          // 默认倍速（面板可选 1/1.5/2/4/8/16）
    maxRate: 16,              // 浏览器 playbackRate 实际上限
    minRate: 1,               // 自适应降速的下限
    autoBackoff: true,        // 撞到防拖拽/停滞时自动降速
    pollInterval: 600,        // 视频轮询间隔（毫秒）
    stallBackoffAt: 15,       // 连续停滞 N 秒自动降一档
    noProgressLimit: 150,     // 单个视频连续 N 秒无进度则放弃该视频
    metaWaitLimit: 20,        // 视频元数据（duration）最多等 N 秒，超过才判定不可播
    textPageWait: 3000,       // 非视频页（PPT/文档）停留毫秒（这类页可能按时长计学分，别调太低）
    modalPollMs: 150,         // 翻页后查弹窗的间隔
    cleanGraceMs: 600,        // 观察这么久还没弹窗就认定是正常翻页，立刻继续
    modalWaitMs: 1800,        // 弹窗观察上限
    maxSamePage: 4,           // 连续 N 次翻页后页面仍无变化 -> 判定没有更多内容，退出
    maxLoops: 800,            // 全局翻页次数上限
    progressRefreshMs: 2000,  // 进度条刷新间隔
    assumedVideoSec: 480,     // 未探明长度的视频按 8 分钟估算（会随实测自动修正）
    perPageOverheadMs: 1200,  // 每页翻页/弹窗开销估算
    autoCloseTab: false,      // 完成后尝试自动关闭标签页（多数浏览器会拦截，默认关）
  };

  const SEL = {
    videoEl: '.video-element',
    mejsContainer: '.mejs__container',
    playBtn: (id) => `#${id} .mejs__overlay-button[aria-label="播放"]`,
    videoInfo: '.video-info',
    finishedSpan: 'span[data-bind="text: $root.i18nMessageText().finished"]',
    nextPage: '.btn-tip span[data-bind="text: i18nMessageText().nextPage"]',
    walkingTooLong: 'span[data-bind="text: $root.i18nMsgText().walkingTooLong"]',
    continueStudy: 'button.btn-submit[data-bind="text: $root.i18nMsgText().continueStudy"]',
    questionsNotCompleted: 'span[data-bind="text: $root.i18nMsgText().questionsNotCompleted"]',
    confirmLeave: 'button.btn-hollow[data-bind="text: $root.i18nMsgText().confirmLeave"]',
    incompleteChapter: 'span[data-bind="text: i18nMessageText().incompleteChapter"]',
    incompleteChapter2: 'span[data-bind="text: i18nMessageText().incompleteChapter2"]',
    goNextPage: 'button.btn-hollow[data-bind="click: goNextPage"]',
    closeStatPage: 'button.btn-hollow[data-bind="click: closeStatPage"]',
  };

  // ================= 工具 =================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitForElement(selector, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(300);
    }
    return null;
  }

  function modalVisible(selector) {
    const el = document.querySelector(selector);
    return !!(el && el.offsetParent !== null);
  }

  function handleModal(selector, action, msg) {
    if (modalVisible(selector)) { log(msg); action(); return true; }
    return false;
  }

  function click(selector) {
    const el = document.querySelector(selector);
    if (el) { el.click(); return true; }
    return false;
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    if (h > 0) return `${h} 小时 ${m} 分`;
    if (m > 0) return `${m} 分钟`;
    return `${Math.max(1, sec)} 秒`;
  }

  // ================= 状态 =================
  let running = false;
  let paused = false;
  let desiredRate = CONFIG.playbackRate;   // 面板选定的目标倍速
  let effectiveRateSeen = 0;               // 最近一次实际生效的倍速（自适应降档后更低）
  let seenVideoSec = 0;                    // 已实测的视频总时长，用于估算平均值
  let seenVideoCount = 0;
  let progressTimer = null;

  // ================= 课程总进度（读平台自己的数据模型）=================
  function pageDone(pg) {
    try {
      const r = pg.record && pg.record();
      return !!(r && r.status && r.status());
    } catch (e) { return false; }
  }

  function readCourseStats() {
    try {
      const vm = window.koLearnCourseViewModel;
      const course = vm && vm.course;
      if (!course || typeof course.chapters !== 'function') return null;
      const pages = [];
      const chapters = course.chapters() || [];
      for (const ch of chapters) {
        if (ch.isHide && ch.isHide()) continue;
        const sections = (typeof ch.sections === 'function' ? ch.sections() : []) || [];
        for (const sec of sections) {
          if (sec.isHide && sec.isHide()) continue;
          const ps = (typeof sec.pages === 'function' ? sec.pages() : []) || [];
          for (const pg of ps) {
            if (pg.isHide && pg.isHide()) continue;
            pages.push(pg);
          }
        }
      }
      if (!pages.length) return null;
      let done = 0;
      for (const pg of pages) if (pageDone(pg)) done++;
      return { total: pages.length, done, pages };
    } catch (e) { return null; }
  }

  // 剩余时间：已知时长的视频按实测值，未知的按平均值补，再加上翻页开销
  function estimateRemainingSec(stats) {
    if (!stats) return null;
    const rate = effectiveRateSeen > 0
      ? Math.max(CONFIG.minRate, effectiveRateSeen)
      : Math.max(CONFIG.minRate, Math.min(desiredRate, CONFIG.maxRate));
    const avg = seenVideoCount > 0 ? seenVideoSec / seenVideoCount : CONFIG.assumedVideoSec;
    let videoSec = 0;
    let unknown = 0;
    for (const pg of stats.pages) {
      if (pageDone(pg)) continue;
      let d = 0;
      try {
        const els = (typeof pg.pageElements === 'function' ? pg.pageElements() : []) || [];
        for (const el of els) {
          const r = el.record && el.record();
          const vd = r && r.videoDuration && r.videoDuration();
          if (vd > 0) d += vd;
        }
      } catch (e) {}
      if (d > 0) videoSec += d; else { unknown++; videoSec += avg; }
    }
    const remaining = stats.total - stats.done;
    return {
      total: videoSec / rate + remaining * (CONFIG.perPageOverheadMs / 1000),
      unknown,
    };
  }

  function updateProgress() {
    const bar = document.getElementById('ul-prog-bar');
    const ptxt = document.getElementById('ul-prog-text');
    const etxt = document.getElementById('ul-eta-text');
    if (!bar || !ptxt || !etxt) return;

    const stats = readCourseStats();
    if (!stats) {
      bar.style.width = '0%';
      ptxt.textContent = '总进度 —（未读到课程数据，请确认已登录）';
      etxt.textContent = '';
      return;
    }
    const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
    bar.style.width = pct + '%';
    ptxt.textContent = `总进度 ${stats.done}/${stats.total} 页 · ${pct}%`;

    if (stats.done >= stats.total) {
      etxt.textContent = '已全部完成';
      return;
    }
    const est = estimateRemainingSec(stats);
    if (!est) { etxt.textContent = ''; return; }
    etxt.textContent = `预计剩余 ≈ ${fmtDuration(est.total)}` + (est.unknown ? `（${est.unknown} 页按时长均值估）` : '');
  }

  // ================= 面板 =================
  function log(msg) {
    console.log('[刷课]', msg);
    const box = document.getElementById('ul-log');
    if (!box) return;
    const line = document.createElement('div');
    line.textContent = new Date().toLocaleTimeString() + ' ' + msg;
    box.appendChild(line);
    while (box.childNodes.length > 300) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function setStatus(s) {
    const el = document.getElementById('ul-status');
    if (el) el.textContent = s;
  }

  function createPanel() {
    if (document.getElementById('ul-panel')) return;
    const p = document.createElement('div');
    p.id = 'ul-panel';
    p.style.cssText =
      'position:fixed;top:60px;left:20px;width:340px;z-index:2147483647;' +
      'background:#1f2430;color:#e6e6e6;border-radius:10px;font:13px/1.5 -apple-system,"PingFang SC",sans-serif;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.4);overflow:hidden;';
    p.innerHTML = `
      <div id="ul-drag" style="padding:10px 14px;background:#2a3040;font-weight:600;display:flex;justify-content:space-between;align-items:center;cursor:move;">
        <span>优学院刷课助手 v1.4</span>
        <span id="ul-status" style="color:#9be98c;font-size:12px;">待机</span>
      </div>
      <div style="padding:8px 14px 10px;background:#232936;">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:#9fb0c4;margin-bottom:5px;">
          <span id="ul-prog-text">总进度 —</span>
          <span id="ul-eta-text"></span>
        </div>
        <div style="height:6px;background:#2a3040;border-radius:3px;overflow:hidden;">
          <div id="ul-prog-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#3b82f6,#22c55e);transition:width .3s;"></div>
        </div>
      </div>
      <div style="padding:10px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button id="ul-start" style="padding:6px 14px;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer;">开始</button>
        <button id="ul-pause" style="padding:6px 12px;background:#6b7280;color:#fff;border:none;border-radius:6px;cursor:pointer;">暂停</button>
        <label style="font-size:12px;color:#bbb;">倍速
          <select id="ul-rate" style="margin-left:4px;padding:4px;border-radius:4px;background:#2a3040;color:#fff;border:1px solid #444;">
            <option value="1">1x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
            <option value="4">4x</option>
            <option value="8" selected>8x</option>
            <option value="16">16x</option>
          </select>
        </label>
        <button id="ul-hide" style="padding:6px 10px;background:#374151;color:#ccc;border:none;border-radius:6px;cursor:pointer;font-size:12px;">收起</button>
      </div>
      <div id="ul-done" style="display:none;padding:9px 14px;background:#14532d;color:#bbf7d0;font-size:12px;font-weight:600;"></div>
      <div style="padding:0 14px 8px;font-size:11px;color:#7d8899;line-height:1.4;">
        刷课时保持本标签页前台可见。8x 是稳妥档；16x 顶着平台防拖拽阈值，被回退时脚本会自动降档。
      </div>
      <div id="ul-log" style="height:176px;overflow-y:auto;padding:6px 14px;font-size:12px;color:#aab;background:#171b24;"></div>
    `;
    document.body.appendChild(p);

    document.getElementById('ul-start').addEventListener('click', () => {
      if (running) { log('已在运行'); return; }
      const d = document.getElementById('ul-done');
      if (d) { d.style.display = 'none'; d.innerHTML = ''; }
      running = true; paused = false;
      desiredRate = parseFloat(document.getElementById('ul-rate').value);
      setStatus('运行中');
      log('启动，倍速 ' + desiredRate + 'x');
      updateProgress();
      mainLoop();
    });

    document.getElementById('ul-pause').addEventListener('click', () => {
      if (!running) { log('当前没有在运行'); return; }
      paused = !paused;
      setStatus(paused ? '已暂停' : '运行中');
      log(paused ? '已暂停，点击恢复' : '已恢复');
    });

    document.getElementById('ul-rate').addEventListener('change', (e) => {
      desiredRate = parseFloat(e.target.value);
      document.querySelectorAll('.video-element video').forEach((v) => {
        try { v.playbackRate = desiredRate; } catch (err) {}
      });
      log('倍速已设为 ' + desiredRate + 'x');
      updateProgress();
    });

    document.getElementById('ul-hide').addEventListener('click', () => {
      const box = document.getElementById('ul-log');
      const hidden = box.style.display === 'none';
      box.style.display = hidden ? 'block' : 'none';
      document.getElementById('ul-hide').textContent = hidden ? '收起' : '展开';
    });

    let drag = false, ox = 0, oy = 0;
    document.getElementById('ul-drag').addEventListener('mousedown', (e) => {
      drag = true; ox = e.clientX - p.offsetLeft; oy = e.clientY - p.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (drag) { p.style.left = (e.clientX - ox) + 'px'; p.style.top = (e.clientY - oy) + 'px'; }
    });
    document.addEventListener('mouseup', () => { drag = false; });
  }

  // ================= 退出机制 =================
  function finish(reason, ok) {
    running = false;
    paused = false;
    setStatus(ok ? '已完成' : '已停止');
    log((ok ? '✅ ' : '⏹ ') + reason + '，已退出运行');
    updateProgress();

    if (!ok) return;
    const d = document.getElementById('ul-done');
    if (d) {
      d.style.display = 'block';
      d.innerHTML =
        '✅ 全部完成，可以关闭此标签页了&nbsp; ' +
        '<button id="ul-close" style="margin-left:4px;padding:3px 10px;background:#22c55e;color:#05301a;border:none;border-radius:5px;cursor:pointer;font-size:12px;">关闭页面</button>';
      const cb = document.getElementById('ul-close');
      if (cb) cb.addEventListener('click', () => {
        try { window.close(); } catch (e) {}
        log('浏览器拦截了自动关闭，请手动关掉这个标签页');
      });
    }
    if (CONFIG.autoCloseTab) {
      log('尝试自动关闭标签页…');
      setTimeout(() => { try { window.close(); } catch (e) {} }, 800);
    }
  }

  // ================= 核心 =================
  function isVideoCourse() {
    return !!document.querySelector('div.mejs__overlay-button[role="button"]');
  }

  function getVideoItems() {
    const items = [];
    document.querySelectorAll(SEL.videoEl).forEach((el) => {
      const c = el.querySelector(SEL.mejsContainer);
      if (c && c.id) items.push({ wrap: el, id: c.id });
    });
    return items;
  }

  function isVideoFinished(item) {
    const info = item.wrap.querySelector(SEL.videoInfo);
    if (!info) return false;
    const span = info.querySelector(SEL.finishedSpan);
    return !!(span && span.offsetParent !== null);
  }

  // 当前页身份指纹（用于判断"翻页后到底有没有真的换页"）
  function pageFingerprint() {
    try {
      const vm = window.koLearnCourseViewModel;
      if (vm) {
        const cp = vm.currentPage && vm.currentPage();
        if (cp && typeof cp.id === 'function') return 'p' + cp.id();
        const cs = vm.currentSection && vm.currentSection();
        if (cs && typeof cs.id === 'function') return 's' + cs.id();
      }
    } catch (e) {}
    const el = document.querySelector('[id^="pageElement"]');
    return el ? el.id : 'none';
  }

  async function startPlayback(item, video, rate) {
    try { video.playbackRate = rate; } catch (e) {}
    if (!video.paused) return;
    try { await video.play(); } catch (e) {}
    if (video.paused) {
      const btn = await waitForElement(SEL.playBtn(item.id), 4000);
      if (btn) { try { btn.click(); } catch (e) {} }
    }
  }

  async function playVideo(item) {
    const video = document.querySelector(`#${item.id} video`);
    if (!video) { log('未找到 video 元素：' + item.id); return false; }

    let rate = Math.min(desiredRate, CONFIG.maxRate);
    let lastDesired = desiredRate;
    effectiveRateSeen = rate;
    await startPlayback(item, video, rate);

    let lastTime = -1;
    let idleMs = 0;
    let nextRetryMs = 5000;
    let nextBackoffMs = CONFIG.stallBackoffAt * 1000;
    let lastLogged = -1;
    let badMeta = 0;
    let durRecorded = false;

    for (;;) {
      if (!running) return false;
      while (paused) await sleep(500);
      const tickStart = Date.now();
      await sleep(CONFIG.pollInterval);

      // 1) 平台自己标记"已看完" -> 结束（权威判据）
      if (isVideoFinished(item)) { log('✔ 平台已标记看完：' + item.id); return true; }

      // 2) "离开太久"暂停弹窗
      handleModal(SEL.walkingTooLong, () => click(SEL.continueStudy), '检测到暂停弹窗，点击继续学习');

      // 3) 面板改倍速 -> 采纳
      if (desiredRate !== lastDesired) {
        lastDesired = desiredRate;
        rate = Math.min(desiredRate, CONFIG.maxRate);
        effectiveRateSeen = rate;
        try { video.playbackRate = rate; } catch (e) {}
      }

      // 4) 维持倍速
      if (Math.abs(video.playbackRate - rate) > 0.01) {
        try { video.playbackRate = rate; } catch (e) {}
      }

      // 5) 平台防拖拽把进度拽回去了 -> 自动降档
      if (lastTime >= 0 && video.currentTime < lastTime - 0.5) {
        if (CONFIG.autoBackoff && rate > CONFIG.minRate) {
          rate = Math.max(CONFIG.minRate, rate / 2);
          effectiveRateSeen = rate;
          log(`⚠ 进度被平台回退（防拖拽），自动降速到 ${rate}x`);
          try { video.playbackRate = rate; } catch (e) {}
        }
      }

      // 6) 播到结尾
      if (video.ended) { log('视频播放到结尾：' + item.id); return true; }

      const dur = video.duration;
      const metaOk = isFinite(dur) && dur > 0;
      if (metaOk && !durRecorded) { durRecorded = true; seenVideoSec += dur; seenVideoCount++; }

      // 7) 进度日志（每约 30s 一条）
      if (metaOk) {
        const sec = Math.floor(video.currentTime);
        if (idleMs === 0 && sec > 0 && sec % 30 === 0 && sec !== lastLogged) {
          lastLogged = sec;
          log(`  ${item.id} ${sec}/${Math.floor(dur)}s  @${rate}x`);
        }
      }

      // 8a) 元数据未就绪：先等，不直接放弃
      if (!metaOk) {
        badMeta++;
        if (badMeta === 1) log('等待视频元数据…（' + item.id + '）');
        if (badMeta * CONFIG.pollInterval / 1000 > CONFIG.metaWaitLimit) {
          log('⚠ 元数据 ' + CONFIG.metaWaitLimit + 's 未就绪，跳过该视频：' + item.id);
          return false;
        }
      } else {
        badMeta = 0;
      }

      // 8b) 停滞检测：先自动降档，再不行才放弃
      if (Math.abs(video.currentTime - lastTime) < 0.2) {
        idleMs += Date.now() - tickStart;
        if (idleMs >= nextRetryMs && video.paused) {
          try { await video.play(); } catch (e) {}
          nextRetryMs += 5000;
        }
        if (CONFIG.autoBackoff && rate > CONFIG.minRate && idleMs >= nextBackoffMs) {
          rate = Math.max(CONFIG.minRate, rate / 2);
          effectiveRateSeen = rate;
          nextBackoffMs += CONFIG.stallBackoffAt * 1000;
          log(`停滞 ${Math.round(idleMs / 1000)}s，自动降速到 ${rate}x`);
          try { video.playbackRate = rate; } catch (e) {}
        }
        if (idleMs >= CONFIG.noProgressLimit * 1000) {
          log('⚠ ' + CONFIG.noProgressLimit + 's 无进度，放弃该视频：' + item.id);
          return false;
        }
      } else {
        idleMs = 0;
        nextRetryMs = 5000;
        nextBackoffMs = CONFIG.stallBackoffAt * 1000;
      }
      lastTime = video.currentTime;
    }
  }

  async function playAllVideos() {
    const items = getVideoItems();
    if (items.length === 0) { log('本页未检测到 .video-element'); return; }
    log(`本页共 ${items.length} 个视频`);
    for (const item of items) {
      if (!running) return;
      if (isVideoFinished(item)) { log('跳过已看完：' + item.id); continue; }
      log('开始播放：' + item.id);
      await playVideo(item);
    }
  }

  function drainModals() {
    handleModal(SEL.questionsNotCompleted, () => click(SEL.confirmLeave), '题目未完成弹窗，点击确认离开');
    handleModal(SEL.incompleteChapter, () => click(SEL.goNextPage), '章节未完成弹窗，点击继续下一章');
    return handleModal(SEL.incompleteChapter2, () => click(SEL.closeStatPage), '课程已结束，关闭统计页');
  }

  async function nextPage() {
    if (!isVideoCourse()) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(150);
    }

    if (drainModals()) return true;

    if (click(SEL.nextPage)) log('点击下一页');
    else log('未找到下一页按钮');

    const clickAt = Date.now();
    const deadline = clickAt + CONFIG.modalWaitMs;
    while (Date.now() < deadline) {
      await sleep(CONFIG.modalPollMs);
      if (drainModals()) return true;
      if (Date.now() - clickAt >= CONFIG.cleanGraceMs) break;
    }
    return false;
  }

  async function mainLoop() {
    let samePage = 0;
    try {
      for (let i = 0; i < CONFIG.maxLoops && running; i++) {
        setStatus(`第 ${i + 1} 页`);
        if (isVideoCourse()) {
          await playAllVideos();
        } else {
          log('非视频页，停留 ' + CONFIG.textPageWait + 'ms 后翻页');
          await sleep(CONFIG.textPageWait);
        }
        if (!running) return;   // 手动停止

        const fpBefore = pageFingerprint();
        if (await nextPage()) { finish('整门课程已完成', true); return; }
        if (!running) return;

        await sleep(150);       // 给 Knockout 一点时间切页
        const fpAfter = pageFingerprint();
        if (fpAfter === fpBefore) {
          samePage++;
          if (samePage >= CONFIG.maxSamePage) {
            finish(`连续 ${CONFIG.maxSamePage} 次翻页后页面没有任何变化，判定已无更多内容`, false);
            return;
          }
        } else {
          samePage = 0;
        }
        updateProgress();
      }
      if (running) finish('达到翻页上限 ' + CONFIG.maxLoops, false);
    } catch (e) {
      finish('运行中出错：' + (e && e.message ? e.message : e), false);
    }
  }

  // ================= 启动 =================
  const boot = () => {
    createPanel();
    log('脚本已加载（选择器与数据模型已对照线上代码校验）。点「开始」启动，默认 8x。');
    updateProgress();
    if (!progressTimer) progressTimer = setInterval(updateProgress, CONFIG.progressRefreshMs);
  };
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 500);
  else window.addEventListener('load', () => setTimeout(boot, 500));
})();
