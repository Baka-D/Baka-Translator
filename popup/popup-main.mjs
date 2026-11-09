/** Bind popup controls and initialize the active tab. */
import { config, languages, KEYS, TARGETS, ui, state, PAGE_ERROR_MESSAGES, VISION_NOTICE_TEXT, EXT_PAGE_MESSAGE, normalizeUsage, renderUsage } from './popup-state.mjs';
import { hostFromUrl, presetDisplayName, populateSitePresetSelect, renderSiteToggles, readSiteSettings, saveSiteFlag, loadPresetIndex } from './popup-site.mjs';
import { persistSettings, openOptions, readConfig, queryActiveTab, isRestrictedUrl } from './popup-transport.mjs';
import { render } from './popup-view.mjs';
import { stopPolling, refreshState, handleMainAction, runQuickCommand } from './popup-page.mjs';

/* ---------- 事件绑定 ---------- */

let modelConfigRequest = 0;

async function refreshModelConfig() {
  const request = ++modelConfigRequest;
  const settings = await readConfig();
  if (request === modelConfigRequest && settings.ok) {
    state.hasApiKey = settings.hasApiKey;
    state.modelError = settings.modelError || '';
    state.polishHasApiKey = settings.polishHasApiKey;
    state.supportsVision = settings.supportsVision;
    state.modelName = settings.modelName;
    state.modelKey = settings.modelKey;
    if (state.supportsVision && state.pageMessage?.message === VISION_NOTICE_TEXT) state.pageMessage = null;
    render();
  }
  return settings;
}

function populateTargetSelect() {
  const fragment = document.createDocumentFragment();
  for (const language of TARGETS) {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = language.label;
    fragment.appendChild(option);
  }
  ui.targetSelect.textContent = '';
  ui.targetSelect.appendChild(fragment);
}

function wireEvents() {
  ui.targetSelect.addEventListener('change', () => {
    state.settings.targetCode = languages.normalizeTarget(ui.targetSelect.value);
    ui.targetSelect.value = state.settings.targetCode;
    persistSettings({ [KEYS.TARGET]: state.settings.targetCode });
    render();
  });

  ui.bilingualToggle.addEventListener('change', () => {
    state.settings.bilingual = ui.bilingualToggle.checked === true;
    persistSettings({ [KEYS.BILINGUAL]: state.settings.bilingual });
    render();
  });

  const bindSiteToggle = (toggle, flag) => {
    if (!toggle) return;
    toggle.addEventListener('change', () => {
      const host = state.host;
      const enabled = toggle.checked === true;
      if (!host) {
        render();
        return;
      }
      void (async () => {
        const saved = await saveSiteFlag(host, { [flag]: enabled });
        if (!saved) {
          state.pageMessage = { tone: 'error', message: '保存站点开关失败，请重试。' };
          render();
          return;
        }
        if (flag === 'polish' && enabled && !state.polishHasApiKey) {
          state.pageMessage = {
            tone: 'warning',
            message: '本站润色已开启，但润色模型尚未配置 API Key，润色会失败；请在设置中填写。'
          };
        } else if (flag === 'polish') {
          state.pageMessage = {
            tone: 'info',
            message: enabled ? '本站润色已开启，重新翻译后生效。' : '本站润色已关闭，重新翻译后生效。'
          };
        } else {
          state.pageMessage = {
            tone: 'info',
            message: enabled
              ? '已开启预翻译：重新翻译当前页后，下一章会自动预翻译。'
              : '已关闭预翻译。'
          };
        }
        render();
      })();
    });
  };
  bindSiteToggle(ui.polishToggle, 'polish');
  bindSiteToggle(ui.pretranslateToggle, 'pretranslate');

  if (ui.sitePresetSelect) {
    ui.sitePresetSelect.addEventListener('change', () => {
      const host = state.host;
      if (!host) {
        render();
        return;
      }
      const value = ui.sitePresetSelect.value;
      void (async () => {
        const saved = await saveSiteFlag(
          host,
          value ? { presetId: value } : {},
          value ? [] : ['presetId']
        );
        if (!saved) {
          state.pageMessage = { tone: 'error', message: '保存本站提示词预设失败，请重试。' };
          render();
          return;
        }
        state.pageMessage = {
          tone: 'info',
          message: value
            ? `本站提示词预设已设为 ${presetDisplayName(value)}，重新翻译后生效。`
            : '本站提示词预设已改为跟随全局，重新翻译后生效。'
        };
        render();
      })();
    });
  }

  ui.mainButton.addEventListener('click', () => {
    void handleMainAction();
  });
  ui.selectionButton.addEventListener('click', () => {
    void runQuickCommand('selection');
  });
  ui.imagesButton.addEventListener('click', () => {
    void runQuickCommand('images');
  });

  for (const button of [ui.openOptionsTop, ui.openOptionsFooter, ui.keyNoticeAction]) {
    if (!button) continue;
    button.addEventListener('click', () => {
      void openOptions();
    });
  }

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes) return;
      const modelKeys = [KEYS.MODEL_ID, KEYS.TRANSLATION_MODEL_ID, KEYS.CUSTOM_PROVIDER,
        KEYS.CUSTOM_PROVIDERS, KEYS.USER_MODELS, KEYS.VISION_CAPABILITIES, KEYS.PROVIDER_KEYS, KEYS.API_KEY];
      if (modelKeys.some((key) => key && Object.hasOwn(changes, key))) void refreshModelConfig();
      if (Object.prototype.hasOwnProperty.call(changes, KEYS.USAGE) && changes[KEYS.USAGE]) {
        state.usage = normalizeUsage(changes[KEYS.USAGE].newValue);
        state.usageKnown = true;
        renderUsage();
      }
      if (Object.prototype.hasOwnProperty.call(changes, KEYS.SITE_SETTINGS) && changes[KEYS.SITE_SETTINGS]) {
        const next = changes[KEYS.SITE_SETTINGS].newValue;
        state.siteSettings =
          next && typeof next === 'object' && !Array.isArray(next) ? next : {};
        renderSiteToggles();
      }
    });
  }

  window.addEventListener('pagehide', stopPolling);
}

