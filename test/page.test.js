const test = require('node:test');
const assert = require('node:assert');
const {
  boot, installVideoMock, hideModals, showModal, showStatPage, markVideoUnfinished,
  makeVideoQuestionModal, sleep,
} = require('./helpers/harness');

// ---------------------------------------------------------------- 基线刻画

test('选择器全部命中线上真实标记', async (t) => {
  const h = await boot(t);
  const sels = {
    video: '.video-element',
    container: '.mejs__container',
    playBtn: '#mep_0 .mejs__overlay-button[aria-label="播放"]',
    videoInfo: '.video-info',
    finished: 'span[data-bind="text: $root.i18nMessageText().finished"]',
    nextPage: '.btn-tip span[data-bind="text: i18nMessageText().nextPage"]',
    walkingTooLong: 'span[data-bind="text: $root.i18nMsgText().walkingTooLong"]',
    continueStudy: 'button.btn-submit[data-bind="text: $root.i18nMsgText().continueStudy"]',
    questions: 'span[data-bind="text: $root.i18nMsgText().questionsNotCompleted"]',
    confirmLeave: 'button.btn-hollow[data-bind="text: $root.i18nMsgText().confirmLeave"]',
    incomplete1: 'span[data-bind="text: i18nMessageText().incompleteChapter"]',
    incomplete2: 'span[data-bind="text: i18nMessageText().incompleteChapter2"]',
    goNextPage: 'button.btn-hollow[data-bind="click: goNextPage"]',
    closeStatPage: 'button.btn-hollow[data-bind="click: closeStatPage"]',
    reviewChapter: 'button.btn-hollow[data-bind="click: reviewChapter"]',
  };
  for (const [k, sel] of Object.entries(sels)) {
    assert.ok(h.doc.querySelectorAll(sel).length >= 1, `${k} 未命中: ${sel}`);
  }
  assert.ok(h.doc.getElementById('ul-panel'), '面板未创建');
  assert.deepStrictEqual(h.errors, []);
});

test('总进度与 ETA 读平台数据模型', async (t) => {
  const h = await boot(t);
  assert.strictEqual(h.txt('ul-prog-text'), '总进度 7/20 页 · 35%');
  assert.match(h.txt('ul-eta-text'), /^预计剩余 ≈ 13 分钟/);
  assert.strictEqual(h.doc.getElementById('ul-prog-bar').style.width, '35%');
});

// ---------------------------------------------------------------- 面板

test('面板只留三个按钮：开始 / 暂停 / 收起', async (t) => {
  const h = await boot(t);
  assert.strictEqual(h.doc.getElementById('ul-stop'), null, '停止按钮应已被移除');
  assert.ok(h.doc.getElementById('ul-start'), '开始按钮必须在');
  assert.ok(h.doc.getElementById('ul-pause'), '暂停按钮必须在');
  assert.ok(h.doc.getElementById('ul-hide'), '收起按钮必须在');
  assert.strictEqual(h.txt('ul-pause'), '暂停', '暂停按钮文案必须是「暂停」');
  h.doc.getElementById('ul-pause').click();
  assert.strictEqual(h.txt('ul-pause'), '暂停', '暂停文案不该变「恢复」');
});

test('倍速下拉只有 8 和 16，默认选中 8', async (t) => {
  const h = await boot(t);
  const sel = h.doc.getElementById('ul-rate');
  assert.deepStrictEqual([...sel.options].map((o) => o.value), ['8', '16']);
  assert.strictEqual(sel.value, '8');
});

test('改倍速后立即作用到正在播放的视频', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  markVideoUnfinished(h.window);
  const v = installVideoMock(h.window);
  h.start();
  await sleep(2500);
  assert.strictEqual(v.rate, 8, '默认应作用 8x');
  const sel = h.doc.getElementById('ul-rate');
  sel.value = '16';
  sel.dispatchEvent(new h.window.Event('change'));
  await sleep(500);
  assert.strictEqual(v.rate, 16, '改成 16x 后应立刻生效');
});

// ---------------------------------------------------------------- 暂停 / 续跑

