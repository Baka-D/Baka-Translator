// Settings-page provider manager: a side list of providers plus one detail panel.
import { state, ui } from './context.mjs';
import { renderCustomFields } from './custom-provider.mjs';
import { renderKeyPanel, resetClearConfirm, setKeyVisibility } from './keys.mjs';
import { renderProviderModels } from './provider-models.mjs';
import { polishProvider, providerKeyFor, translationProvider } from './models.mjs';
import { setFeedback } from './utils.mjs';

export function registryProviders() {
  return state.registry && state.registry.providers ? Object.values(state.registry.providers) : [];
}

export function getProvider(providerIdValue) {
  return (state.registry && state.registry.providers && state.registry.providers[providerIdValue]) || null;
}

export function keyRequired(provider) {
  return !provider || provider.apiKeyRequired !== false;
}

/** Purposes ("翻译" / "润色") that currently use this provider. */
export function providerUses(providerIdValue) {
  const uses = [];
  if (translationProvider() && translationProvider().id === providerIdValue) uses.push('翻译');
  if (polishProvider() && polishProvider().id === providerIdValue) uses.push('润色');
  return uses;
}

/** The provider shown in the detail panel, or null while adding a new one. */
export function selectedProvider() {
  if (state.providerDraft) return null;
  return getProvider(state.selectedProviderId);
}

function keyTone(provider) {
  if (providerKeyFor(provider.id)) return { tone: 'success', text: '已保存 Key' };
  return keyRequired(provider) ? { tone: 'muted', text: '未配置 Key' } : { tone: 'muted', text: '无需 Key' };
}

function tagList(uses) {
  return uses.map((use) => {
    const tag = document.createElement('span');
    tag.className = 'provider-tag';
    tag.textContent = use;
    return tag;
  });
}

function navItem(provider, label, uses, selected, onClick) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'provider-nav-item';
  button.dataset.provider = provider ? provider.id : '';
  if (selected) button.setAttribute('aria-current', 'true');
  const name = document.createElement('span');
  name.className = 'provider-nav-name';
  name.textContent = label;
  const meta = document.createElement('span');
  meta.className = 'provider-nav-meta';
  const status = provider ? keyTone(provider) : { tone: 'muted', text: '未保存' };
  const dot = document.createElement('span');
  dot.className = 'provider-dot';
  dot.dataset.tone = status.tone;
  meta.append(...tagList(uses), dot);
  button.append(name, meta);
  button.setAttribute('aria-label', [label, uses.length ? `${uses.join('、')}使用中` : '', status.text]
    .filter(Boolean).join('，'));
  button.disabled = state.busy || state.customBusy;
  button.addEventListener('click', onClick);
  item.append(button);
  return item;
}

export function selectProvider(providerIdValue) {
  // The running save/test reports into the panel that started it.
  if (state.busy || state.customBusy) return;
  resetClearConfirm();
  state.providerDraft = false;
  state.selectedProviderId = providerIdValue;
  state.confirmDeleteProvider = '';
  renderProviders();
}

export function startAddProvider() {
  if (state.busy || state.customBusy) return;
  resetClearConfirm();
  state.providerDraft = true;
  state.confirmDeleteProvider = '';
  renderProviders();
  if (ui.providerNameInput) ui.providerNameInput.focus();
}

/** Move focus to the selected list entry (after a selection change or a delete). */
export function focusCurrentProvider() {
  const current = ui.providerNav && ui.providerNav.querySelector
    ? ui.providerNav.querySelector('[aria-current="true"]')
    : null;
  if (current) current.focus();
}

function ensureSelection() {
  if (state.providerDraft) return;
  if (getProvider(state.selectedProviderId)) return;
  const fallback = translationProvider() || registryProviders()[0] || null;
  state.selectedProviderId = fallback ? fallback.id : '';
}

export function renderProviders() {
  if (!ui.providerNav) return;
  ensureSelection();
  const providers = registryProviders();
  const items = providers.map((provider) => navItem(
    provider, provider.name || provider.id, providerUses(provider.id),
    !state.providerDraft && provider.id === state.selectedProviderId,
    () => selectProvider(provider.id)
  ));
  if (state.providerDraft) items.push(navItem(null, '新服务商', [], true, () => startAddProvider()));
  // Rebuilding the list detaches the focused button; hand focus to its replacement.
  const active = typeof document.activeElement === 'object' ? document.activeElement : null;
  const hadFocus = Boolean(active && ui.providerNav.contains && ui.providerNav.contains(active));
  if (providers.length === 0 && !state.providerDraft) {
    ui.providerNav.textContent = '模型清单不可用，无法配置服务商。';
  } else {
    ui.providerNav.replaceChildren(...items);
  }
  if (hadFocus) focusCurrentProvider();
  if (ui.addProviderButton) ui.addProviderButton.disabled = state.busy || state.customBusy || !state.registry;

  const provider = selectedProvider();
  const shownId = state.providerDraft ? '#draft' : (provider ? provider.id : '');
  const switched = shownId !== state.shownProviderId;
  state.shownProviderId = shownId;
  if (switched && ui.apiKeyInput) {
    // Never carry a half-typed key or a stale message over to another provider.
    ui.apiKeyInput.value = '';
    setKeyVisibility(false);
    setFeedback(ui.keyFeedback, '');
  }

  ui.providerDetailTitle.textContent = provider ? provider.name || provider.id : state.providerDraft ? '新服务商' : '—';
  ui.providerDetailTags.replaceChildren(...tagList(provider ? providerUses(provider.id) : []));
  renderCustomFields(provider, switched);
  renderKeyPanel(provider);
  renderProviderModels(provider, switched);
}
