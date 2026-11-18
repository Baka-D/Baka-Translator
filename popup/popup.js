/** Load the popup after its shared resources and document are ready. */
(function initPopupUi() {
  'use strict';
  const root = globalThis.DSHT || {};
  const t = (key) => root.i18n?.t(key) || chrome.i18n.getMessage(key);
  const fallback = document.getElementById('statusText');
  if (!root.config || !root.languages) {
    if (fallback) fallback.textContent = t('pop_resources_failed');
    return;
  }
  async function start() {
    await root.i18n.ready;
    root.i18n.onChange(() => window.location.reload());
    const { init } = await import('./popup-main.mjs');
    await init();
  }
  start().catch(() => {
    if (fallback) fallback.textContent = t('pop_init_failed');
  });
})();
