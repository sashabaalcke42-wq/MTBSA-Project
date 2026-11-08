// Mountain Biking SA race calendar.
// Races live in races.csv (edit it like a spreadsheet). This file reads it and draws the page.

(function () {
  const listView = document.getElementById('list-view');
  const detailView = document.getElementById('detail-view');
  const racesEl = document.getElementById('races');
  const fType = document.getElementById('f-type');
  const fRegion = document.getElementById('f-region');
  const fBeginner = document.getElementById('f-beginner');
  const fPast = document.getElementById('f-past');

  let races = [];

  // ---- CSV reading (handles quoted fields with commas) ----
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(v => v.trim() !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some(v => v.trim() !== '')) rows.push(row);
    const header = rows.shift().map(h => h.trim());
    return rows.map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
  }

  // ---- Dates ----
  function toDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function today() { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }
  const fmtDay = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtLong = new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtMonth = new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' });
  function isPast(r) { return toDate(r.end_date || r.date) < today(); }
  function dateRange(r, fmt) {
    if (!r.end_date || r.end_date === r.date) return fmt.format(toDate(r.date));
    return fmt.format(toDate(r.date)) + ' to ' + fmt.format(toDate(r.end_date));
  }

  // ---- Helpers ----
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function safeUrl(u) { return /^https?:\/\//i.test(u) ? u : '#'; }
  function beginnerBadge(r) {
    return r.beginner_friendly.toLowerCase() === 'yes'
      ? '<span class="badge badge-beginner">Beginner friendly</span>' : '';
  }

  // ---- Add to calendar (.ics file) ----
  function icsDate(s) { return s.replace(/-/g, ''); }
  function nextDay(s) { const d = toDate(s); d.setDate(d.getDate() + 1);
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }
  function icsText(s) { return s.replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\n/g, '\\n'); }
  function downloadICS(r) {
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mountain Biking SA//Race Calendar//EN',
      'BEGIN:VEVENT',
      'UID:' + r.id + '@mountainbikingsa',
      'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z',
      'DTSTART;VALUE=DATE:' + icsDate(r.date),
      'DTEND;VALUE=DATE:' + nextDay(r.end_date || r.date),
      'SUMMARY:' + icsText(r.name),
      'LOCATION:' + icsText(r.venue),
      'DESCRIPTION:' + icsText(r.summary + '\n\nEnter / official info: ' + r.entry_url),
      'URL:' + r.entry_url,
      'END:VEVENT', 'END:VCALENDAR'
    ];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.id + '.ics';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---- List view ----
  function fillFilter(select, values) {
    [...new Set(values)].sort().forEach(v => {
      const o = document.createElement('option'); o.value = v; o.textContent = v; select.appendChild(o);
    });
  }

  function renderList() {
    const shown = races.filter(r =>
      (!fType.value || r.type === fType.value) &&
      (!fRegion.value || r.region === fRegion.value) &&
      (!fBeginner.checked || r.beginner_friendly.toLowerCase() === 'yes') &&
      (fPast.checked || !isPast(r))
    );
    if (!shown.length) {
      racesEl.innerHTML = '<p class="empty">No races match. Try changing the filters, or tick "Show past races" to see how the season usually runs.</p>';
      return;
    }
    let html = '', month = '';
    shown.forEach(r => {
      const m = fmtMonth.format(toDate(r.date));
      if (m !== month) { if (month) html += '</ul>'; html += '<h2 class="month">' + m + '</h2><ul class="race-list">'; month = m; }
      html += '<li><a class="race-card' + (isPast(r) ? ' past' : '') + '" href="#race/' + encodeURIComponent(r.id) + '">' +
        '<span class="race-date">' + esc(dateRange(r, fmtDay)) + '</span>' +
        '<span class="race-main"><span class="race-name">' + esc(r.name) + '</span>' +
        '<span class="race-meta">' + esc(r.type) + ' · ' + esc(r.venue) + '</span>' +
        '<span class="race-badges">' + beginnerBadge(r) + (isPast(r) ? '<span class="badge">Finished</span>' : '') + '</span></span>' +
        '</a></li>';
    });
    racesEl.innerHTML = html + '</ul>';
  }

  // ---- Detail view (on our site, then link out) ----
  function renderDetail(id) {
    const r = races.find(x => x.id === id);
    if (!r) { location.hash = ''; return; }
    detailView.innerHTML =
      '<a class="back" href="#">← All races</a>' +
      '<h1>' + esc(r.name) + '</h1>' +
      '<p class="detail-date">' + esc(dateRange(r, fmtLong)) + '</p>' +
      '<p>' + beginnerBadge(r) + (isPast(r) ? '<span class="badge">Finished</span>' : '') + '</p>' +
      '<p class="lead">' + esc(r.summary) + '</p>' +
      '<dl class="facts">' +
        '<dt>Type</dt><dd>' + esc(r.type) + '</dd>' +
        '<dt>Where</dt><dd>' + esc(r.venue) + ' (' + esc(r.region) + ')</dd>' +
        '<dt>Who can ride</dt><dd>' + esc(r.ages) + '</dd>' +
        '<dt>Cost</dt><dd>' + esc(r.cost) + '</dd>' +
        '<dt>Licence needed</dt><dd>' + esc(r.licence) + ' <a href="new-to-racing.html#licence">What\'s this?</a></dd>' +
        '<dt>Run by</dt><dd><a href="' + esc(safeUrl(r.organiser_url)) + '" target="_blank" rel="noopener">' + esc(r.organiser) + '</a></dd>' +
      '</dl>' +
      '<div class="actions">' +
        (isPast(r) ? '' : '<a class="btn btn-primary" href="' + esc(safeUrl(r.entry_url)) + '" target="_blank" rel="noopener">Enter on the official page ↗</a>') +
        (isPast(r) ? '' : '<button class="btn" id="add-cal" type="button">Add to my calendar</button>') +
        (isPast(r) ? '<a class="btn" href="' + esc(safeUrl(r.entry_url)) + '" target="_blank" rel="noopener">Official page and results ↗</a>' : '') +
      '</div>' +
      '<p class="muted small">Details can change. Always check the official page before you go.</p>';
    const btn = document.getElementById('add-cal');
    if (btn) btn.addEventListener('click', () => downloadICS(r));
  }

  function route() {
    const m = location.hash.match(/^#race\/(.+)$/);
    if (m) {
      renderDetail(decodeURIComponent(m[1]));
      listView.hidden = true; detailView.hidden = false; window.scrollTo(0, 0);
    } else {
      detailView.hidden = true; listView.hidden = false;
    }
  }

  // ---- Start ----
  fetch('races.csv')
    .then(res => { if (!res.ok) throw new Error(res.status); return res.text(); })
    .then(text => {
      races = parseCSV(text).filter(r => r.id && r.date).sort((a, b) => a.date.localeCompare(b.date));
      fillFilter(fType, races.map(r => r.type));
      fillFilter(fRegion, races.map(r => r.region));
      [fType, fRegion, fBeginner, fPast].forEach(el => el.addEventListener('change', renderList));
      renderList();
      route();
    })
    .catch(() => { racesEl.innerHTML = '<p class="empty">Sorry, the races couldn\'t be loaded. Please try again later.</p>'; });

  window.addEventListener('hashchange', route);
})();
