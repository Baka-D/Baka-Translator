/** Static extension pages localize once, without changing user content or HTML. */
(function localizePage(globalScope) {
  'use strict';
  const apply = () => globalScope.DSHT.i18n.localizeDocument();
  // Loaded at the end of body, before app startup; never overwrite a rendered status later.
  if (document.body) apply();
  else document.addEventListener('DOMContentLoaded', apply, { once: true });
})(globalThis);
