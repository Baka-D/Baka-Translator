/** Dom behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['dom'] = function createModule(app) {
  const { detect, textUtils, LIMITS, page } = app;
  const { rubyForNode, collectRubyBaseTextNodes, collectRubyReadingElements, hideRubyReadings, restoreRubyReadings } = app;

  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'CODE',
    'PRE',
    'KBD',
    'SAMP',
    'VAR',
    'TEXTAREA',
    'INPUT',
    'SELECT',
    'OPTION',
    'OPTGROUP',
    'RT',
    'RP',
    'SVG',
    'MATH',
    'CANVAS',
    'IFRAME',
    'OBJECT',
    'EMBED',
    'VIDEO',
    'AUDIO',
    'MAP',
    'AREA',
    'HEAD',
    'META',
    'LINK',
    'TITLE'
  ]);

  const SKIP_SELECTOR = [
    'script',
    'style',
    'noscript',
    'template',
    'code',
    'pre',
    'kbd',
    'samp',
    'var',
    'textarea',
    'select',
    'option',
    'rt',
    'rp',
    'svg',
    'math',
    'canvas',
    'iframe',
    'object',
    'embed',
    'video',
    'audio',
    '[contenteditable]:not([contenteditable="false"])',
    '[data-dsht-skip]',
    '[data-dsht-original]'
  ].join(',');

  const TRANSLATE_BLOCK_SELECTOR = '[translate="no"], .notranslate';
  const SKIP_TEXT_ROOT_ATTR = 'data-dsht-ui';

  function newFilterContext() {
    return {
      skipCache: new WeakMap(),
      visibilityCache: new WeakMap()
    };
  }

  function isSkippedParent(element, ctx) {
    if (!element) return true;
    if (ctx.skipCache.has(element)) return ctx.skipCache.get(element);
    let skipped = false;
    try {
      skipped = SKIP_TAGS.has(element.tagName) || Boolean(element.closest(SKIP_SELECTOR));
      if (!skipped) {
        const blocker = element.closest(TRANSLATE_BLOCK_SELECTOR);
        if (blocker) {
          const ownerDocument = blocker.ownerDocument || element.ownerDocument;
          // Outlook (and some other apps) place translate="no" on <html> or
          // <body> to opt the whole application out of browser translation.
          // Since our translation is explicitly user-initiated, ignore that
          // blanket marker at the document root, but honour markers inside
          // actual page content.
          const rootLevel =
            blocker === ownerDocument.documentElement || blocker === ownerDocument.body;
          skipped = !rootLevel;
        }
      }
    } catch (_error) {
      skipped = true;
    }
    ctx.skipCache.set(element, skipped);
    return skipped;
  }

  function getComputedStyleFor(element) {
    const view = element && element.ownerDocument && element.ownerDocument.defaultView;
    return view ? view.getComputedStyle(element) : window.getComputedStyle(element);
  }

  function isVisibleParent(element, ctx) {
    if (!element) return false;
    if (ctx.visibilityCache.has(element)) return ctx.visibilityCache.get(element);
    let visible = true;
    try {
      const style = getComputedStyleFor(element);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.contentVisibility === 'hidden'
      ) {
        visible = false;
      } else if (element.closest('[hidden]')) {
        visible = false;
      } else if (typeof element.checkVisibility === 'function') {
        visible = element.checkVisibility({
          checkOpacity: false,
          checkVisibilityCSS: true
        });
      }
    } catch (_error) {
      visible = true;
    }
    ctx.visibilityCache.set(element, visible);
    return visible;
  }

  function isCandidateTextNode(node, ctx, allowDetached) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const parent = node.parentElement;
    if (!parent) return false;
    const previous = page.translatedNodes.get(node);
    if (previous && node.nodeValue === previous.translated) return false;
    // SPAs reuse text nodes. A page-authored update becomes the new original.
    if (previous) {
      page.translatedNodes.delete(node);
      app.removeCaptionForNode(node);
    }
    if (!textUtils.isMeaningfulText(node.nodeValue)) return false;
    if (isSkippedParent(parent, ctx)) return false;
    // Parsed (not-yet-attached) documents have no layout; checkVisibility()
    // would report every node as invisible, so only apply visibility checks
    // to nodes from the live page document.
    const inLiveDocument = parent.ownerDocument === document;
    if (!allowDetached || inLiveDocument) {
      if (!isVisibleParent(parent, ctx)) return false;
    }
    return true;
  }

  function createTextWalker(root) {
    const ownerDocument = root.ownerDocument || document;
    return ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !textUtils.isMeaningfulText(node.nodeValue)) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
  }

  /**
   * Build the list of roots that can contain user-visible page text:
   * the main document body, open shadow roots, and same-origin iframe bodies.
   * Outlook web (and several other mail/enterprise apps) keeps the message body
   * inside an iframe, while the page itself is a large SPA.
   */

  function collectComposedTextRoots(baseDocument) {
    const base = baseDocument || document;
    const roots = [];
    const seenRoots = new Set();
    const seenDocuments = new Set();
    const MAX_IFRAME_DEPTH = 4;

    const addRoot = (root) => {
      if (root && !seenRoots.has(root)) {
        seenRoots.add(root);
        roots.push(root);
      }
    };

    const visitDocument = (ownerDocument, depth) => {
      if (!ownerDocument || depth > MAX_IFRAME_DEPTH || seenDocuments.has(ownerDocument)) {
        return;
      }
      seenDocuments.add(ownerDocument);
      if (ownerDocument.body) addRoot(ownerDocument.body);

      const queue = ownerDocument.documentElement ? [ownerDocument.documentElement] : [];
      while (queue.length > 0) {
        const element = queue.pop();
        if (!element || element.nodeType !== Node.ELEMENT_NODE) continue;
        if (
          (element.hasAttribute && element.hasAttribute(SKIP_TEXT_ROOT_ATTR)) ||
          element.id === '__deepseek_translate_overlay__'
        ) {
          continue;
        }

        if (element.shadowRoot) {
          addRoot(element.shadowRoot);
          for (const child of element.shadowRoot.children) queue.push(child);
        }

        if (element.tagName === 'IFRAME') {
          let childDocument = null;
          try {
            childDocument = element.contentDocument;
          } catch (_error) {
            // Cross-origin iframe: not accessible. Other same-origin iframes
            // can still be translated.
            childDocument = null;
          }
          if (childDocument) visitDocument(childDocument, depth + 1);
          continue;
        }

        if (element.children) {
          for (const child of element.children) queue.push(child);
        }
      }
    };

    visitDocument(base, 0);
    return roots;
  }

  function collectPageSample(maxChars) {    const sampleParts = [];
    let length = 0;
    try {
      if (document.title) {
        sampleParts.push(document.title);
        length += document.title.length;
      }
      const meta = document.querySelector('meta[name="description"]');
      if (meta && meta.content && length < maxChars) {
        sampleParts.push(meta.content);
        length += meta.content.length;
      }
    } catch (_error) {
      // Ignore metadata issues.
    }

    const ctx = newFilterContext();
    const roots = collectComposedTextRoots(document);
    if (roots.length === 0) return sampleParts.join('\n');
    for (const root of roots) {
      if (length >= maxChars) break;
      if (!root || !root.isConnected) continue;
      const walker = createTextWalker(root);
      let node = walker.nextNode();
      while (node && length < maxChars) {
        if (isCandidateTextNode(node, ctx)) {
          const core = textUtils.splitWhitespace(node.nodeValue).core;
          if (core) {
            sampleParts.push(core);
            length += core.length;
          }
        }
        node = walker.nextNode();
      }
    }
    return sampleParts.join('\n').slice(0, maxChars);
  }

  function detectPageLanguage(force) {
    const now = Date.now();
    if (!force && page.detectionCache && now - page.detectionCache.at < 15000) {
      return page.detectionCache.value;
    }
    const sample = collectPageSample(18000);
    const result = detect.detectPageLanguage(sample, document.documentElement.lang || '');
    const value = {
      code: result.code,
      label: result.label || '未知',
      confidence: result.confidence || 0,
      mixed: Boolean(result.mixed)
    };
    page.detectionCache = { value, at: now };
    return value;
  }

  function detectFromTargets(targets) {
    const sample = targets
      .slice(0, 800)
      .map((target) => target.core)
      .join('\n')
      .slice(0, 20000);
    const result = detect.detectPageLanguage(sample, document.documentElement.lang || '');
    return {
      code: result.code,
      label: result.label || '未知',
      confidence: result.confidence || 0,
      mixed: Boolean(result.mixed)
    };
  }

  function noTranslatableTextMessage() {
    let inaccessibleIframes = 0;
    try {
      for (const frame of document.querySelectorAll('iframe')) {
        try {
          if (!frame.contentDocument) inaccessibleIframes += 1;
        } catch (_error) {
          inaccessibleIframes += 1;
        }
      }
    } catch (_error) {
      // Ignore DOM inspection failures.
    }
    if (inaccessibleIframes > 0) {
      return '没有找到可翻译的文本。正文可能位于受保护的跨域 iframe 中：可尝试在邮件客户端中选择“在新窗口打开”邮件，或直接选中正文使用划词翻译。';
    }
    return '没有找到可翻译的文本。';
  }

  function collectTargets(rootOrRoots, options) {
    const opts = options || {};
    const ctx = newFilterContext();
    const targets = [];
    let chars = 0;
    let truncated = false;
    let stopped = false;

    const roots = Array.isArray(rootOrRoots) ? rootOrRoots : [rootOrRoots];
    if (roots.length === 0) return { targets, truncated };
    const consumed = new WeakSet();

    /** Group a sentence split only by ruby elements into one readable target. */
    const buildRubyGroup = (start) => {
      const startRuby = rubyForNode(start);
      const nodes = [];
      const rubies = [];
      let cursor = start;
      if (startRuby) {
        const baseNodes = collectRubyBaseTextNodes(startRuby)
          .filter((node) => isCandidateTextNode(node, ctx, opts.allowDisconnected));
        if (!baseNodes.includes(start)) return null;
        nodes.push(...baseNodes);
        rubies.push(startRuby);
        cursor = startRuby;
      } else {
        nodes.push(start);
      }

      while (cursor) {
        const next = cursor.nextSibling;
        if (!next) break;
        if (next.nodeType === Node.TEXT_NODE) {
          if (isCandidateTextNode(next, ctx, opts.allowDisconnected)) {
            nodes.push(next);
            cursor = next;
            continue;
          }
          if (!textUtils.isMeaningfulText(next.nodeValue)) {
            nodes.push(next);
            cursor = next;
            continue;
          }
          break;
        }
        if (next.nodeType === Node.ELEMENT_NODE && next.tagName === 'RUBY') {
          const baseNodes = collectRubyBaseTextNodes(next)
            .filter((node) => isCandidateTextNode(node, ctx, opts.allowDisconnected));
          if (baseNodes.length > 0) {
            nodes.push(...baseNodes);
            rubies.push(next);
          }
          cursor = next;
          continue;
        }
        break;
      }

      if (nodes.length <= 1 && rubies.length === 0) return null;
      const combined = nodes.map((node) => node.nodeValue).join('');
      const split = textUtils.splitWhitespace(combined);
      if (!textUtils.isMeaningfulText(split.core)) return null;
      if (split.core.length > LIMITS.TEXT_MAX_SEGMENT_CHARS) {
        truncated = true;
        return null;
      }
      const readings = [];
      for (const ruby of rubies) {
        for (const reading of collectRubyReadingElements(ruby)) {
          if (!readings.includes(reading)) readings.push(reading);
        }
      }
      return { nodes, rubyReadings: readings, split };
    };

    const pushTarget = (targetInfo) => {
      if (targets.length >= LIMITS.PAGE_MAX_NODES) {
        truncated = true;
        stopped = true;
        return;
      }
      if (chars + targetInfo.split.core.length > LIMITS.PAGE_MAX_CHARS) {
        truncated = true;
        stopped = true;
        return;
      }
      const target = {
        node: targetInfo.nodes[0],
        nodes: targetInfo.nodes,
        nodeOriginals: targetInfo.nodes.map((node) => node.nodeValue),
        rubyReadings: targetInfo.rubyReadings,
        original: targetInfo.nodes[0].nodeValue,
        leading: targetInfo.split.leading,
        core: targetInfo.split.core,
        trailing: targetInfo.split.trailing,
        segmentId: '',
        anchor: null,
        anchorRecord: null,
        applied: false
      };
      if (opts.bilingual) target.anchor = app.findCaptionAnchor(target.node);
      targets.push(target);
      chars += target.core.length;
      for (const node of target.nodes) consumed.add(node);
    };

    const processNode = (node) => {
      if (stopped || consumed.has(node)) return;
      if (targets.length >= LIMITS.PAGE_MAX_NODES) {
        truncated = true;
        stopped = true;
        return;
      }
      if (!isCandidateTextNode(node, ctx, opts.allowDisconnected)) return;
      const group = buildRubyGroup(node);
      if (group) {
        pushTarget(group);
        return;
      }
      const split = textUtils.splitWhitespace(node.nodeValue);
      if (!textUtils.isMeaningfulText(split.core)) return;
      if (split.core.length > LIMITS.TEXT_MAX_SEGMENT_CHARS) {
        truncated = true;
        return;
      }
      pushTarget({ nodes: [node], rubyReadings: [], split });
    };

    for (const root of roots) {
      if (stopped) break;
      if (!root) continue;
      if (root.isConnected === false && !opts.allowDisconnected) continue;
      if (root.nodeType === Node.TEXT_NODE) {
        processNode(root);
        continue;
      }
      const walker = createTextWalker(root);
      let node = walker.nextNode();
      while (node && !stopped) {
        processNode(node);
        node = walker.nextNode();
      }
    }
    return { targets, truncated };
  }

  return {
    newFilterContext,
    isSkippedParent,
    getComputedStyleFor,
    isVisibleParent,
    isCandidateTextNode,
    createTextWalker,
    collectComposedTextRoots,
    collectPageSample,
    detectPageLanguage,
    detectFromTargets,
    noTranslatableTextMessage,
    hideRubyReadings,
    restoreRubyReadings,
    collectTargets
  };
  };
})(globalThis);
