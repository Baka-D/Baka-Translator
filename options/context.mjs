// Shared settings-page state and DOM references.
export const root = globalThis.DSHT || {};
export const i18n = root.i18n;
export const t = i18n.t;
export const config = root.config;
export const languages = root.languages;
export const modelsTools = root.models || null;
export const visionTools = root.vision || null;
export const presetsTools = root.presets || null;
export const billingTools = root.billing || null;
export const usageTools = root.usage || null;
export const novelUtils = root.novel || null;
export const fallback = document.getElementById('keyFeedback');

if (!config || !languages) {
  if (fallback) fallback.textContent = t('opt_resources_unavailable');
  throw new Error('Options UI resources are unavailable.');
}

export const MSG = config.MSG;
export const KEYS = config.STORAGE_KEYS;
export const TARGETS = languages.TARGET_LANGUAGES;

export const KEY_MIN_LENGTH = 20;
export const KEY_MAX_LENGTH = 512;
export const FEEDBACK_CLEAR_MS = 2600;
export const CONFIRM_RESET_MS = 5000;
// Plain http would expose the API key, so it stays limited to this machine.
export const LOCAL_HTTP_HOSTS = ['localhost', '127.0.0.1'];
export const EFFORT_LABELS = Object.freeze({
  none: t('opt_effort_none'),
  low: t('opt_effort_low'),
  medium: t('opt_effort_medium'),
  high: t('opt_effort_high'),
  xhigh: t('opt_effort_xhigh'),
  max: t('opt_effort_max')
});
export const STORAGE_KEYS_TO_READ = [
  KEYS.API_KEY,
  KEYS.TARGET,
  KEYS.BILINGUAL,
  KEYS.USAGE,
  KEYS.MODEL_ID,
  KEYS.EFFORT,
  KEYS.TRANSLATION_MODEL_ID,
  KEYS.TRANSLATION_EFFORT,
  KEYS.POLISH_MODEL_ID,
  KEYS.POLISH_EFFORT,
  KEYS.PRESET_ID,
  KEYS.PROVIDER_KEYS,
  KEYS.CUSTOM_PROVIDER,
  KEYS.CUSTOM_PROVIDERS,
  KEYS.USER_MODELS,
  KEYS.VISION_CAPABILITIES,
  KEYS.PROMPT_OVERRIDES,
  KEYS.SITE_SETTINGS
];

