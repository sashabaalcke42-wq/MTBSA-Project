// Checks for the Cloudflare functions behind race alerts and the calendar feed.
// Run: node --test .github/site-check/test_functions.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequest } from '../../functions/api/alerts/[[path]].js';
import { buildCalendar, onRequestGet as calendar } from '../../functions/api/calendar.js';

const TOKEN = 'a-long-test-token-for-alerts-123';

function fakeKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix, limit, cursor }) {
      const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const keys = all.slice(start, start + limit).map(name => ({ name }));
      const done = start + limit >= all.length;
      return { keys, list_complete: done, cursor: done ? undefined : String(start + limit) };
    }
  };
}

function call(env, path, { method = 'GET', body, auth } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = 'Bearer ' + auth;
  const request = new Request('https://mtbsa.com.au/api/alerts/' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  return onRequest({ request, env, params: { path: path.split('?')[0].split('/') } });
}

const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'BPk3x_y-z', auth: 'q1w2e3' } };

test('everything says "not set up" until the KV namespace is connected', async () => {
  const res = await call({}, 'key');
  assert.equal(res.status, 503);
});

test('key is hidden until the daily check makes one', async () => {
  const env = { ALERTS: fakeKV(), ALERTS_TOKEN: TOKEN };
  assert.equal((await call(env, 'key')).status, 503);
  const made = await (await call(env, 'admin', { method: 'POST', auth: TOKEN, body: { setup: { publicKey: 'PUB', privateKey: 'PRIV' } } })).json();
  assert.equal(made.created, true);
  // A second setup never replaces it, because everyone's sign-up depends on it.
  const again = await (await call(env, 'admin', { method: 'POST', auth: TOKEN, body: { setup: { publicKey: 'X', privateKey: 'Y' } } })).json();
  assert.equal(again.created, false);
  assert.deepEqual(await (await call(env, 'key')).json(), { publicKey: 'PUB' });
});

test('admin needs the right token', async () => {
  const env = { ALERTS: fakeKV(), ALERTS_TOKEN: TOKEN };
  assert.equal((await call(env, 'admin')).status, 401);
  assert.equal((await call(env, 'admin', { auth: TOKEN + 'x' })).status, 401);
  assert.equal((await call({ ALERTS: fakeKV(), ALERTS_TOKEN: 'short' }, 'admin', { auth: 'short' })).status, 401);
  assert.equal((await call(env, 'admin', { auth: TOKEN })).status, 200);
});

test('subscribe, change, read back and turn off', async () => {
  const env = { ALERTS: fakeKV(), ALERTS_TOKEN: TOKEN };
  let res = await call(env, 'subscribe', { method: 'POST', body: { subscription: SUB, topics: { open: true, close: 'yes', sneaky: true }, races: ['mtb-nationals-2027', '../bad', 'mtb-nationals-2027'] } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, topics: { open: true, close: false, new: false }, races: ['mtb-nationals-2027'] });
  assert.equal(env.ALERTS.m.size, 1);

  res = await call(env, 'me', { method: 'POST', body: { endpoint: SUB.endpoint } });
  assert.deepEqual(await res.json(), { topics: { open: true, close: false, new: false }, races: ['mtb-nationals-2027'] });

  const list = await (await call(env, 'admin', { auth: TOKEN })).json();
  assert.equal(list.subs.length, 1);
  assert.equal(list.subs[0].subscription.endpoint, SUB.endpoint);
  assert.match(list.subs[0].id, /^[0-9a-f]{64}$/);

  // Nothing ticked means off.
  res = await call(env, 'subscribe', { method: 'POST', body: { subscription: SUB, topics: {}, races: [] } });
  assert.equal((await res.json()).off, true);
  assert.equal(env.ALERTS.m.size, 0);

  await call(env, 'subscribe', { method: 'POST', body: { subscription: SUB, topics: { new: true } } });
  await call(env, 'unsubscribe', { method: 'POST', body: { endpoint: SUB.endpoint } });
  assert.equal(env.ALERTS.m.size, 0);
  assert.equal((await call(env, 'me', { method: 'POST', body: { endpoint: SUB.endpoint } })).status, 404);
});

test('bad sign-ups are refused', async () => {
  const env = { ALERTS: fakeKV(), ALERTS_TOKEN: TOKEN };
  for (const subscription of [null, { endpoint: 'http://x.example/1', keys: SUB.keys }, { endpoint: SUB.endpoint }, { endpoint: SUB.endpoint, keys: { p256dh: '<script>', auth: 'a' } }]) {
    assert.equal((await call(env, 'subscribe', { method: 'POST', body: { subscription, topics: { open: true } } })).status, 400);
  }
  const big = await onRequest({ env, params: { path: ['subscribe'] }, request: new Request('https://x/api/alerts/subscribe', { method: 'POST', body: 'x'.repeat(9000) }) });
  assert.equal(big.status, 400);
  assert.equal(env.ALERTS.m.size, 0);
});

test('the daily check pages through everyone and removes gone devices', async () => {
  const env = { ALERTS: fakeKV(), ALERTS_TOKEN: TOKEN };
  for (let i = 0; i < 205; i++) {
    await call(env, 'subscribe', { method: 'POST', body: { subscription: { ...SUB, endpoint: SUB.endpoint + i }, topics: { open: true } } });
  }
  const p1 = await (await call(env, 'admin', { auth: TOKEN })).json();
  assert.equal(p1.subs.length, 200);
  const p2 = await (await call(env, 'admin?cursor=' + p1.cursor, { auth: TOKEN })).json();
  assert.equal(p2.subs.length, 5);
  assert.equal(p2.cursor, null);
  await call(env, 'admin', { method: 'POST', auth: TOKEN, body: { remove: p2.subs.map(s => s.id).concat('not-an-id') } });
  assert.equal(env.ALERTS.m.size, 200);
});

test('calendar feed has races and entry days, and is valid enough for calendar apps', async () => {
  const csv = readFileSync(new URL('../../races.csv', import.meta.url), 'utf8');
  const env = { ASSETS: { fetch: async () => new Response(csv) } };
  const res = await calendar({ request: new Request('https://mtbsa.com.au/api/calendar'), env });
  assert.equal(res.headers.get('Content-Type'), 'text/calendar; charset=utf-8');
  const ics = await res.text();
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.match(ics, /SUMMARY:Entries open: MTB National Championships\r\nLOCATION|SUMMARY:Entries open: MTB National Championships\r\nDESCRIPTION/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261209/);
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length);
});

test('calendar feed leaves out old races', () => {
  const ics = buildCalendar([
    { id: 'old', date: '2020-01-01', name: 'Old' },
    { id: 'new', date: '2027-01-02', end_date: '2027-01-03', name: 'New; race, here', entries_close: '2026-12-20' }
  ], 'https://mtbsa.com.au', new Date('2026-11-26T00:00:00Z'));
  assert.doesNotMatch(ics, /UID:old@/);
  assert.match(ics, /DTEND;VALUE=DATE:20270104/);
  assert.match(ics, /SUMMARY:New\\; race\\, here/);
  assert.match(ics, /SUMMARY:Entries close: New/);
});
