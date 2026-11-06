/** Second step of term extraction: a small request that removes ordinary words. */
(function initTermApi(globalScope) {
  'use strict';

  const protocol =
    (globalScope.DSHT && globalScope.DSHT.protocol) ||
    (typeof require === 'function' ? require('../shared/protocol.js') : null);
  const REVIEW_BATCH = 40;
  const REVIEW_TIMEOUT_MS = 30000;
  // A batch this size dropped whole is a bad reply, not a batch of ordinary words.
  const MIN_SUSPECT_DROP = 6;

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

  const api = Object.freeze({ reviewTerms });

  globalScope.DSHT = globalScope.DSHT || {};
  globalScope.DSHT.termApi = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