/* ---------- 启动 ---------- */

async function init() {
  populateTargetSelect();
  ui.targetSelect.value = state.settings.targetCode;
  ui.bilingualToggle.checked = state.settings.bilingual;
  wireEvents();
  state.loading = true;
  render();

  try {
    const tab = await queryActiveTab();
    state.tabId = tab && Number.isInteger(tab.id) ? tab.id : null;
    state.tabUrl = tab && typeof tab.url === 'string' ? tab.url : '';
    state.host = hostFromUrl(state.tabUrl);

    const results = await Promise.all([refreshModelConfig(), readSiteSettings(), loadPresetIndex()]);
    const settings = results[0];
    state.siteSettings = results[1];
    state.globalPresetId =
      (settings && settings.presetId) || config.DEFAULT_PRESET_ID || 'general';
    state.polishHasApiKey = !(settings && settings.polishHasApiKey === false);
    populateSitePresetSelect();
    state.configLoaded = true;
    if (!settings.ok) {
      state.loading = false;
      state.pageError = {
        code: 'BACKGROUND_UNAVAILABLE',
        message: PAGE_ERROR_MESSAGES.BACKGROUND_UNAVAILABLE
      };
      render();
      return;
    }
    state.hasApiKey = settings.hasApiKey;
    state.modelError = settings.modelError || '';
    state.settings.targetCode = settings.targetCode;
    state.settings.bilingual = settings.bilingual;
    state.usage = settings.usage;
    state.usageKnown = Boolean(settings.usage);
    ui.targetSelect.value = state.settings.targetCode;
    ui.bilingualToggle.checked = state.settings.bilingual;
    state.loading = false;

    if (!state.tabId) {
      state.pageError = { code: 'INVALID_TAB', message: PAGE_ERROR_MESSAGES.INVALID_TAB };
      render();
      return;
    }
    if (state.tabUrl.startsWith(chrome.runtime.getURL(''))) {
      state.pageError = { code: 'UNSUPPORTED_PAGE', message: EXT_PAGE_MESSAGE };
      render();
      return;
    }
    if (isRestrictedUrl(state.tabUrl)) {
      state.pageError = { code: 'UNSUPPORTED_PAGE', message: PAGE_ERROR_MESSAGES.UNSUPPORTED_PAGE };
      render();
      return;
    }

    state.initialFetch = true;
    render();
    await refreshState();
  } catch (_error) {
    state.pageMessage = { tone: 'error', message: '扩展初始化失败，请关闭后重试。' };
  } finally {
    state.loading = false;
    state.initialFetch = false;
    state.configLoaded = true;
    render();
  }
}


export { init };
