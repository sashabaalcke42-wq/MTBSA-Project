// A calendar feed of every race, plus the days entries open and close.
// People subscribe to it once (iPhone, Android, Google, Outlook) and new races
// and changed dates show up in their calendar app by themselves.
// Address: https://mtbsa.com.au/api/calendar  (built from races.csv, nothing to set up)

function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = ''; if (row.some(v => v.trim())) rows.push(row); row = [];
    } else f += c;
  }
  row.push(f); if (row.some(v => v.trim())) rows.push(row);
  const head = rows.shift().map(h => h.replace(/^﻿/, '').trim());
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

const normDate = s => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s || ''); return m ? m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') : (s || ''); };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const compact = s => s.replace(/-/g, '');
function nextDay(s) {
  const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const text = s => String(s || '').replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\r?\n/g, '\\n');

// Calendar lines longer than 75 bytes have to be folded.
function fold(line) {
  const out = []; let cur = '', size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; size = 0; }
    cur += ch; size += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function buildCalendar(races, origin, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const cutoff = new Date(now.getTime() - 60 * 864e5).toISOString().slice(0, 10);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mountain Biking SA//Race Calendar//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:MTB SA races', 'X-WR-TIMEZONE:Australia/Adelaide',
    'X-WR-CALDESC:South Australian mountain bike races from mtbsa.com.au',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H', 'X-PUBLISHED-TTL:PT12H'];
  const event = (uid, day, end, summary, desc, url, location) => {
    lines.push('BEGIN:VEVENT', 'UID:' + uid + '@mtbsa.com.au', 'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + compact(day), 'DTEND;VALUE=DATE:' + compact(nextDay(end)),
      'SUMMARY:' + text(summary));
    if (location) lines.push('LOCATION:' + text(location));
    lines.push('DESCRIPTION:' + text(desc), 'URL:' + url, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  };
  for (const r of races) {
    const date = normDate(r.date), end = normDate(r.end_date) || date;
    if (!r.id || !isDate(date) || end < cutoff) continue;
    const page = origin + '/calendar#race/' + encodeURIComponent(r.id);
    const where = r.venue === 'See entry page' ? r.region : [r.venue, r.region].filter(Boolean).join(', ');
    event(r.id, date, isDate(end) ? end : date, r.name, (r.summary || '') + '\n\nRace info: ' + page +
      (r.entry_url ? '\nEnter: ' + r.entry_url : ''), page, where);
    const open = normDate(r.entries_open), close = normDate(r.entries_close);
    if (isDate(open)) event(r.id + '-entries-open', open, open, 'Entries open: ' + r.name,
      'Entries open today for ' + r.name + '.\n\nEnter: ' + (r.entry_url || page), page);
    if (isDate(close)) event(r.id + '-entries-close', close, close, 'Entries close: ' + r.name,
      'Last day to enter ' + r.name + '.\n\nEnter: ' + (r.entry_url || page), page);
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const res = await env.ASSETS.fetch(new URL('/races.csv', url.origin));
  if (!res.ok) return new Response('Races could not be loaded.', { status: 502 });
  const body = buildCalendar(parseCSV(await res.text()), url.origin);
  return new Response(body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="mtbsa-races.ics"',
      'Cache-Control': 'public, max-age=3600'
    }
  });
}
