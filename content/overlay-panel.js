(function initOverlayPart(globalScope) {
  'use strict';
  globalScope.DSHT = globalScope.DSHT || {};
  const parts = globalScope.DSHT.overlayParts = globalScope.DSHT.overlayParts || {};

  parts.createPanel = function createPanel(callbacks) {
    const { el, onTrusted } = parts;
    let panel, panelTitle, panelSubtitle, panelProgress, panelProgressFill;
    let panelActions, panelNote, panelDismiss;

    function buildPanel(layer) {
      panel = el('section', 'dsht-panel dsht-hidden');
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', 'Baka Translator 页面翻译');

      const head = el('div', 'dsht-panel-head');
      const logo = el('div', 'dsht-logo', '译');
      const copy = el('div', 'dsht-panel-copy');
      panelTitle = el('h2', 'dsht-panel-title', '正在翻译…');
      panelSubtitle = el('div', 'dsht-panel-subtitle', '');
      panelSubtitle.setAttribute('aria-live', 'polite');
      copy.appendChild(panelTitle);
      copy.appendChild(panelSubtitle);

      panelDismiss = el('button', 'dsht-icon-button', '×');
      panelDismiss.type = 'button';
      panelDismiss.setAttribute('aria-label', '关闭翻译面板');
      panelDismiss.title = '关闭面板（翻译会继续）';
      onTrusted(panelDismiss, 'click', () => callbacks.onPanelAction && callbacks.onPanelAction('dismiss'));

      head.appendChild(logo);
      head.appendChild(copy);
      head.appendChild(panelDismiss);
      panel.appendChild(head);

      const progress = el('div', 'dsht-progress');
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-label', '翻译进度');
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      panelProgressFill = el('div', 'dsht-progress-fill');
      progress.appendChild(panelProgressFill);
      panelProgress = progress;
      panel.appendChild(progress);

      panelActions = el('div', 'dsht-panel-actions');
      panel.appendChild(panelActions);

      panelNote = el('div', 'dsht-panel-note dsht-hidden');
      panel.appendChild(panelNote);

      layer.appendChild(panel);
    }

    function renderPanel(model) {
      if (!model || !model.visible) {
        if (panel) panel.classList.add('dsht-hidden');
        return;
      }
      if (!panel) return;
      panel.classList.remove('dsht-hidden');
      panel.dataset.status = model.status || 'running';
      panelTitle.textContent = model.title || '正在翻译…';
      panelSubtitle.textContent = model.subtitle || '';

      const showProgress = Boolean(model.showProgress);
      panelProgress.classList.toggle('dsht-hidden', !showProgress);
      if (showProgress) {
        const ratio = Math.max(0, Math.min(1, Number(model.progressRatio) || 0));
        panelProgressFill.style.width = `${Math.round(ratio * 100)}%`;
        panelProgress.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
      }

      panelActions.textContent = '';
      for (const action of model.actions || []) {
        if (!action || !action.id) continue;
        const button = el(
          'button',
          `dsht-btn ${action.variant === 'primary' ? 'dsht-btn-primary' : action.variant === 'danger' ? 'dsht-btn-danger' : 'dsht-btn-ghost'}`,
          action.label
        );
        button.type = 'button';
        button.dataset.action = action.id;
        const actionId = action.id;
        onTrusted(button, 'click', () => callbacks.onPanelAction && callbacks.onPanelAction(actionId));
        panelActions.appendChild(button);
      }
      panelActions.classList.toggle('dsht-hidden', (model.actions || []).length === 0);
      panelDismiss.classList.toggle('dsht-hidden', model.showDismiss === false);

      const note = model.note || '';
      panelNote.textContent = note;
      panelNote.classList.toggle('dsht-hidden', !note);
    }

    function hidePanel() {
      if (panel) panel.classList.add('dsht-hidden');
    }

    return { build: buildPanel, render: renderPanel, hide: hidePanel };
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
