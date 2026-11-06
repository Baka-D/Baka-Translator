/**
 * Prompt construction and defensive parsing for Baka Translator model responses.
 *
 * The model is asked for JSON only. Real-world responses still occasionally
 * contain markdown fences, prose, aliases or missing keys, so parsing here is
 * deliberately forgiving on shape and strict on ids.
 */
(function initProtocol(globalScope) {
  'use strict';

  const languages =
    (globalScope.DSHT && globalScope.DSHT.languages) ||
    (typeof require === 'function' ? require('./languages.js') : null);
  const presets =
    (globalScope.DSHT && globalScope.DSHT.presets) ||
    (typeof require === 'function' ? require('./presets.js') : null);

  const responses =
    (globalScope.DSHT && globalScope.DSHT.protocolResponses) ||
    (typeof require === 'function' ? require('./protocol-responses.js') : null);

  const glossaryUtils =
    (globalScope.DSHT && globalScope.DSHT.glossary) ||
    (typeof require === 'function' ? require('./glossary.js') : null);

  const prompts =
    (globalScope.DSHT && globalScope.DSHT.systemPrompts) ||
    (typeof require === 'function' ? require('../preset/system-prompts.js') : null);

  function resolveTarget(targetCode) {
    if (!languages) throw new Error('Language module is not loaded');
    return languages.getTargetLanguage(targetCode) || languages.getTargetLanguage('zh');
  }

  function targetSpec(targetCode) {
    const target = resolveTarget(targetCode);
    return `${target.promptName} (${target.nativeName})`;
  }

  /** Fill the placeholders of fixed prompt text from preset/system-prompts.js. */
  function fixedPrompt(text, target, sourceHint) {
    return presets.fillTemplate(text, {
      targetName: target.promptName,
      targetLanguage: `${target.promptName} (${target.nativeName})`,
      sourceSpec: sourceHint ? targetSpec(sourceHint) : ''
    });
  }

  function promptVariables(target, sourceHint) {
    return {
      targetLanguage: `${target.promptName} (${target.nativeName})`,
      targetNative: target.nativeName,
      sourceHint:
        sourceHint && sourceHint !== 'unknown'
          ? String(sourceHint)
          : 'detected automatically',
      // The glossary differs per request, so it always goes last in the system
      // prompt: anywhere earlier it would end the prefix providers can cache.
      glossary: ''
    };
  }

  /** The part of `context` worth sending: nearby text replaces the previous chapter. */
  function contextPayload(context) {
    if (!context || typeof context !== 'object') return null;
    const nearby = context.precedingText ? 'precedingText' : 'previousChapter';
    const entries = ['workTitle', nearby]
      .filter((key) => context[key])
      .map((key) => [key, String(context[key])]);
    return entries.length > 0 ? Object.fromEntries(entries) : null;
  }

  /** Terms used by the request; nearby text counts, so a pronoun can reach its character. */
  function usedGlossary(glossary, texts, context) {
    const nearby = context ? [context.precedingText, context.previousChapter] : [];
    return glossaryUtils.selectGlossary(glossary, [...texts, ...nearby]);
  }

  function buildGlossaryText(glossary) {
    if (!glossary) return '';
    if (typeof glossary === 'string') {
      const text = glossary.trim();
      return text ? `${prompts.glossaryHeading}\n${text}` : '';
    }
    if (Array.isArray(glossary)) {
      const lines = glossary
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const source = String(item.source || item.term || '').trim();
          const target = String(item.target || item.translation || '').trim();
          const details = [
            item.gender === 'male' || item.gender === 'female' ? `gender: ${item.gender}` : '',
            String(item.note || '').trim()
          ].filter(Boolean).join('; ');
          if (!source || !target) return '';
          return `- ${source} => ${target}${details ? ` (${details})` : ''}`;
        })
        .filter(Boolean);
      if (lines.length === 0) return '';
      const heading = lines.some((line) => line.includes('(gender: '))
        ? prompts.glossaryGenderHeading
        : prompts.glossaryHeading;
      return `${heading}\n${lines.join('\n')}`;
    }
    return '';
  }

  function presetPrompt(preset, field, target, sourceHint) {
    const template =
      preset && typeof preset[field] === 'string' && preset[field].trim()
        ? preset[field]
        : '';
    if (!template) return '';
    const variables = promptVariables(target, sourceHint);
    const filled = presets
      ? presets.fillTemplate(template, variables)
      : template
          .replace(/\{\{\s*targetLanguage\s*\}\}/g, variables.targetLanguage)
          .replace(/\{\{\s*targetNative\s*\}\}/g, variables.targetNative)
          .replace(/\{\{\s*sourceHint\s*\}\}/g, variables.sourceHint)
          .replace(/\{\{\s*glossary\s*\}\}/g, variables.glossary);
    return filled.trim();
  }

  function buildTranslationMessages({
    segments,
    targetCode,
    sourceHint,
    preset,
    glossary: fullGlossary,
    context: rawContext
  }) {
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error('No translation segments provided');
    }
    const target = resolveTarget(targetCode);
    const context = contextPayload(rawContext);
    const glossary = usedGlossary(
      fullGlossary,
      segments.map((segment) => segment && segment.text),
      context
    );
    const hint = sourceHint && sourceHint !== 'unknown' ? sourceHint : null;
    const fixed = prompts.translation;
    const fill = (text) => fixedPrompt(text, target, hint);
    const stylePrompt = presetPrompt(preset, 'translationPrompt', target, sourceHint);

    const systemLines = [
      fixed.role,
      stylePrompt,
      fill(fixed.task),
      fill(hint ? fixed.sourceDetected : fixed.sourceAuto),
      ...fixed.rulesBeforeContext,
      context ? prompts.contextRule : '',
      ...fixed.rulesAfterContext.map(fill),
      !stylePrompt ? fixed.defaultStyle[target.code] : '',
      target.code === 'zh' ? fixed.simplifiedChinese : '',
      buildGlossaryText(glossary)
    ];

    const payload = {
      targetLanguage: target.promptName,
      ...(context ? { context } : {}),
      segments: segments.map((segment, index) => ({
        id: String(segment && segment.id !== undefined ? segment.id : index + 1),
        text: String((segment && segment.text) || '')
      }))
    };

    return [
      { role: 'system', content: systemLines.filter(Boolean).join('\n') },
      {
        role: 'user',
        content: `${fill(fixed.user)}\n${JSON.stringify(payload)}`
      }
    ];
  }

  function buildPolishMessages({
    segments,
    targetCode,
    sourceHint,
    preset,
    glossary: fullGlossary,
    context: rawContext
  }) {
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error('No proofreading segments provided');
    }
    const target = resolveTarget(targetCode);
    const context = contextPayload(rawContext);
    const glossary = usedGlossary(
      fullGlossary,
      segments.map((segment) => segment && segment.original),
      context
    );
    const fixed = prompts.polish;
    const fill = (text) => fixedPrompt(text, target);
    const stylePrompt = presetPrompt(preset, 'polishPrompt', target, sourceHint);
    const systemLines = [
      fixed.role,
      stylePrompt,
      ...fixed.task.map(fill),
      ...fixed.rulesBeforeContext,
      context ? prompts.contextRule : '',
      context && context.precedingText ? prompts.contextPairRule : '',
      ...fixed.rulesAfterContext,
      target.code === 'zh' ? fixed.simplifiedChinese : '',
      fixed.closing,
      buildGlossaryText(glossary)
    ];

    const payload = {
      targetLanguage: target.promptName,
      ...(context ? { context } : {}),
      segments: segments.map((segment, index) => ({
        id: String(segment && segment.id !== undefined ? segment.id : index + 1),
        original: String((segment && segment.original) || ''),
        translation: String((segment && segment.translation) || '')
      }))
    };

    return [
      { role: 'system', content: systemLines.filter(Boolean).join('\n') },
      {
        role: 'user',
        content: `${fill(fixed.user)}\n${JSON.stringify(payload)}`
      }
    ];
  }


  /**
   * Recorded terms in this chapter, so the model does not bill them again.
   * Characters without a gender stay out: a later chapter may still reveal it.
   */
  function knownTermSources(glossary, segments) {
    if (!Array.isArray(glossary)) return [];
    return usedGlossary(glossary, segments.map((segment) => segment && segment.original))
      .filter(glossaryUtils.isSettledTerm)
      .map((term) => term.source);
  }

  function buildTermExtractionMessages({ segments, targetCode, glossary }) {
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error('No terminology segments provided');
    }
    const target = resolveTarget(targetCode);
    const fill = (text) => fixedPrompt(text, target);
    const knownTerms = knownTermSources(glossary, segments);
    const system = [...prompts.terms.system, knownTerms.length ? prompts.terms.knownTermsRule : '']
      .map(fill).join('\n').trimEnd();
    const payload = {
      targetLanguage: target.promptName,
      ...(knownTerms.length ? { knownTerms } : {}),
      segments: segments.map((segment, index) => ({
        id: String(segment && segment.id !== undefined ? segment.id : index + 1),
        original: String((segment && segment.original) || ''),
        translation: String((segment && segment.translation) || '')
      }))
    };
    return [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `${fill(prompts.terms.user)}\n${JSON.stringify(payload)}`
      }
    ];
  }

  /**
   * New terms worth reviewing. People and skills always stay: skill names are often
   * ordinary words, such as 解析, and the review would take them for vocabulary.
   */
  function termReviewCandidates(terms, glossary) {
    const known = new Set((Array.isArray(glossary) ? glossary : [])
      .map((term) => glossaryUtils.termKey(term.source)));
    return terms.filter((term) => (
      !glossaryUtils.isCharacterCategory(term.category) &&
      String(term.category).trim().toLowerCase() !== 'skill' &&
      !known.has(glossaryUtils.termKey(term.source))
    ));
  }

  function buildTermReviewMessages(terms) {
    const candidates = terms.map(({ source, target, category, note }) => ({
      source, target, category: String(category).slice(0, 40), note
    }));
    return [
      { role: 'system', content: prompts.terms.review.join('\n') },
      { role: 'user', content: JSON.stringify({ candidates }) }
    ];
  }

  function buildImageTranslationMessages({ targetCode, imageDataUrl, sourceHint }) {
    const target = resolveTarget(targetCode);
    const hint = sourceHint && sourceHint !== 'unknown' ? sourceHint : null;
    const fill = (text) => fixedPrompt(text, target, hint);
    const system = [...prompts.image.system, hint ? prompts.image.sourceDetected : '']
      .filter(Boolean)
      .map(fill)
      .join('\n');
    const userText = prompts.image.user.map(fill).join('\n');

    return [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          {
            type: 'image_url',
            image_url: { url: imageDataUrl, detail: 'original' }
          }
        ]
      }
    ];
  }

  const api = Object.freeze({
    buildTranslationMessages,
    buildPolishMessages,
    buildTermExtractionMessages,
    termReviewCandidates,
    buildTermReviewMessages,
    buildImageTranslationMessages,
    ...responses,
    targetSpec
  });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.protocol = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof self !== 'undefined'
      ? self
      : this
);
