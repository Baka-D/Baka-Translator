/**
 * Prompt preset helpers. Preset definitions live in preset/*.json; users may
 * override prompts from the advanced settings page.
 */
(function initPresets(globalScope) {
  'use strict';

  const PLACEHOLDERS = Object.freeze([
    'targetLanguage',
    'targetNative',
    'sourceHint'
  ]);

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function trimString(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  function normalizePreset(raw, fallbackId) {
    const source = isObject(raw) ? raw : {};
    const id = trimString(source.id, fallbackId || 'general');
    return {
      id,
      name: trimString(source.name, id),
      description: trimString(source.description, ''),
      translationPrompt: trimString(source.translationPrompt, ''),
      polishPrompt: trimString(source.polishPrompt, '')
    };
  }

  function normalizePresetIndex(raw) {
    const source = isObject(raw) ? raw : {};
    const presets = [];
    const seen = new Set();
    if (Array.isArray(source.presets)) {
      for (const item of source.presets) {
        if (!isObject(item)) continue;
        const id = trimString(item.id, '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        presets.push({
          id,
          name: trimString(item.name, id),
          description: trimString(item.description, ''),
          file: trimString(item.file, `${id}.json`)
        });
      }
    }
    if (presets.length === 0) {
      presets.push({
        id: 'general',
        name: '常规',
        description: '',
        file: 'general.json'
      });
    }
    const defaultPresetId = seen.has(trimString(source.defaultPresetId, ''))
      ? trimString(source.defaultPresetId, '')
      : presets[0].id;
    return { version: 1, defaultPresetId, presets };
  }

  function fillTemplate(template, variables) {
    const input = typeof template === 'string' ? template : '';
    const vars = isObject(variables) ? variables : {};
    return input.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
      return typeof vars[key] === 'string' ? vars[key] : String(vars[key] ?? '');
    });
  }

  function buildPromptVariables(values) {
    const source = isObject(values) ? values : {};
    return {
      targetLanguage: trimString(source.targetLanguage, 'the target language'),
      targetNative: trimString(source.targetNative, ''),
      sourceHint: trimString(source.sourceHint, 'auto'),
      glossary: trimString(source.glossary, '')
    };
  }

  /**
   * @param {object} preset normalized preset from preset/*.json
   * @param {object} overrides stored promptOverrides[presetId]
   */
  function mergePromptOverrides(preset, overrides) {
    const base = normalizePreset(preset, (preset && preset.id) || 'general');
    const override = isObject(overrides) ? overrides : {};
    return {
      ...base,
      translationPrompt: trimString(override.translationPrompt, base.translationPrompt),
      polishPrompt: trimString(override.polishPrompt, base.polishPrompt)
    };
  }

  function getPresetMeta(index, presetId) {
    if (!index || !Array.isArray(index.presets)) return null;
    return index.presets.find((preset) => preset.id === presetId) || null;
  }

  const api = Object.freeze({
    PLACEHOLDERS,
    normalizePreset,
    normalizePresetIndex,
    fillTemplate,
    buildPromptVariables,
    mergePromptOverrides,
    getPresetMeta
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.presets = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
