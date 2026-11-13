/** Images behavior for the content script. */
(function registerContentModule(globalScope) {
  'use strict';
  const { t } = globalScope.DSHT.i18n;
  const modules = globalScope.DSHT.contentModules ||= {};
  modules['images'] = function createModule(app) {
  const { languages, MSG, LIMITS, page, imageJob, overlay } = app;
  const { loadScreenshotImage, clamp, cropImageFromScreenshot, nextPaint } = app;
  const UNSUPPORTED_NOTICE = t('content_vision_unsupported');
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
        sourceLabel: item.sourceLabel || '',
        error: item.error || ''
      };
    });
    const failed = imageJob.items.filter((item) => item.status === 'error').length;
    const finished = imageJob.items.filter(
      (item) => item.status === 'error' || item.status === 'done'
    ).length;
    let subtitle = imageJob.subtitle || '';
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
      emptyMessage: imageJob.error || '',
      footer: t('content_image_privacy')
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
            // The panel shows a 58px thumb; resending the full OCR crop on every update is wasteful.
            thumbnail: cropImageFromScreenshot(screenshot, candidate, 160, 0.7),
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
      const worker = async () => {
        while (true) {
          if (runId !== imageJob.runId) return;
          const index = cursor;
          cursor += 1;
          if (index >= imageJob.items.length) return;
          const item = imageJob.items[index];
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
            const sourceLanguage = String(response.sourceLanguage || '').slice(0, 40);
            item.sourceLabel = response.sourceLanguage
              ? t('content_detected_language', [globalScope.DSHT.i18n.languageLabel(sourceLanguage, sourceLanguage)])
              : '';
            item.error = '';
          } catch (error) {
            if (runId !== imageJob.runId) return;
            if (error.code === 'VISION_UNSUPPORTED') {
              showImageUnsupported();
              return;
            }
            item.status = 'error';
            item.error = error.message || t('content_image_translation_error');
            if (app.isSettingsError(error.code)) {
              overlay.showToast(t('content_image_provider_error'), 'error');
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
      imageJob.error = error.message || t('content_image_translation_error');
      imageJob.running = false;
      imageJob.items = [];
      imageJob.subtitle = t('content_keep_page_foreground');
      overlay.showToast(t('content_image_error_details'), 'error');
      renderImagePanel();
    } finally {
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
      sourceLabel: '',
      error: ''
    }));
    imageJob.error = '';
    imageJob.skipped = Math.max(0, collected.totalEligible - LIMITS.IMAGE_MAX_COUNT);
    imageJob.subtitle = t('content_capturing');
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
