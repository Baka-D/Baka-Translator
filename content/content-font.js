/** Detect partial Han coverage in page fonts and repair the translated reading area. */
(function registerContentModule(globalScope) {
  'use strict';
  const modules = globalScope.DSHT.contentModules ||= {};
  modules.font = function createModule(app) {
    const chineseFonts = [
      'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Noto Sans SC',
      'Source Han Sans SC', 'WenQuanYi Micro Hei', 'Droid Sans Fallback', 'SimSun'
    ];
    const fontFamily = chineseFonts.map((name) => `"${name}"`).concat('sans-serif').join(', ');
    // CSS local() can require an individual face's full or PostScript name.
    const probeSource = [...chineseFonts, 'PingFangSC-Regular', 'NotoSansCJKsc-Regular',
      'NotoSansSC-Regular', 'SourceHanSansSC-Regular'].map((font) => `local("${font}")`).join(', ');
    const probes = new Map();
    const wrappers = new Map();
    const readingRoots = new Set();
    let readingSheet = null;
    let readingMarker = '';

    // A CJK glyph usually has the same advance in two different fonts. Enlarge a
    // local Chinese face *only on the measuring canvas* so fallback is observable.
    function getProbe(doc) {
      if (!probes.has(doc)) {
        const view = doc.defaultView;
        const name = `dsht-measure-${view.crypto.getRandomValues(new Uint32Array(2)).join('-')}`;
        const face = new view.FontFace(name, probeSource, { sizeAdjust: '300%' });
        const ready = face.load().then(() => {
          if (probes.get(doc)?.face !== face) return null;
          doc.fonts.add(face);
          return { name, ctx: doc.createElement('canvas').getContext('2d') };
        }, () => null);
        probes.set(doc, { face, ready });
      }
      return probes.get(doc).ready;
    }

    function hasMixedCoverage(probe, style, text, lang) {
      if (!probe.ctx) return false;
      const glyphs = Array.from(new Set(text.match(/\p{Script=Han}/gu))).join('');
      const { ctx, name } = probe;
      ctx.canvas.lang = lang;
      if ('lang' in ctx) ctx.lang = lang || 'inherit';
      const measure = (families, sample) => {
        ctx.font = `${style.fontStyle} ${style.fontWeight} 20px ${families}`;
        return ctx.measureText(sample).width;
      };
      // Some stacks put a Latin-only face ahead of a perfectly good CJK face.
      // Only assess the first family that actually supplies Chinese characters.
      const reference = '中日' + glyphs;
      const probeWidth = measure(name, reference);
      for (const family of style.fontFamily.match(/(?:[^,"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g) || []) {
        const candidate = family.trim();
        if (!candidate) continue;
        const withProbe = `${candidate}, ${name}`;
        if (Math.abs(measure(withProbe, reference) - probeWidth) < 0.1) continue;
        return Math.abs(measure(withProbe, glyphs) - measure(`${candidate}, ${fontFamily}`, glyphs)) > 0.1;
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

    function releaseTranslatedFont(node) {
      const wrapper = wrappers.get(node);
      if (!wrapper) return;
      wrappers.delete(node);
      if (wrapper.parentNode) wrapper.replaceWith(...wrapper.childNodes);
    }

    function clearTranslatedFonts() {
      for (const node of wrappers.keys()) releaseTranslatedFont(node);
      for (const [doc, { face }] of probes) doc.fonts.delete(face);
      probes.clear();
      if (readingSheet) {
        globalScope.navigation?.removeEventListener('currententrychange', checkReadingRoute);
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== readingSheet);
        for (const root of readingRoots) root.removeAttribute(readingMarker);
        readingRoots.clear();
        readingSheet = null;
      }
    }

    function checkReadingRoute() {
      if (app.page.translatedRoute !== app.currentRoute()) clearTranslatedFonts();
    }

    function markReadingRoot(root) {
      if (readingRoots.has(root)) return;
      root.setAttribute(readingMarker, '');
      readingRoots.add(root);
    }

    async function updateTranslatedFont(node, translation) {
      if (app.page.targetCode !== 'zh' || !/\p{Script=Han}/u.test(translation)) {
        releaseTranslatedFont(node);
        return;
      }
      const doc = node.ownerDocument;
      const selector = doc === document && readingSelector();
      if (selector) {
        const root = node.parentElement?.closest(selector);
        if (!root) return;
        if (readingSheet) {
          markReadingRoot(root);
          return;
        }
      }
      const runId = app.page.runId;
      const probe = await getProbe(doc);
      const isCurrent = () => runId === app.page.runId && node.isConnected &&
        node.nodeValue === translation && app.page.translatedRoute === app.currentRoute();
      if (!probe || !isCurrent()) return;
      if (selector && readingSheet) return;
      const wrapper = wrappers.get(node);
      const parent = wrapper?.parentElement || node.parentElement;
      if (!parent) return;
      const style = app.getComputedStyleFor(parent);
      const descriptor = `${style.fontStyle} ${style.fontWeight} 20px ${style.fontFamily}`;
      if (!doc.fonts.check(descriptor, translation)) {
        // A translated character can select a new unicode-range subset of a web
        // font. Measure after the page has loaded the matching faces.
        // A failed face leaves the next family in the page's stack in use.
        await doc.fonts.load(descriptor, translation).catch(() => {});
        if (!isCurrent() || (selector && readingSheet)) return;
      }
      const lang = parent.closest('[lang]')?.lang || doc.documentElement.lang;
      if (!hasMixedCoverage(probe, style, translation, lang)) {
        releaseTranslatedFont(node);
        return;
      }
      if (selector) {
        const sheet = new CSSStyleSheet();
        readingMarker = `data-${probe.name}`;
        sheet.replaceSync(`[${readingMarker}], [${readingMarker}] * { font-family: ${fontFamily} !important; }`);
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
        readingSheet = sheet;
        for (const root of doc.querySelectorAll(selector)) markReadingRoot(root);
        globalScope.navigation?.addEventListener('currententrychange', checkReadingRoute);
      } else if (!wrapper) {
        const span = doc.createElement('span');
        span.lang = 'zh-Hans';
        span.style.setProperty('all', 'inherit', 'important');
        span.style.setProperty('display', 'contents', 'important');
        span.style.setProperty('font-family', fontFamily, 'important');
        parent.insertBefore(span, node);
        span.append(node);
        wrappers.set(node, span);
      }
    }

    // Styling is best-effort on documents with restricted font or canvas access.
    return {
      applyTranslatedFont: (node, value) => { void updateTranslatedFont(node, value).catch(() => {}); },
      releaseTranslatedFont,
      clearTranslatedFonts
    };
  };
})(globalThis);
