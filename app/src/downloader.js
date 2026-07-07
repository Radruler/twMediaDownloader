/**
 * downloader.js — M1 STUB (queue bookkeeping only; logs what M2 will do).
 * The real M2 implementation (plan 06 §4: ≤2 concurrent CDN GETs,
 * 500–1500 ms jittered gaps, request_template-shaped headers, retry 3×,
 * disk writer + sha256 dedupe) lands next — see docs/plans/PROGRESS.md D1/D2.
 */

export function createDownloader({ db, archiveRoot, getTemplate, log = () => {}, onStatusChange = () => {} }) {
  const queue = [];
  const runs = new Map(); // run_id -> label

  return {
    enqueue(request) {
      queue.push(request);
      log(
        `queued for archive: ${request.post_key} (reason ${request.reason ?? '?'}` +
          `${request.run_id ? `, run ${request.run_id}` : ''}) — M2 downloader not yet implemented`,
      );
      onStatusChange({ queue_depth: queue.length });
    },
    setRun(runId, phase, label) {
      if (phase === 'begin') runs.set(runId, label);
      else runs.delete(runId);
    },
    queueDepth() {
      return queue.length;
    },
    async drain() {
      /* M1: nothing in flight */
    },
  };
}
