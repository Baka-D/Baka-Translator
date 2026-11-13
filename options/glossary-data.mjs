// Glossary data helpers for the editor: storage keys, paging and validating rows.
import { languages, novelUtils } from './context.mjs';

export const GLOSSARY_PREFIX = 'novelGlossary:';
const META_PREFIX = 'novelMeta:';

function targetLabel(code) {
  const target = languages.getTargetLanguage(code);
  return target ? target.label : String(code || '中文');
}

function siteLabel(siteId) {
  const adapter = novelUtils && novelUtils.SITE_ADAPTERS
    ? novelUtils.SITE_ADAPTERS[siteId]
    : null;
  return adapter && adapter.name ? adapter.name : siteId;
}

/** Parse a storage key such as novelGlossary:kakuyomu:123:en. */
export function parseGlossaryKey(key) {
  if (typeof key !== 'string' || !key.startsWith(GLOSSARY_PREFIX)) return null;
  const parts = key.split(':');
  if (parts.length < 3 || !parts[1] || !parts[2]) return null;
  const siteId = parts[1];
  const workId = parts[2];
  const rawTarget = parts[3] || 'zh';
  const targetCode = languages.normalizeTarget(rawTarget);
  const suffix = targetCode === 'zh' ? '' : `:${targetCode}`;
  return {
    key,
    siteId,
    workId,
    targetCode,
    metaKey: `${META_PREFIX}${siteId}:${workId}${suffix}`,
    tidyKey: `novelGlossaryTidy:${siteId}:${workId}${suffix}`
  };
}

/** Chapter caches can be large; only fetch the values this editor needs. */
export async function readGlossaryStorage(local) {
  // getKeys is available from Chromium 130; keep the supported older browsers working.
  if (typeof local.getKeys !== 'function') return local.get(null);
  const keys = (await local.getKeys()).flatMap((key) => {
    const parsed = parseGlossaryKey(key);
    return parsed ? [key, parsed.metaKey, parsed.tidyKey] : [];
  });
  return local.get(Array.from(new Set(keys)));
}

/** Which rows a page shows; an out-of-range page moves to the nearest one. */
export function glossaryPageRange(total, page, size) {
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(page, 0), pages - 1);
  return { page: current, pages, start: current * size, end: Math.min(total, (current + 1) * size) };
}

/** Normalize terms for editing without silently dropping duplicate sources. */
export function normalizeGlossaryRows(rows) {
  const terms = [];
  const seen = new Map();
  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const source = String((row && row.source) || '').trim();
    const target = String((row && row.target) || '').trim();
    if (!source && !target) continue;
    if (!source || !target) {
      return { error: `第 ${index + 1} 行需要同时填写原文和译文。`, row: index };
    }
    const normalized = novelUtils.normalizeTerm({
      source,
      target,
      category: row.category,
      note: row.note,
      gender: row.gender,
      aliases: row.aliases
    });
    if (!normalized) {
      return { error: `第 ${index + 1} 行术语格式不正确，请检查原文和译文。`, row: index };
    }
    // An alias is matched like a source, so it must be unique among them too.
    for (const { source: spelling } of [normalized, ...(normalized.aliases || [])]) {
      const key = novelUtils.termKey(spelling);
      if (seen.has(key)) {
        return {
          error: `第 ${index + 1} 行“${spelling}”与第 ${seen.get(key)} 行重复。`,
          row: index,
          other: seen.get(key) - 1
        };
      }
      seen.set(key, index + 1);
    }
    terms.push(normalized);
  }
  if (terms.length === 0) return { error: '请至少保留一条术语，或使用“清空术语库”。' };
  return { terms };
}

export const withNewStoredTerms = novelUtils.withNewStoredTerms;

export function describeGlossary(key, terms, allValues) {
  const parsed = parseGlossaryKey(key);
  if (!parsed) return null;
  const meta = novelUtils.normalizeMeta((allValues || {})[parsed.metaKey]);
  const normalizedTerms = novelUtils.mergeGlossary(terms, []);
  return {
    ...parsed,
    title: (meta && meta.title) || parsed.workId,
    siteName: siteLabel(parsed.siteId),
    targetLabel: targetLabel(parsed.targetCode),
    meta,
    tidy: (allValues || {})[parsed.tidyKey] || null,
    terms: normalizedTerms
  };
}
