/** Dom behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const { t } = globalScope.DSHT.i18n;
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['dom'] = function createModule(app) {
  const { detect, textUtils, LIMITS, page } = app;

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

  const SKIP_SELECTORS = [
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
  ];
  const SKIP_SELECTOR = SKIP_SELECTORS.join(',');
  const FRAME_SKIP_SELECTOR = SKIP_SELECTORS.filter((selector) => selector !== 'iframe').join(',');

  const TRANSLATE_BLOCK_SELECTOR = '[translate="no"], .notranslate';
  const SKIP_TEXT_ROOT_ATTR = 'data-dsht-ui';

  function newFilterContext() {
    return {
      skipCache: new WeakMap(),
      frameSkipCache: new WeakMap(),
      visibilityCache: new WeakMap()
    };
  }

  function composedBoundary(element) {
    return element.getRootNode?.().host || element.ownerDocument?.defaultView?.frameElement;
  }

  function isSkippedParent(element, ctx, frameBoundary = false) {
    if (!element) return true;
    const cache = frameBoundary ? ctx.frameSkipCache : ctx.skipCache;
    if (cache.has(element)) return cache.get(element);
    let skipped = false;
    try {
      // An iframe's own fallback DOM is excluded, but an accessible child document
      // can be translated if the frame and its ancestors allow translation.
      skipped = (!frameBoundary && SKIP_TAGS.has(element.tagName)) ||
        Boolean(element.closest(frameBoundary ? FRAME_SKIP_SELECTOR : SKIP_SELECTOR));
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
      const boundary = !skipped && composedBoundary(element);
      if (boundary) skipped = isSkippedParent(boundary, ctx, boundary.tagName === 'IFRAME');
    } catch (_error) {
      skipped = true;
    }
    cache.set(element, skipped);
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
      } else if (style.display === 'contents') {
        // A boxless host can still render its children.
        visible = !element.parentElement || isVisibleParent(element.parentElement, ctx);
      } else if (typeof element.checkVisibility === 'function') {
        visible = element.checkVisibility({
          checkOpacity: false,
          checkVisibilityCSS: true
        });
      }
      const boundary = visible && composedBoundary(element);
      if (boundary) visible = isVisibleParent(boundary, ctx);
    } catch (_error) {
      visible = true;
    }
    ctx.visibilityCache.set(element, visible);
    return visible;
  }

  function isEligibleTextNode(node, ctx, allowDetached) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const previous = page.translatedNodes.get(node);
    if (previous && node.nodeValue === previous.translated) return false;
    // SPAs reuse text nodes. A page-authored update becomes the new original.
    if (previous) {
      page.translatedNodes.delete(node);
      app.releaseTranslatedFont?.(node);
      app.removeCaptionForNode(node);
    }
    const parent = node.parentElement;
    if (!parent) return false;
    if (isSkippedParent(parent, ctx)) return false;
    // Parsed (not-yet-attached) documents have no layout; checkVisibility()
    // would report every node as invisible, so only apply visibility checks
    // to nodes from a live document.
    const inLiveDocument = parent.ownerDocument === document || parent.ownerDocument?.defaultView;
    return (allowDetached && !inLiveDocument) || isVisibleParent(parent, ctx);
  }

  function isCandidateTextNode(node, ctx, allowDetached) {
    return isEligibleTextNode(node, ctx, allowDetached) && textUtils.isMeaningfulText(node.nodeValue);
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

        for (let index = (element.children?.length || 0) - 1; index >= 0; index--) {
          queue.push(element.children[index]);
        }
        const shadow = element.shadowRoot;
        if (shadow) {
          addRoot(shadow);
          for (let index = shadow.children.length - 1; index >= 0; index--) {
            queue.push(shadow.children[index]);
          }
        }
      }
    };

    visitDocument(base, 0);
    return roots;
  }

  function collectPageSample(maxChars) {
    const sampleParts = [];
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

  function detectSample(sample) {
    const result = detect.detectPageLanguage(sample, document.documentElement.lang || '');
    return {
      code: result.code,
      label: globalScope.DSHT.i18n.languageLabel(result.code),
      confidence: result.confidence || 0,
      mixed: Boolean(result.mixed)
    };
  }

  function detectPageLanguage(force) {
    const now = Date.now();
    if (!force && page.detectionCache && now - page.detectionCache.at < 15000) {
      return page.detectionCache.value;
    }
    const value = detectSample(collectPageSample(18000));
    page.detectionCache = { value, at: now };
    return value;
  }

  function detectFromTargets(targets) {
    const sample = targets
      .slice(0, 800)
      .map((target) => target.core)
      .join('\n')
      .slice(0, 20000);
    return detectSample(sample);
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
      return t('content_no_text_iframe');
    }
    return t('content_no_translatable_text');
  }

  function collectTargets(rootOrRoots, options) {
    const opts = options || {};
    const ctx = newFilterContext();
    // The anchor depends only on the parent chain, which is fixed during one collection.
    const anchorByParent = new Map();
    const targets = [];
    let chars = 0;
    let truncated = false;
    let stopped = false;

    const roots = Array.isArray(rootOrRoots) ? rootOrRoots : [rootOrRoots];
    if (roots.length === 0) return { targets, truncated };
    const consumed = new WeakSet();

    const canInclude = (node) =>
      !consumed.has(node) && isEligibleTextNode(node, ctx, opts.allowDisconnected);

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
      if (opts.bilingual) {
        const parent = target.node.parentElement;
        if (!anchorByParent.has(parent)) anchorByParent.set(parent, app.findCaptionAnchor(target.node));
        target.anchor = anchorByParent.get(parent);
      }
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
      const group = app.buildRubyGroup(node, canInclude);
      if (group) {
        const split = textUtils.splitWhitespace(group.nodes.map((part) => part.nodeValue).join(''));
        if (split.core.length <= LIMITS.TEXT_MAX_SEGMENT_CHARS) {
          pushTarget({ ...group, split });
          return;
        }
        truncated = true;
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
    collectTargets
  };
  };
})(globalThis);
