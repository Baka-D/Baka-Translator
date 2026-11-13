// User-initiated image requests teach the extension when a model rejects images.
let visionMenuRevision = 0;

function requireVisionSupported(runtime) {
  if (runtime.resolved.model.supportsVision === false) {
    throw new PageAccessError('VISION_UNSUPPORTED', t('bg_vision_disabled'));
  }
  return runtime;
}

async function requireVisionRuntime(hostname) {
  return requireVisionSupported(await resolveRuntime('translation', hostname));
}

async function syncVisionContextMenu() {
  if (typeof chrome.contextMenus.update !== 'function') return;
  const revision = ++visionMenuRevision;
  try {
    const snapshot = await getConfigSnapshot();
    if (revision !== visionMenuRevision) return;
    chrome.contextMenus.update(MENU_IDS.IMAGES, { enabled: snapshot.model?.supportsVision !== false }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_error) {
    // Menu state is best-effort; the request path independently guards the capability.
  }
}

async function rememberVisionUnsupported(runtime) {
  const key = visionUtils.keyFor(runtime.resolved.model, runtime.resolved.provider);
  if (!key) return;
  learnedVisionCapabilities[key] = true;
  visionWriteQueue = visionWriteQueue.then(async () => {
    const values = await chrome.storage.local.get(config.STORAGE_KEYS.VISION_CAPABILITIES);
    const next = visionUtils.normalizeCache(values[config.STORAGE_KEYS.VISION_CAPABILITIES]);
    next[key] = true;
    await chrome.storage.local.set({ [config.STORAGE_KEYS.VISION_CAPABILITIES]: next });
  }).catch(() => {});
  await visionWriteQueue;
}

async function resetVisionCapability(message) {
  const settings = await readSettings();
  const registry = settingsRegistry(await loadRegistry(), settings);
  const providerId = typeof message.providerId === 'string' ? message.providerId : '';
  const provider = Object.hasOwn(registry.providers, providerId) && registry.providers[providerId];
  const modelName = typeof message.modelName === 'string' ? message.modelName : '';
  const model = provider && modelUtils.listModels(registry, providerId).find((entry) => entry.model === modelName);
  const key = model && visionUtils.keyFor(model, provider);
  if (!key) throw new PageAccessError('MISSING_MODEL', t('bg_model_missing'));
  const operation = visionWriteQueue.then(async () => {
    const values = await chrome.storage.local.get(config.STORAGE_KEYS.VISION_CAPABILITIES);
    const next = visionUtils.normalizeCache(values[config.STORAGE_KEYS.VISION_CAPABILITIES]);
    delete next[key];
    delete learnedVisionCapabilities[key];
    await chrome.storage.local.set({ [config.STORAGE_KEYS.VISION_CAPABILITIES]: next });
    return next;
  });
  visionWriteQueue = operation.catch(() => {});
  return { visionCapabilities: await operation };
}
