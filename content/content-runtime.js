/** Runtime behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const { t } = globalScope.DSHT.i18n;
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['runtime'] = function createModule(app) {
  const { config, languages, MSG, page, overlay } = app;

  // Translations made under other values of these must not be reused.
  const ENGINE_KEYS = config.TRANSLATION_ENGINE_KEYS;
  let liveFontRepair;

  function bindFontRepairChanges() {
    const key = config.STORAGE_KEYS.SITE_SETTINGS;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[key]) return;
      const site = changes[key].newValue?.[location.hostname.toLowerCase()];
      liveFontRepair = site?.repairFonts !== false;
      app.setFontRepairEnabled(liveFontRepair);
    });
  }

  function readSettings() {
    return new Promise((resolve) => {
      const fallback = {
        targetLang: config.DEFAULT_TARGET,
        bilingual: config.DEFAULT_BILINGUAL,
        siteSettings: {}
      };
      try {
        chrome.storage.local.get(
          [
            config.STORAGE_KEYS.TARGET,
            config.STORAGE_KEYS.BILINGUAL,
            config.STORAGE_KEYS.PRESET_ID,
            config.STORAGE_KEYS.SITE_SETTINGS,
            ...ENGINE_KEYS
          ],
          (values) => {
            void chrome.runtime.lastError;
            const settings = values || {};
            resolve({
              targetLang: languages.normalizeTarget(settings[config.STORAGE_KEYS.TARGET] || fallback.targetLang),
              bilingual:
                typeof settings[config.STORAGE_KEYS.BILINGUAL] === 'boolean'
                  ? settings[config.STORAGE_KEYS.BILINGUAL]
                  : fallback.bilingual,
              presetId: settings[config.STORAGE_KEYS.PRESET_ID],
              engine: JSON.stringify(ENGINE_KEYS.map((key) => settings[key] ?? null)),
              siteSettings:
                settings[config.STORAGE_KEYS.SITE_SETTINGS] &&
                typeof settings[config.STORAGE_KEYS.SITE_SETTINGS] === 'object'
                  ? settings[config.STORAGE_KEYS.SITE_SETTINGS]
                  : {}
            });
          }
        );
      } catch (_error) {
        resolve(fallback);
      }
    });
  }

  function siteFeatures(settings) {
    const all = settings && settings.siteSettings ? settings.siteSettings : {};
    const raw = all[location.hostname.toLowerCase()];
    return {
      polish: typeof raw === 'boolean' ? raw : raw?.polish === true,
      pretranslate: raw?.pretranslate === true,
      // A live change can arrive while the initial settings read is pending.
      repairFonts: liveFontRepair ?? (raw?.repairFonts !== false),
      presetId: activePresetId(settings)
    };
  }

  function activePresetId(settings) {
    const all = settings && settings.siteSettings ? settings.siteSettings : {};
    const site = all[location.hostname.toLowerCase()];
    const sitePreset = site && typeof site.presetId === 'string' ? site.presetId.trim() : '';
    return sitePreset || (settings && settings.presetId) || config.DEFAULT_PRESET_ID;
  }

  /** What a stored translation depends on; it is reused only when all of it matches. */
  function translationKey(settings, targetCode) {
    return config.translationCacheKey(settings, targetCode, location.hostname.toLowerCase());
  }

  /** Whether this site's preset wants surrounding text in its requests. */
  function contextEnabled(settings) {
    return config.CONTEXT_PRESET_IDS.includes(String(activePresetId(settings)).trim());
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (values) => {
          void chrome.runtime.lastError;
          resolve(values || {});
        });
      } catch (_error) {
        resolve({});
      }
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(keys, () => {
          resolve(!chrome.runtime.lastError);
        });
      } catch (_error) {
        resolve(false);
      }
    });
  }

  function saveTargetLanguage(targetCode) {
    try {
      chrome.storage.local.set({ [config.STORAGE_KEYS.TARGET]: languages.normalizeTarget(targetCode) }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // Settings persistence is best-effort.
    }
  }

  function extensionMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message || t('content_background_no_response')));
            return;
          }
          if (!response) {
            reject(new Error(t('content_background_no_response')));
            return;
          }
          if (response.ok === false) {
            const error = new Error(
              (response.error && response.error.message) || t('content_request_failed')
            );
            error.code = (response.error && response.error.code) || 'REQUEST_FAILED';
            error.retryable = Boolean(response.error && response.error.retryable);
            error.discardedBilling = response.error && response.error.discardedBilling;
            reject(error);
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function sendRuntime(message) {
    return extensionMessage(message).catch((error) => {
      if (/Extension context invalidated/i.test(String(error && error.message))) {
        error.code = 'EXTENSION_RELOADED';
        error.message = t('content_extension_updated');
      } else if (/message (channel|port) closed|Receiving end does not exist/i.test(String(error && error.message))) {
        error.code = 'WORKER_RESTARTED';
        error.retryable = true;
        error.message = t('content_background_restarted');
      }
      throw error;
    });
  }

  function sendHeartbeat() {
    try {
      chrome.runtime.sendMessage({ type: MSG.HEARTBEAT }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // The page may be unloading.
    }
  }

  /** A page run only covers the route on which the reader started it. */
  function assertPageRoute() {
    if (!page.translatedRoute || app.currentRoute() === page.translatedRoute) return;
    if (!page.abortFatal) {
      page.abortFatal = true;
      void app.sendRuntime({ type: MSG.STOP_PAGE_REQUESTS }).catch(() => {});
    }
    throw Object.assign(new Error(t('content_route_changed_error')), { code: 'PAGE_CHANGED' });
  }

  function notifyBadge(status) {
    try {
      chrome.runtime.sendMessage(
        {
          type: MSG.PAGE_STATUS,
          status,
          targetCode: page.targetCode,
          targetLabel: page.targetLabel || ''
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    } catch (_error) {
      // The page may be unloading.
    }
  }

  function openOptionsPage() {
    try {
      chrome.runtime.sendMessage({ type: MSG.OPEN_OPTIONS }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      overlay.showToast(t('content_open_settings_error'), 'error');
    }
  }

  return {
    readSettings,
    bindFontRepairChanges,
    translationKey,
    siteFeatures,
    contextEnabled,
    storageGet,
    storageRemove,
    saveTargetLanguage,
    extensionMessage,
    sendRuntime,
    assertPageRoute,
    sendHeartbeat,
    notifyBadge,
    openOptionsPage
  };
  };
})(globalThis);
