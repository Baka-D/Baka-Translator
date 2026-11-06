/**
 * Light-novel site adapters and pure helpers.
 *
 * Chapter detection is URL-pattern based so a table-of-contents or work home
 * page can never be mistaken for a chapter. DOM-based next-link discovery is
 * deliberately restricted to the same site and the same work.
 */
(function initNovel(globalScope) {
  'use strict';

  const glossary =
    (globalScope.DSHT && globalScope.DSHT.glossary) ||
    (typeof require === 'function' ? require('./glossary.js') : null);

  const MAX_CACHE_CHAPTERS = 30;
  const MAX_CACHE_ENTRIES = 4500;

  const SITE_ADAPTERS = Object.freeze({
    syosetu: {
      id: 'syosetu',
      name: '小説家になろう',
      hosts: ['ncode.syosetu.com'],
      chapterPattern: /^\/([a-z]\d+[a-z0-9]*)\/(\d+)\/?$/i,
      workPattern: /^\/([a-z]\d+[a-z0-9]*)\/?$/i,
      chapterRootSelectors: ['.p-novel__body .js-novel-text', '.js-novel-text', '.p-novel__body'],
      nextSelectors: ['a.c-pager__item--next'],
      previousSelectors: ['a.c-pager__item--before'],
      afterwordSelector: '.p-novel__text--afterword',
      titleSelector: '.p-novel__title',
      workTitleSelector: '',
      chapterLabelSelector: '.p-novel__number'
    },
    kakuyomu: {
      id: 'kakuyomu',
      name: 'カクヨム',
      hosts: ['kakuyomu.jp'],
      chapterPattern: /^\/works\/(\d+)\/episodes\/(\d+)\/?$/,
      workPattern: /^\/works\/(\d+)\/?$/,
      chapterRootSelectors: [
        '#contentMain .widget-episodeBody',
        '#contentMain .js-episode-body',
        '.widget-episodeBody'
      ],
      nextSelectors: ['#contentMain-readNextEpisode', 'a.js-read-next-episode'],
      previousSelectors: ['#contentMain-readPreviousEpisode'],
      afterwordSelector: '',
      titleSelector: '.widget-episodeTitle',
      workTitleSelector: '#contentMain-header-workTitle',
      chapterLabelSelector: ''
    }
  });

  const ADAPTER_LIST = Object.values(SITE_ADAPTERS);

  function hostMatches(host, adapter) {
    const value = String(host || '').toLowerCase();
    return adapter.hosts.some(
      (candidate) => value === candidate || value === `www.${candidate}`
    );
  }

  function adapterForUrl(urlLike) {
    let url;
    try {
      url = new URL(String(urlLike || ''), 'https://invalid.invalid');
    } catch (_error) {
      return null;
    }
    const host = url.hostname.toLowerCase();
    return ADAPTER_LIST.find((adapter) => hostMatches(host, adapter)) || null;
  }

  function siteIdForUrl(urlLike) {
    const adapter = adapterForUrl(urlLike);
    return adapter ? adapter.id : '';
  }

  function normalizePath(pathname) {
    const value = String(pathname || '');
    if (value.length > 1 && value.endsWith('/')) return value.slice(0, -1);
    return value;
  }

  /**
   * Detect a supported light-novel page from its URL.
   * @returns {object|null}
   */
  function detectChapter(urlLike) {
    let url;
    try {
      url = new URL(String(urlLike || ''));
    } catch (_error) {
      return null;
    }
    const adapter = adapterForUrl(url.href);
    if (!adapter) return null;
    const pathname = normalizePath(url.pathname);
    const chapterMatch = pathname.match(adapter.chapterPattern);
    const workMatch = pathname.match(adapter.workPattern);
    const isChapter = Boolean(chapterMatch);
    if (!isChapter && !workMatch) return null;

    const workId = isChapter ? chapterMatch[1] : workMatch[1];
    const chapterId = isChapter ? chapterMatch[2] : '';
    const workUrl =
      adapter.id === 'syosetu'
        ? `${url.origin}/${workId}/`
        : `${url.origin}/works/${workId}`;
    const canonicalUrl = isChapter ? `${url.origin}${pathname}` : workUrl;
    return {
      siteId: adapter.id,
      siteName: adapter.name,
      host: url.hostname.toLowerCase(),
      workId,
      chapterId,
      chapterOrder: isChapter && /^\d+$/.test(chapterId) ? Number(chapterId) : null,
      workUrl,
      canonicalUrl,
      isChapter,
      isWorkPage: !isChapter,
      isToc: !isChapter
    };
  }

  function isSupportedUrl(urlLike) {
    return Boolean(adapterForUrl(urlLike));
  }

  function cacheKeyForChapter(chapter) {
    if (!chapter || !chapter.isChapter) return '';
    return `novelCache:${chapter.siteId}:${chapter.workId}:${chapter.chapterId}`;
  }

  function workKey(chapter) {
    if (!chapter || !chapter.workId) return '';
    return `novelWork:${chapter.siteId}:${chapter.workId}`;
  }

  function languageSuffix(targetCode) {
    const target = String(targetCode || 'zh').toLowerCase();
    return target === 'zh' ? '' : `:${target}`;
  }

  function glossaryKeyForWork(chapter, targetCode) {
    if (!chapter || !chapter.workId) return '';
    return `novelGlossary:${chapter.siteId}:${chapter.workId}${languageSuffix(targetCode)}`;
  }

  function metaKeyForWork(chapter, targetCode) {
    if (!chapter || !chapter.workId) return '';
    return `novelMeta:${chapter.siteId}:${chapter.workId}${languageSuffix(targetCode)}`;
  }

  function cacheKeyForWork(chapter) {
    return workKey(chapter) ? `${workKey(chapter)}:cache` : '';
  }

  function findChapterRoot(doc, chapter) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    const adapter = chapter && SITE_ADAPTERS[chapter.siteId];
    if (!adapter) return null;
    for (const selector of adapter.chapterRootSelectors) {
      try {
        const node = doc.querySelector(selector);
        if (node && String(node.textContent || '').trim()) return node;
      } catch (_error) {
        // Ignore unsupported selectors.
      }
    }
    return null;
  }

  function findChapterRoots(doc, chapter) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const adapter = chapter && SITE_ADAPTERS[chapter.siteId];
    if (!adapter) return [];
    for (const selector of adapter.chapterRootSelectors) {
      try {
        const nodes = Array.from(doc.querySelectorAll(selector))
          .filter((node) => String(node.textContent || '').trim());
        if (nodes.length > 0) return nodes;
      } catch (_error) {
        // Ignore unsupported selectors.
      }
    }
    return [];
  }

  function selectorText(doc, selector) {
    if (!doc || !selector) return '';
    try {
      const node = doc.querySelector(selector);
      return node ? String(node.textContent || '').trim() : '';
    } catch (_error) {
      return '';
    }
  }

  function getTitle(doc, chapter) {
    const adapter = chapter && SITE_ADAPTERS[chapter.siteId];
    return adapter ? selectorText(doc, adapter.titleSelector) : '';
  }

  /** Novel/work title, not the title of the current chapter. */
  function getWorkTitle(doc, chapter) {
    if (!doc || !chapter) return '';
    const adapter = SITE_ADAPTERS[chapter.siteId];
    if (!adapter) return '';
    const selected = selectorText(doc, adapter.workTitleSelector);
    if (selected) return selected;
    const title = String(doc.title || '').trim();
    if (!title) return '';
    if (adapter.id === 'syosetu') {
      // "作品名 - 話タイトル"; the work title itself may contain " - ".
      const episode = getTitle(doc, chapter);
      const suffix = episode ? ` - ${episode}` : '';
      if (suffix && title.endsWith(suffix)) return title.slice(0, -suffix.length).trim();
      const match = title.match(/^(.*\S)\s+-\s+/);
      return match ? match[1].trim() : '';
    }
    if (adapter.id === 'kakuyomu') {
      const withoutSite = title.replace(/\s+-\s+カクヨム\s*$/, '').trim();
      const parts = withoutSite.split(/\s+-\s+/);
      return parts.length > 1 ? parts.slice(1).join(' - ').trim() : '';
    }
    return '';
  }

  function getChapterLabel(doc, chapter) {
    const adapter = chapter && SITE_ADAPTERS[chapter.siteId];
    return adapter ? selectorText(doc, adapter.chapterLabelSelector) : '';
  }

  function candidateHref(anchor) {
    if (!anchor) return '';
    const href =
      (typeof anchor.getAttribute === 'function' && anchor.getAttribute('href')) ||
      anchor.href ||
      '';
    return String(href || '').trim();
  }

  function nextFromAnchor(anchor, baseUrl, chapter) {
    const href = candidateHref(anchor);
    if (!href) return '';
    let next;
    try {
      next = new URL(href, baseUrl);
    } catch (_error) {
      return '';
    }
    const candidate = detectChapter(next.href);
    if (!candidate || !candidate.isChapter) return '';
    if (candidate.siteId !== chapter.siteId) return '';
    if (candidate.workId !== chapter.workId) return '';
    if (candidate.chapterId === chapter.chapterId) return '';
    return candidate.canonicalUrl;
  }

  /**
   * Find the next chapter URL from the current already-rendered chapter.
   * Returns '' for TOC/home pages and for the last chapter.
   */
  function findNextChapterUrl(doc, currentUrl) {
    const chapter = detectChapter(currentUrl);
    if (!chapter || !chapter.isChapter || !doc) return '';
    const adapter = SITE_ADAPTERS[chapter.siteId];
    if (!adapter) return '';

    for (const selector of adapter.nextSelectors) {
      try {
        const anchors = doc.querySelectorAll(selector);
        for (const anchor of anchors) {
          const next = nextFromAnchor(anchor, currentUrl, chapter);
          if (next) return next;
        }
      } catch (_error) {
        // Ignore selector errors.
      }
    }

    let anchors = [];
    try {
      anchors = Array.from(doc.querySelectorAll('a[href]'));
    } catch (_error) {
      anchors = [];
    }
    const nextPattern = /(次へ|次章|次の|next)/i;
    for (const anchor of anchors) {
      const text = String(
        (typeof anchor.textContent === 'string' ? anchor.textContent : '') || ''
      ).trim();
      if (!nextPattern.test(text)) continue;
      const next = nextFromAnchor(anchor, currentUrl, chapter);
      if (next) return next;
    }
    return '';
  }

  /** Find the previous chapter URL; '' for the first chapter and TOC pages. */
  function findPreviousChapterUrl(doc, currentUrl) {
    const chapter = detectChapter(currentUrl);
    if (!chapter || !chapter.isChapter || !doc) return '';
    for (const selector of SITE_ADAPTERS[chapter.siteId].previousSelectors) {
      try {
        for (const anchor of doc.querySelectorAll(selector)) {
          const previous = nextFromAnchor(anchor, currentUrl, chapter);
          if (previous) return previous;
        }
      } catch (_error) {
        // Ignore selector errors.
      }
    }
    return '';
  }

  function normalizeSourceText(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/\r\n?/g, '\n')
      .trim();
  }

  /**
   * Match cached source paragraphs to the current page's segment array.
   * Cached records store sources, because segment ids are page-local.
   */
  function mapCachedTranslations(segments, entries) {
    const queues = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry !== 'object') continue;
      const source = normalizeSourceText(entry.source);
      const translation = normalizeSourceText(entry.translation);
      if (!source || !translation) continue;
      if (!queues.has(source)) queues.set(source, []);
      queues.get(source).push(translation);
    }

    const translations = [];
    let matched = 0;
    const list = Array.isArray(segments) ? segments : [];
    for (const segment of list) {
      const source = normalizeSourceText(segment && segment.text);
      const queue = queues.get(source);
      if (!queue || queue.length === 0) continue;
      translations.push({
        id: String(segment && segment.id !== undefined ? segment.id : matched + 1),
        text: queue.shift()
      });
      matched += 1;
    }
    return {
      translations,
      matched,
      total: list.length,
      complete: list.length > 0 && matched === list.length
    };
  }

  function normalizeCacheRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const entries = [];
    for (const item of Array.isArray(raw.entries) ? raw.entries : []) {
      if (!item || typeof item !== 'object') continue;
      const source = normalizeSourceText(item.source);
      const translation = normalizeSourceText(item.translation);
      if (!source || !translation) continue;
      entries.push({ source, translation });
    }
    if (entries.length === 0) return null;
    const chapter = detectChapter(raw.chapterUrl || '');
    const cost = Number(raw.costUsd);
    return {
      chapterUrl: String(raw.chapterUrl || ''),
      canonicalUrl: String(raw.canonicalUrl || (chapter ? chapter.canonicalUrl : '') || ''),
      siteId: String(raw.siteId || (chapter ? chapter.siteId : '') || ''),
      workId: String(raw.workId || (chapter ? chapter.workId : '') || ''),
      chapterId: String(raw.chapterId || (chapter ? chapter.chapterId : '') || ''),
      chapterTitle: String(raw.chapterTitle || '').trim(),
      targetCode: String(raw.targetCode || '').trim(),
      bilingual: raw.bilingual === true,
      polished: raw.polished === true,
      costUsd: Number.isFinite(cost) && cost > 0 ? cost : 0,
      translationKey: typeof raw.translationKey === 'string' ? raw.translationKey : '',
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : 0,
      entries: entries.slice(0, MAX_CACHE_ENTRIES)
    };
  }

  /** Records from before keys existed have none and stay usable. */
  function cacheMatchesSettings(record, translationKey) {
    return !record.translationKey || record.translationKey === translationKey;
  }

  function normalizeMeta(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const chapters = Array.isArray(raw.chapterIds)
      ? Array.from(
          new Set(
            raw.chapterIds
              .map((value) => String(value || '').trim())
              .filter(Boolean)
          )
        )
      : [];
    const extracted = Array.isArray(raw.extractedChapterIds)
      ? Array.from(
          new Set(
            raw.extractedChapterIds
              .map((value) => String(value || '').trim())
              .filter(Boolean)
          )
        )
      : [];
    return {
      siteId: String(raw.siteId || ''),
      workId: String(raw.workId || ''),
      title: String(raw.title || '').trim(),
      titleManual: raw.titleManual === true,
      chapterIds: chapters.slice(-200),
      extractedChapterIds: extracted.slice(-200)
    };
  }

  function addChapterToMeta(raw, chapter) {
    const meta =
      normalizeMeta(raw) || {
        siteId: chapter.siteId,
        workId: chapter.workId,
        title: '',
        titleManual: false,
        chapterIds: [],
        extractedChapterIds: []
      };
    if (chapter && chapter.chapterId && !meta.chapterIds.includes(chapter.chapterId)) {
      meta.chapterIds.push(chapter.chapterId);
      meta.chapterIds = meta.chapterIds.slice(-200);
    }
    return meta;
  }

  const api = Object.freeze({
    ...glossary,
    SITE_ADAPTERS,
    MAX_CACHE_CHAPTERS,
    MAX_CACHE_ENTRIES,
    siteIdForUrl,
    isSupportedUrl,
    detectChapter,
    adapterForUrl,
    findChapterRoot,
    findChapterRoots,
    getTitle,
    getWorkTitle,
    getChapterLabel,
    findNextChapterUrl,
    findPreviousChapterUrl,
    mapCachedTranslations,
    cacheMatchesSettings,
    normalizeCacheRecord,
    normalizeMeta,
    addChapterToMeta,
    cacheKeyForChapter,
    cacheKeyForWork,
    glossaryKeyForWork,
    metaKeyForWork,
    workKey,
    normalizeSourceText
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.novel = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof self !== 'undefined'
      ? self
      : this
);
