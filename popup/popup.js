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
  import('./popup-main.mjs').then(({ init }) => init()).catch(() => {
    if (fallback) fallback.textContent = t('pop_init_failed');
  });
})();
