// Mountain Biking SA gear guide.
// All gear lives in gear.csv (edit it like a spreadsheet). This file reads it and draws the cards.

(function () {
  const SKILLS = ['Beginner', 'Intermediate', 'Racer'];
  const SKILL_HELP = {
    Beginner: 'Great first buy',
    Intermediate: 'Riding often, getting faster',
    Racer: 'Racing, downhill or bike parks'
  };

  const $ = id => document.getElementById(id);
  const grid = $('g-grid'), count = $('g-count');
  const fCat = $('g-cat'), fSkill = $('g-skill'), fPrice = $('g-price'), fBrand = $('g-brand'), fSort = $('g-sort');
  let gear = [];

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
    const head = rows.shift().map(h => h.trim());
    return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = u => /^https?:\/\//i.test(u) ? u : '#';
  const money = n => '$' + (Number.isInteger(n) ? n : n.toFixed(2));
  const fmtDate = s => { const [y, m, d] = s.split('-').map(Number); return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(y, m - 1, d)); };

  function fill(select, values) {
    values.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; select.appendChild(o); });
  }

  function draw() {
    const [lo, hi] = fPrice.value ? fPrice.value.split('-').map(Number) : [0, Infinity];
    let items = gear.filter(g =>
      (!fCat.value || g.category === fCat.value) &&
      (!fSkill.value || g.skill === fSkill.value) &&
      (!fBrand.value || g.brand === fBrand.value) &&
      g.price >= lo && g.price < hi);
    const sort = fSort.value;
    items.sort((a, b) => sort === 'price-desc' ? b.price - a.price : sort === 'name' ? (a.brand + a.name).localeCompare(b.brand + b.name) : a.price - b.price);

    count.textContent = items.length === gear.length ? 'Showing all ' + items.length + ' items' : 'Showing ' + items.length + ' of ' + gear.length + ' items';
    if (!items.length) {
      grid.innerHTML = '<p class="empty">Nothing matches those filters. Try a wider price range or "All brands".</p>';
      return;
    }
    grid.innerHTML = items.map(g =>
      '<article class="gear-card">' +
        '<div class="gear-top">' +
          '<span class="gear-cat">' + esc(g.category) + '</span>' +
          '<span class="skill skill-' + esc(g.skill.toLowerCase()) + '" title="' + esc(SKILL_HELP[g.skill] || '') + '">' + esc(g.skill) + '</span>' +
        '</div>' +
        '<p class="gear-brand">' + esc(g.brand) + '</p>' +
        '<h2 class="gear-name">' + esc(g.name) + '</h2>' +
        '<p class="gear-price">' + money(g.price) +
          (g.rrp > g.price ? ' <s>' + money(g.rrp) + '</s> <span class="sale">on sale</span>' : '') + '</p>' +
        '<p class="gear-what">' + esc(g.what_it_is) + '</p>' +
        '<dl class="gear-take">' +
          '<dt>Good for</dt><dd>' + esc(g.good_for) + '</dd>' +
          '<dt>Watch out</dt><dd>' + esc(g.watch_out) + '</dd>' +
        '</dl>' +
        '<div class="gear-foot">' +
          '<a class="btn btn-main" href="' + esc(safeUrl(g.shop_url)) + '" target="_blank" rel="noopener">See at ' + esc(g.shop) + ' ↗</a>' +
          '<span class="gear-checked">Price checked ' + esc(fmtDate(g.checked)) + '</span>' +
        '</div>' +
      '</article>').join('');
  }

  fetch('gear.csv')
    .then(res => { if (!res.ok) throw new Error(res.status); return res.text(); })
    .then(text => {
      gear = parseCSV(text).filter(g => g.id).map(g => Object.assign(g, { price: Number(g.price_aud), rrp: Number(g.rrp_aud) || 0 }));
      fill(fCat, [...new Set(gear.map(g => g.category))].sort());
      fill(fSkill, SKILLS.filter(s => gear.some(g => g.skill === s)));
      fill(fBrand, [...new Set(gear.map(g => g.brand))].sort());
      [fCat, fSkill, fPrice, fBrand, fSort].forEach(el => el.addEventListener('change', draw));
      draw();
    })
    .catch(() => { grid.innerHTML = '<p class="empty">Sorry, the gear list couldn\'t be loaded. Please try again later.</p>'; });
})();
