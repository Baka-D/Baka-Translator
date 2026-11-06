/** Load the popup after its shared resources and document are ready. */
(function initPopupUi() {
  'use strict';
  const root = globalThis.DSHT || {};
  const fallback = document.getElementById('statusText');
  if (!root.config || !root.languages) {
    if (fallback) fallback.textContent = '扩展资源加载失败，请重新加载扩展后重试。';
    return;
  }
  import('./popup-main.mjs').then(({ init }) => init()).catch(() => {
    if (fallback) fallback.textContent = '扩展初始化失败，请关闭后重试。';
  });
})();