test('「暂停」立刻停脚本并真的把视频停住', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  markVideoUnfinished(h.window);
  const v = installVideoMock(h.window);
  h.start();
  await sleep(2000);
  assert.match(h.txt('ul-status'), /^第 \d+ 页$/, '应已进入运行');
  h.pause();
  await sleep(400);
  assert.strictEqual(h.txt('ul-status'), '已暂停');
  assert.strictEqual(v.paused, true, '「暂停」必须真的调 video.pause()');
  const plays = v.playCalls;
  await sleep(1600);
  assert.strictEqual(v.playCalls, plays, '暂停后脚本不该再自动续播');
});

test('暂停后按「开始」能续跑', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  markVideoUnfinished(h.window);
  installVideoMock(h.window);
  h.start();
  await sleep(1500);
  h.pause();
  await sleep(300);
  assert.strictEqual(h.txt('ul-status'), '已暂停');
  h.start();
  await sleep(600);
  assert.match(h.txt('ul-status'), /^第 \d+ 页$/, '「开始」要兼任续跑入口（没有「恢复」按钮）');
});

// ---------------------------------------------------------------- 弹窗 / 退出

test('「离开太久」弹窗被点掉', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  markVideoUnfinished(h.window);
  let clicked = 0;
  h.doc.querySelector('button[data-bind*="continueStudy"]')
    .addEventListener('click', () => { clicked++; });
  h.doc.querySelector('[data-bind*="walkingTooLong"]').style.display = '';
  installVideoMock(h.window);
  h.start();
  await sleep(3000);
  assert.ok(clicked >= 1, '应点掉"离开太久"弹窗');
});

test('翻页后页面身份始终不变 -> 自动退出而不是空转', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  h.window.koLearnCourseViewModel.currentPage = () => ({ id: () => 999 });
  const v = installVideoMock(h.window);
  h.start();
  await sleep(9000);
  assert.strictEqual(h.txt('ul-status'), '已停止');
  assert.match(h.logs(), /连续 4 次翻页后页面没有任何变化/);
  assert.strictEqual(v.paused, true, '退出时必须把视频停住（finish 调 haltMedia）');
});

// ---------------------------------------------------------------- 结算页（整门课刷完的判定）

test('最后一张章节结算卡 -> 判定刷完、日志给出完成语、不点「关闭」', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  const sp = showStatPage(h.window);
  sp.querySelector('[data-bind*="goNextPage"]').remove();     // 最后一章：没有「下一章」
  h.start();
  await sleep(2500);
  assert.strictEqual(h.txt('ul-status'), '已完成');
  assert.match(h.logs(), /课程刷完啦！🥳/);
  assert.strictEqual(h.doc.getElementById('ul-done').style.display, 'block');
  assert.ok(h.doc.getElementById('ul-close'), '要有关闭页面入口');
  const clicked = h.window.__clicks.join('|');
  assert.ok(!/closeStatPage/.test(clicked), '方案 A：绝不能点「关闭」（它其实是回退两页）');
  assert.ok(!/reviewChapter/.test(clicked), '绝不能点「留在本页」');
});

test('结算页连一个前进/关闭按钮都没有 -> 依然判成刷完', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  const sp = showStatPage(h.window);
  const box = sp.querySelector('.stat-next');
  if (box) box.innerHTML = '';                                // 关键加固：点不到也认终点
  h.start();
  await sleep(2500);
  assert.strictEqual(h.txt('ul-status'), '已完成');
  assert.match(h.logs(), /课程刷完啦！🥳/);
});

test('非最后一章结算卡 -> 点「下一章」继续，不判完成', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  showStatPage(h.window);
  h.start();
  await sleep(2500);
  assert.match(h.window.__clicks.join('|'), /goNextPage/, '应点「下一章」继续');
  assert.notStrictEqual(h.txt('ul-status'), '已完成', '这一章结束不等于整门课结束');
});

test('视频播到一半弹出结算页 -> 立即收工，不空等', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  markVideoUnfinished(h.window);
  installVideoMock(h.window, { t: 100, dur: 600 });           // 远没播完
  h.start();
  await sleep(1500);
  showStatPage(h.window);
  await sleep(2500);
  assert.match(h.logs(), /页面已切到结算页/, '结算页一出现就该退出 playVideo');
});

