/**
 * Behavioral tests for the MAIN-world interceptor, run against hand-rolled
 * window/document fakes (no jsdom needed — the script touches very little DOM
 * on purpose).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const GRAPHQL_URL = 'https://x.com/i/api/graphql/AbCdEf123_xy/UserTweets?variables=%7B%7D';
const UNLISTED_URL = 'https://x.com/i/api/graphql/ZzZzZz999_zz/BrandNewOperation';

type Dispatched = { type: string; detail: any };
const dispatched: Dispatched[] = [];
const localStore = new Map<string, string>();

class FakeXHR {
  static instances: FakeXHR[] = [];
  listeners: Record<string, Array<() => void>> = {};
  status = 0;
  responseType: string = '';
  responseText = '';
  response: unknown = null;
  constructor() {
    FakeXHR.instances.push(this);
  }
  open(_method: string, _url: string) {}
  send(_body?: unknown) {}
  addEventListener(name: string, cb: () => void) {
    (this.listeners[name] ??= []).push(cb);
  }
  fireLoad(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    for (const cb of this.listeners.load ?? []) cb.call(this);
  }
}

function fakeResponse(url: string, body: string, ok = true) {
  return {
    ok,
    url,
    clone() {
      return { text: async () => body };
    },
  };
}

let pageFetchCalls: unknown[][] = [];

beforeAll(async () => {
  const fakeWindow: any = {
    fetch: (...args: unknown[]) => {
      pageFetchCalls.push(args);
      const url = typeof args[0] === 'string' ? args[0] : (args[0] as any)?.url ?? '';
      return Promise.resolve(fakeResponse(url, (fakeWindow.__nextBody as string) ?? '{}'));
    },
    XMLHttpRequest: FakeXHR,
    document: {},
  };
  (globalThis as any).window = fakeWindow;
  (globalThis as any).document = {
    dispatchEvent(event: any) {
      dispatched.push({ type: event.type, detail: JSON.parse(event.detail) });
      return true;
    },
  };
  (globalThis as any).localStorage = {
    getItem: (key: string) => localStore.get(key) ?? null,
  };
  // @ts-expect-error side-effect script (IIFE), deliberately not a module
  await import('../extension/content/page-interceptor.js');
});

beforeEach(() => {
  dispatched.length = 0;
  pageFetchCalls = [];
  localStore.clear();
  FakeXHR.instances.length = 0;
});

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('page-interceptor: fetch', () => {
  it('forwards pass-listed GraphQL responses as a string-detail CustomEvent', async () => {
    const body = JSON.stringify({ data: { user: {} } });
    (window as any).__nextBody = body;
    await (window as any).fetch(GRAPHQL_URL, { method: 'GET' });
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe('twmd:graphql');
    expect(dispatched[0].detail).toMatchObject({
      v: 1,
      op: 'UserTweets',
      url: GRAPHQL_URL,
      body,
    });
    expect(typeof dispatched[0].detail.ts).toBe('number');
  });

  it('returns the original response untouched and passes args through', async () => {
    (window as any).__nextBody = '{}';
    const response = await (window as any).fetch(GRAPHQL_URL, { method: 'GET' });
    await settle();
    expect(response.ok).toBe(true);
    expect(response.url).toBe(GRAPHQL_URL);
    expect(pageFetchCalls).toEqual([[GRAPHQL_URL, { method: 'GET' }]]);
  });

  it('ignores non-GraphQL URLs', async () => {
    await (window as any).fetch('https://x.com/home');
    await (window as any).fetch('https://pbs.twimg.com/media/abc.jpg?name=orig');
    await settle();
    expect(dispatched).toHaveLength(0);
  });

  it('ignores unlisted operations by default, forwards name-only telemetry in debug mode', async () => {
    await (window as any).fetch(UNLISTED_URL);
    await settle();
    expect(dispatched).toHaveLength(0);

    localStore.set('twmd_debug', '1');
    await (window as any).fetch(UNLISTED_URL);
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe('twmd:graphql-unlisted');
    expect(dispatched[0].detail.op).toBe('BrandNewOperation');
    expect(dispatched[0].detail.body).toBeUndefined();
  });

  it('never throws into the page, even for exotic arguments', async () => {
    await expect((window as any).fetch(undefined)).resolves.toBeDefined();
    await expect((window as any).fetch({ url: 42 })).resolves.toBeDefined();
    await settle();
    expect(dispatched).toHaveLength(0);
  });
});

describe('page-interceptor: XHR', () => {
  function performXhr(url: string, status: number, body: string) {
    const xhr = new (window as any).XMLHttpRequest();
    xhr.open('GET', url);
    xhr.send();
    xhr.fireLoad(status, body);
    return xhr;
  }

  it('forwards pass-listed GraphQL responses', () => {
    const body = JSON.stringify({ data: {} });
    performXhr(GRAPHQL_URL, 200, body);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].detail).toMatchObject({ op: 'UserTweets', body });
  });

  it('ignores non-2xx responses and non-GraphQL URLs', () => {
    performXhr(GRAPHQL_URL, 429, '{"errors":[]}');
    performXhr('https://x.com/i/api/1.1/jot/client_event.json', 200, '{}');
    expect(dispatched).toHaveLength(0);
  });

  it('does not register load listeners for non-GraphQL requests', () => {
    const xhr = performXhr('https://video.twimg.com/some.mp4', 200, 'binary');
    expect(Object.keys(xhr.listeners)).toHaveLength(0);
  });
});
