const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadVisionWorker } = require('../helpers/vision-worker');
const config = require('../../shared/config.js');
const catalogs = {
  en: require('../../locales/en.json'),
  ko: require('../../locales/ko.json'),
  zh: require('../../locales/zh-cn.json')
};

test('worker messages, context menus, labels and badges follow the saved and changed UI language', async () => {
  const worker = loadVisionWorker({ uiLanguage: 'ko', targetLang: 'ja' }, {}, { locale: 'en' });
  const { context } = worker;
  const menuTitles = new Map();
  context.chrome.contextMenus.create = (item, done) => { menuTitles.set(item.id, item.title); done(); };
  context.chrome.contextMenus.removeAll = (done) => { menuTitles.clear(); done(); };
  let tabTitle;
  context.chrome.action = {
    setBadgeBackgroundColor() {}, setBadgeText() {},
    setTitle({ title }) { tabTitle = title; }
  };

  async function check(language) {
    const catalog = catalogs[language];
    const snapshot = await context.handleMessage({ type: config.MSG.GET_CONFIG }, {});
    assert.equal(snapshot.targetLang, 'ja');
    const registry = await context.loadRegistry();
    const index = await context.loadPresetIndex();
    const preset = await context.loadPreset('general', 'general.json');
    assert.equal(registry.providers.custom.name, catalog.provider_custom_name);
    assert.equal(index.presets[0].name, catalog.preset_general_name);
    assert.equal(preset.name, catalog.preset_general_name);
    assert.equal(context.pageError('TAB_CLOSED').message, catalog.bg_tab_closed);
    const finished = context.pretranslationSnapshot({ status: 'ready', progress: {},
      noteKey: 'bg_next_chapter_polish_failed', noteDetail: 'provider error $2' });
    assert.equal(finished.note, catalog.bg_next_chapter_polish_failed.replace('$1', 'provider error $2'));
    await context.handleMessage({ type: config.MSG.PAGE_STATUS, status: 'done', targetCode: 'ja' },
      { tab: { id: 1 } });
    assert.equal(tabTitle, catalog.bg_badge_done.replace('$1', catalog.language_ja));
    await vm.runInContext('menuQueue', context);
    assert.equal(menuTitles.get('dsht-page'), catalog.bg_menu_page);
  }

  await context.DSHT.i18n.ready;
  await vm.runInContext('menuQueue', context);
  assert.equal(menuTitles.size, 0, 'a normal worker wake leaves existing menus alone');
  worker.install();
  await check('ko');
  await context.DSHT.i18n.setPreference('zh');
  await check('zh');
  await context.DSHT.i18n.setPreference('auto');
  await check('en');
});

test('a UI language change that wakes the worker refreshes existing menus', async () => {
  const { context } = loadVisionWorker({ uiLanguage: 'ko' });
  const menuTitles = new Map();
  context.chrome.contextMenus.create = (item, done) => { menuTitles.set(item.id, item.title); done(); };
  await context.chrome.storage.local.set({ uiLanguage: 'zh' });
  await vm.runInContext('menuQueue', context);
  assert.equal(menuTitles.get('dsht-page'), catalogs.zh.bg_menu_page);
});
