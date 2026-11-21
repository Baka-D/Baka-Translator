/** Images behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const { t } = globalScope.DSHT.i18n;
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['images'] = function createModule(app) {
  const { languages, MSG, LIMITS, page, imageJob, overlay } = app;
  const { loadScreenshotImage, clamp, screenshotViewport, cropImageFromScreenshot, nextPaint } = app;
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
      items: [], error: '' });
    renderImagePanel();
    if (notify) overlay.showToast(t('content_vision_unsupported'), 'info');
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
    const viewport = screenshotViewport();

    for (const img of images) {
      const rect = rects.get(img);
      if (!rect?.width || !rect.height) continue;
      const box = toTopViewport(img, rect);
      const left = Math.max(box.left, viewport.left);
      const top = Math.max(box.top, viewport.top);
      const right = Math.min(box.right, viewport.left + viewport.width);
      const bottom = Math.min(box.bottom, viewport.top + viewport.height);
      const visibleWidth = right - left;
      const visibleHeight = bottom - top;
      if (!(visibleWidth >= LIMITS.IMAGE_MIN_WIDTH && visibleHeight >= LIMITS.IMAGE_MIN_HEIGHT)) {
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
          ? t('content_queued')
          : item.status === 'loading'
            ? t('content_translating')
            : item.status === 'error'
              ? t('content_failed')
              : item.hasText
                ? t('content_translated')
                : t('content_no_text');
      return {
        thumbnail: item.thumbnail || '',
        thumbnailAlt: item.alt ? t('content_image_alt', [item.alt]) : t('content_image_screenshot'),
        status: item.status,
        stateLabel,
        hasText: Boolean(item.hasText),
        translation: item.translation || '',
        original: item.original || '',
        sourceLabel: item.sourceLanguage
          ? t('content_detected_language', [globalScope.DSHT.i18n.languageLabel(item.sourceLanguage, item.sourceLanguage)])
          : '',
        error: item.error || ''
      };
    });
    const failed = imageJob.items.filter((item) => item.status === 'error').length;
    const finished = imageJob.items.filter(
      (item) => item.status === 'error' || item.status === 'done'
    ).length;
    let subtitle = imageJob.error ? t('content_keep_page_foreground') : '';
    const skipped = imageJob.skipped > 0 ? t('content_images_skipped', [imageJob.skipped]) : '';
    if (imageJob.running) {
      subtitle = t('content_images_progress', [finished, imageJob.items.length || 0, skipped]);
    } else if (imageJob.items.length > 0) {
      subtitle = failed > 0
        ? t('content_images_failed_count', [imageJob.items.length, failed, skipped])
        : t('content_images_done_count', [imageJob.items.length, skipped]);
    }
    return {
      visible: imageJob.open,
      title: imageJob.unsupported ? t('content_image_disabled') : imageJob.error && imageJob.items.length === 0 ? t('content_image_failed') : t('content_image_translation'),
      subtitle,
      items,
      emptyMessage: imageJob.unsupported ? t('content_vision_unsupported') : imageJob.error || '',
      footer: t('content_image_privacy')
    };
  }

  function renderImagePanel() {
    overlay.renderImagePanel(imagePanelModel());
  }

  function refreshImagePanelLanguage() {
    // The panel stays hidden until the screenshot has been taken.
    if (imageJob.open && captureRunId === null) renderImagePanel();
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
    const items = [];
    try {
      // Never let our own overlays end up in the screenshot we send for OCR.
      captureRunId = runId;
      overlay.setCaptureMode(true);
      await nextPaint();
      if (runId !== imageJob.runId) return;
      const viewport = screenshotViewport();
      const screenshotResponse = await app.sendRuntime({ type: MSG.CAPTURE_SCREENSHOT });
      finishCapture(runId);
      if (runId !== imageJob.runId) return;

      const screenshot = await loadScreenshotImage(screenshotResponse.dataUrl);
      for (const candidate of job.candidates) {
        if (runId !== imageJob.runId) return;
        try {
          const dataUrl = cropImageFromScreenshot(screenshot, candidate, undefined, undefined, viewport);
          items.push({
            status: 'pending',
            // The panel shows a 58px thumb; resending the full OCR crop on every update is wasteful.
            thumbnail: cropImageFromScreenshot(screenshot, candidate, 160, 0.7, viewport),
            dataUrl,
            alt: candidate.alt,
            hasText: false,
            translation: '',
            original: '',
            sourceLanguage: '',
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
            sourceLanguage: '',
            error: error.message || t('content_image_crop_error')
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
        overlay.showToast(t('content_image_panel_blocked'), 'error');
        return;
      }

      let cursor = 0;
      let fatalError;
      const worker = async () => {
        while (!fatalError && cursor < items.length) {
          if (runId !== imageJob.runId) return;
          const item = items[cursor++];
          if (!item.dataUrl) {
            item.status = 'error';
            item.error = item.error || t('content_image_capture_error');
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
            item.sourceLanguage = String(response.sourceLanguage || '').slice(0, 40);
            item.error = '';
          } catch (error) {
            if (runId !== imageJob.runId) return;
            if (error.code === 'VISION_UNSUPPORTED') {
              showImageUnsupported();
              return;
            }
            item.status = 'error';
            item.error = error.message || t('content_image_translation_error');
            if (!fatalError && app.FATAL_ERROR_CODES?.has(error.code)) {
              fatalError = item.error;
              const notice = error.code === 'EXTENSION_RELOADED' ? 'content_extension_updated'
                : app.isSettingsError(error.code) ? 'content_image_provider_error' : 'content_image_error_details';
              overlay.showToast(t(notice), 'error');
              for (const pending of items.slice(cursor)) {
                if (pending.status === 'pending') Object.assign(pending, { status: 'error', error: fatalError, dataUrl: '' });
              }
            }
          } finally {
            item.dataUrl = '';
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
      renderImagePanel();
    } catch (error) {
      if (runId !== imageJob.runId) return;
      if (error.code === 'VISION_UNSUPPORTED') {
        showImageUnsupported();
        return;
      }
      imageJob.error = error.message || t('content_image_translation_error');
      imageJob.running = false;
      imageJob.items = [];
      overlay.showToast(t('content_image_error_details'), 'error');
      renderImagePanel();
    } finally {
      for (const item of items) item.dataUrl = '';
      finishCapture(runId);
    }
  }

  async function startImageTranslation(message) {
    const request = message || {};
    if (imageJob.running) {
      overlay.showToast(t('content_images_busy'), 'info');
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
      overlay.showToast(t('content_no_large_images'), 'info');
      return {
        ok: false,
        error: {
          code: 'NO_VISIBLE_IMAGES',
          message: t('content_no_images')
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
      sourceLanguage: '',
      error: ''
    }));
    imageJob.error = '';
    imageJob.skipped = Math.max(0, collected.totalEligible - LIMITS.IMAGE_MAX_COUNT);
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
    refreshImagePanelLanguage,
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
