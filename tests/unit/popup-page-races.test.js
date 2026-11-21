'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installI18n } = require('../helpers/i18n');

function element() {
  return {
    textContent: '', value: '', checked: false, hidden: false, disabled: false,
    attributes: {}, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    appendChild() {},
    addEventListener() {}
  };
}

test('popup ignores stale page replies across refreshes, commands, and page hide', async (t) => {
  const nodes = new Map();
  const timers = new Map();
  const events = new Map();
  const requests = [];
  let timerId = 0;
  const config = require('../../shared/config.js');
  const originalFetch = global.fetch;
  global.document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    createElement: element,
    createDocumentFragment: element
  };
  global.window = {
    addEventListener(event, listener) { events.set(event, listener); },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    close() { assert.fail('an unstarted command cannot close the popup'); }
  };
  global.DSHT = { config, languages: require('../../shared/languages.js') };
  global.chrome = {
    tabs: { async query() { return [{ id: 1, url: 'https://example.com/' }]; } },
    runtime: {
      getURL(path) { return `chrome-extension://test/${path}`; },
      sendMessage(message) {
        if (message.type === config.MSG.GET_CONFIG) {
          return Promise.resolve({ ok: true, hasApiKey: true });
        }
        return new Promise((reply) => requests.push({ command: message.command, reply }));
      }
    },
    storage: { local: { async get() { return {}; } } }
  };
  global.fetch = async () => ({ ok: false });
  t.after(() => {
    delete global.document;
    delete global.window;
    delete global.chrome;
    delete global.DSHT;
    global.fetch = originalFetch;
  });

  const take = (command) => {
    const next = requests.shift();
    assert.equal(next?.command, command);
    return next.reply;
  };
  const replyState = (reply, status, extra) => reply({ ok: true, info: { status, ...extra } });
  const flush = () => new Promise(setImmediate);
  const poll = () => {
    assert.equal(timers.size, 1);
    const [id, callback] = timers.entries().next().value;
    timers.delete(id);
    callback();
    return take('getState');
  };

  installI18n();
  const { init } = await import('../../popup/popup-main.mjs');
  const { refreshState, handleMainAction, runQuickCommand } = await import('../../popup/popup-page.mjs');
  const { state, t: message } = await import('../../popup/popup-state.mjs');
  const initializing = init();
  await flush();
  replyState(take('getState'), 'done', { pageTranslated: true, pretranslationStatus: 'running' });
  await initializing;

  const stalePretranslation = poll();
  // Retranslate with new settings while a pretranslation poll has not yet returned.
  state.mainAction = { kind: 'retranslate', disabled: false };
  const translate = handleMainAction();
  take('translate')({ ok: true, started: true });
  await translate;
  replyState(stalePretranslation, 'done');
  await flush();
  assert.equal(state.info.status, 'running');

  const pendingPage = poll();
  const restore = handleMainAction();
  take('restore')({ ok: true, restored: true });
  await flush();
  replyState(take('getState'), 'idle');
  await restore;
  replyState(pendingPage, 'running');
  await flush();
  assert.equal(state.info.status, 'idle');
  assert.equal(timers.size, 0);

  for (const command of ['selection', 'images']) {
    const quick = runQuickCommand(command);
    take(command)({ ok: true, started: false, reason: 'cancelled' });
    await quick;
    assert.deepEqual(state.pageMessage, { tone: 'info', message: message('pop_cancelled') });
  }

  const first = refreshState();
  const stale = take('getState');
  const second = refreshState();
  replyState(take('getState'), 'running');
  await second;
  stale({ ok: false, error: { code: 'NO_PAGE_ACCESS' } });
  await first;
  assert.equal(state.pageError, null);
  assert.equal(state.info.status, 'running');

  const failedStop = handleMainAction();
  assert.equal(timers.size, 0, 'stop cancels a scheduled poll before issuing the command');
  take('restore')({ ok: false, error: { message: 'restore failed' } });
  await failedStop;
  replyState(take('getState'), 'running');
  await flush();
  assert.equal(state.pageMessage.message, 'restore failed');

  const last = poll();
  events.get('pagehide')();
  replyState(last, 'running', { progress: { done: 1, total: 2 } });
  await flush();
  assert.equal(state.info.progress.total, 0);
  assert.equal(timers.size, 0);
});
