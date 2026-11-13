// Mountain Biking SA gear guide.
// All gear lives in gear.csv (edit it like a spreadsheet). This file reads it and draws the cards.

(function () {
  const SKILLS = ['Beginner', 'Intermediate', 'Racer'];
  const SECTIONS = ['Rider gear', 'Bike parts', 'Bikes'];
  const SKILL_HELP = {
    Beginner: 'Great first buy',
    Intermediate: 'Riding often, getting faster',
    Racer: 'Racing, downhill or bike parks'
  };

  const $ = id => document.getElementById(id);
  const grid = $('g-grid'), count = $('g-count');
  const fCat = $('g-cat'), fSkill = $('g-skill'), fPrice = $('g-price'), fBrand = $('g-brand'), fSort = $('g-sort');
  let gear = [];
  let section = '';                 // '' means everything
  // On phones, start with the filters folded away so the gear is the first thing you see.
  if (window.matchMedia('(max-width: 640px)').matches) $('g-filterbox').open = false;

  // CSV reader (handles quoted fields with commas)
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
    const head = rows.shift().map(h => h.replace(/^\uFEFF/, '').trim());
    return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = u => /^https?:\/\//i.test(u) ? u : '#';
  const money = n => '$' + n.toLocaleString('en-AU', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  const fmtDate = s => { const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); const [y, m, d] = dm ? [+dm[3], +dm[2], +dm[1]] : s.split('-').map(Number); if (!y || !m || !d) return ''; return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(y, m - 1, d)); };

  function fill(select, values) {
    values.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; select.appendChild(o); });
  }

  // Simple line drawings for each type of gear (our own art, no copied photos).
  const ART = {
    Helmets: '<path d="M10 40c0-14 10-24 24-24s22 9 22 22v4H18"/><path d="M10 40h44"/><path d="M40 18l10 10M30 17l6 12M20 22l4 10"/><path d="M46 26l12-2"/>',
    Protection: '<path d="M22 8h20v14c0 4 4 6 4 14 0 10-6 20-14 20s-14-10-14-20c0-8 4-10 4-14z"/><ellipse cx="32" cy="36" rx="9" ry="11"/><path d="M18 22h28"/>',
    Gloves: '<path d="M20 58V30l-6-8c-2-3 2-6 4-3l6 7V10c0-3 5-3 5 0v16-20c0-3 5-3 5 0v20-18c0-3 5-3 5 0v18-13c0-3 5-3 5 0v29c0 9-5 15-13 15z"/><path d="M20 50h20"/>',
    Pedals: '<rect x="12" y="16" width="40" height="32" rx="6"/><path d="M32 16v32M2 32h10"/><circle cx="19" cy="22" r="1.6"/><circle cx="45" cy="22" r="1.6"/><circle cx="19" cy="42" r="1.6"/><circle cx="45" cy="42" r="1.6"/><circle cx="19" cy="32" r="1.6"/><circle cx="45" cy="32" r="1.6"/>',
    Shoes: '<path d="M6 44V24l12 2c4 6 10 8 18 8 10 0 22 2 22 10v4H6z"/><path d="M6 48h52"/><path d="M22 28l4-4M28 30l4-4M34 31l4-4"/>',
    Tyres: '<circle cx="32" cy="32" r="24"/><circle cx="32" cy="32" r="14"/><path d="M32 4v6M32 54v6M4 32h6M54 32h6M12 12l4 4M48 48l4 4M12 52l4-4M48 16l4-4"/>',
    Bikes: '<circle cx="14" cy="42" r="11"/><circle cx="50" cy="42" r="11"/><path d="M14 42l10-18h18l8 18M24 24l8 18h10M30 18h-8M42 24l-3-8h6"/><path d="M32 42l-6-18"/>',
    Grips: '<rect x="6" y="24" width="22" height="16" rx="5"/><rect x="36" y="24" width="22" height="16" rx="5"/><path d="M28 32h8M12 24v16M22 24v16M42 24v16M52 24v16"/>',
    Brakes: '<circle cx="28" cy="34" r="20"/><circle cx="28" cy="34" r="5"/><path d="M28 14v6M28 48v6M8 34h6M42 34h6"/><path d="M42 12h12a4 4 0 0 1 4 4v16a4 4 0 0 1-4 4H44"/>',
    'Tyre sealant': '<path d="M24 8h16v8l6 6v32a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4V22l6-6z"/><path d="M24 16h16"/><path d="M32 30c-5 7-6 10-6 13a6 6 0 0 0 12 0c0-3-1-6-6-13z"/>',
    Pumps: '<rect x="24" y="14" width="14" height="40" rx="4"/><path d="M31 14V6M26 6h10M24 46h14"/><path d="M38 48c10 0 14-6 14-14"/>',
    Tools: '<rect x="14" y="22" width="36" height="20" rx="10"/><circle cx="24" cy="32" r="3"/><circle cx="40" cy="32" r="3"/><path d="M24 22L18 6M40 22l8-14M40 42l6 14"/>',
    'Dropper posts': '<path d="M14 12h28l6 4-6 4H14z"/><path d="M28 20v14M24 34h8v24h-8z"/><path d="M44 30v12M40 38l4 4 4-4"/>',
    Hydration: '<path d="M18 14c0-4 4-6 14-6s14 2 14 6v40c0 3-3 4-14 4s-14-1-14-4z"/><path d="M24 22h16v14H24z"/><path d="M46 20c8 2 10 10 6 18l-4 6"/>'
  };
  const art = cat => '<svg viewBox="0 0 64 64" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' + (ART[cat] || ART.Pedals) + '</svg>';
  const priceHTML = g => money(g.price) + (g.rrp > g.price ? ' <s>' + money(g.rrp) + '</s>' : '');
  const skillTag = g => '<span class="skill skill-' + esc(g.skill.toLowerCase()) + '">' + esc(g.skill) + '</span>';
  let shown = [];

  function draw() {
    const [lo, hi] = fPrice.value ? fPrice.value.split('-').map(Number) : [0, Infinity];
    let items = gear.filter(g =>
      (!section || g.section === section) &&
      (!fCat.value || g.category === fCat.value) &&
      (!fSkill.value || g.skill === fSkill.value) &&
      (!fBrand.value || g.brand === fBrand.value) &&
      g.price >= lo && g.price < hi);
    const sort = fSort.value;
    items.sort((a, b) => sort === 'price-desc' ? b.price - a.price : sort === 'name' ? (a.brand + a.name).localeCompare(b.brand + b.name) : a.price - b.price);
    shown = items;

    const pool = section ? gear.filter(g => g.section === section).length : gear.length;
    count.textContent = items.length === pool ? 'Showing all ' + items.length + ' items' : 'Showing ' + items.length + ' of ' + pool + ' items';
    if (!items.length) {
      grid.innerHTML = '<p class="empty">Nothing matches those filters. Try a wider price range or "All brands".</p>';
      return;
    }
    grid.innerHTML = items.map((g, i) =>
      '<button type="button" class="gear-card" data-i="' + i + '" aria-haspopup="dialog">' +
        '<span class="gear-art">' + art(g.category) + (g.rrp > g.price ? '<span class="sale">Sale</span>' : '') + (g.tested ? '<span class="tested">Tested</span>' : '') + '</span>' +
        '<span class="gear-body">' +
          '<span class="gear-brand">' + esc(g.brand) + ' · ' + esc(g.category) + '</span>' +
          '<span class="gear-name">' + esc(g.name) + '</span>' +
          '<span class="gear-row"><span class="gear-price">' + priceHTML(g) + '</span>' + skillTag(g) + '</span>' +
        '</span>' +
      '</button>').join('');
    grid.querySelectorAll('.gear-card').forEach(b => b.addEventListener('click', () => open(shown[+b.dataset.i])));
  }

  // ---- Detail pop-up ----
  const dialog = $('g-dialog'), detail = $('g-detail');
  function open(g) {
    detail.innerHTML =
      '<button type="button" class="gd-close" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '<div class="gd-art">' + art(g.category) + '</div>' +
      '<div class="gd-text">' +
        '<p class="gear-brand">' + esc(g.brand) + ' · ' + esc(g.category) + '</p>' +
        '<h2 class="gd-name" id="gd-name">' + esc(g.name) + '</h2>' +
        '<p class="gd-price">' + priceHTML(g) + (g.rrp > g.price ? ' <span class="sale">On sale</span>' : '') + ' ' + skillTag(g) + '</p>' +
        (g.our_take ? '<p class="our-take"><strong>Our take:</strong> ' + esc(g.our_take) + '</p>' : '') +
        '<p>' + esc(g.what_it_is) + '</p>' +
        '<dl class="gear-take"><dt>Good for</dt><dd>' + esc(g.good_for) + '</dd><dt>Watch out</dt><dd>' + esc(g.watch_out) + '</dd></dl>' +
        '<a class="btn btn-main" href="' + esc(safeUrl(g.shop_url)) + '" target="_blank" rel="noopener">See it at ' + esc(g.shop) + ' ↗</a>' +
        '<p class="gear-checked">Price checked at ' + esc(g.shop) + (fmtDate(g.checked) ? ' on ' + esc(fmtDate(g.checked)) : '') + '. ' + (g.tested ? 'Tested by us.' : 'Researched, not tested by us.') + '</p>' +
      '</div>';
    detail.querySelector('.gd-close').addEventListener('click', () => dialog.close());
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
  }
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

  // ---- Rider gear / Bike parts / Bikes tabs ----
  function drawTabs() {
    const tabs = $('g-tabs');
    const have = SECTIONS.filter(s => gear.some(g => g.section === s));
    tabs.innerHTML = ['', ...have].map(s =>
      '<button type="button" class="g-tab" data-s="' + esc(s) + '" aria-pressed="' + (s === section) + '">' + (s || 'All gear') + '</button>').join('');
    tabs.querySelectorAll('.g-tab').forEach(b => b.addEventListener('click', () => {
      section = b.dataset.s; drawTabs(); fillCats(); draw();
    }));
  }
  // The "Type" list only shows types in the chosen tab.
  function fillCats() {
    const keep = fCat.value;
    fCat.length = 1;
    const cats = [...new Set(gear.filter(g => !section || g.section === section).map(g => g.category))].sort();
    fill(fCat, cats);
    fCat.value = cats.includes(keep) ? keep : '';
  }

  fetch('gear.csv')
    .then(res => { if (!res.ok) throw new Error(res.status); return res.text(); })
    .then(text => {
      gear = parseCSV(text).filter(g => g.id && g.price_aud !== '' && !isNaN(Number(g.price_aud))).map(g => Object.assign(g, {
        price: Number(g.price_aud), rrp: Number(g.rrp_aud) || 0,
        section: SECTIONS.includes(g.section) ? g.section : 'Rider gear',
        tested: /^(y|yes|true)$/i.test(g.tested || '') }));
      drawTabs(); fillCats();
      fill(fSkill, SKILLS.filter(s => gear.some(g => g.skill === s)));
      fill(fBrand, [...new Set(gear.map(g => g.brand))].sort());
      [fCat, fSkill, fPrice, fBrand, fSort].forEach(el => el.addEventListener('change', draw));
      draw();
    })
    .catch(() => { grid.innerHTML = '<p class="empty">Sorry, the gear list couldn\'t be loaded. Please try again later.</p>'; });
})();
