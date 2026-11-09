// Home page: shows the next few races from races.csv.
(function () {
  const list = document.getElementById('next-races');
  const LEVELS = ['beginner', 'club', 'school', 'state', 'national'];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function parseCSV(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(v => v.trim())) rows.push(row); row = []; }
      else f += c;
    }
    row.push(f); if (row.some(v => v.trim())) rows.push(row);
    const head = rows.shift().map(h => h.replace(/^\uFEFF/, '').trim());
    return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
  }
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const fmt = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  // Excel likes to save dates as 15/11/2026. Turn those back into 2026-11-15.
  const normDate = s => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s || ''); return m ? m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') : (s || ''); };
  const toDate = s => { const [y, m, dd] = s.split('-').map(Number); return new Date(y, m - 1, dd); };
  fetch('races.csv').then(r => { if (!r.ok) throw new Error(r.status); return r.text(); }).then(text => {
    const next = parseCSV(text).map(r => Object.assign(r, { date: normDate(r.date), end_date: normDate(r.end_date) }))
      .filter(r => r.id && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && (r.end_date || r.date) >= today)
      .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
    if (!next.length) { list.innerHTML = '<li class="empty">No upcoming races listed yet. New dates get added as clubs announce them.</li>'; return; }
    list.innerHTML = next.map(r => {
      const lvl = LEVELS.includes((r.level || '').toLowerCase()) ? r.level.toLowerCase() : 'club';
      return '<li><a class="race" href="calendar.html#race/' + encodeURIComponent(r.id) + '">' +
        '<span class="bar lvl-' + lvl + '"></span>' +
        '<span class="race-body"><span class="race-when">' + esc(fmt.format(toDate(r.date)) + (r.end_date && r.end_date !== r.date ? ' to ' + fmt.format(toDate(r.end_date)) : '')) + '</span>' +
        '<span class="race-name">' + esc(r.name) + '</span>' +
        '<span class="race-where">' + esc(r.venue === 'See entry page' ? r.region : r.venue) + '</span></span>' +
        '<span class="tag lvl-' + lvl + '">' + esc(r.level) + '</span></a></li>';
    }).join('');
  }).catch(() => { list.innerHTML = '<li class="empty">Sorry, races couldn\'t be loaded.</li>'; });
})();
