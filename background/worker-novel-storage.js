// All read/modify/write operations for one work share this queue across tabs and options.
const storedNovel = globalThis.DSHT.novel;
const novelWorkWrites = new Map();

async function withNovelWorkWrite(key, operation) {
  const previous = novelWorkWrites.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  novelWorkWrites.set(key, pending);
  try {
    return await pending;
  } finally {
    if (novelWorkWrites.get(key) === pending) novelWorkWrites.delete(key);
  }
}

function novelStorageKeys(chapter, targetCode) {
  return {
    glossaryKey: storedNovel.glossaryKeyForWork(chapter, targetCode),
    metaKey: storedNovel.metaKeyForWork(chapter, targetCode),
    tidyKey: storedNovel.tidyKeyForWork(chapter, targetCode)
  };
}

function currentNovelRequest(message, sender) {
  const request = pretranslationRequest(message, sender);
  const source = storedNovel.detectChapter(sender.tab.url);
  if (source.chapterId !== request.chapter.chapterId) {
    throw new PageAccessError('INVALID_SENDER', t('bg_current_chapter_only'));
  }
  return request;
}

function novelTitle(value) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
}

async function loadNovelContext(message, sender) {
  const { chapter, targetCode } = currentNovelRequest(message, sender);
  const { glossaryKey, metaKey } = novelStorageKeys(chapter, targetCode);
  return withNovelWorkWrite(glossaryKey, async () => {
    const values = await chrome.storage.local.get([glossaryKey, metaKey]);
    const meta = storedNovel.addChapterToMeta(values[metaKey], chapter);
    const title = novelTitle(message.title);
    if (!meta.titleManual && title) meta.title = title;
    else if (!meta.title) meta.title = title;
    await chrome.storage.local.set({ [metaKey]: meta });
    return { chapter, meta, glossary: storedNovel.glossaryForPrompt(storedNovel.mergeGlossary(values[glossaryKey], [])) };
  });
}

async function saveNovelGlossary(message, sender) {
  const { chapter, targetCode } = currentNovelRequest(message, sender);
  if (!Array.isArray(message.terms) || message.terms.length > LIMITS.GLOSSARY_CHAPTER_MAX_TERMS) {
    throw new PageAccessError('INVALID_REQUEST', t('bg_terms_request_invalid'));
  }
  const terms = normalizeGlossaryPayload(message.terms, LIMITS.GLOSSARY_CHAPTER_MAX_TERMS);
  const { glossaryKey, metaKey, tidyKey } = novelStorageKeys(chapter, targetCode);
  return withNovelWorkWrite(glossaryKey, async () => {
    const values = await chrome.storage.local.get([glossaryKey, metaKey, tidyKey]);
    const glossary = storedNovel.mergeGlossary(
      values[glossaryKey], storedNovel.extractedTerms(values[glossaryKey], terms, values[tidyKey])
    );
    const meta = storedNovel.addChapterToMeta(values[metaKey], chapter);
    if (!meta.title) meta.title = novelTitle(message.title);
    if (message.extracted === true && !meta.extractedChapterIds.includes(chapter.chapterId)) {
      meta.chaptersSinceTidy += 1;
      meta.extractedChapterIds = meta.extractedChapterIds.concat(chapter.chapterId).slice(-200);
    }
    await chrome.storage.local.set({ [glossaryKey]: glossary, [metaKey]: meta });
    return { saved: true, meta, glossary: storedNovel.glossaryForPrompt(glossary) };
  });
}

function glossaryEditRequest(message, sender) {
  let fromOptions = false;
  try {
    const source = new URL(sender?.url);
    const options = new URL(chrome.runtime.getURL('options/options.html'));
    fromOptions = source.protocol === options.protocol && source.host === options.host && source.pathname === options.pathname;
  } catch (_error) {}
  if (!fromOptions) {
    throw new PageAccessError('INVALID_SENDER', t('bg_glossary_options_only'));
  }
  const site = Object.hasOwn(storedNovel.SITE_ADAPTERS, message.siteId) && storedNovel.SITE_ADAPTERS[message.siteId];
  const id = typeof message.workId === 'string' ? message.workId : '';
  const workPath = message.siteId === 'syosetu' ? `/${id}/` : `/works/${id}`;
  const chapter = site && storedNovel.detectChapter(`https://${site.hosts[0]}${workPath}`);
  if (!chapter?.isWorkPage || chapter.workId !== id || !['save', 'undo', 'clear'].includes(message.action)) {
    throw new PageAccessError('INVALID_REQUEST', t('bg_glossary_operation_invalid'));
  }
  return { chapter, targetCode: validateTargetCode(message.targetCode) };
}

function editedGlossaryTerms(value, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) {
    throw new PageAccessError('INVALID_REQUEST', t('bg_glossary_keep_one'));
  }
  const terms = value.map(storedNovel.normalizeTerm);
  if (terms.some((term) => !term)) throw new PageAccessError('INVALID_REQUEST', t('bg_glossary_fields_required'));
  return terms;
}

async function handleGlossaryEdit(message, sender) {
  const { chapter, targetCode } = glossaryEditRequest(message, sender);
  const { glossaryKey, metaKey, tidyKey } = novelStorageKeys(chapter, targetCode);
  const terms = message.action === 'save' ? editedGlossaryTerms(message.terms) : null;
  const opened = message.action === 'save' ? editedGlossaryTerms(message.opened, true) : null;
  return withNovelWorkWrite(glossaryKey, async () => {
    if (message.action === 'clear') {
      await chrome.storage.local.remove([glossaryKey, tidyKey]);
      if (typeof cancelGlossaryTidy === 'function') cancelGlossaryTidy(glossaryKey);
      return { cleared: true };
    }
    const values = await chrome.storage.local.get([glossaryKey, metaKey, tidyKey]);
    const tidy = values[tidyKey];
    if (message.action === 'undo') {
      if (!tidy || !Array.isArray(tidy.terms)) return { undone: false };
      if ((tidy.tidiedAt ?? null) !== (message.expectedTidyAt ?? null)) {
        throw new PageAccessError('GLOSSARY_CHANGED', t('bg_glossary_undo_stale'));
      }
      await chrome.storage.local.set({
        [glossaryKey]: storedNovel.undoneTerms(tidy, values[glossaryKey]),
        [tidyKey]: { removed: Array.isArray(tidy.earlierRemoved) ? tidy.earlierRemoved : [] }
      });
      if (typeof cancelGlossaryTidy === 'function') cancelGlossaryTidy(glossaryKey);
      return { undone: true };
    }
    if ((tidy?.tidiedAt ?? null) !== (message.expectedTidyAt ?? null)) {
      throw new PageAccessError('GLOSSARY_CHANGED', t('bg_glossary_draft_stale'));
    }
    const merged = storedNovel.withNewStoredTerms(terms, values[glossaryKey], opened);
    const meta = storedNovel.normalizeMeta(values[metaKey]) || storedNovel.addChapterToMeta(null, chapter);
    meta.title = novelTitle(message.title) || meta.title || chapter.workId;
    meta.titleManual = true;
    await chrome.storage.local.set({ [glossaryKey]: merged, [metaKey]: meta });
    return { saved: true, count: merged.length };
  });
}
