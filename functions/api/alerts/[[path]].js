// Race alerts: phone and computer notifications for "entries open today",
// "entries close tomorrow" and "new race added".
//
// This keeps the list of people who turned alerts on. It never sends anything
// itself: the free daily site check on GitHub sends the alerts each morning.
//
//   GET  /api/alerts/key          the public key browsers need to sign up
//   POST /api/alerts/subscribe    turn alerts on, or change what you get
//   POST /api/alerts/me           what this device has picked
//   POST /api/alerts/unsubscribe  turn alerts off on this device
//   GET  /api/alerts/admin        for the daily check only (needs ALERTS_TOKEN)
//   POST /api/alerts/admin        for the daily check only (needs ALERTS_TOKEN)
//
// Setup (free, once): see "Race alerts" in README.md. It needs a KV namespace
// bound as ALERTS and a secret called ALERTS_TOKEN. Until both are there,
// the alert buttons stay hidden and nothing breaks.

const TOPICS = ['open', 'close', 'new'];
const RACE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PAGE = 200;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

async function hash(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > 8000) throw new Error('too big');
  return JSON.parse(text || '{}');
}

function validEndpoint(e) {
  if (typeof e !== 'string' || e.length > 1000) return false;
  try { return new URL(e).protocol === 'https:'; } catch { return false; }
}

function cleanSubscription(s) {
  if (!s || !validEndpoint(s.endpoint) || !s.keys) return null;
  const { p256dh, auth } = s.keys;
  const ok = v => typeof v === 'string' && v.length > 0 && v.length <= 200 && /^[A-Za-z0-9_=-]+$/.test(v);
  return ok(p256dh) && ok(auth) ? { endpoint: s.endpoint, keys: { p256dh, auth } } : null;
}

function cleanChoices(body) {
  const t = body.topics || {};
  const topics = Object.fromEntries(TOPICS.map(k => [k, t[k] === true]));
  const races = [...new Set(Array.isArray(body.races) ? body.races : [])]
    .filter(r => typeof r === 'string' && RACE_ID.test(r)).slice(0, 100);
  return { topics, races };
}

// Same length check every time, so the token can't be guessed a letter at a time.
function sameText(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function isAdmin(request, env) {
  const token = env.ALERTS_TOKEN || '';
  const got = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return token.length >= 20 && sameText(got, token);
}

async function admin(request, env) {
  if (!isAdmin(request, env)) return json({ error: 'not allowed' }, 401);
  const kv = env.ALERTS;
  if (request.method === 'GET') {
    const cursor = new URL(request.url).searchParams.get('cursor') || undefined;
    const vapid = await kv.get('vapid', 'json');
    const page = await kv.list({ prefix: 'sub:', limit: PAGE, cursor });
    const subs = [];
    for (const k of page.keys) {
      const v = await kv.get(k.name, 'json');
      if (v) subs.push({ id: k.name.slice(4), ...v });
    }
    return json({ vapid, subs, cursor: page.list_complete ? null : page.cursor });
  }
  const body = await readBody(request);
  if (body.setup) {
    // The daily check makes the key pair the first time. It's never replaced,
    // because everyone's sign-up depends on it.
    const have = await kv.get('vapid', 'json');
    if (have) return json({ ok: true, created: false, publicKey: have.publicKey });
    const { publicKey, privateKey } = body.setup;
    if (typeof publicKey !== 'string' || typeof privateKey !== 'string') return json({ error: 'bad keys' }, 400);
    await kv.put('vapid', JSON.stringify({ publicKey, privateKey }));
    return json({ ok: true, created: true, publicKey });
  }
  if (Array.isArray(body.remove)) {
    const ids = body.remove.filter(id => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)).slice(0, 500);
    for (const id of ids) await kv.delete('sub:' + id);
    return json({ ok: true, removed: ids.length });
  }
  return json({ error: 'nothing to do' }, 400);
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = [].concat(params.path || []).join('/');
  if (!env.ALERTS) return json({ error: 'Race alerts are not set up yet.' }, 503);
  try {
    if (path === 'admin') return await admin(request, env);

    if (path === 'key' && request.method === 'GET') {
      const vapid = await env.ALERTS.get('vapid', 'json');
      if (!vapid) return json({ error: 'Race alerts are not set up yet.' }, 503);
      return new Response(JSON.stringify({ publicKey: vapid.publicKey }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
      });
    }

    if (request.method !== 'POST') return json({ error: 'not found' }, 404);
    const body = await readBody(request);

    if (path === 'subscribe') {
      const subscription = cleanSubscription(body.subscription);
      if (!subscription) return json({ error: 'That browser sign-up looks wrong.' }, 400);
      const { topics, races } = cleanChoices(body);
      const id = await hash(subscription.endpoint);
      if (!races.length && !TOPICS.some(k => topics[k])) {
        await env.ALERTS.delete('sub:' + id);
        return json({ ok: true, off: true });
      }
      const old = await env.ALERTS.get('sub:' + id, 'json');
      await env.ALERTS.put('sub:' + id, JSON.stringify({
        subscription, topics, races,
        created: (old && old.created) || new Date().toISOString().slice(0, 10)
      }));
      return json({ ok: true, topics, races });
    }

    if (path === 'me' || path === 'unsubscribe') {
      if (!validEndpoint(body.endpoint)) return json({ error: 'missing endpoint' }, 400);
      const key = 'sub:' + await hash(body.endpoint);
      if (path === 'unsubscribe') { await env.ALERTS.delete(key); return json({ ok: true }); }
      const v = await env.ALERTS.get(key, 'json');
      return v ? json({ topics: v.topics, races: v.races }) : json({ error: 'not signed up' }, 404);
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: 'Something went wrong.' }, 400);
  }
}
