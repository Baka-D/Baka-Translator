/** Screenshot decoding, cropping and paint synchronization. */
(function registerContentModule(globalScope) {
  'use strict';
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['image-capture'] = function createModule(app) {
  const { LIMITS } = app;

  function loadScreenshotImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('截图解码失败，请重试。'));
      image.src = dataUrl;
    });
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function cropImageFromScreenshot(screenshot, candidate) {
    const naturalWidth = screenshot.naturalWidth || screenshot.width;
    const naturalHeight = screenshot.naturalHeight || screenshot.height;
    if (!naturalWidth || !naturalHeight) throw new Error('截图尺寸异常，请重试。');

    const scaleX = naturalWidth / Math.max(1, window.innerWidth);
    const scaleY = naturalHeight / Math.max(1, window.innerHeight);
    const padding = 6;
    const left = clamp(candidate.rect.left - padding, 0, window.innerWidth);
    const top = clamp(candidate.rect.top - padding, 0, window.innerHeight);
    const right = clamp(candidate.rect.right + padding, 0, window.innerWidth);
    const bottom = clamp(candidate.rect.bottom + padding, 0, window.innerHeight);
    const sourceX = Math.floor(left * scaleX);
    const sourceY = Math.floor(top * scaleY);
    const sourceWidth = Math.max(1, Math.ceil((right - left) * scaleX));
    const sourceHeight = Math.max(1, Math.ceil((bottom - top) * scaleY));

    let targetWidth = sourceWidth;
    let targetHeight = sourceHeight;
    const maxDimension = LIMITS.IMAGE_MAX_DIMENSION;
    if (targetWidth > maxDimension || targetHeight > maxDimension) {
      const factor = maxDimension / Math.max(targetWidth, targetHeight);
      targetWidth = Math.max(1, Math.round(targetWidth * factor));
      targetHeight = Math.max(1, Math.round(targetHeight * factor));
    }

    let attemptWidth = targetWidth;
    let attemptHeight = targetHeight;
    let quality = LIMITS.IMAGE_JPEG_QUALITY;
    let dataUrl = '';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = attemptWidth;
      canvas.height = attemptHeight;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('无法处理页面截图，请重试。');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, attemptWidth, attemptHeight);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(
        screenshot,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        attemptWidth,
        attemptHeight
      );
      try {
        dataUrl = canvas.toDataURL('image/jpeg', quality);
      } catch (_error) {
        throw new Error('无法读取页面图片，浏览器拒绝了截图数据。');
      }
      if (dataUrl.length <= LIMITS.IMAGE_MAX_DATA_URL_CHARS - 200000) break;
      attemptWidth = Math.max(1, Math.round(attemptWidth * 0.72));
      attemptHeight = Math.max(1, Math.round(attemptHeight * 0.72));
      quality = Math.max(0.55, quality - 0.1);
    }

    if (!dataUrl) throw new Error('无法编码页面截图，请重试。');
    return dataUrl;
  }

  function nextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }

  return { loadScreenshotImage, clamp, cropImageFromScreenshot, nextPaint };
  };
})(globalThis);
