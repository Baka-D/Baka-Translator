// Service-worker helpers; loaded in the worker global scope.

function contentScriptFilesFor(tabId, recipient = { frameId: 0 }) {
  return chrome.scripting.executeScript({
    target: recipient.documentId
      ? { tabId, documentIds: [recipient.documentId] }
      : { tabId, frameIds: [recipient.frameId] },
    files: CONTENT_SCRIPTS
  });
}

async function frameDocument(tabId, frameId, expectedUrl) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: () => location.href
  });
  const frame = results.find((item) => item.frameId === frameId);
  if (!frame || typeof frame.documentId !== 'string' || !frame.documentId ||
      typeof frame.result !== 'string' || (expectedUrl && frame.result !== expectedUrl)) {
    throw pageError('NO_PAGE_ACCESS');
  }
  return { documentId: frame.documentId, url: frame.result };
}

function isRestrictedUrl(url) {
  return config.isRestrictedUrl(url);
}

function pageError(code, message) {
  return new PageAccessError(code, message || PAGE_ACCESS_ERRORS[code] || PAGE_ACCESS_ERRORS.NO_PAGE_ACCESS);
}

function describeInjectionFailure(error, tab) {
  const raw = String((error && error.message) || error || '');
  const url = tab && tab.url ? tab.url : '';
  // Let each browser identify its own protected HTTPS pages (for example Edge Add-ons).
  if (isRestrictedUrl(url) || /extensions gallery cannot be scripted|cannot access (?:a |an )?(?:chrome|brave|edge):\/\//i.test(raw)) {
    return pageError('UNSUPPORTED_PAGE');
  }
  if (url.startsWith('file://')) {
    return pageError('FILE_ACCESS_DISABLED');
  }
  if (/extension manifest must request permission|cannot access contents of the page|cannot access a chrome|cannot access contents/i.test(raw)) {
    return pageError('NO_PAGE_ACCESS');
  }
  if (/no tab with id|tab was closed/i.test(raw)) {
    return pageError('TAB_CLOSED');
  }
  return pageError('NO_PAGE_ACCESS');
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (_error) {
    throw pageError('TAB_CLOSED');
  }
}

async function injectContentScripts(tabId, recipient = { frameId: 0 }) {
  const tab = await getTab(tabId);
  if (isRestrictedUrl(tab.url)) throw pageError('UNSUPPORTED_PAGE');
  try {
    await contentScriptFilesFor(tabId, recipient);
  } catch (error) {
    throw describeInjectionFailure(error, tab);
  }
}

async function pingContent(tabId, recipient = { frameId: 0 }) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MSG.PING }, recipient);
    return Boolean(response && response.ok);
  } catch (_error) {
    return false;
  }
}

async function ensureContentScript(tabId, recipient = { frameId: 0 }) {
  if (await pingContent(tabId, recipient)) return;
  await injectContentScripts(tabId, recipient);

  // executeScript resolves after the script has run, but give Chrome one short
  // retry for very slow frames.
  if (await pingContent(tabId, recipient)) return;
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (await pingContent(tabId, recipient)) return;
  throw pageError('NO_PAGE_ACCESS');
}

/** The frame holding the selection, by document so a navigation cannot receive the request. */
async function selectionRecipient(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    injectImmediately: true,
    // hasFocus() is also true for the ancestors of a focused frame.
    func: () => ({ selected: Boolean(getSelection()?.toString().trim()),
      focused: document.hasFocus() && !/^I?FRAME$/.test(document.activeElement?.tagName || '') })
  }).catch(() => []);
  const selected = results.filter((item) => item.result?.selected && item.documentId);
  // The popup holds the focus itself, so there the selection alone has to decide.
  const focused = results.find((item) => item.result?.focused);
  const frame = focused ? selected.find((item) => item === focused)
    : selected.find((item) => item.frameId === 0) || selected[0];
  return frame && frame.frameId !== 0 ? { documentId: frame.documentId } : { frameId: 0 };
}

async function sendToContent(tabId, message, recipient = { frameId: 0 }) {
  await ensureContentScript(tabId, recipient);
  return chrome.tabs.sendMessage(tabId, message, recipient);
}

async function getPageInfo(tabId) {
  return sendToContent(tabId, { type: MSG.PAGE_INFO });
}

