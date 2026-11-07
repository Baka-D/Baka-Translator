/** Second step of term extraction: a small request that removes ordinary words. */
(function initTermApi(globalScope) {
  'use strict';

  const protocol =
    (globalScope.DSHT && globalScope.DSHT.protocol) ||
    (typeof require === 'function' ? require('../shared/protocol.js') : null);
  const glossary =
    (globalScope.DSHT && globalScope.DSHT.glossary) ||
    (typeof require === 'function' ? require('../shared/glossary.js') : null);
  const REVIEW_BATCH = 40;
  const REVIEW_TIMEOUT_MS = 30000;
  // A batch this size dropped whole is a bad reply, not a batch of ordinary words.
  const MIN_SUSPECT_DROP = 6;
  const TIDY_TIMEOUT_MS = 180000;
  // Measured on a real work: a sound tidy dropped 39% of what it may drop, unsound ones 72-97%.
  const MAX_TIDY_DROP_SHARE = 2 / 3;

  /**
   * A model that is not reasoning ignores the "no ordinary words" rule inside the long
   * extraction task, and reasoning takes six times as long, so ask separately.
   * `chat` is chatCompletion. Terms keep their place whenever a review fails.
   * Returns the terms left and the billed review replies.
   */
  async function reviewTerms(terms, opts, chat) {
    const candidates = protocol.termReviewCandidates(terms, opts.glossary);
    const dropped = new Set();
    const replies = [];
    for (let at = 0; at < candidates.length; at += REVIEW_BATCH) {
      if (opts.stopped?.()) break;
      try {
        const batch = candidates.slice(at, at + REVIEW_BATCH);
        const reply = await chat({
          ...opts,
          messages: protocol.buildTermReviewMessages(batch),
          kind: 'terms',
          temperature: 0,
          timeoutMs: REVIEW_TIMEOUT_MS
        });
        replies.push(reply);
        // Only what was sent can go: a reply must not reach terms kept out of the review.
        const sent = new Set(batch.map((term) => term.source));
        const drop = new Set(protocol.parseTermReview(reply.content).filter((source) => sent.has(source)));
        if (drop.size === sent.size && sent.size >= MIN_SUSPECT_DROP) continue;
        for (const source of drop) dropped.add(source);
      } catch (error) {
        // The review only tidies the glossary; extracted terms must survive it.
        if (error && error.code === 'TIMEOUT') break;
      }
    }
    return { terms: terms.filter((term) => !dropped.has(term.source)), replies };
  }

  /** One batch: propose from the term list alone, then check the proposals against the story. */
  async function tidyBatch(terms, opts, ask) {
    const { targetCode, workTitle, chapters } = opts;
    const proposed = protocol.parseJsonObject(
      await ask(protocol.buildGlossaryTidyMessages({ terms, targetCode, workTitle }))
    );
    if (!proposed) return null;
    const changes = glossary.tidyChanges(terms, proposed);
    if (changes.length === 0) return [];
    const checked = protocol.parseJsonObject(
      await ask(protocol.buildGlossaryCheckMessages({ changes, chapters, targetCode, workTitle }))
    );
    if (!checked || !Array.isArray(checked.accept)) return null;
    // Only what the check names goes through: a careless reply must change nothing.
    const accepted = new Set(checked.accept);
    const kept = changes.filter((_change, id) => accepted.has(id));
    const drops = kept.filter((change) => change.action === 'drop').length;
    const droppable = terms.filter(glossary.isTidyDroppable).length;
    // No check can vouch for a reply that empties the glossary: keep only its merges.
    if (drops >= MIN_SUSPECT_DROP && drops > droppable * MAX_TIDY_DROP_SHARE) {
      return kept.filter((change) => change.action === 'merge');
    }
    return kept;
  }

  /**
   * Plan a tidy of `opts.terms`. `chat` is chatCompletion. Nothing is changed without
   * passing the check, so a failed batch only leaves its terms as they are.
   * Returns the changes, the billed replies and whether any batch failed.
   */
  async function tidyGlossary(opts, chat) {
    const changes = [];
    const replies = [];
    let failed = false;
    const ask = async (messages) => {
      const reply = await chat({
        ...opts, messages, kind: 'terms', temperature: 0, timeoutMs: TIDY_TIMEOUT_MS
      });
      replies.push(reply);
      return reply.content;
    };
    for (const batch of glossary.tidyBatches(opts.terms, opts.batchTerms)) {
      if (await opts.cancelled?.()) break;
      try {
        const accepted = await tidyBatch(batch, opts, ask);
        if (accepted) changes.push(...accepted);
        else failed = true;
      } catch (_error) {
        failed = true;
        // The replies so far are billed either way; further batches would likely fail too.
        break;
      }
    }
    return { changes, replies, failed };
  }

  const api = Object.freeze({ reviewTerms, tidyGlossary });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.termApi = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
