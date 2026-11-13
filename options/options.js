// Settings-page options.
import { t, i18n, FEEDBACK_CLEAR_MS, KEYS, languages, modelsTools, novelUtils, visionTools, state, ui } from './context.mjs';
import { handleDeleteProviderClick, handleSaveCustomProvider } from './custom-provider.mjs';
import { handleClearKeyClick, handleSaveKey, handleTestConnection, handleToggleKeyVisibility } from './keys.mjs';
import { handleAddModel, handleFetchModels } from './provider-models.mjs';
import { renderProviders, startAddProvider } from './providers.mjs';
import { applyCustomProviders, applyModelSelection, applyPolishProvider, applyResolvedModel, applyTranslationProvider, followStoredModels, loadRegistry, normalizePolishSelection, persistModels, renderModelArea } from './model-selection.mjs';
import { polishInheritsModel, polishModel, providerNameById, translationModel } from './models.mjs';
import { handlePresetChange, handleResetPrompts, handleSavePrompts, loadPresetIndex } from './presets.mjs';
import { handleBilingualChange, handleResetUsageClick, handleTargetChange, populateTargetSelect, renderDefaultSettings, renderUsage } from './settings.mjs';
import { handleAddSite, renderSiteSettings } from './sites.mjs';
import { initGlossaries, wireGlossaryEvents } from './glossaries.mjs';
import { loadStoredData, persistDefaultsIfMissing, readConfigSnapshot, resolvePreset } from './storage.mjs';
import { effortLabel, getVersion, isObject, normalizeProviderKeys, normalizeUsage, persist, restoreFocus, setFeedback } from './utils.mjs';

/* ---------- 选项卡 ---------- */

export function applyTab(tabId, options) {
  const opts = options || {};
  const next = tabId === 'advanced' ? 'advanced' : 'general';
  state.activeTab = next;
  const generalSelected = next === 'general';
  ui.tabGeneral.setAttribute('aria-selected', String(generalSelected));
  ui.tabAdvanced.setAttribute('aria-selected', String(!generalSelected));
  ui.tabGeneral.tabIndex = generalSelected ? 0 : -1;
  ui.tabAdvanced.tabIndex = generalSelected ? -1 : 0;
  ui.panelGeneral.hidden = !generalSelected;
  ui.panelAdvanced.hidden = generalSelected;
  if (opts.focus !== false) {
    const target = generalSelected ? ui.tabGeneral : ui.tabAdvanced;
    if (target && typeof target.focus === 'function') target.focus();
  }
  if (opts.updateHash && typeof history !== 'undefined' && history.replaceState) {
    try {
      history.replaceState(null, '', generalSelected ? '#general' : '#advanced');
    } catch (_error) {
      // file:// 等受限上下文忽略。
    }
  }
}

export function readTabFromHash() {
  if (typeof location !== 'undefined' && typeof location.hash === 'string') {
    return location.hash.replace('#', '') === 'advanced' ? 'advanced' : 'general';
  }
  return 'general';
}

export function wireTabs() {
  ui.tabGeneral.addEventListener('click', () => applyTab('general', { updateHash: true }));
  ui.tabAdvanced.addEventListener('click', () => applyTab('advanced', { updateHash: true }));
  const onKeydown = (event) => {
    const key = event && event.key;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      if (event.preventDefault) event.preventDefault();
      applyTab(state.activeTab === 'general' ? 'advanced' : 'general', { updateHash: true });
    } else if (key === 'Home') {
      if (event.preventDefault) event.preventDefault();
      applyTab('general', { updateHash: true });
    } else if (key === 'End') {
      if (event.preventDefault) event.preventDefault();
      applyTab('advanced', { updateHash: true });
    }
  };
  ui.tabGeneral.addEventListener('keydown', onKeydown);
  ui.tabAdvanced.addEventListener('keydown', onKeydown);
}

/* ---------- 事件绑定 ---------- */