test('没有下一页按钮、且平台说 noMore -> 次级兜底判成刷完', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  const tip = h.doc.querySelector('.btn-tip');
  if (tip) tip.remove();                                      // 最后一页：平台不渲染「下一节」
  h.window.i18nMessageText = { noMore: '没有下一页' };
  h.window.koLearnCourseViewModel.nextPageName = () => '没有下一页';
  h.start();
  await sleep(4000);
  assert.strictEqual(h.txt('ul-status'), '已完成');
  assert.match(h.logs(), /课程刷完啦！🥳/);
});

// ---------------------------------------------------------------- 看门狗

test('平台把视频暂停了（非用户操作）-> 看门狗自动续播', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  markVideoUnfinished(h.window);
  const v = installVideoMock(h.window, { paused: true });     // 从"暂停"起步，脚本才会去 play()
  h.start();
  await sleep(2000);
  assert.ok(v.playCalls >= 1, '应已开始播放');
  v.paused = true;                                            // 模拟平台/网络导致的暂停
  const before = v.playCalls;
  await sleep(2500);                                          // 看门狗 1.5s 一轮
  assert.ok(v.playCalls > before, '看门狗应把视频自动续播起来');
});

test('习题弹窗开着时，看门狗不去动视频', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  markVideoUnfinished(h.window);
  const v = installVideoMock(h.window, { paused: true });
  h.start();
  await sleep(1500);
  makeVideoQuestionModal(h.window, 'skippable');              // 弹窗打开且一直不关
  await sleep(600);
  v.paused = true;
  const before = v.playCalls;
  await sleep(2000);
  assert.strictEqual(v.playCalls, before, '习题弹窗开着时不该自动续播');
});

test('本页没有视频时，看门狗依然会点掉「离开太久」弹窗', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  h.doc.querySelector('.video-element').remove();             // 没有视频 -> playAllVideos 直接 return
  let clicked = 0;
  h.doc.querySelector('button[data-bind*="continueStudy"]')
    .addEventListener('click', () => { clicked++; });
  h.doc.querySelector('[data-bind*="walkingTooLong"]').style.display = '';
  h.start();
  await sleep(3000);
  assert.ok(clicked >= 1, '看门狗独立于 playVideo 的循环，这种情况只有它还盯着');
});

// ---------------------------------------------------------------- 习题

test('整页习题（type 6）-> 不作答，直接翻页', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  h.doc.querySelector('.video-element').remove();             // 让它走"非视频页"分支
  const q = h.doc.createElement('div');
  q.className = 'question-view';                              // pageView.html:173 type==6 的根元素
  h.doc.body.appendChild(q);
  h.start();
  await sleep(2500);
  assert.match(h.logs(), /本页是习题页，不作答直接跳过/);
  const clicked = h.window.__clicks.join('|');
  assert.ok(!/submitQuiz/.test(clicked), '绝不能自动交卷');
});

test('视频内嵌习题（可跳过）-> 点「继续视频」', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  markVideoUnfinished(h.window);
  installVideoMock(h.window);
  const m = makeVideoQuestionModal(h.window, 'skippable');
  let clicked = 0;
  m.querySelector('[data-bind*="continueVideo"]').addEventListener('click', () => { clicked++; });
  h.start();
  await sleep(3000);
  assert.ok(clicked >= 1, '应点「继续视频」跳过');
});

test('视频内嵌习题（必答）-> 停下并把控制权交还用户', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  markVideoUnfinished(h.window);
  const v = installVideoMock(h.window);
  makeVideoQuestionModal(h.window, 'mandatory');              // 只有「重看视频」，没有「继续视频」
  h.start();
  await sleep(3000);
  assert.strictEqual(h.txt('ul-status'), '需要你作答');
  assert.match(h.logs(), /遇到必答习题/);
  assert.strictEqual(v.paused, true, '停下时应把视频停住');
  const clicked = h.window.__clicks.join('|');
  assert.ok(!/submitQuiz/.test(clicked), '绝不能自动作答/交卷');
});
