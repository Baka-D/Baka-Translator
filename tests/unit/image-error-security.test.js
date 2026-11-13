'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createLocalizedContext } = require('../helpers/i18n');
const config = require('../../shared/config.js');

for (const failure of [config.MSG.CAPTURE_SCREENSHOT, config.MSG.TRANSLATE_IMAGE]) {
  test(`image error details stay in the isolated panel (${failure})`, async () => {
    const secret = 'private OCR echoed by provider';
    const panels = [], toasts = [];
    const imageJob = { runId: 1, open: true, running: true, targetCode: 'zh', items: [] };
    const app = {
      config, MSG: config.MSG, LIMITS: config.LIMITS, imageJob,
      overlay: { setCaptureMode() {}, renderImagePanel: model => panels.push(model),
        waitImagePanel: async () => true,
        showToast: message => toasts.push(message) },
      isSettingsError: () => true,
      sendRuntime: async message => {
        if (message.type === failure) throw Object.assign(new Error(secret), { code: 'AUTH_FAILED' });
        return { dataUrl: 'data:image/png;base64,AA==' };
      }
    };
    const context = createLocalizedContext({
      DSHT: {},
      requestAnimationFrame: callback => callback(), window: { innerWidth: 1000, innerHeight: 1000 },
      Image: class {
        naturalWidth = 1000; naturalHeight = 1000;
        set src(_value) { this.onload(); }
      },
      document: { createElement: () => ({
        getContext: () => ({ fillRect() {}, drawImage() {} }),
        toDataURL: () => 'data:image/jpeg;base64,AA=='
      }) }
    });
    for (const name of ['image-capture', 'images']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, `../../content/content-${name}.js`), 'utf8'), context);
      Object.assign(app, context.DSHT.contentModules[name](app));
    }
    await app.processImageJob({ runId: 1, candidates: [{ alt: '', rect: {
      left: 10, top: 10, right: 210, bottom: 160, width: 200, height: 150
    } }] });
    assert.equal(toasts.length, 1);
    assert.ok(toasts.every(message => !message.includes(secret)));
    assert.ok(JSON.stringify(panels).includes(secret), 'details remain available in the private viewer');
  });
}