export function wireEvents() {
  ui.apiKeyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleSaveKey();
    }
  });
  ui.toggleKeyVisibility.addEventListener('click', handleToggleKeyVisibility);
  ui.saveKeyButton.addEventListener('click', () => void handleSaveKey());
  ui.clearKeyButton.addEventListener('click', handleClearKeyClick);
  ui.testConnectionButton.addEventListener('click', () => void handleTestConnection());
  ui.addProviderButton.addEventListener('click', startAddProvider);
  ui.addUserModelButton.addEventListener('click', () => void handleAddModel());
  ui.fetchProviderModelsButton.addEventListener('click', () => void handleFetchModels());
  ui.userModelInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleAddModel();
    }
  });
  ui.saveCustomProviderButton.addEventListener('click', () => {
    void handleSaveCustomProvider();
  });
  ui.deleteProviderButton.addEventListener('click', () => void handleDeleteProviderClick());
  ui.translationProviderSelect.addEventListener('change', () => {
    const providerIdValue = ui.translationProviderSelect.value;
    if (!providerIdValue) return;
    applyTranslationProvider(providerIdValue)?.then(
      () => {
        const model = translationModel();
        setFeedback(
          ui.behaviorFeedback,
          model
            ? t('opt_translation_provider_model_saved', [providerNameById(providerIdValue), i18n.modelName(model.id, model.name)])
            : t('opt_translation_provider_saved', [providerNameById(providerIdValue)]),
          'success',
          FEEDBACK_CLEAR_MS
        );
      },
      () => {
        setFeedback(ui.behaviorFeedback, t('opt_translation_provider_save_failed'), 'error');
      }
    );
  });
  ui.polishProviderSelect.addEventListener('change', () => {
    const providerIdValue = ui.polishProviderSelect.value;
    applyPolishProvider(providerIdValue)?.then(
      () => {
        const model = polishModel();
        setFeedback(
          ui.behaviorFeedback,
          providerIdValue
            ? (model
              ? t('opt_polish_provider_model_saved', [providerNameById(providerIdValue), i18n.modelName(model.id, model.name)])
              : t('opt_polish_provider_saved', [providerNameById(providerIdValue)]))
            : t('opt_polish_model_follow_saved'),
          'success',
          FEEDBACK_CLEAR_MS
        );
      },
      () => {
        setFeedback(ui.behaviorFeedback, t('opt_polish_provider_save_failed'), 'error');
      }
    );
  });
  ui.modelSelect.addEventListener('change', () => {
    applyModelSelection(ui.modelSelect.value)?.then(
      () => {
        const model = translationModel();
        setFeedback(
          ui.behaviorFeedback,
          model ? t('opt_translation_model_named_saved', [i18n.modelName(model.id, model.name)]) : t('opt_translation_model_saved'),
          'success',
          FEEDBACK_CLEAR_MS
        );
      },
      () => {
        setFeedback(ui.behaviorFeedback, t('opt_translation_model_save_failed'), 'error');
      }
    );
  });
  ui.polishModelSelect.addEventListener('change', () => {
    state.polishModelIdRaw = ui.polishModelSelect.value;
    normalizePolishSelection();
    renderModelArea();
    persistModels('polish').then(
      () => {
        const model = polishModel();
        setFeedback(
          ui.behaviorFeedback,
          polishInheritsModel()
            ? t('opt_polish_model_follow_saved')
            : t('opt_polish_model_named_saved', [model ? i18n.modelName(model.id, model.name) : '—']),
          'success',
          FEEDBACK_CLEAR_MS
        );
      },
      () => {
        setFeedback(ui.behaviorFeedback, t('opt_polish_model_save_failed'), 'error');
      }
    );
  });
  ui.effortSelect.addEventListener('change', () => {
    const value = ui.effortSelect.value;
    state.effortLevel = value;
    renderModelArea();
    persistModels('translation').then(
      () => {
        setFeedback(
          ui.behaviorFeedback,
          t('opt_translation_effort_saved', [effortLabel(value)]),
          'success',
          FEEDBACK_CLEAR_MS
        );
      },
      () => {
        setFeedback(ui.behaviorFeedback, t('opt_translation_effort_save_failed'), 'error');
      }
    );
  });
  ui.polishEffortSelect.addEventListener('change', () => {
    const value = ui.polishEffortSelect.value;
    state.polishEffortRaw = value;
    renderModelArea();
    persistModels('polish').then(
      () => {
        setFeedback(
          ui.behaviorFeedback,
          value ? t('opt_polish_effort_saved', [effortLabel(value)]) : t('opt_polish_effort_follow_saved'),
          'success',
          FEEDBACK_CLEAR_MS
        );
      },
      () => {
        setFeedback(ui.behaviorFeedback, t('opt_polish_effort_save_failed'), 'error');
      }
    );
  });
  ui.presetSelect.addEventListener('change', handlePresetChange);
  ui.savePromptsButton.addEventListener('click', () => {
    void handleSavePrompts();
  });
  ui.resetPromptsButton.addEventListener('click', () => {
    void handleResetPrompts();
  });
  ui.addSiteButton.addEventListener('click', handleAddSite);
  ui.siteHostInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleAddSite();
    }
  });
  ui.defaultTargetSelect.addEventListener('change', handleTargetChange);
  ui.defaultBilingualToggle.addEventListener('change', handleBilingualChange);
  ui.resetUsageButton.addEventListener('click', handleResetUsageClick);
  wireGlossaryEvents();
  if (ui.reloadModelsButton) {
    ui.reloadModelsButton.addEventListener('click', () => {
      void (async () => {
        const button = ui.reloadModelsButton;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.textContent = t('opt_loading');
        try {
          await loadRegistry();
          applyResolvedModel();
          await resolvePreset();
        } finally {
          button.disabled = false;
          button.removeAttribute('aria-busy');
          button.textContent = t('opt_reload');
          // A successful reload hides the notice holding the button.
          restoreFocus(button, ui.providerNav.querySelector('[aria-current="true"]'));
        }
        if (state.registryError) {
          // The notice is where the user is looking; an unchanged text would read as no response.
          ui.modelsLoadErrorText.textContent = t('opt_registry_retry_failed', [state.registryError]);
        } else {
          setFeedback(ui.keyFeedback, t('opt_models_reloaded'), 'success', FEEDBACK_CLEAR_MS);
        }
      })();
    });
  }

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes) return;
      if (Object.prototype.hasOwnProperty.call(changes, KEYS.TARGET) && changes[KEYS.TARGET]) {
        state.targetLang = languages.normalizeTarget(changes[KEYS.TARGET].newValue);
        ui.defaultTargetSelect.value = state.targetLang;
      }
      if (Object.prototype.hasOwnProperty.call(changes, KEYS.BILINGUAL) && changes[KEYS.BILINGUAL]) {
        state.bilingual = changes[KEYS.BILINGUAL].newValue === true;
        ui.defaultBilingualToggle.checked = state.bilingual;
      }
      if (Object.prototype.hasOwnProperty.call(changes, KEYS.USAGE) && changes[KEYS.USAGE]) {
        state.usage = normalizeUsage(changes[KEYS.USAGE].newValue);
        renderUsage();
      }
      if (Object.prototype.hasOwnProperty.call(changes, KEYS.API_KEY) && changes[KEYS.API_KEY]) {
        // Track a cleared legacy key so the fallback below cannot resurrect it.
        const legacy = changes[KEYS.API_KEY].newValue;
        state.legacyApiKey = typeof legacy === 'string' ? legacy.trim() : '';
      }
      if (
        Object.prototype.hasOwnProperty.call(changes, KEYS.PROVIDER_KEYS) &&
        changes[KEYS.PROVIDER_KEYS]
      ) {
        state.providerKeys = normalizeProviderKeys(changes[KEYS.PROVIDER_KEYS].newValue);
        if (!state.providerKeys.deepseek && state.legacyApiKey) {
          state.providerKeys.deepseek = state.legacyApiKey;
        }
        renderProviders();
      }
      if (Object.prototype.hasOwnProperty.call(changes, KEYS.CUSTOM_PROVIDERS) && changes[KEYS.CUSTOM_PROVIDERS]) {
        state.customProviders = modelsTools.normalizeCustomProviders(changes[KEYS.CUSTOM_PROVIDERS].newValue);
        applyCustomProviders();
        renderModelArea();
      }
      if (Object.prototype.hasOwnProperty.call(changes, KEYS.USER_MODELS) && changes[KEYS.USER_MODELS]) {
        state.userModels = modelsTools.normalizeUserModels(changes[KEYS.USER_MODELS].newValue);
        applyCustomProviders();
        renderModelArea();
      }
      if (changes[KEYS.VISION_CAPABILITIES] && visionTools) {
        state.visionCapabilities = visionTools.normalizeCache(changes[KEYS.VISION_CAPABILITIES].newValue);
        applyCustomProviders();
        renderModelArea();
      }
      // After the branches above: another tab's pick may be a model they just registered.
      followStoredModels(changes);
      if (changes[KEYS.PROMPT_OVERRIDES]) {
        // The editor stays as it is: reloading it would wipe unsaved typing.
        // shortcut: this tab's next save still wins for the preset it has open, warn if that bites.
        const overrides = changes[KEYS.PROMPT_OVERRIDES].newValue;
        state.promptOverrides = isObject(overrides) ? overrides : {};
      }
      if (
        Object.prototype.hasOwnProperty.call(changes, KEYS.SITE_SETTINGS) &&
        changes[KEYS.SITE_SETTINGS]
      ) {
        state.siteSettings = isObject(changes[KEYS.SITE_SETTINGS].newValue)
          ? changes[KEYS.SITE_SETTINGS].newValue
          : {};
        renderSiteSettings();
      }
    });
  }
}

