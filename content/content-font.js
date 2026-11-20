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
      lang: 'zh-Hans', letters: /\p{Script=Han}/gu,
      stack: localStack(
        ['Microsoft YaHei', 'MicrosoftYaHei'], ['PingFang SC', 'PingFangSC-Regular'], notoSC,
        ['Noto Sans SC', 'NotoSansSC-Regular'], ['Source Han Sans SC', 'SourceHanSansSC-Regular'],
        ['WenQuanYi Micro Hei', 'WenQuanYiMicroHei'], ['Droid Sans Fallback', 'DroidSansFallback'],
        ['SimSun'], ['Microsoft JhengHei', 'MicrosoftJhengHei'], notoTC, notoHK, notoJP, notoKR
      )
    },
    ja: {
      lang: 'ja', letters: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ーｰ]/gu,
      stack: localStack(
        ['Yu Gothic', 'YuGothic-Regular'], ['Hiragino Sans', 'Hiragino Sans W3'], ['Meiryo'], notoJP,
        ['Noto Sans JP', 'NotoSansJP-Regular'], ['Source Han Sans', 'SourceHanSans-Regular'],
        ['Hiragino Kaku Gothic ProN', 'HiraKakuProN-W3'], ['MS PGothic', 'MS-PGothic'], notoSC, notoKR, notoTC, notoHK
      )
    },
    ko: {
      lang: 'ko', letters: /[\p{Script=Hangul}\p{Script=Han}]/gu,
      stack: localStack(
        ['Malgun Gothic', 'MalgunGothic'], ['Apple SD Gothic Neo', 'AppleSDGothicNeo-Regular'], notoKR,
        ['Noto Sans KR', 'NotoSansKR-Regular'], ['Source Han Sans K', 'SourceHanSansK-Regular'],
        ['NanumGothic'], notoSC, notoJP, notoTC, notoHK
      )
    },
    en: { lang: 'en', letters: /\p{Script=Latin}/gu, stack: western },
    ru: { lang: 'ru', letters: /\p{Script=Cyrillic}/gu, stack: western }
  };

  modules.font = function createModule(app) {
    const probes = new Map();
    const wrappers = new Map();
    const readingRoots = new Set();
    const originalLanguages = new Map();
    let readingSheet = null;
    let readingMarker = '';

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

    function hasMixedCoverage(probe, style, glyphs, lang, profile) {
      if (!probe.ctx) return false;
      const { ctx, name } = probe;
      ctx.canvas.lang = lang;
      if ('lang' in ctx) ctx.lang = lang || 'inherit';
      const measure = (families, sample) => {
        ctx.font = `${style.fontStyle} ${style.fontWeight} 20px ${families}`;
        return ctx.measureText(sample).width;
      };
      // Skip families that contribute none of the actual translated letters.
      const probeWidth = measure(name, glyphs);
      for (const family of style.fontFamily.match(/(?:[^,"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g) || []) {
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
        for (const [element, { original, applied }] of originalLanguages) {
          if (element.getAttribute('lang') !== applied) continue;
          if (original === null) element.removeAttribute('lang');
          else element.setAttribute('lang', original);
        }
        originalLanguages.clear();
        readingSheet = null;
      }
    }

    function checkReadingRoute() {
      if (app.page.translatedRoute !== app.currentRoute()) clearTranslatedFonts();
    }

    function originalReadingLanguage(element) {
      // Dynamic captions can be created after the reading roots have been marked.
      for (let owner = element; owner; owner = owner.parentElement || owner.getRootNode().host) {
        const current = owner.getAttribute('lang');
        const record = originalLanguages.get(owner);
        const original = record && current === record.applied ? record.original : current;
        if (original !== null) return original;
      }
      return null;
    }

    function markReadingLanguage(element, lang) {
      if (originalLanguages.has(element)) return;
      originalLanguages.set(element, { original: element.getAttribute('lang'), applied: lang });
      element.setAttribute('lang', lang);
    }

    function markReadingRoot(root, lang) {
      if (readingRoots.has(root)) return;
      root.setAttribute(readingMarker, '');
      readingRoots.add(root);
      markReadingLanguage(root, lang);
      for (const child of root.querySelectorAll('[lang]')) {
        if (!child.closest(`[${app.BILINGUAL_ATTR}]`)) markReadingLanguage(child, lang);
      }
    }

    async function updateTranslatedFont(node, translation) {
      const profile = profiles[app.page.targetCode];
      if (!profile || translation.search(profile.letters) < 0) {
        releaseTranslatedFont(node);
        return;
      }
      const doc = node.ownerDocument;
      const selector = doc === document && readingSelector();
      if (selector) {
        const root = node.parentElement?.closest(selector);
        if (!root) return;
        if (readingSheet) {
          markReadingRoot(root, profile.lang);
          for (let child = node.parentElement; child !== root; child = child.parentElement) {
            if (child.hasAttribute('lang')) markReadingLanguage(child, profile.lang);
          }
          return;
        }
      }
      const runId = app.page.runId;
      const probe = await getProbe(doc, profile.stack);
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
      const glyphs = [...new Set(translation.normalize('NFC').match(profile.letters))].join('');
      if (!hasMixedCoverage(probe, style, glyphs, lang, profile)) {
        releaseTranslatedFont(node);
        return;
      }
      if (selector) {
        const sheet = new CSSStyleSheet();
        readingMarker = `data-${probe.name}`;
        sheet.replaceSync(`[${readingMarker}], [${readingMarker}] * { font-family: ${profile.stack.family} !important; }`);
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
        readingSheet = sheet;
        for (const root of doc.querySelectorAll(selector)) markReadingRoot(root, profile.lang);
        globalScope.navigation?.addEventListener('currententrychange', checkReadingRoute);
      } else if (!wrapper) {
        const span = doc.createElement('span');
        span.lang = profile.lang;
        span.style.setProperty('all', 'inherit', 'important');
        span.style.setProperty('display', 'contents', 'important');
        span.style.setProperty('font-family', profile.stack.family, 'important');
        parent.insertBefore(span, node);
        span.append(node);
        wrappers.set(node, span);
      }
    }

    // Styling is best-effort on documents with restricted font or canvas access.
    return {
      applyTranslatedFont: (node, value) => { void updateTranslatedFont(node, value).catch(() => {}); },
      originalReadingLanguage,
      releaseTranslatedFont,
      clearTranslatedFonts
    };
  };
})(globalThis);
