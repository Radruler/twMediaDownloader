/**
 * disk-writer.js — writes originals + sidecars to the archive root
 * (plan 06 §4). Filenames and sidecar content come from @twmd/core so the
 * app and the extension's standalone mode produce IDENTICAL files.
 *
 * Layout:
 *   <archive_root>/<screen_name>/<screen_name>-<id>-<ts>-img1.jpg …
 *   <archive_root>/_runs/<YYYYMMDD>-<label>/…        (bulk runs, Decision 13)
 *
 * sha256 dedupe (plan 06 §3 files table): identical bytes are stored once;
 * a re-archive that resolves to a known hash writes nothing new.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  formatFilenameTimestamp,
  mediaBasename,
  sanitizeForFilename,
  sidecarBasename,
  sidecarJsonText,
  sidecarTxt,
} from '@twmd/core';

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Directory for a save: per-author, or per-run for bulk (Decision 13). */
export function archiveDirFor(archiveRoot, record, run = /** @type {any} */ (null)) {
  if (run) {
    const date = formatFilenameTimestamp(run.started_at ?? Date.now()).slice(0, 8);
    return path.join(
      archiveRoot,
      '_runs',
      `${date}-${sanitizeForFilename(run.label || 'run')}`,
    );
  }
  return path.join(archiveRoot, sanitizeForFilename(record.user.screen_name ?? 'unknown'));
}

export function createDiskWriter({ db, archiveRoot }) {
  return {
    /**
     * Persist one downloaded media item. Returns
     * { path, basename, deduped } — deduped means identical bytes were
     * already in the library (files.sha256 UNIQUE) and nothing was written.
     */
    async writeMedia({ record, media, ext, bytes, media_key, run = null }) {
      const parts = {
        screen_name: record.user.screen_name,
        tweet_id: record.id_str,
        created_at_ms: record.created_at_ms,
      };
      const basename = mediaBasename(parts, media, ext);
      const existing = db.findFileBySha(sha256Hex(bytes));
      if (existing) {
        return { path: existing.path, basename, deduped: true };
      }
      const dir = archiveDirFor(archiveRoot, record, run);
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, basename);
      await writeFile(filePath, bytes);
      db.recordFile({
        media_key,
        path: filePath,
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
        downloaded_at: Date.now(),
      });
      return { path: filePath, basename, deduped: false };
    },

    /** Write the sidecar(s) next to the media. Sidecars are never deduped. */
    async writeSidecars({ record, savedBasenames, run = null, formats = ['txt'] }) {
      const parts = {
        screen_name: record.user.screen_name,
        tweet_id: record.id_str,
        created_at_ms: record.created_at_ms,
      };
      const dir = archiveDirFor(archiveRoot, record, run);
      await mkdir(dir, { recursive: true });
      const written = [];
      const saved_files = [
        ...savedBasenames,
        ...formats.map((format) => sidecarBasename(parts, format)),
      ];
      for (const format of formats) {
        const text =
          format === 'txt'
            ? sidecarTxt(record, { saved_files })
            : sidecarJsonText(record, { saved_files });
        const filePath = path.join(dir, sidecarBasename(parts, format));
        await writeFile(filePath, text, 'utf8');
        written.push(filePath);
      }
      return written;
    },
  };
}
