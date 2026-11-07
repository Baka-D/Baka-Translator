/** Dynamic behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['dynamic'] = function createModule(app) {
  const { textUtils, MSG, LIMITS, BILINGUAL_ATTR, FATAL_ERROR_CODES, page, overlay } = app;
  const REVEAL_ATTRIBUTES = ['class', 'style', 'hidden', 'open'];
  let observedRoots = new WeakSet();
  let frameUrls = new WeakMap();
  const revealed = new Set();
  let composedRoots = [];
  let rootsChanged = false;

  function disconnectDynamicObserver() {
    observedRoots = new WeakSet();
    frameUrls = new WeakMap();
    composedRoots = [];
    revealed.clear();
    rootsChanged = false;
    if (!Array.isArray(page.observers)) {
      page.observers = [];
      return;
    }
    for (const observer of page.observers) {
      try {
        observer.disconnect();
      } catch (_error) {
        // Ignore.
      }
    }
    page.observers = [];
  }

  function dynamicBudgetReached() {
    return (
      page.dynamicNodeCount >= LIMITS.DYNAMIC_MAX_NODES ||
      page.dynamicCharCount >= LIMITS.DYNAMIC_MAX_CHARS
    );
  }

  function stopDynamicTranslation() {
    disconnectDynamicObserver();
    if (page.dynamicTimer) {
      clearTimeout(page.dynamicTimer);
      page.dynamicTimer = 0;
    }
    page.dynamicQueue.clear();
  }

  function isInPageAnchor(hash) {
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch (_error) {
      // Browsers also match the fragment as written.
    }
    return Boolean(document.getElementById(id)) || document.getElementsByName(id).length > 0;
  }

  /** A hash that names no element belongs to a router (#inbox, #/mail), so it is a route. */
  function currentRoute() {
    const { origin, pathname, search, hash } = globalScope.location;
    return origin + pathname + search + (!hash || isInPageAnchor(hash) ? '' : hash);
  }

  function stopForNewRoute() {
    stopDynamicTranslation();
    overlay.showToast('页面已切换，新内容不再自动翻译。需要时请还原后重新翻译。', 'info');
  }

  /** Consent covers the page the user translated, not wherever an SPA goes next. */
  function leftTranslatedRoute() {
    if (currentRoute() === page.translatedRoute) return false;
    stopForNewRoute();
    return true;
  }

  function frameUrl(frame) {
    try {
      return frame.contentWindow.location.href;
    } catch (_error) {
      return '';
    }
  }

  function handleMutations(records) {
    if (page.status !== 'done' && page.status !== 'partial') return;
    if (leftTranslatedRoute()) return;
    if (page.abortFatal || dynamicBudgetReached()) {
      stopDynamicTranslation();
      return;
    }
    for (const record of records) {
      if (record.type === 'characterData') {
        const previous = page.translatedNodes.get(record.target);
        if (!previous || record.target.nodeValue !== previous.translated) {
          page.dynamicQueue.add(record.target);
        }
        continue;
      }
      if (record.type === 'attributes') {
        const { target, attributeName } = record;
        if (target.tagName === 'HTML' || target.tagName === 'BODY' ||
          target.hasAttribute(BILINGUAL_ATTR)) continue;
        revealed.add(target);
        // `.on + .panel` shows a later sibling. Style is left out: scripts animate it per frame.
        if (attributeName === 'style') continue;
        for (let next = target.nextElementSibling; next; next = next.nextElementSibling) {
          revealed.add(next);
        }
        continue;
      }
      for (const added of record.addedNodes) {
        if (!added) continue;
        if (added.nodeType === Node.TEXT_NODE) {
          if (added.parentElement) page.dynamicQueue.add(added.parentElement);
        } else if (added.nodeType === Node.ELEMENT_NODE) {
          if (added.hasAttribute && added.hasAttribute(BILINGUAL_ATTR)) continue;
          page.dynamicQueue.add(added);
          rootsChanged = !page.novelMode;
        }
      }
    }
    if (page.dynamicQueue.size > 0 || revealed.size > 0) scheduleDynamicFlush();
  }

  function handleFrameLoad(event) {
    if (event.target.tagName !== 'IFRAME') return;
    // Mail apps open each message in a same-origin frame: a new document is a new page.
    const previous = frameUrls.get(event.target);
    if (previous && previous !== frameUrl(event.target)) {
      stopForNewRoute();
      return;
    }
    rootsChanged = true;
    scheduleDynamicFlush();
  }

  /** Observe the roots not seen yet and return them. */
  function observeRoots(roots) {
    composedRoots = roots;
    const options = { childList: true, characterData: true, subtree: true };
    if (!page.novelMode) options.attributeFilter = REVEAL_ATTRIBUTES;
    const added = [];
    for (const root of roots) {
      if (!root || root.isConnected === false || observedRoots.has(root)) continue;
      observedRoots.add(root);
      try {
        const view = root.ownerDocument && root.ownerDocument.defaultView;
        if (view && view.frameElement) frameUrls.set(view.frameElement, view.location.href);
        const ObserverCtor = (view && view.MutationObserver) || MutationObserver;
        const observer = new ObserverCtor(handleMutations);
        observer.observe(root, options);
        page.observers.push(observer);
        added.push(root);
        if (page.novelMode) continue;
        root.addEventListener('load', handleFrameLoad, true);
        page.observers.push({
          disconnect: () => root.removeEventListener('load', handleFrameLoad, true)
        });
      } catch (_error) {
        // A detached frame/root can refuse observation; keep the others.
      }
    }
    return added;
  }

  // shortcut: attachShadow on an element already in the page produces no mutation
  // record so that root waits for the next insertion, hook attachShadow from the main
  // world if pages turn out to need it.
  // shortcut: text shown by an html/body class, :has(), :hover, :checked or popover stays
  // untranslated, keep a list of the hidden text the first pass skipped if pages need it.
  function rescanRoots() {
    rootsChanged = false;
    try {
      for (const root of observeRoots(app.collectComposedTextRoots(document))) {
        page.dynamicQueue.add(root);
      }
    } catch (_error) {
      // Dynamic translation is a progressive enhancement; never disturb the page.
    }
  }

  /** Queue revealed elements, plus the shadow and frame roots inside them. */
  function queueRevealed() {
    for (const element of revealed) {
      if (element.textContent.trim()) page.dynamicQueue.add(element);
    }
    for (const root of composedRoots) {
      let node = root;
      while (node && !revealed.has(node)) {
        node = node.parentNode || node.host || node.defaultView?.frameElement;
      }
      if (node) page.dynamicQueue.add(root);
    }
    revealed.clear();
  }

  function startDynamicObserver() {
    disconnectDynamicObserver();
    if (!document.body || dynamicBudgetReached() || leftTranslatedRoute()) return;

    try {
      observeRoots(page.novelMode
        ? app.collectNovelRoots(document, page.novel)
        : app.collectComposedTextRoots(document));
    } catch (_error) {
      page.observers = [];
    }
    // Nothing observed the run, so sweep for what it missed. Truncated or failed text stays out.
    if (page.status !== 'done' || page.truncated || page.novelMode) return;
    for (const root of composedRoots) page.dynamicQueue.add(root);
    rootsChanged = true;
    scheduleDynamicFlush();
  }

  function scheduleDynamicFlush() {
    if (page.dynamicTimer) return;
    page.dynamicTimer = setTimeout(() => {
      page.dynamicTimer = 0;
      void flushDynamicQueue();
    }, 750);
  }

  /** A caption read from such an anchor would present translated text as the original. */
  function holdsTranslation(anchor) {
    const walker = anchor.ownerDocument.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (page.translatedNodes.has(node)) return true;
    }
    return false;
  }

  /** Originals of the translated text right before the plan, oldest first. */
  function translatedBefore(plan) {
    const earlier = [];
    try {
      const [{ node }] = plan.targetsBySegment.get(plan.segments[0].id);
      const walker = node.ownerDocument.createTreeWalker(node.getRootNode(), NodeFilter.SHOW_TEXT);
      walker.currentNode = node;
      let room = LIMITS.CONTEXT_PRECEDING_CHARS;
      while (room > 0 && walker.previousNode()) {
        const record = page.translatedNodes.get(walker.currentNode);
        if (!record) continue;
        earlier.unshift({ text: record.original });
        room -= record.original.length;
      }
    } catch (_error) {
      // Context only sharpens a batch; losing it must not lose the batch.
    }
    return earlier;
  }

  async function flushDynamicQueue() {
    if (page.dynamicBusy) return;
    if (page.status !== 'done' && page.status !== 'partial') return;
    if (leftTranslatedRoute()) return;
    if (page.abortFatal || dynamicBudgetReached()) {
      stopDynamicTranslation();
      return;
    }
    if (rootsChanged) rescanRoots();
    queueRevealed();
    const roots = Array.from(page.dynamicQueue);
    page.dynamicQueue.clear();
    if (roots.length === 0) return;

    page.dynamicBusy = true;
    const runId = page.runId;
    try {
      const uniqueTargets = [];
      const seenNodes = new Set();
      for (const root of roots) {
        if (!root || !root.isConnected) continue;
        const collected = app.collectTargets(root, { bilingual: page.bilingual });
        for (const target of collected.targets) {
          if (seenNodes.has(target.node)) continue;
          seenNodes.add(target.node);
          uniqueTargets.push(target);
        }
      }
      if (uniqueTargets.length === 0) return;

      const remainingNodes = LIMITS.DYNAMIC_MAX_NODES - page.dynamicNodeCount;
      const remainingChars = LIMITS.DYNAMIC_MAX_CHARS - page.dynamicCharCount;
      const limited = [];
      let chars = 0;
      for (const target of uniqueTargets) {
        if (limited.length >= remainingNodes) break;
        if (chars + target.core.length > remainingChars) break;
        limited.push(target);
        chars += target.core.length;
      }
      if (limited.length === 0) {
        stopDynamicTranslation();
        return;
      }

      const plan = app.buildPagePlan(limited, page.bilingual);
      if (plan.segments.length === 0) return;
      const captions = plan.anchors.filter((record) => !holdsTranslation(record.anchor));
      const recalled = textUtils.recallTranslations(plan.segments, page.translationMemory);
      const batches = textUtils.createBatches(recalled.fresh, {
        maxChars: LIMITS.TEXT_MAX_BATCH_CHARS,
        maxItems: LIMITS.TEXT_MAX_BATCH_ITEMS
      });
      let cursor = 0;
      const earlier = page.requestContext ? translatedBefore(plan) : [];
      let appliedTargets = recalled.known.length === 0 ? 0 : app.applyTranslationsForBatch(
        recalled.known, recalled.translations, plan, { updateProgress: false }
      );

      const worker = async () => {
        while (true) {
          if (runId !== page.runId || page.abortFatal || currentRoute() !== page.translatedRoute) return;
          const index = cursor;
          cursor += 1;
          if (index >= batches.length) return;
          const batch = batches[index];
          try {
            const context = textUtils.contextBefore(
              page.requestContext, [...earlier, ...plan.segments], batch[0],
              (segment) => segment.text, LIMITS.CONTEXT_PRECEDING_CHARS
            );
            const response = await app.sendRuntime({
              type: MSG.TRANSLATE_BATCH,
              targetCode: page.targetCode,
              sourceHint: page.source && page.source.code,
              glossary: app.requestGlossary(batch.map((segment) => segment.text), context),
              context,
              segments: batch.map((segment) => ({ id: segment.id, text: segment.text }))
            });
            if (runId !== page.runId) return;
            app.addPageCost(response.billing);
            app.addDiscardedCost(response);
            appliedTargets += app.applyTranslationsForBatch(batch, response.translations, plan, {
              updateProgress: false
            });
          } catch (error) {
            if (runId !== page.runId) return;
            app.addDiscardedCost(error);
            if (FATAL_ERROR_CODES.has(String(error.code || ''))) {
              page.abortFatal = true;
              page.error = error.message || page.error;
              page.errorCode = error.code || page.errorCode;
              stopDynamicTranslation();
            }
          }
        }
      };

      const workerCount = Math.max(
        1,
        Math.min(LIMITS.IMAGE_MAX_CONCURRENCY, batches.length, 2)
      );
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      if (runId !== page.runId) return;
      if (captions.length > 0) app.applyBilingualCaptions(captions);

      page.dynamicNodeCount += Math.max(appliedTargets, 0);
      page.dynamicCharCount += chars;
      if (dynamicBudgetReached()) {
        stopDynamicTranslation();
      }
    } catch (_error) {
      // Dynamic translation is a progressive enhancement; never disturb the page.
    } finally {
      if (runId === page.runId) {
        page.dynamicBusy = false;
        if (page.dynamicQueue.size > 0 || rootsChanged || revealed.size > 0) scheduleDynamicFlush();
      }
    }
  }

  return {
    currentRoute,
    disconnectDynamicObserver,
    dynamicBudgetReached,
    stopDynamicTranslation,
    startDynamicObserver,
    scheduleDynamicFlush,
    flushDynamicQueue
  };
  };
})(globalThis);