function createMenu(item) {
  return new Promise((resolve) => {
    chrome.contextMenus.create(item, () => {
      // Duplicate ids can happen during hot reload; they are harmless.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

async function setupContextMenus() {
  await new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      resolve();
    });
  });

  await createMenu({
    id: MENU_IDS.ROOT,
    title: 'Baka Translator',
    contexts: ['page', 'selection', 'image']
  });
  await createMenu({
    id: MENU_IDS.SELECTION,
    parentId: MENU_IDS.ROOT,
    title: t('bg_menu_selection'),
    contexts: ['selection']
  });
  await createMenu({
    id: MENU_IDS.PAGE,
    parentId: MENU_IDS.ROOT,
    title: t('bg_menu_page'),
    contexts: ['page']
  });
  await createMenu({
    id: MENU_IDS.RESTORE,
    parentId: MENU_IDS.ROOT,
    title: t('bg_menu_restore'),
    contexts: ['page']
  });
  await createMenu({
    id: MENU_IDS.IMAGES,
    parentId: MENU_IDS.ROOT,
    title: t('bg_menu_images'),
    contexts: ['page', 'image']
  });
  await syncVisionContextMenu();
}

function setBadge(tabId, status, targetLabel) {
  const states = {
    running: { text: t('bg_badge_text'), color: '#4D6BFE', title: t('bg_badge_running') },
    done: { text: t('bg_badge_text'), color: '#0F9D58', title: t('bg_badge_done', [targetLabel || t('bg_target_language')]) },
    partial: { text: '!', color: '#D97706', title: t('bg_badge_partial') },
    error: { text: '!', color: '#DC2626', title: t('bg_badge_error') },
    idle: { text: '', color: '#4D6BFE', title: 'Baka Translator' }
  };
  const state = states[status] || states.idle;
  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color: state.color }, () => {
      void chrome.runtime.lastError;
    });
    chrome.action.setBadgeText({ tabId, text: state.text }, () => {
      void chrome.runtime.lastError;
    });
    chrome.action.setTitle({ tabId, title: state.title }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_error) {
    // The tab may have been closed between the message and this call.
  }
}

function clearBadgeSoon(tabId, text, reason) {
  try {
    chrome.action.setTitle({ tabId, title: t('bg_badge_reason', [reason]) }, () => {
      void chrome.runtime.lastError;
    });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#D97706' }, () => {
      void chrome.runtime.lastError;
    });
    chrome.action.setBadgeText({ tabId, text }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_error) {
    return;
  }
  // The reason stays in the title for hovering; the next navigation resets it.
  setTimeout(() => {
    try {
      chrome.action.setBadgeText({ tabId, text: '' }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // Tab closed.
    }
  }, 3200);
}

function errorPayload(error) {
  const code = (error && error.code) || 'UNKNOWN_ERROR';
  let message = (error && error.message) || t('bg_unknown_error');
  if (error instanceof api.ApiError) {
    return { ...api.getErrorPayload(error), discardedBilling: error.discardedBilling };
  }
  if (code === 'MISSING_API_KEY') message = PAGE_ACCESS_ERRORS.NO_API_KEY;
  if (code === 'TAB_CLOSED') message = PAGE_ACCESS_ERRORS.TAB_CLOSED;
  return { code, message, retryable: false, status: 0 };
}

async function reportActionError(tabId, error) {
  if (!tabId) return;
  const { message } = errorPayload(error);
  const unsupported = error?.code === 'VISION_UNSUPPORTED';
  try {
    await sendToContent(tabId, { type: MSG.SHOW_TOAST, message, tone: unsupported ? 'info' : 'error' });
  } catch (_error) {
    // Pages without the content script fall back to the badge; a disabled image shortcut stays quiet.
    if (!unsupported) clearBadgeSoon(tabId, '!', message);
  }
  const settingsCodes = new Set([
    'MISSING_API_KEY',
    'AUTH_FAILED',
    'INVALID_API_KEY_FORMAT',
    'MODEL_CONFIG_ERROR',
    'MISSING_MODEL',
    'MISSING_CUSTOM_PROVIDER',
    'MISSING_CUSTOM_ENDPOINT',
    'MISSING_MODEL_NAME'
  ]);
  if (error && settingsCodes.has(error.code)) {
    try {
      await chrome.runtime.openOptionsPage();
    } catch (_error) {
      // Ignore.
    }
  }
}

async function captureVisibleTab(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new PageAccessError('SCREENSHOT_FAILED', PAGE_ACCESS_ERRORS.SCREENSHOT_FAILED));
        return;
      }
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
        reject(new PageAccessError('SCREENSHOT_FAILED', PAGE_ACCESS_ERRORS.SCREENSHOT_FAILED));
        return;
      }
      resolve(dataUrl);
    });
  });
}

