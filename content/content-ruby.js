/** Ruby base-text collection and reading visibility for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['ruby'] = function createModule(app) {
  const { page } = app;

  function rubyForNode(node) {
    const parent = node && node.parentElement;
    if (!parent) return null;
    try {
      if (parent.tagName === 'RUBY') return parent;
      return parent.closest ? parent.closest('ruby') : null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Return the readable base text nodes of a ruby, excluding rt readings and
   * rp fallback parentheses. Those must never be sent to the translator: on a
   * Japanese page `<ruby>賜<rt>たまわ</rt></ruby>` would otherwise produce a
   * translated duplicate annotation above the translated sentence.
   */
  function collectRubyBaseTextNodes(ruby) {
    const nodes = [];
    const visit = (element) => {
      if (!element || !element.childNodes) return;
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          nodes.push(child);
        } else if (
          child.nodeType === Node.ELEMENT_NODE &&
          child.tagName !== 'RT' &&
          child.tagName !== 'RP'
        ) {
          visit(child);
        }
      }
    };
    visit(ruby);
    return nodes;
  }

  function collectRubyReadingElements(ruby) {
    const readings = [];
    if (!ruby || typeof ruby.querySelectorAll !== 'function') return readings;
    try {
      for (const element of ruby.querySelectorAll('rt, rp')) readings.push(element);
    } catch (_error) {
      // Ignore detached/unsupported ruby elements.
    }
    return readings;
  }

  function hideRubyReadings(elements) {
    if (!Array.isArray(elements)) return;
    if (!page.hiddenRubyReadings) page.hiddenRubyReadings = new Map();
    for (const element of elements) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) continue;
      if (page.hiddenRubyReadings.has(element)) continue;
      try {
        page.hiddenRubyReadings.set(element, {
          display: element.style.getPropertyValue('display'),
          priority: element.style.getPropertyPriority('display')
        });
        element.style.setProperty('display', 'none', 'important');
      } catch (_error) {
        // Ignore detached/unsupported elements.
      }
    }
  }

  function restoreRubyReadings() {
    if (!page.hiddenRubyReadings) return;
    for (const [element, record] of page.hiddenRubyReadings) {
      try {
        if (record && record.display) {
          element.style.setProperty('display', record.display, record.priority || '');
        } else {
          element.style.removeProperty('display');
        }
      } catch (_error) {
        // Ignore detached elements.
      }
    }
    page.hiddenRubyReadings.clear();
  }

  return { rubyForNode, collectRubyBaseTextNodes, collectRubyReadingElements, hideRubyReadings, restoreRubyReadings };
  };
})(globalThis);