/* ---------- 启动 ---------- */

export function showMeta() {
  const version = getVersion();
  if (ui.versionChip) ui.versionChip.textContent = version ? `v${version}` : '—';
  if (ui.versionText) ui.versionText.textContent = version || t('opt_unknown');
  if (ui.modelText) ui.modelText.textContent = '—';
}

export function renderNovelSupportNote() {
  if (!ui.novelSupportNote) return;
  const adapters =
    novelUtils && novelUtils.SITE_ADAPTERS ? Object.values(novelUtils.SITE_ADAPTERS) : [];
  if (adapters.length === 0) return;
  const sites = adapters
    .map((adapter) => {
      const host = Array.isArray(adapter.hosts) && adapter.hosts.length > 0 ? adapter.hosts[0] : '';
      return host ? t('opt_novel_site', [host, adapter.name]) : adapter.name;
    })
    .join(t('opt_list_separator'));
  ui.novelSupportNote.textContent = t('opt_novel_support', [sites]);
}

export async function init() {
  populateTargetSelect();
  showMeta();
  renderNovelSupportNote();
  wireTabs();
  wireEvents();
  applyTab(readTabFromHash(), { focus: false, updateHash: false });

  state.snapshot = await readConfigSnapshot();
  await loadStoredData();
  renderDefaultSettings();
  renderUsage();
  renderSiteSettings();
  await initGlossaries();

  await Promise.all([loadRegistry(), loadPresetIndex()]);
  applyResolvedModel();
  await resolvePreset();
  await persistDefaultsIfMissing();
  renderSiteSettings();
}

void init();
