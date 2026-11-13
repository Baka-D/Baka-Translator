// Settings-page provider manager: a side list of providers plus one detail panel.
import { state, ui, i18n, t } from './context.mjs';
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

export function providerDisplayName(provider) {
  if (!provider) return '';
  const name = provider.name || provider.id;
  return provider.custom ? name : i18n.providerName(provider.id, name);
}

/** Purposes (translation / polishing) that currently use this provider. */
export function providerUses(providerIdValue) {
  const uses = [];
  if (translationProvider() && translationProvider().id === providerIdValue) uses.push(t('opt_provider_use_translation'));
  if (polishProvider() && polishProvider().id === providerIdValue) uses.push(t('opt_provider_use_polishing'));
  return uses;
}

/** The provider shown in the detail panel, or null while adding a new one. */
export function selectedProvider() {
  if (state.providerDraft) return null;
  return getProvider(state.selectedProviderId);
}

function keyTone(provider) {
  if (providerKeyFor(provider.id)) return { tone: 'success', text: t('opt_key_saved') };
  return keyRequired(provider) ? { tone: 'muted', text: t('opt_key_missing') } : { tone: 'muted', text: t('opt_key_not_required') };
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
  const status = provider ? keyTone(provider) : { tone: 'muted', text: t('opt_provider_unsaved') };
  const dot = document.createElement('span');
  dot.className = 'provider-dot';
  dot.dataset.tone = status.tone;
  meta.append(...tagList(uses), dot);
  button.append(name, meta);
  button.setAttribute('aria-label', [label,
    uses.length ? t('opt_provider_usage_label', [uses.join(t('opt_provider_usage_separator'))]) : '', status.text]
    .filter(Boolean).join(t('opt_provider_label_separator')));
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
    provider, providerDisplayName(provider), providerUses(provider.id),
    !state.providerDraft && provider.id === state.selectedProviderId,
    () => selectProvider(provider.id)
  ));
  if (state.providerDraft) items.push(navItem(null, t('opt_provider_new'), [], true, () => startAddProvider()));
  // Rebuilding the list detaches the focused button; hand focus to its replacement.
  const active = typeof document.activeElement === 'object' ? document.activeElement : null;
  const hadFocus = Boolean(active && ui.providerNav.contains && ui.providerNav.contains(active));
  if (providers.length === 0 && !state.providerDraft) {
    ui.providerNav.textContent = t('opt_provider_registry_unavailable');
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

  ui.providerDetailTitle.textContent = provider ? providerDisplayName(provider) : state.providerDraft ? t('opt_provider_new') : '—';
  ui.providerDetailTags.replaceChildren(...tagList(provider ? providerUses(provider.id) : []));
  renderCustomFields(provider, switched);
  renderKeyPanel(provider);
  renderProviderModels(provider, switched);
}