export const byId = (id) => document.getElementById(id);
export const ui = {
  versionChip: byId('versionChip'),
  tabGeneral: byId('tab-general'),
  tabAdvanced: byId('tab-advanced'),
  panelGeneral: byId('panel-general'),
  panelAdvanced: byId('panel-advanced'),
  modelsLoadError: byId('modelsLoadError'),
  modelsLoadErrorText: byId('modelsLoadErrorText'),
  reloadModelsButton: byId('reloadModelsButton'),
  modelSelect: byId('modelSelect'),
  modelDetails: byId('modelDetails'),
  providerNav: byId('providerNav'),
  addProviderButton: byId('addProviderButton'),
  providerDetailTitle: byId('providerDetailTitle'),
  providerDetailTags: byId('providerDetailTags'),
  keyStatus: byId('keyStatus'),
  providerKeyFields: byId('providerKeyFields'),
  providerDraftHint: byId('providerDraftHint'),
  providerKeyLabel: byId('providerKeyLabel'),
  apiKeyInput: byId('apiKeyInput'),
  toggleKeyVisibility: byId('toggleKeyVisibility'),
  apiKeyHint: byId('apiKeyHint'),
  saveKeyButton: byId('saveKeyButton'),
  clearKeyButton: byId('clearKeyButton'),
  keyFeedback: byId('keyFeedback'),
  testConnectionButton: byId('testConnectionButton'),
  translationSummary: byId('translationSummary'),
  polishSummary: byId('polishSummary'),
  translationProviderSelect: byId('translationProviderSelect'),
  polishProviderSelect: byId('polishProviderSelect'),
  polishModelSelect: byId('polishModelSelect'),
  polishModelDetails: byId('polishModelDetails'),
  polishEffortSelect: byId('polishEffortSelect'),
  polishEffortHint: byId('polishEffortHint'),
  customProviderFields: byId('customProviderFields'),
  providerNameInput: byId('providerNameInput'),
  deleteProviderButton: byId('deleteProviderButton'),
  providerModelFields: byId('providerModelFields'),
  providerModelList: byId('providerModelList'),
  fetchProviderModelsButton: byId('fetchProviderModelsButton'),
  userModelInput: byId('userModelInput'),
  addUserModelButton: byId('addUserModelButton'),
  providerModelFeedback: byId('providerModelFeedback'),
  customEndpointInput: byId('customEndpointInput'),
  customModelInput: byId('customModelInput'),
  customProviderFeedback: byId('customProviderFeedback'),
  saveCustomProviderButton: byId('saveCustomProviderButton'),
  defaultTargetSelect: byId('defaultTargetSelect'),
  defaultBilingualToggle: byId('defaultBilingualToggle'),
  settingsFeedback: byId('settingsFeedback'),
  usageTotal: byId('usageTotal'),
  usageCost: byId('usageCost'),
  usagePrompt: byId('usagePrompt'),
  usageCompletion: byId('usageCompletion'),
  usageCached: byId('usageCached'),
  usageRequests: byId('usageRequests'),
  usageUpdated: byId('usageUpdated'),
  usageEmptyHint: byId('usageEmptyHint'),
  usageFeedback: byId('usageFeedback'),
  resetUsageButton: byId('resetUsageButton'),
  effortSelect: byId('effortSelect'),
  effortHint: byId('effortHint'),
  presetSelect: byId('presetSelect'),
  presetDescription: byId('presetDescription'),
  behaviorFeedback: byId('behaviorFeedback'),
  promptPlaceholders: byId('promptPlaceholders'),
  translationPromptInput: byId('translationPromptInput'),
  polishPromptInput: byId('polishPromptInput'),
  promptStatus: byId('promptStatus'),
  promptFeedback: byId('promptFeedback'),
  savePromptsButton: byId('savePromptsButton'),
  resetPromptsButton: byId('resetPromptsButton'),
  siteList: byId('siteList'),
  novelSupportNote: byId('novelSupportNote'),
  siteEmptyHint: byId('siteEmptyHint'),
  siteHostInput: byId('siteHostInput'),
  addSiteButton: byId('addSiteButton'),
  siteFeedback: byId('siteFeedback'),
  glossaryTidyToggle: byId('glossaryTidyToggle'),
  glossaryTidyChapters: byId('glossaryTidyChapters'),
  glossaryTidyModel: byId('glossaryTidyModel'),
  glossaryTidyFeedback: byId('glossaryTidyFeedback'),
  glossaryUndoRow: byId('glossaryUndoRow'),
  glossaryUndoText: byId('glossaryUndoText'),
  glossaryUndoButton: byId('glossaryUndoButton'),
  glossaryList: byId('glossaryList'),
  glossaryEmptyHint: byId('glossaryEmptyHint'),
  glossaryEditor: byId('glossaryEditor'),
  glossaryEditorTitle: byId('glossaryEditorTitle'),
  glossaryTitleInput: byId('glossaryTitleInput'),
  glossaryTitleSaveButton: byId('glossaryTitleSaveButton'),
  glossaryTitleCancelButton: byId('glossaryTitleCancelButton'),
  glossaryRows: byId('glossaryRows'),
  glossaryPager: byId('glossaryPager'),
  glossaryPageSize: byId('glossaryPageSize'),
  glossaryPrevButton: byId('glossaryPrevButton'),
  glossaryNextButton: byId('glossaryNextButton'),
  glossaryPageInput: byId('glossaryPageInput'),
  glossaryPageTotal: byId('glossaryPageTotal'),
  glossaryAddButton: byId('glossaryAddButton'),
  glossarySaveButton: byId('glossarySaveButton'),
  glossaryClearButton: byId('glossaryClearButton'),
  glossaryCloseButton: byId('glossaryCloseButton'),
  glossaryRefreshButton: byId('glossaryRefreshButton'),
  glossaryFeedback: byId('glossaryFeedback'),
  versionText: byId('versionText'),
  modelText: byId('modelText')
};

if (!ui.providerNav || !ui.apiKeyInput || !ui.keyFeedback || !ui.modelSelect || !ui.tabGeneral) {
  throw new Error('Options UI resources are unavailable.');
}

export const state = {
  snapshot: null,
  registry: null,
  registryError: '',
  presetIndex: null,
  presetCache: new Map(),
  presetLoadToken: 0,
  modelId: config.DEFAULT_MODEL_ID || 'deepseek-flash',
  effortLevel: config.DEFAULT_EFFORT || 'none',
  polishModelIdRaw: '',
  polishEffortRaw: '',
  presetId: config.DEFAULT_PRESET_ID || 'general',
  // A stored translation model that no longer exists; `modelId` holds the stand-in shown meanwhile.
  staleModelId: '',
  storedTranslationModel: false,
  storedTranslationEffort: false,
  storedPolishModel: false,
  storedPolishEffort: false,
  storedPresetId: '',
  providerKeys: {},
  legacyApiKey: '',
  // User-added providers and model names; `registry` is `baseRegistry` merged with them.
  customProviders: [],
  userModels: {},
  visionCapabilities: {},
  baseRegistry: null,
  // Provider shown in the detail panel; `providerDraft` while adding a new one.
  selectedProviderId: '',
  providerDraft: false,
  shownProviderId: null,
  confirmDeleteProvider: '',
  deleteConfirmTimer: 0,
  confirmMoveProvider: '',
  moveConfirmTimer: 0,
  promptOverrides: {},
  siteSettings: {},
  glossaries: [],
  activeGlossaryKey: '',
  glossaryDraft: [],
  // Terms the draft started from; anything else in storage arrived after it opened.
  glossaryOpened: [],
  // The saved term behind each draft row (null for an added row), aligned with glossaryDraft.
  glossarySaved: [],
  glossaryPage: 0,
  glossaryPageSize: 50,
  glossaryClearArmed: false,
  glossaryClearTimer: 0,
  targetLang: languages.normalizeTarget(null),
  bilingual: config.DEFAULT_BILINGUAL === true,
  usage: null,
  busy: false,
  customBusy: false,
  usageBusy: false,
  confirmClear: false,
  clearTimer: 0,
  confirmResetUsage: false,
  resetUsageTimer: 0,
  activeTab: 'general'
};

export const feedbackTimers = new WeakMap();
