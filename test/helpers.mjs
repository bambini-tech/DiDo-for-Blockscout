// Shared test doubles: a scripted fetch and a client that never really sleeps.
import { BlockscoutClient } from '../dist/blockscout/client.js';

process.env.NODE_ENV = 'test';

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** routes: array of [predicate(url) | substring, response | (url) => response]. Records every URL. */
export function scriptedFetch(routes) {
  const seen = [];
  const fn = async (url) => {
    const u = new URL(String(url));
    seen.push(u);
    for (const [match, res] of routes) {
      const hit = typeof match === 'string' ? u.pathname.includes(match) : match(u);
      if (hit) {
        const out = typeof res === 'function' ? res(u) : res;
        if (out instanceof Error) throw out;
        return out.clone();
      }
    }
    return json({ message: 'no route' }, 500);
  };
  fn.seen = seen;
  return fn;
}

export function makeClient(fetchFn, extra = {}) {
  const sleeps = [];
  const client = new BlockscoutClient({
    apiKey: 'test-key',
    fetch: fetchFn,
    sleep: async (ms) => { sleeps.push(ms); },
    ...extra,
  });
  client.sleeps = sleeps;
  return client;
}
