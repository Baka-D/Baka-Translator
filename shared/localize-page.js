/** Localize static extension markup before application-specific rendering. */
(function localizePage(globalScope) {
  'use strict';
  const i18n = globalScope.DSHT.i18n;
  let applied;
  function apply() {
    if (applied === i18n.locale) return;
    i18n.localizeDocument();
    applied = i18n.locale;
  }
  i18n.onChange(apply);
  void i18n.ready.then(apply);
})(globalThis);
