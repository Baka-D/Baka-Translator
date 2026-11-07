/** Images behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['images'] = function createModule(app) {
  const { languages, MSG, LIMITS, page, imageJob, overlay } = app;
  const UNSUPPORTED_NOTICE = '当前模型不支持图像识别，已停用图片翻译。请切换到支持图像识别的模型。';
  imageJob.unsupported = false;
  let capabilityRevision = 0;

  async function imageTranslationEnabled() {
    const snapshot = await app.sendRuntime({ type: MSG.GET_CONFIG });
    return snapshot.model?.supportsVision !== false;
  }

  function showImageUnsupported() {
    const notify = !imageJob.unsupported;
    imageJob.runId += 1;
    Object.assign(imageJob, { unsupported: true, open: true, running: false,
      items: [], error: UNSUPPORTED_NOTICE, subtitle: '' });
    renderImagePanel();
    if (notify) overlay.showToast(UNSUPPORTED_NOTICE, 'info');
  }

  function bindImageCapabilityChanges() {
    if (!chrome.storage?.onChanged?.addListener) return;
    const keys = ['MODEL_ID', 'TRANSLATION_MODEL_ID', 'CUSTOM_PROVIDER', 'CUSTOM_PROVIDERS',
      'USER_MODELS', 'VISION_CAPABILITIES'].map(key => app.config.STORAGE_KEYS[key]).filter(Boolean);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes || !keys.some(key => Object.hasOwn(changes, key))) return;
      const selectionChanged = keys.some(key => key !== app.config.STORAGE_KEYS.VISION_CAPABILITIES &&
        Object.hasOwn(changes, key));
      if (selectionChanged && (imageJob.running || imageJob.unsupported)) closeImagePanel();
      const revision = ++capabilityRevision;
      void imageTranslationEnabled().then(enabled => {
        if (revision !== capabilityRevision) return;
        if (!enabled && imageJob.open) showImageUnsupported();
        else if (enabled && imageJob.unsupported) closeImagePanel();
      }).catch(() => {});
    });
  }

  const frameOf = (element) => element.ownerDocument?.defaultView?.frameElement;

  function shownThroughFrames(img) {
    for (let element = img; element; element = frameOf(element)) {
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    }
    return true;
  }

  /** Each image's intersectionRect: clipped by all its ancestors, in its own frame's viewport. */
  function visibleRects(images) {
    if (images.length === 0) return Promise.resolve(new Map());
    return new Promise((resolve) => {
      const observer = new IntersectionObserver((entries) => {
        observer.disconnect();
        resolve(new Map(entries.map((entry) => [entry.target, entry.intersectionRect])));
      });
      for (const img of images) observer.observe(img);
    });
  }

  // shortcut: a rotated or skewed frame maps through its bounding box and crops the wrong
  // pixels, use a DOMMatrix from the frame's computed transform if such pages show up.
  function toTopViewport(img, rect) {
    let { left, top, right, bottom } = rect;
    for (let frame = frameOf(img); frame; frame = frameOf(frame)) {
      const box = frame.getBoundingClientRect();
      const style = frame.ownerDocument.defaultView.getComputedStyle(frame);
      const scaleX = box.width / frame.offsetWidth;
      const scaleY = box.height / frame.offsetHeight;
      const originX = frame.clientLeft + parseFloat(style.paddingLeft);
      const originY = frame.clientTop + parseFloat(style.paddingTop);
      left = box.left + (originX + left) * scaleX;
      right = box.left + (originX + right) * scaleX;
      top = box.top + (originY + top) * scaleY;
      bottom = box.top + (originY + bottom) * scaleY;
    }
    return { left, top, right, bottom };
  }

  async function collectVisibleImages() {
    const candidates = [];
    const images = app.collectComposedTextRoots(document)
      .flatMap((root) => Array.from(root.querySelectorAll('img')))
      .filter((img) => img.currentSrc && img.complete && img.naturalWidth !== 0 &&
        shownThroughFrames(img));
    const rects = await visibleRects(images);

    for (const img of images) {
      const rect = rects.get(img);
      if (!rect?.width || !rect.height) continue;
      const { left, top, right, bottom } = toTopViewport(img, rect);
      const visibleWidth = right - left;
      const visibleHeight = bottom - top;
      if (visibleWidth < LIMITS.IMAGE_MIN_WIDTH || visibleHeight < LIMITS.IMAGE_MIN_HEIGHT) {
        continue;
      }
      const visibleArea = visibleWidth * visibleHeight;
      if (visibleArea < LIMITS.IMAGE_MIN_AREA) continue;
      candidates.push({
        element: img,
        rect: {
          left,
          top,
          right,
          bottom,
          width: visibleWidth,
          height: visibleHeight
        },
        area: visibleArea,
        alt: String(img.alt || '').slice(0, 120)
      });
    }

    const seen = new Set();
    const unique = candidates.filter((candidate) => {
      if (seen.has(candidate.element)) return false;
      seen.add(candidate.element);
      return true;
    });
    unique.sort((a, b) => b.area - a.area);
    return {
      totalEligible: unique.length,
      candidates: unique.slice(0, LIMITS.IMAGE_MAX_COUNT)
    };
  }

  function imagePanelModel() {
    const items = imageJob.items.map((item) => {
      const stateLabel =
        item.status === 'pending'
          ? '排队中'
          : item.status === 'loading'
            ? '识别中'
            : item.status === 'error'
              ? '失败'
              : item.hasText
                ? '已翻译'
                : '无文字';
      return {
        thumbnail: item.thumbnail || '',
        thumbnailAlt: item.alt ? `图片截图：${item.alt}` : '图片截图',
        status: item.status,
        stateLabel,
        hasText: Boolean(item.hasText),
        translation: item.translation || '',
        original: item.original || '',
        sourceLabel: item.sourceLabel || '',
        error: item.error || ''
      };
    });
    const failed = imageJob.items.filter((item) => item.status === 'error').length;
    const finished = imageJob.items.filter(
      (item) => item.status === 'error' || item.status === 'done'
    ).length;
    let subtitle = imageJob.subtitle || '';
    if (imageJob.running) {
      subtitle = `正在识别 · ${finished}/${imageJob.items.length || 0}`;
    } else if (imageJob.items.length > 0) {
      subtitle = failed > 0
        ? `${imageJob.items.length} 张图片 · ${failed} 张失败`
        : `${imageJob.items.length} 张图片 · 识别完成`;
    }
    return {
      visible: imageJob.open,
      title: imageJob.unsupported ? '图片翻译已停用' : imageJob.error && imageJob.items.length === 0 ? '图片翻译失败' : '图片翻译',
      subtitle,
      items,
      emptyMessage: imageJob.error || '',
      footer: '仅截取当前画面中可见的图片区域并发送给所选模型服务商识别，不会上传整页截图。'
    };
  }

  function renderImagePanel() {
    overlay.renderImagePanel(imagePanelModel());
  }

  function closeImagePanel() {
    imageJob.runId += 1;
    imageJob.open = false;
    imageJob.running = false;
    imageJob.items = [];
    imageJob.error = '';
    imageJob.unsupported = false;
    overlay.renderImagePanel({ visible: false });
  }

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

  async function processImageJob(job) {
    const runId = job.runId;
    let captureMode = false;
    try {
      // Never let our own overlays end up in the screenshot we send for OCR.
      overlay.setCaptureMode(true);
      captureMode = true;
      await nextPaint();
      const screenshotResponse = await app.sendRuntime({ type: MSG.CAPTURE_SCREENSHOT });
      overlay.setCaptureMode(false);
      captureMode = false;
      if (runId !== imageJob.runId) return;

      const screenshot = await loadScreenshotImage(screenshotResponse.dataUrl);
      const items = [];
      for (const candidate of job.candidates) {
        if (runId !== imageJob.runId) return;
        try {
          const dataUrl = cropImageFromScreenshot(screenshot, candidate);
          items.push({
            status: 'pending',
            thumbnail: dataUrl,
            dataUrl,
            alt: candidate.alt,
            hasText: false,
            translation: '',
            original: '',
            sourceLabel: '',
            error: ''
          });
        } catch (error) {
          items.push({
            status: 'error',
            thumbnail: '',
            dataUrl: '',
            alt: candidate.alt,
            hasText: false,
            translation: '',
            original: '',
            sourceLabel: '',
            error: error.message || '图片裁剪失败。'
          });
        }
      }
      if (runId !== imageJob.runId) return;
      imageJob.items = items;
      imageJob.subtitle = `${items.length} 张图片`;
      imageJob.running = true;
      renderImagePanel();
      // Sandboxed pages stop the results window from running: fail before paying for OCR.
      const panelReady = await overlay.waitImagePanel(5000);
      if (runId !== imageJob.runId) return;
      if (!panelReady) {
        closeImagePanel();
        overlay.showToast('当前页面的安全策略不允许显示结果窗口，图片未发送。', 'error');
        return;
      }

      let cursor = 0;
      const worker = async () => {
        while (true) {
          if (runId !== imageJob.runId) return;
          const index = cursor;
          cursor += 1;
          if (index >= imageJob.items.length) return;
          const item = imageJob.items[index];
          if (!item.dataUrl) {
            item.status = 'error';
            item.error = item.error || '图片截图失败，请重试。';
            renderImagePanel();
            continue;
          }
          item.status = 'loading';
          renderImagePanel();
          try {
            const response = await app.sendRuntime({
              type: MSG.TRANSLATE_IMAGE,
              targetCode: imageJob.targetCode,
              sourceHint: imageJob.sourceHint,
              imageDataUrl: item.dataUrl
            });
            if (runId !== imageJob.runId) return;
            item.status = 'done';
            item.hasText = Boolean(response.hasText);
            item.translation = typeof response.translation === 'string' ? response.translation : '';
            item.original = typeof response.original === 'string' ? response.original : '';
            item.sourceLabel = response.sourceLanguage
              ? `识别语言：${String(response.sourceLanguage).slice(0, 40)}`
              : '';
            item.error = '';
          } catch (error) {
            if (runId !== imageJob.runId) return;
            if (error.code === 'VISION_UNSUPPORTED') {
              showImageUnsupported();
              return;
            }
            item.status = 'error';
            item.error = error.message || '图片识别失败，请重试。';
            if (app.isSettingsError(error.code)) {
              overlay.showToast('图片翻译失败，请检查所选服务商的设置。', 'error');
            }
          }
          renderImagePanel();
        }
      };

      const workerCount = Math.max(
        1,
        Math.min(LIMITS.IMAGE_MAX_CONCURRENCY, imageJob.items.length)
      );
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      if (runId !== imageJob.runId) return;
      imageJob.running = false;
      imageJob.subtitle = '';
      renderImagePanel();
    } catch (error) {
      if (runId !== imageJob.runId) return;
      if (error.code === 'VISION_UNSUPPORTED') {
        showImageUnsupported();
        return;
      }
      imageJob.error = error.message || '图片翻译失败，请重试。';
      imageJob.running = false;
      imageJob.items = [];
      imageJob.subtitle = '请保持页面在前台后重试。';
      overlay.showToast('图片翻译失败，请在图片结果面板查看详情。', 'error');
      renderImagePanel();
    } finally {
      if (captureMode) overlay.setCaptureMode(false);
    }
  }

  async function startImageTranslation(message) {
    const request = message || {};
    if (imageJob.running) {
      overlay.showToast('正在识别图片，请稍候。', 'info');
      return { started: false, reason: 'running' };
    }

    const revision = capabilityRevision;
    const enabled = await imageTranslationEnabled();
    if (revision !== capabilityRevision) return { started: false, reason: 'model-changed' };
    if (!enabled) {
      showImageUnsupported();
      return { started: false, reason: 'vision-unsupported' };
    }
    imageJob.unsupported = false;

    const settings = await app.readSettings();
    if (revision !== capabilityRevision) return { started: false, reason: 'model-changed' };
    const targetCode = languages.normalizeTarget(
      request.targetCode !== undefined ? request.targetCode : settings.targetLang
    );
    const collected = await collectVisibleImages();
    if (revision !== capabilityRevision) return { started: false, reason: 'model-changed' };
    // Two starts can both pass the check at the top while these awaits are pending.
    if (imageJob.running) return { started: false, reason: 'running' };
    if (collected.candidates.length === 0) {
      overlay.showToast('当前画面中没有找到足够大的图片，请滚动到图片处再试。', 'info');
      return {
        ok: false,
        error: {
          code: 'NO_VISIBLE_IMAGES',
          message: '当前画面中没有找到可翻译的图片。'
        }
      };
    }

    imageJob.runId += 1;
    const runId = imageJob.runId;
    const source = page.source || app.detectPageLanguage(false);
    imageJob.open = true;
    imageJob.running = true;
    imageJob.targetCode = targetCode;
    imageJob.sourceHint = source && source.code;
    imageJob.items = collected.candidates.map((candidate) => ({
      status: 'pending',
      thumbnail: '',
      dataUrl: '',
      alt: candidate.alt,
      hasText: false,
      translation: '',
      original: '',
      sourceLabel: '',
      error: ''
    }));
    imageJob.error = '';
    imageJob.subtitle =
      collected.totalEligible > LIMITS.IMAGE_MAX_COUNT
        ? `当前画面有 ${collected.totalEligible} 张图片，仅处理最大的 ${LIMITS.IMAGE_MAX_COUNT} 张`
        : '正在截取当前画面…';
    // Do not paint the image panel before captureVisibleTab() runs.
    overlay.hideImagePanel();

    void processImageJob({
      candidates: collected.candidates,
      runId
    });

    return {
      started: true,
      imageCount: collected.candidates.length,
      totalEligible: collected.totalEligible
    };
  }

  return {
    bindImageCapabilityChanges,
    collectVisibleImages,
    imagePanelModel,
    renderImagePanel,
    closeImagePanel,
    loadScreenshotImage,
    clamp,
    cropImageFromScreenshot,
    nextPaint,
    processImageJob,
    startImageTranslation
  };
  };
})(globalThis);