async function handlePageCommand(message, sender) {
  if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(''))) {
    throw new PageAccessError('INVALID_SENDER', t('bg_invalid_sender'));
  }
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new PageAccessError('INVALID_TAB', t('bg_invalid_tab'));
  }
  const command = String(message.command || '');

  if (command === 'getState') {
    return getPageInfo(tabId);
  }

  if (command === 'restore') {
    return sendToContent(tabId, { type: MSG.RESTORE_PAGE });
  }

  const targetCode =
    message.targetCode === undefined ? undefined : validateTargetCode(message.targetCode);
  const bilingual =
    message.bilingual === undefined ? undefined : normalizeBilingual(message.bilingual);

  const tab = await getTab(tabId);
  const runtime = await requireRuntimeReady('translation', hostnameFromUrl(tab && tab.url));
  if (command === 'images') requireVisionSupported(runtime);
  await ensureContentScript(tabId);

  if (command === 'translate') {
    return chrome.tabs.sendMessage(tabId, {
      type: MSG.TRANSLATE_PAGE,
      targetCode,
      bilingual
    }, { frameId: 0 });
  }
  if (command === 'selection') {
    return sendToContent(tabId, {
      type: MSG.TRANSLATE_SELECTION,
      targetCode
    }, await selectionRecipient(tabId));
  }
  if (command === 'images') {
    return chrome.tabs.sendMessage(tabId, {
      type: MSG.TRANSLATE_IMAGES,
      targetCode
    }, { frameId: 0 });
  }
  throw new PageAccessError('UNKNOWN_COMMAND', t('bg_unknown_command'));
}

async function handleContextMenuClick(info, tab) {
  if (!tab || !tab.id) return;
  try {
    if (info.menuItemId === MENU_IDS.RESTORE) {
      await sendToContent(tab.id, { type: MSG.RESTORE_PAGE });
      return;
    }
    if (info.menuItemId === MENU_IDS.SELECTION) {
      const frameId = info.frameId === undefined ? 0 : info.frameId;
      if (!Number.isInteger(frameId) || frameId < 0) throw pageError('NO_PAGE_ACCESS');
      const frameUrl = frameId === 0 ? info.pageUrl || tab.url : info.frameUrl;
      if (typeof frameUrl !== 'string' || !frameUrl) throw pageError('NO_PAGE_ACCESS');
      const source = await frameDocument(tab.id, frameId, frameUrl);
      await requireRuntimeReady('translation', hostnameFromUrl(source.url));
      await sendToContent(tab.id, {
        type: MSG.TRANSLATE_SELECTION,
        text: typeof info.selectionText === 'string' ? info.selectionText : ''
      }, { documentId: source.documentId });
      return;
    }
    if (info.menuItemId === MENU_IDS.PAGE) {
      await requireRuntimeReady('translation', hostnameFromUrl(tab && tab.url));
      await sendToContent(tab.id, { type: MSG.TRANSLATE_PAGE });
      return;
    }
    if (info.menuItemId === MENU_IDS.IMAGES) {
      await requireVisionRuntime(hostnameFromUrl(tab && tab.url));
      await sendToContent(tab.id, { type: MSG.TRANSLATE_IMAGES });
    }
  } catch (error) {
    await reportActionError(tab.id, error);
  }
}

async function handleCommand(command, tab) {
  if (!tab || !tab.id) return;
  try {
    if (command === 'toggle-page-translation') {
      let info = null;
      try {
        info = await getPageInfo(tab.id);
      } catch (error) {
        await reportActionError(tab.id, error);
        return;
      }
      const status = info && info.info && info.info.status;
      const pageTranslated = Boolean(info && info.info && info.info.pageTranslated);
      if (status === 'running' || pageTranslated) {
        await sendToContent(tab.id, { type: MSG.RESTORE_PAGE });
      } else {
        await requireRuntimeReady('translation', hostnameFromUrl(tab && tab.url));
        await sendToContent(tab.id, { type: MSG.TRANSLATE_PAGE });
      }
      return;
    }
    if (command === 'translate-selection') {
      await requireRuntimeReady('translation', hostnameFromUrl(tab && tab.url));
      await sendToContent(tab.id, { type: MSG.TRANSLATE_SELECTION }, await selectionRecipient(tab.id));
      return;
    }
    if (command === 'translate-images') {
      await requireVisionRuntime(hostnameFromUrl(tab && tab.url));
      await sendToContent(tab.id, { type: MSG.TRANSLATE_IMAGES });
    }
  } catch (error) {
    await reportActionError(tab.id, error);
  }
}
