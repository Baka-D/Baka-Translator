/** Ruby base-text collection and reading visibility for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['ruby'] = function createModule(app) {
  const { page, textUtils } = app;

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

  /** Group adjacent base text without crossing protected or already translated text. */
  function buildRubyGroup(start, canInclude) {
    const startRuby = rubyForNode(start);
    const nodes = [];
    const rubies = [];
    const eligibleBase = (ruby) => {
      const base = collectRubyBaseTextNodes(ruby);
      return base.length && base.every(canInclude) ? base : null;
    };

    if (startRuby) {
      const base = eligibleBase(startRuby);
      if (!base?.includes(start)) return null;
      nodes.push(...base);
      rubies.push(startRuby);
    } else {
      nodes.push(start);
    }

    const first = startRuby || start;
    for (let next = first.nextSibling; next; next = next.nextSibling) {
      if (next.nodeType === Node.TEXT_NODE && canInclude(next)) {
        nodes.push(next);
      } else if (next.nodeType === Node.ELEMENT_NODE && next.tagName === 'RUBY') {
        const base = eligibleBase(next);
        if (!base) break;
        nodes.push(...base);
        rubies.push(next);
      } else {
        break;
      }
    }

    // The text walker starts with a letter, so any leading punctuation or
    // numeric base belonging to the same ruby sequence needs a backward scan.
    const prefix = [];
    for (let prior = first.previousSibling; prior; prior = prior.previousSibling) {
      const isRuby = prior.nodeType === Node.ELEMENT_NODE && prior.tagName === 'RUBY';
      const base = isRuby ? eligibleBase(prior) : (canInclude(prior) ? [prior] : null);
      if (!base || base.some((part) => textUtils.isMeaningfulText(part.nodeValue))) break;
      prefix.push(base);
      if (isRuby) rubies.unshift(prior);
    }
    if (rubies.length) nodes.unshift(...prefix.reverse().flat());
    if (nodes.length <= 1 && rubies.length === 0) return null;
    return { nodes, rubyReadings: [...new Set(rubies.flatMap(collectRubyReadingElements))] };
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

  return { rubyForNode, buildRubyGroup, hideRubyReadings, restoreRubyReadings };
  };
})(globalThis);
