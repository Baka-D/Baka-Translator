import { withStorageLock } from './storage-lock.mjs';

export function updateSiteSettings(key, host, change) {
  return withStorageLock(key, async () => {
    const values = await chrome.storage.local.get([key]);
    const stored = values[key];
    const settings = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    const previous = Object.hasOwn(settings, host) ? settings[host] : undefined;
    const next = change(previous);
    if (next === undefined) return { settings, changed: false };
    const updated = next === null ? { ...settings } : { ...settings, [host]: next };
    if (next === null) delete updated[host];
    await chrome.storage.local.set({ [key]: updated });
    return { settings: updated, changed: true };
  });
}

export function patchSiteSettings(value, patch, removeKeys = []) {
  const current = typeof value === 'boolean' ? { polish: value }
    : value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const next = { polish: false, pretranslate: false, ...current, ...patch };
  for (const key of removeKeys) delete next[key];
  return next;
}
