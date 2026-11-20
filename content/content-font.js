/** Repair partial font coverage in the translated reading area. */
(function registerContentModule(globalScope) {
  'use strict';
  const modules = globalScope.DSHT.contentModules ||= {};

  // CSS font-family takes family names. FontFace local() can also need the
  // regular face's full or PostScript name (e.g. YuGothic-Regular on Windows).
  function localStack(...faces) {
    return {
      family: faces.map(([family]) => `"${family}"`).concat('sans-serif').join(', '),
      source: faces.flat().map((name) => `local("${name}")`).join(', ')
    };
  }

  // Regional Noto CJK faces cover all three scripts. Prefer the target region.
  const notoSC = ['Noto Sans CJK SC', 'NotoSansCJKsc-Regular'];
  const notoJP = ['Noto Sans CJK JP', 'NotoSansCJKjp-Regular'];
  const notoKR = ['Noto Sans CJK KR', 'NotoSansCJKkr-Regular'];
  const notoTC = ['Noto Sans CJK TC', 'NotoSansCJKtc-Regular'];
  const notoHK = ['Noto Sans CJK HK', 'NotoSansCJKhk-Regular'];
  const western = localStack(
    ['Segoe UI', 'SegoeUI'], ['Helvetica Neue', 'HelveticaNeue'], ['Arial', 'ArialMT'],
    ['Roboto', 'Roboto-Regular'], ['Noto Sans', 'NotoSans-Regular'],
    ['Liberation Sans', 'LiberationSans'], ['DejaVu Sans', 'DejaVuSans']
  );
  const profiles = {
    zh: {
      letters: /\p{Script=Han}/gu,
      stack: localStack(
        ['Microsoft YaHei', 'MicrosoftYaHei'], ['PingFang SC', 'PingFangSC-Regular'], notoSC,
        ['Noto Sans SC', 'NotoSansSC-Regular'], ['Source Han Sans SC', 'SourceHanSansSC-Regular'],
        ['WenQuanYi Micro Hei', 'WenQuanYiMicroHei'], ['Droid Sans Fallback', 'DroidSansFallback'],
        ['SimSun'], ['Microsoft JhengHei', 'MicrosoftJhengHei'], notoTC, notoHK, notoJP, notoKR
      )
    },
    ja: {
      letters: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ーｰ]/gu,
      stack: localStack(
        ['Yu Gothic', 'YuGothic-Regular'], ['Hiragino Sans', 'Hiragino Sans W3'], ['Meiryo'], notoJP,
        ['Noto Sans JP', 'NotoSansJP-Regular'], ['Source Han Sans', 'SourceHanSans-Regular'],
        ['Hiragino Kaku Gothic ProN', 'HiraKakuProN-W3'], ['MS PGothic', 'MS-PGothic'], notoSC, notoKR, notoTC, notoHK
      )
    },
    ko: {
      letters: /[\p{Script=Hangul}\p{Script=Han}]/gu,
      stack: localStack(
        ['Malgun Gothic', 'MalgunGothic'], ['Apple SD Gothic Neo', 'AppleSDGothicNeo-Regular'], notoKR,
        ['Noto Sans KR', 'NotoSansKR-Regular'], ['Source Han Sans K', 'SourceHanSansK-Regular'],
        ['NanumGothic'], notoSC, notoJP, notoTC, notoHK
      )
    },
    en: { letters: /\p{Script=Latin}/gu, stack: western },
    ru: { letters: /\p{Script=Cyrillic}/gu, stack: western }
  };

  modules.font = function createModule(app) {
    const probes = new Map();
    const stylesheets = new Map();
    const styledElements = new Map();
    const localNodes = new Map();
    const readingRoots = new Set();
    const readingSamples = new Map();
    const protectedContent = 'button,input,textarea,select,svg,math,canvas,iframe,object,embed,video,audio,code,pre,kbd,samp,var,[contenteditable]:not([contenteditable="false"]),[data-dsht-skip],[data-dsht-ui]';
    const originalContent = `[${app.BILINGUAL_ATTR}]`;
    const inlineContent = 'a,abbr,b,bdi,bdo,br,cite,del,em,i,ins,mark,q,rp,rt,ruby,rb,s,small,span,strong,sub,sup,time,u,wbr';
    const protectedChildren = `${protectedContent},[translate="no"],.notranslate`;
    const blocked = `:is(${protectedContent},${originalContent},[translate="no"]:not(html,body),.notranslate:not(html,body))`;
    const safeHost = `:not(:has(${protectedChildren})):not(:has(> :not(${inlineContent},${originalContent})))`;
    let enabled = true;
    let pending = new WeakMap();

    // Enlarge only the measuring face so fallback is visible even for equal-width glyphs.
    function getProbe(doc, stack) {
      if (!probes.has(doc)) {
        const view = doc.defaultView;
        const name = `dsht-measure-${view.crypto.getRandomValues(new Uint32Array(2)).join('-')}`;
        const face = new view.FontFace(name, stack.source, { sizeAdjust: '300%' });
        const ready = face.load().then(() => {
          if (probes.get(doc)?.face !== face) return null;
          doc.fonts.add(face);
          return { name, ctx: doc.createElement('canvas').getContext('2d') };
        }, () => null);
        probes.set(doc, { face, ready });
      }
      return probes.get(doc).ready;
    }

    function hasMixedCoverage(probe, style, fontFamily, glyphs, lang, profile) {
      if (!probe.ctx) return false;
      const { ctx, name } = probe;
      ctx.canvas.lang = lang;
      if ('lang' in ctx) ctx.lang = lang || 'inherit';
      const measure = (families, sample) => {
        ctx.font = `${style.fontStyle} ${style.fontWeight} 20px ${families}`;
        return ctx.measureText(sample).width;
      };
      // A family that covers none of the actual translated letters is just a
      // normal fallback step; an unrelated reference letter can give a false hit.
      const probeWidth = measure(name, glyphs);
      for (const family of fontFamily.match(/(?:[^,"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g) || []) {
        const candidate = family.trim();
        if (!candidate) continue;
        const withProbe = `${candidate}, ${name}`;
        const width = measure(withProbe, glyphs);
        if (Math.abs(width - probeWidth) < 0.1) continue;
        return Math.abs(width - measure(`${candidate}, ${profile.stack.family}`, glyphs)) > 0.1;
      }
      return false;
    }

    function readingSelector() {
      const chapter = app.page.novel;
      if (!chapter) return '';
      const adapter = app.novelUtils.SITE_ADAPTERS[chapter.siteId];
      const selectors = [...adapter.chapterRootSelectors, adapter.titleSelector];
      if (chapter.siteId === 'syosetu') {
        if (!chapter.isChapter && !document.querySelector('.p-novel__body, .js-novel-text')) return '';
        selectors.push('.p-novel__author', '.p-novel__date-published', '.p-novel__number',
          '.p-novel__series', '.p-novel__summary');
      } else if (chapter.isChapter) {
        selectors.push(adapter.workTitleSelector, adapter.chapterLabelSelector,
          '#episodeFooter-work-header-workTitle', '#episodeFooter-work-header-author');
      } else {
        return '';
      }
      return `:is(${selectors.filter(Boolean).join(', ')})`;
    }

    function originalReadingLanguage(element) {
      for (let owner = element; owner; owner = owner.parentElement || owner.getRootNode().host) {
        if (owner.hasAttribute('lang')) return owner.getAttribute('lang');
      }
      return null;
    }

    function canInheritLocalFont(child, record) {
      if (child.nodeType === Node.TEXT_NODE) return !child.nodeValue.trim() || record.nodes.get(child) === child.nodeValue;
      if (child.nodeType !== Node.ELEMENT_NODE || child.matches(`br,wbr,${originalContent}`)) return true;
      if (child.matches('ruby') && [...child.childNodes].every((part) =>
        !part.textContent.trim() || part.nodeType === Node.ELEMENT_NODE && part.matches('rt,rp'))) return true;
      // Inline emphasis and links that need the same repair can share the font.
      // A healthy or untranslated child must keep its existing inherited style.
      return child.hasAttribute(record.marker);
    }

    function syncLocalMarker(record) {
      const owned = [...record.element.childNodes].every((child) => canInheritLocalFont(child, record));
      if (owned && record.nodes.size) {
        if (!record.element.hasAttribute(record.marker)) record.element.setAttribute(record.marker, record.value);
      } else {
        record.element.removeAttribute(record.marker);
      }
    }

    function syncLocalAncestors(element) {
      for (let parent = element; parent; parent = parent.parentElement) {
        const record = styledElements.get(parent);
        if (record && !record.reading) syncLocalMarker(record);
      }
    }

    function removeLocalNode(node, record = localNodes.get(node)) {
      if (!record) return;
      if (localNodes.get(node) === record) localNodes.delete(node);
      record.nodes.delete(node);
      syncLocalMarker(record);
      if (record.nodes.size === 0) styledElements.delete(record.element);
      syncLocalAncestors(record.element.parentElement);
    }

    function releaseTranslatedFont(node) {
      pending.delete(node);
      removeLocalNode(node);
    }

    function observeLocalChanges(mutations) {
      for (const mutation of mutations) {
        const parent = mutation.type === 'characterData' ? mutation.target.parentElement : mutation.target;
        const record = styledElements.get(parent);
        for (const [node, value] of record?.nodes || []) {
          if (node.parentElement !== parent || node.nodeValue !== value) removeLocalNode(node, record);
        }
        syncLocalAncestors(parent);
      }
    }

    function clearTranslatedFonts() {
      pending = new WeakMap();
      for (const [scope, { sheet, observer }] of stylesheets) {
        observer.disconnect();
        scope.adoptedStyleSheets = scope.adoptedStyleSheets.filter((item) => item !== sheet);
      }
      for (const [element, record] of styledElements) element.removeAttribute(record.marker);
      for (const [doc, { face }] of probes) doc.fonts.delete(face);
      globalScope.navigation?.removeEventListener('currententrychange', checkReadingRoute);
      probes.clear();
      stylesheets.clear();
      styledElements.clear();
      localNodes.clear();
      readingRoots.clear();
      readingSamples.clear();
    }

    function checkReadingRoute() {
      if (app.page.translatedRoute !== app.currentRoute()) clearTranslatedFonts();
    }

    function styleSelector(marker, readerScope, id) {
      const local = id === undefined ? `[${marker}^="l"]` : `[${marker}="l${id}"]`;
      const reading = id === undefined ? `[${marker}^="r"]` : `[${marker}="r${id}"]`;
      return `:is(${local}${safeHost},${reading}${readerScope}:not(:has(${protectedChildren}))):not(${blocked},${blocked} *)`;
    }

    function stylesheetFor(element, probe, profile) {
      const scope = element.getRootNode();
      let state = stylesheets.get(scope);
      if (!state) {
        const view = element.ownerDocument.defaultView;
        const sheet = new view.CSSStyleSheet();
        const marker = `data-${probe.name}`;
        const selector = scope === document && readingSelector();
        const readerScope = selector ? `:is(${selector}, ${selector} *)` : ':not(*)';
        sheet.replaceSync(`${styleSelector(marker, readerScope)} { font-family: ${profile.stack.family} !important; }`);
        const observer = new view.MutationObserver(observeLocalChanges);
        observer.observe(scope, { childList: true, characterData: true, subtree: true });
        scope.adoptedStyleSheets = [...scope.adoptedStyleSheets, sheet];
        state = { sheet, observer, marker, readerScope, families: new Map() };
        stylesheets.set(scope, state);
        globalScope.navigation?.addEventListener('currententrychange', checkReadingRoute);
      }
      return state;
    }

    function hasInheritedDecoration(element, originalFamily) {
      const view = element.ownerDocument.defaultView;
      // Icon fonts often draw their only glyph on an otherwise empty element.
      // Preserve those glyphs without competing with the author's CSS layers.
      for (const owner of [element, ...element.querySelectorAll(':empty:not(br,wbr)')]) {
        for (const pseudo of ['::before', '::after']) {
          const style = view.getComputedStyle(owner, pseudo);
          if (!['none', 'normal', '""'].includes(style.content) && style.fontFamily === originalFamily) return true;
        }
      }
      return false;
    }

    function markElement(element, originalFamily, probe, profile, reading) {
      let record = styledElements.get(element);
      if (record) return record;
      if (hasInheritedDecoration(element, originalFamily)) return null;
      const { sheet, marker, readerScope, families } = stylesheetFor(element, probe, profile);
      let id = families.get(originalFamily);
      if (id === undefined) {
        id = families.size;
        const selector = styleSelector(marker, readerScope, id);
        sheet.insertRule(`${selector} { --dsht-original-font: ${originalFamily}; }`, sheet.cssRules.length);
        families.set(originalFamily, id);
      }
      const value = `${reading ? 'r' : 'l'}${id}`;
      record = { element, marker, value, originalFamily, reading, nodes: new Map() };
      styledElements.set(element, record);
      if (reading) element.setAttribute(marker, value);
      return record;
    }

    function markReadingRoot(root, probe, profile) {
      if (readingRoots.has(root)) return;
      readingRoots.add(root);
      const owners = new Map();
      const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const ctx = app.newFilterContext();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!node.nodeValue.trim() || owners.has(parent) || styledElements.has(parent) ||
            app.isSkippedParent(parent, ctx) || parent.closest(protectedContent)) continue;
        owners.set(parent, app.getComputedStyleFor(parent).fontFamily);
      }
      for (const [parent, originalFamily] of owners) markElement(parent, originalFamily, probe, profile, true);
    }

    async function updateTranslatedFont(node, translation) {
      const profile = profiles[app.page.targetCode];
      const parent = node.parentElement;
      if (!enabled || !parent || !profile || translation.search(profile.letters) < 0) {
        releaseTranslatedFont(node);
        return;
      }
      const doc = node.ownerDocument;
      const selector = doc === document && readingSelector();
      const readingRoot = selector && parent.closest(selector);
      if (selector && !readingRoot) return;
      const scope = parent.getRootNode();
      const ticket = {};
      pending.set(node, ticket);
      const runId = app.page.runId;
      const isCurrent = () => pending.get(node) === ticket && enabled && app.page.runId === runId &&
        node.isConnected && node.parentElement === parent && parent.getRootNode() === scope &&
        node.nodeValue === translation && app.page.translatedRoute === app.currentRoute() &&
        !app.isSkippedParent(parent, app.newFilterContext()) && !parent.closest(protectedContent) &&
        (selector ? parent.closest(selector) === readingRoot : parent.matches(safeHost) && !parent.shadowRoot);
      const probe = await getProbe(doc, profile.stack);
      if (!probe || !isCurrent()) return;
      const old = styledElements.get(parent);
      const style = app.getComputedStyleFor(parent);
      const fontFamily = old?.originalFamily || style.fontFamily;
      if (readingRoot && readingRoots.size) {
        markReadingRoot(readingRoot, probe, profile);
        markElement(parent, fontFamily, probe, profile, true);
        return;
      }
      const descriptor = `${style.fontStyle} ${style.fontWeight} 20px ${fontFamily}`;
      if (!doc.fonts.check(descriptor, translation)) {
        // A translated character can select a new unicode-range subset. Wait for
        // it to finish loading before measuring the page's effective stack.
        await doc.fonts.load(descriptor, translation).catch(() => {});
        if (!isCurrent() || (readingRoot && readingRoots.size)) return;
      }
      const lang = originalReadingLanguage(parent) || doc.documentElement.lang;
      const letters = new Set(translation.normalize('NFC').match(profile.letters));
      if (readingRoot) {
        // Two paragraphs can each use one complete face, but different faces
        // in the same author stack. Compare against a real letter in this chapter.
        const key = `${descriptor}\0${lang}`;
        const sample = readingSamples.get(key);
        if (sample?.node.isConnected && sample.node.nodeValue === sample.translation &&
            sample.node.parentElement?.closest(selector)) letters.add(sample.letter);
        else readingSamples.set(key, { node, translation, letter: letters.values().next().value });
      }
      const glyphs = [...letters].join('');
      if (!hasMixedCoverage(probe, style, fontFamily, glyphs, lang, profile)) {
        removeLocalNode(node);
        return;
      }
      if (readingRoot) {
        for (const root of doc.querySelectorAll(selector)) markReadingRoot(root, probe, profile);
      } else {
        const record = markElement(parent, fontFamily, probe, profile, false);
        if (!record) return;
        const previous = localNodes.get(node);
        if (previous && previous !== record) removeLocalNode(node, previous);
        record.nodes.set(node, translation);
        localNodes.set(node, record);
        syncLocalAncestors(parent);
      }
    }

    function applyTranslatedFont(node, value) {
      if (enabled) void updateTranslatedFont(node, value).catch(() => {});
    }

    function setFontRepairEnabled(value) {
      const next = value !== false;
      if (enabled === next) return;
      enabled = next;
      clearTranslatedFonts();
      if (enabled) {
        for (const [node, record] of app.page.translatedNodes) {
          if (node.isConnected && record.translated && node.nodeValue === record.translated) {
            applyTranslatedFont(node, record.translated);
          }
        }
      }
    }

    // Styling is best-effort on documents with restricted font or canvas access.
    return { applyTranslatedFont, originalReadingLanguage, releaseTranslatedFont, clearTranslatedFonts, setFontRepairEnabled };
  };
})(globalThis);
