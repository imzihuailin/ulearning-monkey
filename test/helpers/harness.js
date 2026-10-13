const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'ulearning-auto.user.js');
const FIXTURE = path.join(ROOT, 'fixtures', 'page.html');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(t) {
  const dom = new JSDOM(fs.readFileSync(FIXTURE, 'utf8'), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://ua.ulearning.cn/learnCourse/learnCourse.html?courseId=65264',
  });
  const { window } = dom;
  // 脚本里有 setInterval（进度刷新），不关 window 的话 Node 事件循环永远不空、测试进程挂住
  if (t && typeof t.after === 'function') t.after(() => { try { dom.window.close(); } catch (e) {} });
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e && e.message)));

  // --- jsdom 缺口的等价垫片；不是业务逻辑，只为让浏览器语义可用 ---
  // jsdom 无布局，offsetParent 恒为 null，而脚本用它判断元素/弹窗可见性
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      if (this.style && this.style.display === 'none') return null;
      return this.parentElement || window.document.body;
    },
  });
  window.scrollTo = () => {};                 // jsdom 未实现，否则刷 "Not implemented"
  // 注意：不要覆盖 window.close —— jsdom 的 close() 会停掉所有定时器，是上面清理的关键

  // --- 注入磁盘上的真实脚本，而不是快照 ---
  const tag = window.document.createElement('script');
  tag.textContent = fs.readFileSync(SCRIPT, 'utf8');
  window.document.body.appendChild(tag);

  await sleep(700);                            // 脚本 boot 里延迟 500ms 挂面板
  return {
    dom, window, errors,
    doc: window.document,
    txt: (id) => window.document.getElementById(id).textContent,
    logs: () => window.document.getElementById('ul-log').textContent,  // jsdom 无 innerText
    start: () => window.document.getElementById('ul-start').click(),
    pause: () => window.document.getElementById('ul-pause').click(),
  };
}

// 给某个 <video> 装可控替身。opts.sel / opts.el 可指定目标（默认夹具里的 #mep_0 video）
function installVideoMock(window, opts = {}) {
  const v = opts.el || window.document.querySelector(opts.sel || '#mep_0 video');
  if (!v) throw new Error('installVideoMock: video not found');
  const st = {
    t: opts.t || 0,
    dur: opts.dur === undefined ? 600 : opts.dur,
    paused: opts.paused === undefined ? false : opts.paused,
    ended: false, rate: 1, pauseCalls: 0, playCalls: 0,
  };
  const d = (n, g, s) => Object.defineProperty(v, n, { get: g, set: s, configurable: true });
  d('currentTime', () => st.t, (x) => { st.t = x; });
  d('duration', () => st.dur);
  d('paused', () => st.paused);
  d('ended', () => st.ended);
  d('playbackRate', () => st.rate, (x) => { st.rate = x; });
  v.play = () => { st.playCalls++; st.paused = false; return Promise.resolve(); };
  v.pause = () => { st.pauseCalls++; st.paused = true; };
  return st;
}

const hideModals = (window) => {
  ['walkingTooLong', 'questionsNotCompleted', 'incompleteChapter', 'incompleteChapter2']
    .forEach((k) => {
      const e = window.document.querySelector(`[data-bind*="${k}"]`);
      if (e) e.style.display = 'none';
    });
  const sp = window.document.querySelector('.stat-page');
  if (sp) sp.style.display = 'none';
};

const showModal = (window, key) => {
  const e = window.document.querySelector(`[data-bind*="${key}"]`);
  if (e) e.style.display = '';
};

const showStatPage = (window) => {
  const sp = window.document.querySelector('.stat-page');
  if (sp) sp.style.display = 'block';
  return sp;
};

// 夹具里 .video-info 的"已看完"标记默认是可见的 —— 不隐藏的话脚本会直接跳过视频，
// playVideo 根本不会跑。凡是需要走视频路径的用例都要先调这个。
const markVideoUnfinished = (window) => {
  const s = window.document.querySelector('.video-info span[data-bind*="finished"]');
  if (s) s.style.display = 'none';
};

// 造一个"视频内嵌习题"弹窗；mode='skippable' 给「继续视频」，'mandatory' 给「重看视频」
function makeVideoQuestionModal(window, mode = 'skippable') {
  const wrap = window.document.createElement('div');
  wrap.className = 'video-question-modal';
  wrap.style.display = 'block';
  const bind = mode === 'skippable' ? 'continueVideo' : 'reViewVideo';
  const label = mode === 'skippable' ? '继续视频' : '重看视频';
  wrap.innerHTML =
    `<div class="modal-content"><button type="button" class="btn-submit btn-video" ` +
    `data-bind="text: $root.i18nMsgText().${bind}, click: ${bind}">${label}</button></div>`;
  window.document.body.appendChild(wrap);
  return wrap;
}

module.exports = {
  boot, installVideoMock, hideModals, showModal, showStatPage, markVideoUnfinished,
  makeVideoQuestionModal, sleep,
};
