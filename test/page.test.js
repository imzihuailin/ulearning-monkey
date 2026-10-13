const test = require('node:test');
const assert = require('node:assert');
const {
  boot, installVideoMock, hideModals, showModal, markVideoUnfinished, sleep,
} = require('./helpers/harness');

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

test('出现"全书结束"弹窗 -> 标记已完成并给出关闭入口', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  installVideoMock(h.window);          // 不藏"已看完"标记：让视频被跳过，循环才能快速走到翻页
  h.start();
  await sleep(1500);
  showModal(h.window, 'incompleteChapter2');
  await sleep(2500);
  assert.strictEqual(h.txt('ul-status'), '已完成');
  assert.strictEqual(h.doc.getElementById('ul-done').style.display, 'block');
  assert.ok(h.doc.getElementById('ul-close'), '缺少关闭页面按钮');
});

test('翻页后页面身份始终不变 -> 自动退出而不是空转', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  h.window.koLearnCourseViewModel.currentPage = () => ({ id: () => 999 });
  installVideoMock(h.window);
  h.start();
  await sleep(9000);
  assert.strictEqual(h.txt('ul-status'), '已停止');
  assert.match(h.logs(), /连续 4 次翻页后页面没有任何变化/);
});

test('「离开太久」弹窗被点掉', async (t) => {
  const h = await boot(t);
  hideModals(h.window);
  markVideoUnfinished(h.window);          // 不隐藏"已看完"标记的话，脚本会跳过视频、playVideo 不跑
  let clicked = 0;
  h.doc.querySelector('button[data-bind*="continueStudy"]')
    .addEventListener('click', () => { clicked++; });
  h.doc.querySelector('[data-bind*="walkingTooLong"]').style.display = '';
  installVideoMock(h.window);
  h.start();
  await sleep(3000);
  assert.ok(clicked >= 1, '应点掉"离开太久"弹窗');
});

test('面板只留三个按钮：开始 / 暂停 / 收起', async (t) => {
  const h = await boot(t);
  assert.strictEqual(h.doc.getElementById('ul-stop'), null, '停止按钮应已被移除');
  assert.ok(h.doc.getElementById('ul-start'), '开始按钮必须在');
  assert.ok(h.doc.getElementById('ul-pause'), '暂停按钮必须在');
  assert.ok(h.doc.getElementById('ul-hide'), '收起按钮必须在');
  assert.strictEqual(h.txt('ul-pause'), '暂停', '暂停按钮文案必须是「暂停」');
  // 暂停按钮的文案任何时候都不该变成"恢复"
  h.doc.getElementById('ul-pause').click();
  assert.strictEqual(h.txt('ul-pause'), '暂停', '暂停文案不该变「恢复」');
});
