// Mountain Biking SA race calendar.
// All races live in races.csv (edit it like a spreadsheet). This file reads it and draws the calendar.

(function () {
  // Race levels, in the order they show. Colours live in style.css (.lvl-<key>).
  const LEVELS = [
    { name: 'Beginner', key: 'beginner', help: 'Easy entry, great for first-timers' },
    { name: 'Club', key: 'club', help: 'Local club races, all abilities' },
    { name: 'School', key: 'school', help: 'Run through schools' },
    { name: 'State', key: 'state', help: 'State series and championships' },
    { name: 'National', key: 'national', help: 'National rounds and championships' }
  ];
  const levelKey = name => (LEVELS.find(l => l.name.toLowerCase() === String(name).toLowerCase()) || { key: 'club' }).key;

  const $ = id => document.getElementById(id);
  const calView = $('calendar-view'), detailView = $('detail-view');
  const grid = $('grid'), list = $('list'), monthTitle = $('month-title'), listTitle = $('list-title');

  let races = [];
  const picked = new Set();          // levels the viewer has picked (none picked = show all)
  let shown = startOfMonth(new Date()); // month on screen
  let pickedDay = null;              // 'YYYY-MM-DD' when a day is tapped
  let yearView = true;               // list shows the next 12 months until someone changes month

  // ---- CSV (handles quoted fields with commas) ----
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
    const head = rows.shift().map(h => h.trim());
    return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
  }

  // ---- Dates ----
  function toDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  const todayISO = iso(new Date());
  const fmtMonth = new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' });
  const fmtShort = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtLong = new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const endOf = r => r.end_date || r.date;
  const isPast = r => endOf(r) < todayISO;
  const onDay = (r, day) => r.date <= day && day <= endOf(r);
  function when(r, fmt) {
    return r.end_date && r.end_date !== r.date
      ? fmt.format(toDate(r.date)) + ' to ' + fmt.format(toDate(r.end_date))
      : fmt.format(toDate(r.date));
  }

  // ---- Helpers ----
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = u => /^https?:\/\//i.test(u) ? u : '#';
  const tag = r => '<span class="tag lvl-' + levelKey(r.level) + '">' + esc(r.level) + '</span>';
  const visible = () => races.filter(r => !picked.size || picked.has(levelKey(r.level)));

  // ---- Level buttons ----
  // Tap one to show only that level. Tap more to add them. Tap a picked one again to drop it.
  function drawLevels() {
    const box = $('levels');
    box.classList.toggle('filtering', picked.size > 0);
    box.innerHTML = LEVELS.map(l =>
      '<button type="button" class="level-btn lvl-' + l.key + '" data-key="' + l.key + '" aria-pressed="' + picked.has(l.key) + '" title="' + esc(l.help) + '">' +
      '<span class="dot"></span>' + l.name + '</button>').join('') +
      (picked.size ? '<button type="button" class="link-btn" id="show-all">Show all</button>' : '');
    box.querySelectorAll('.level-btn').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.key; picked.has(k) ? picked.delete(k) : picked.add(k);
      drawLevels(); drawMonth();
    }));
    const all = $('show-all'); if (all) all.addEventListener('click', () => { picked.clear(); drawLevels(); drawMonth(); });
  }

  // ---- Month grid ----
  function drawMonth() {
    monthTitle.textContent = fmtMonth.format(shown);
    $('today').hidden = yearView;
    const y = shown.getFullYear(), m = shown.getMonth();
    const first = new Date(y, m, 1);
    const lead = (first.getDay() + 6) % 7;            // Monday-first
    const days = new Date(y, m + 1, 0).getDate();
    const vis = visible();
    let html = '';
    for (let i = 0; i < lead; i++) html += '<div class="day blank" aria-hidden="true"></div>';
    for (let d = 1; d <= days; d++) {
      const day = iso(new Date(y, m, d));
      const evs = vis.filter(r => onDay(r, day));
      const cls = ['day'];
      if (day === todayISO) cls.push('today');
      if (day < todayISO) cls.push('past');
      if (evs.length) cls.push('has');
      if (day === pickedDay) cls.push('picked');
      html += '<button type="button" class="' + cls.join(' ') + '" data-day="' + day + '"' + (evs.length ? '' : ' tabindex="-1"') +
        ' aria-label="' + esc(fmtLong.format(toDate(day)) + (evs.length ? ', ' + evs.length + ' race' + (evs.length > 1 ? 's' : '') : '')) + '">' +
        '<span class="num">' + d + '</span>' +
        (evs.length ? '<span class="chips">' + evs.map(r => '<span class="chip lvl-' + levelKey(r.level) + '"><span class="chip-text">' + esc(r.name) + '</span></span>').join('') + '</span>' : '') +
        '</button>';
    }
    grid.innerHTML = html;
    grid.querySelectorAll('.day.has').forEach(b => b.addEventListener('click', () => {
      pickedDay = pickedDay === b.dataset.day ? null : b.dataset.day;
      drawMonth();
      list.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }));
    drawList();
  }

  // ---- Races under the calendar ----
  function drawList() {
    let from, to;
    if (yearView && !pickedDay) {
      const now = new Date();
      from = todayISO; to = iso(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate() - 1));
    } else {
      const y = shown.getFullYear(), m = shown.getMonth();
      from = iso(new Date(y, m, 1)); to = iso(new Date(y, m + 1, 0));
    }
    let items = visible().filter(r => r.date <= to && endOf(r) >= from);
    if (pickedDay) items = items.filter(r => onDay(r, pickedDay));
    listTitle.innerHTML = pickedDay
      ? esc(fmtLong.format(toDate(pickedDay))) + ' <button type="button" class="link-btn" id="clear-day">' + (yearView ? 'Show next 12 months' : 'Show whole month') + '</button>'
      : yearView ? 'Races in the next 12 months' : 'Races in ' + esc(fmtMonth.format(shown));
    const clear = $('clear-day'); if (clear) clear.addEventListener('click', () => { pickedDay = null; drawMonth(); });

    if (!items.length) {
      list.innerHTML = '<li class="empty">' + (picked.size ? 'No races at that level ' + (yearView ? 'in the next 12 months' : 'this month') + '. Try picking another level, or tap "Show all".'
        : yearView ? 'No races listed yet. New dates get added as clubs announce them.'
        : 'No races listed this month. Most SA racing runs from March to October, and new dates get added as clubs announce them.') + '</li>';
      return;
    }
    // In the 12-month view, put a small month heading above each new month.
    let lastMonth = '';
    list.innerHTML = items.map(r => {
      let head = '';
      if (yearView && !pickedDay) {
        const mk = (r.date < from ? from : r.date).slice(0, 7);
        if (mk !== lastMonth) { lastMonth = mk; head = '<li class="list-month">' + esc(fmtMonth.format(toDate(mk + '-01'))) + '</li>'; }
      }
      return head + '<li><a class="race' + (isPast(r) ? ' done' : '') + '" href="#race/' + encodeURIComponent(r.id) + '">' +
      '<span class="bar lvl-' + levelKey(r.level) + '"></span>' +
      '<span class="race-body"><span class="race-when">' + esc(when(r, fmtShort)) + (isPast(r) ? ' · finished' : '') + '</span>' +
      '<span class="race-name">' + esc(r.name) + '</span>' +
      '<span class="race-where">' + esc(r.venue === 'See entry page' ? r.region : r.venue) + '</span></span>' +
      tag(r) + '</a></li>';
    }).join('');
  }

  // ---- Add to calendar (.ics) ----
  function downloadICS(r) {
    const t = s => s.replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\n/g, '\\n');
    const end = toDate(endOf(r)); end.setDate(end.getDate() + 1);
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mountain Biking SA//Race Calendar//EN', 'BEGIN:VEVENT',
      'UID:' + r.id + '@mountainbikingsa',
      'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z',
      'DTSTART;VALUE=DATE:' + r.date.replace(/-/g, ''),
      'DTEND;VALUE=DATE:' + iso(end).replace(/-/g, ''),
      'SUMMARY:' + t(r.name), 'LOCATION:' + t(r.venue),
      'DESCRIPTION:' + t(r.summary + '\n\nEnter / official info: ' + r.entry_url),
      'URL:' + r.entry_url, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    a.download = r.id + '.ics'; document.body.appendChild(a); a.click(); a.remove();
  }

  // ---- Race page ----
  function drawDetail(id) {
    const r = races.find(x => x.id === id);
    if (!r) { location.hash = ''; return; }
    const past = isPast(r);
    const row = (k, v) => v ? '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>' : '';
    detailView.innerHTML =
      '<a class="back" href="#" id="back">‹ Back to calendar</a>' +
      '<p>' + tag(r) + '</p>' +
      '<h1>' + esc(r.name) + '</h1>' +
      '<p class="detail-when">' + esc(when(r, fmtLong)) + (past ? ' · finished' : '') + '</p>' +
      '<p class="detail-summary">' + esc(r.summary) + '</p>' +
      '<div class="actions">' +
        '<a class="btn btn-main" href="' + esc(safeUrl(r.entry_url)) + '" target="_blank" rel="noopener">' + (past ? 'Results and info' : 'Enter on the official page') + ' ↗</a>' +
        (past ? '' : '<button class="btn" id="add-cal" type="button">Add to my calendar</button>') +
      '</div>' +
      '<dl class="facts">' +
        row('Where', esc(r.venue === 'See entry page' ? r.region + ' (venue on the entry page)' : r.venue + ', ' + r.region)) +
        row('Race type', esc(r.type)) +
        row('Who can ride', esc(r.ages)) +
        row('Cost', esc(r.cost)) +
        row('Licence', esc(r.licence) + ' · <a href="new-to-racing.html#licence">what\'s this?</a>') +
        row('Run by', '<a href="' + esc(safeUrl(r.organiser_url)) + '" target="_blank" rel="noopener">' + esc(r.organiser) + '</a>') +
      '</dl>' +
      '<p class="muted small">Details can change, so check the official page before you go.</p>';
    $('back').addEventListener('click', e => { e.preventDefault(); history.length > 1 ? history.back() : (location.hash = ''); });
    const b = $('add-cal'); if (b) b.addEventListener('click', () => downloadICS(r));
  }

  function route() {
    const m = location.hash.match(/^#race\/(.+)$/);
    if (m) { drawDetail(decodeURIComponent(m[1])); calView.hidden = true; detailView.hidden = false; window.scrollTo(0, 0); }
    else { detailView.hidden = true; calView.hidden = false; }
  }

  // ---- Start ----
  // "Find a race" glides down to the calendar instead of jumping.
  if ($('find')) $('find').addEventListener('click', e => {
    e.preventDefault();
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('cal-start').scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  });
  // Changing month switches the list to that one month. "Show next 12 months" switches back.
  $('prev').addEventListener('click', () => { shown = new Date(shown.getFullYear(), shown.getMonth() - 1, 1); pickedDay = null; yearView = false; drawMonth(); });
  $('next').addEventListener('click', () => { shown = new Date(shown.getFullYear(), shown.getMonth() + 1, 1); pickedDay = null; yearView = false; drawMonth(); });
  $('today').addEventListener('click', () => { shown = startOfMonth(new Date()); pickedDay = null; yearView = true; drawMonth(); });
  window.addEventListener('hashchange', route);

  fetch('races.csv')
    .then(res => { if (!res.ok) throw new Error(res.status); return res.text(); })
    .then(text => {
      races = parseCSV(text).filter(r => r.id && r.date).sort((a, b) => a.date.localeCompare(b.date));
      drawLevels(); drawMonth(); route();
    })
    .catch(() => { list.innerHTML = '<li class="empty">Sorry, the races couldn\'t be loaded. Please try again later.</li>'; });
})();
