// captureVisibleTab is window-scoped, so discard its bytes if ownership changes.
async function capturePageScreenshot(sender) {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  if (!Number.isInteger(tabId) || !Number.isInteger(windowId) ||
      (sender.frameId !== undefined && sender.frameId !== 0) ||
      typeof sender.documentId !== 'string' || !sender.documentId) {
    throw pageError('SCREENSHOT_FAILED');
  }

  let changed = false;
  const invalidate = () => { changed = true; };
  const activation = (info) => {
    if (info.windowId === windowId && info.tabId !== tabId) invalidate();
  };
  const update = (id, info) => {
    if (id === tabId && (info.status === 'loading' || Object.hasOwn(info, 'url') || info.discarded)) invalidate();
  };
  const removal = (id) => { if (id === tabId) invalidate(); };
  const replacement = (added, removed) => { if (added === tabId || removed === tabId) invalidate(); };
  const listeners = [
    [chrome.tabs.onActivated, activation],
    [chrome.tabs.onUpdated, update],
    [chrome.tabs.onRemoved, removal],
    [chrome.tabs.onReplaced, replacement],
    [chrome.tabs.onDetached, removal],
    [chrome.tabs.onAttached, removal]
  ];

  async function requireOwner() {
    try {
      const tab = await getTab(tabId);
      const source = await frameDocument(tabId, 0);
      if (changed || !tab.active || tab.windowId !== windowId ||
          source.documentId !== sender.documentId) throw pageError('SCREENSHOT_FAILED');
    } catch (_error) {
      throw pageError('SCREENSHOT_FAILED');
    }
  }

  try {
    for (const [event, listener] of listeners) event.addListener(listener);
    await requireVisionRuntime(hostnameFromSender(sender));
    await requireOwner();
    const dataUrl = await captureVisibleTab(windowId);
    await requireOwner();
    if (changed) throw pageError('SCREENSHOT_FAILED');
    return { dataUrl };
  } finally {
    for (const [event, listener] of listeners) event.removeListener(listener);
  }
}
