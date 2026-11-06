/** Recognize explicit model capability failures only on an image request. */
(function initApiVision(globalScope) {
  'use strict';

  function isUnsupportedError(error) {
    if (!error || typeof error !== 'object') return false;
    if (['VISION_UNSUPPORTED', 'IMAGE_UNSUPPORTED'].includes(error.code)) return true;
    if (![400, 404, 415, 422].includes(error.status)) return false;
    const message = String(error.providerMessage || error.message || '');
    // Bad image data, optional settings and image generation say nothing about input capability.
    if (/\b(?:format|mime|base64|dimension|resolution|detail|pixel|width|height|download|decode|encoding)\b|too large|格式|尺寸|大小|分辨率|参数/i.test(message)) return false;
    if (/image[ -](?:generation|output)|generat(?:e|ing) images?|(?:图像|图片)(?:生成|输出)|生成图片|生成图像/i.test(message)) return false;
    if (/\b(?:response|output) modalities\b|\b(?:system|assistant)\b.{0,20}\b(?:messages?|roles?)\b/i.test(message)) return false;
    return /\bmodel\b.{0,160}\b(?:does(?: not|n't) support|does(?: not|n't) accept|cannot (?:accept|process|read)|can't (?:accept|process|read)).{0,60}\b(?:images?|image_url|vision|visual)\b/i.test(message) ||
      /\b(?:images?|image_url|vision)\b.{0,80}\b(?:not supported|unsupported)\b.{0,40}\b(?:this|the|selected|current) model\b/i.test(message) ||
      /\bimage_url\b.{0,60}\bonly supported\b.{0,60}\bmodels\b/i.test(message) ||
      /\bmodel\b.{0,60}\bonly supports? text(?:[- ]only)? (?:inputs?|messages?|prompts?)\b/i.test(message) ||
      /\bunsupported input modality\s*:?\s*['"`]?image\b/i.test(message) ||
      /模型.{0,100}(?:不支持|无法(?:处理|识别|读取)).{0,20}(?:图像|图片|视觉)/.test(message);
  }

  const api = Object.freeze({ isUnsupportedError });
  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.apiVision = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
