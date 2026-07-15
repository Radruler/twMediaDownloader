import type { TweetRecord } from './tweet-record.ts';

export interface ArchivistFileRef {
  media_key?: string | null;
  sha256?: string | null;
  path?: string | null;
  bytes?: number | null;
  mime?: string | null;
}

export interface ArchivistOwnAccount {
  service_account_id: string;
  screen_name?: string | null;
}

export interface ArchivistPost {
  v: 1;
  service: 'twitter';
  post_key: string;
  author: {
    service_account_id: string | null;
    screen_name: string | null;
    display_name: string | null;
    /** Always 'unknown': capture carries no evidence of account standing. */
    status: 'unknown';
  };
  created_at_ms: number | null;
  text: string;
  lang: string | null;
  url: string | null;
  is_sensitive: boolean;
  deleted: boolean;
  counts: TweetRecord['counts'];
  reply_to: { key: string | null; author_service_account_id: string | null };
  quoted_key: string | null;
  versions: { service_version_id: string; captured_at_ms: number; raw: TweetRecord }[];
  media: {
    position: number;
    type: string;
    sha256: string | null;
    source_url: string | null;
    alt_text: string | null;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    original_basename: string | null;
  }[];
  relations: {
    subject: { service_account_id: string; screen_name: string | null };
    key: 'like' | 'bookmark';
    value: null;
    observed_at: number;
    active: boolean;
  }[];
}

export function postKeyForArchivist(record: TweetRecord): string {
  return record.edit_initial_id_str ?? record.id_str;
}

function newest(records: TweetRecord[]): TweetRecord {
  return [...records].sort((a, b) => {
    const byCapture = b.captured_at_ms - a.captured_at_ms;
    if (byCapture !== 0) return byCapture;
    return b.id_str.localeCompare(a.id_str);
  })[0];
}

function basename(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  return filePath.split(/[\\/]/).pop() ?? null;
}

function fileMap(files: Iterable<ArchivistFileRef> | Record<string, ArchivistFileRef> | null) {
  const map = new Map<string, ArchivistFileRef>();
  if (!files) return map;
  const values =
    typeof (files as Iterable<ArchivistFileRef>)[Symbol.iterator] === 'function'
      ? (files as Iterable<ArchivistFileRef>)
      : Object.values(files as Record<string, ArchivistFileRef>);
  for (const file of values) {
    if (file?.media_key) map.set(file.media_key, file);
  }
  return map;
}

function statusUrl(screenName: string | null, id: string): string {
  return `https://x.com/${screenName ?? 'i'}/status/${id}`;
}

export function toArchivistPost(
  records: TweetRecord[] | TweetRecord,
  filesBySha: Iterable<ArchivistFileRef> | Record<string, ArchivistFileRef> | null = null,
  ownAccounts: ArchivistOwnAccount[] = [],
): ArchivistPost {
  const versions = Array.isArray(records) ? records : [records];
  if (versions.length === 0) throw new Error('toArchivistPost requires at least one TweetRecord');

  const latest = newest(versions);
  const files = fileMap(filesBySha);
  const relationPairs = [
    ['like', latest.viewer?.liked] as const,
    ['bookmark', latest.viewer?.bookmarked] as const,
  ];

  return {
    v: 1,
    service: 'twitter',
    post_key: postKeyForArchivist(latest),
    author: {
      service_account_id: latest.user.id_str,
      screen_name: latest.user.screen_name,
      display_name: latest.user.name,
      status: 'unknown',
    },
    created_at_ms: latest.created_at_ms,
    text: latest.full_text,
    lang: latest.lang,
    url: statusUrl(latest.user.screen_name, latest.id_str),
    is_sensitive: latest.is_sensitive,
    deleted: false,
    counts: latest.counts,
    reply_to: {
      key: latest.in_reply_to_status_id_str,
      author_service_account_id: latest.in_reply_to_user_id_str,
    },
    quoted_key: latest.quoted_status_id_str,
    versions: versions
      .map((record) => ({
        service_version_id: record.id_str,
        captured_at_ms: record.captured_at_ms,
        raw: record,
      }))
      .sort((a, b) => a.captured_at_ms - b.captured_at_ms || a.service_version_id.localeCompare(b.service_version_id)),
    media: latest.media.map((media) => {
      const mediaKey = media.media_key ?? `${latest.id_str}:${media.index}`;
      const file = files.get(mediaKey) ?? null;
      return {
        position: media.index,
        type: media.type,
        sha256: file?.sha256 ?? null,
        source_url: media.image_url,
        alt_text: media.alt_text,
        width: media.width,
        height: media.height,
        duration_ms: media.duration_ms,
        original_basename: basename(file?.path),
      };
    }),
    // Viewer flags identify the viewer only as "some logged-in own account".
    // With exactly one configured own account the attribution is certain;
    // with zero or several we must not guess (client plan §C-3), so no
    // relations are emitted.
    relations: (ownAccounts.length === 1 ? ownAccounts : []).flatMap((account) =>
      relationPairs
        .filter(([, active]) => active !== null && active !== undefined)
        .map(([key, active]) => ({
          subject: {
            service_account_id: account.service_account_id,
            screen_name: account.screen_name ?? null,
          },
          key,
          value: null,
          observed_at: latest.captured_at_ms,
          active: active === true,
        })),
    ),
  };
}
