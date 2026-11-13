/** Images behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['images'] = function createModule(app) {
  const { languages, MSG, LIMITS, page, imageJob, overlay } = app;
  const { loadScreenshotImage, clamp, cropImageFromScreenshot, nextPaint } = app;
  const UNSUPPORTED_NOTICE = '当前模型不支持图像识别，已停用图片翻译。请切换到支持图像识别的模型。';
  imageJob.unsupported = false;
  let capabilityRevision = 0;
  let captureRunId = null;

  function finishCapture(runId) {
    if (captureRunId !== runId) return;
    captureRunId = null;
    overlay.setCaptureMode(false);
  }

  async function imageTranslationEnabled() {
    const snapshot = await app.sendRuntime({ type: MSG.GET_CONFIG });
    return snapshot.model?.supportsVision !== false;
  }

  function showImageUnsupported() {
    const notify = !imageJob.unsupported;
    finishCapture(imageJob.runId);
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
    const skipped = imageJob.skipped > 0 ? ` · 另有 ${imageJob.skipped} 张未处理` : '';
    if (imageJob.running) {
      subtitle = `正在识别 · ${finished}/${imageJob.items.length || 0}${skipped}`;
    } else if (imageJob.items.length > 0) {
      subtitle = failed > 0
        ? `${imageJob.items.length} 张图片 · ${failed} 张失败${skipped}`
        : `${imageJob.items.length} 张图片 · 识别完成${skipped}`;
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
    finishCapture(imageJob.runId);
    imageJob.runId += 1;
    imageJob.open = false;
    imageJob.running = false;
    imageJob.items = [];
    imageJob.error = '';
    imageJob.unsupported = false;
    overlay.renderImagePanel({ visible: false });
  }

  async function processImageJob(job) {
    const runId = job.runId;
    if (runId !== imageJob.runId) return;
    try {
      // Never let our own overlays end up in the screenshot we send for OCR.
      captureRunId = runId;
      overlay.setCaptureMode(true);
      await nextPaint();
      if (runId !== imageJob.runId) return;
      const screenshotResponse = await app.sendRuntime({ type: MSG.CAPTURE_SCREENSHOT });
      finishCapture(runId);
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
      finishCapture(runId);
    }
  }

  async function startImageTranslation(message) {
    const request = message || {};
    if (imageJob.running) {
      overlay.showToast('正在识别图片，请稍候。', 'info');
      return { started: false, reason: 'running' };
    }

    const revision = capabilityRevision;
    const pendingRunId = imageJob.runId;
    const cancelled = () => pendingRunId !== imageJob.runId;
    const cancelledResult = () => ({ started: false, reason: imageJob.running ? 'running' : 'cancelled' });
    const enabled = await imageTranslationEnabled();
    if (revision !== capabilityRevision) return { started: false, reason: 'model-changed' };
    if (cancelled()) return cancelledResult();
    if (!enabled) {
      showImageUnsupported();
      return { started: false, reason: 'vision-unsupported' };
    }
    imageJob.unsupported = false;

    const settings = await app.readSettings();
    if (revision !== capabilityRevision) return { started: false, reason: 'model-changed' };
    if (cancelled()) return cancelledResult();
    const targetCode = languages.normalizeTarget(
      request.targetCode !== undefined ? request.targetCode : settings.targetLang
    );
    const collected = await collectVisibleImages();
    if (revision !== capabilityRevision) return { started: false, reason: 'model-changed' };
    if (cancelled()) return cancelledResult();
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
    imageJob.skipped = Math.max(0, collected.totalEligible - LIMITS.IMAGE_MAX_COUNT);
    imageJob.subtitle = '正在截取当前画面…';
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
