(function initOverlayPart(globalScope) {
  'use strict';
  globalScope.DSHT = globalScope.DSHT || {};
  const parts = globalScope.DSHT.overlayParts = globalScope.DSHT.overlayParts || {};

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setImportant(node, key, value) {
    node.style.setProperty(key, value, 'important');
  }

  function onTrusted(node, type, callback) {
    node.addEventListener(type, (event) => {
      if (event.isTrusted !== true || node.disabled || node.closest('.dsht-hidden')) return;
      callback(event);
    });
  }

  function copyText(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard
        .writeText(text)
        .then(() => true)
        .catch(() => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      setImportant(area, 'position', 'fixed');
      setImportant(area, 'left', '-9999px');
      setImportant(area, 'top', '0');
      document.documentElement.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch (_error) {
      return false;
    }
  }

  parts.el = el;
  parts.setImportant = setImportant;
  parts.onTrusted = onTrusted;
  parts.copyText = copyText;

})(typeof globalThis !== 'undefined' ? globalThis : this);
