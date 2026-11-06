/** Captions behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['captions'] = function createModule(app) {
  const { textUtils, LIMITS, BILINGUAL_ATTR, page } = app;

  const CAPTION_PRIMARY_TAGS = new Set([
    'P',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'LI',
    'DT',
    'DD',
    'BLOCKQUOTE',
    'FIGCAPTION',
    'TD',
    'TH',
    'CAPTION'
  ]);

  const CAPTION_FALLBACK_TAGS = new Set([
    'DIV',
    'SECTION',
    'ARTICLE',
    'MAIN',
    'HEADER',
    'FOOTER',
    'ASIDE',
    'NAV'
  ]);

  const CAPTION_BLOCK_CHILD_TAGS = new Set([
    'DIV',
    'P',
    'SECTION',
    'ARTICLE',
    'MAIN',
    'HEADER',
    'FOOTER',
    'ASIDE',
    'NAV',
    'UL',
    'OL',
    'LI',
    'DL',
    'DT',
    'DD',
    'TABLE',
    'THEAD',
    'TBODY',
    'TFOOT',
    'TR',
    'TD',
    'TH',
    'BLOCKQUOTE',
    'FIGURE',
    'FIGCAPTION',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'FORM',
    'FIELDSET',
    'DETAILS',
    'SUMMARY',
    'HR'
  ]);

  function hasBlockChild(element) {
    for (const child of element.children) {
      if (CAPTION_BLOCK_CHILD_TAGS.has(child.tagName)) return true;
      try {
        const display = app.getComputedStyleFor(child).display;
        if (/^(block|flow-root|list-item|table|flex|grid)$/.test(display)) return true;
      } catch (_error) {
        // Ignore detached/unsupported children.
      }
    }
    return false;
  }

  function findCaptionAnchor(node) {
    const ownerDocument = node.ownerDocument || document;
    let element = node.parentElement;
    let fallback = null;
    while (
      element &&
      element !== ownerDocument.documentElement &&
      element !== ownerDocument.body
    ) {
      const tag = element.tagName;
      if (CAPTION_PRIMARY_TAGS.has(tag)) return element;
      if (!fallback && CAPTION_FALLBACK_TAGS.has(tag) && !hasBlockChild(element)) {
        fallback = element;
      }
      element = element.parentElement;
    }
    return fallback;
  }

  function captureAnchorOriginal(anchor) {
    let text = '';
    try {
      if (anchor.querySelector && anchor.querySelector('rt, rp')) {
        // Readings are still visible at plan time; captions show base text only.
        const clone = anchor.cloneNode(true);
        for (const reading of clone.querySelectorAll('rt, rp')) reading.remove();
        for (const br of clone.querySelectorAll('br')) br.replaceWith('\n');
        text = clone.textContent || '';
      } else {
        text = typeof anchor.innerText === 'string' ? anchor.innerText : anchor.textContent || '';
      }
    } catch (_error) {
      text = anchor.textContent || '';
    }
    text = text.replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').trim();
    if (!text) return '';
    return textUtils.truncate(text, LIMITS.BILINGUAL_MAX_ORIGINAL_CHARS);
  }

  function buildPagePlan(targets, bilingual) {
    const segments = [];
    const byText = new Map();
    const targetsBySegment = new Map();
    const anchorRecords = new Map();
    let chars = 0;

    for (const target of targets) {
      let segment = byText.get(target.core);
      if (!segment) {
        segment = {
          id: `s${segments.length + 1}`,
          text: target.core
        };
        byText.set(target.core, segment);
        segments.push(segment);
        targetsBySegment.set(segment.id, []);
        chars += segment.text.length;
      }
      target.segmentId = segment.id;
      targetsBySegment.get(segment.id).push(target);

      if (bilingual && target.anchor) {
        let record = anchorRecords.get(target.anchor);
        if (!record) {
          record = {
            anchor: target.anchor,
            original: captureAnchorOriginal(target.anchor),
            applied: false,
            captioned: false
          };
          anchorRecords.set(target.anchor, record);
        }
        target.anchorRecord = record;
      }
    }

    return {
      segments,
      targetsBySegment,
      anchors: Array.from(anchorRecords.values()),
      chars
    };
  }

  function applyBilingualCaptions(anchorRecords) {
    for (const record of anchorRecords) {
      if (!record.applied || record.captioned) continue;
      const anchor = record.anchor;
      if (!anchor || !anchor.isConnected || !record.original) continue;
      if (anchor.querySelector(`[${BILINGUAL_ATTR}]`)) continue;

      let caption;
      try {
        const ownerDocument = anchor.ownerDocument || document;
        caption = ownerDocument.createElement('span');
      } catch (_error) {
        continue;
      }
      caption.setAttribute(BILINGUAL_ATTR, '1');
      caption.setAttribute('role', 'note');
      caption.textContent = `原文：${record.original}`;
      const styles = {
        display: 'block',
        margin: '6px 0 0',
        padding: '6px 0 0',
        border: '0',
        'border-top': '1px dashed rgba(23, 32, 51, 0.16)',
        'font-family': 'inherit',
        'font-size': '0.82em',
        'font-style': 'normal',
        'font-weight': '400',
        'line-height': '1.55',
        color: 'rgba(23, 32, 51, 0.58)',
        'letter-spacing': 'normal',
        'text-transform': 'none',
        'text-decoration': 'none',
        'text-align': 'start',
        'white-space': 'pre-wrap',
        'overflow-wrap': 'anywhere',
        background: 'transparent',
        'box-shadow': 'none',
        'user-select': 'text'
      };
      for (const [property, value] of Object.entries(styles)) {
        try {
          caption.style.setProperty(property, value, 'important');
        } catch (_error) {
          // Ignore unsupported property values.
        }
      }
      try {
        anchor.appendChild(caption);
        page.captions.add(caption);
        record.captioned = true;
      } catch (_error) {
        // The page may have removed the anchor.
      }
    }
  }

  function removeBilingualCaptions() {
    for (const caption of page.captions) {
      try {
        if (caption && caption.isConnected) caption.remove();
      } catch (_error) {
        // Ignore.
      }
    }
    page.captions.clear();
    try {
      document.querySelectorAll(`[${BILINGUAL_ATTR}]`).forEach((node) => {
        if (node.closest('[data-dsht-ui]')) return;
        node.remove();
      });
    } catch (_error) {
      // Ignore.
    }
  }

  function removeCaptionForNode(node) {
    const anchor = findCaptionAnchor(node);
    const caption = anchor && anchor.querySelector(`[${BILINGUAL_ATTR}]`);
    if (!caption) return;
    caption.remove();
    page.captions.delete(caption);
  }

  function restoreTranslatedNodes() {
    for (const [node, record] of page.translatedNodes) {
      try {
        if (node && node.isConnected && node.nodeValue === record.translated) {
          node.nodeValue = record.original;
        }
      } catch (_error) {
        // Ignore text nodes detached mid-restore.
      }
    }
    page.translatedNodes.clear();
  }

  return {
    hasBlockChild,
    findCaptionAnchor,
    captureAnchorOriginal,
    buildPagePlan,
    applyBilingualCaptions,
    removeBilingualCaptions,
    removeCaptionForNode,
    restoreTranslatedNodes
  };
  };
})(globalThis);
