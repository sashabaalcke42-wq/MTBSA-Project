// Race-day weather and fire danger for the calendar.
//
// Everything here is free and needs no account or key:
// - Weather: Open-Meteo (open-meteo.com), a free forecast service. It gives up to 16 days ahead.
// - Fire danger ratings and total fire bans: the SA CFS map service, which is filled from the
//   Bureau of Meteorology's SA fire danger forecast. It gives the next 4 days.
//
// The visitor's browser asks for this directly, so nothing has to run on a server.
// If the CFS feed can't be reached from the browser, it tries functions/api/fire-danger.js
// (a tiny free Cloudflare Pages helper that fetches the same feed).
//
// Where each race is: the VENUES list below matches words in the race's venue, and REGIONS is
// the backup for the region column. To pin a race exactly, add lat, lon and fire_district
// columns to races.csv and they win over these lists.

(function () {
  // The web addresses are split like 'https:' + '//...' so the daily link check doesn't
  // try to open them as normal pages (they only work with the extra bits added below).
  const METEO = 'https:' + '//api.open-meteo.com/v1/forecast';
  const CFS = 'https:' + '//cfs.geohub.sa.gov.au/server/rest/services/CFS_Custodial_Read/South_Australia_Fire_Danger_Ratings_Read/MapServer/1/query';
  const CFS_HELPER = 'api/fire-danger';
  const CFS_PAGE = 'https://www.cfs.sa.gov.au/firebans';
  const BOM_PAGE = 'https://www.bom.gov.au/sa/';
  const WEATHER_DAYS = 16;   // Open-Meteo forecast length
  const KEEP_MINUTES = 30;   // how long to reuse a forecast before asking again

  // Words in the venue name -> where it is and which CFS fire ban district it's in.
  const VENUES = [
    { match: /eagle/i, lat: -34.982, lon: 138.676, district: 'Mount Lofty Ranges' },
    { match: /fox creek|cudlee/i, lat: -34.853, lon: 138.806, district: 'Mount Lofty Ranges' },
    { match: /dazzleland|mt torrens|mount torrens/i, lat: -34.874, lon: 138.957, district: 'Mount Lofty Ranges' },
    { match: /shepherds hill/i, lat: -35.010, lon: 138.600, district: 'Adelaide Metropolitan' },
    { match: /o'?halloran/i, lat: -35.060, lon: 138.556, district: 'Adelaide Metropolitan' },
    { match: /sturt gorge|craigburn/i, lat: -35.033, lon: 138.616, district: 'Adelaide Metropolitan' },
    { match: /willunga/i, lat: -35.285, lon: 138.570, district: 'Mount Lofty Ranges' },
    { match: /angaston/i, lat: -34.502, lon: 139.046, district: 'Mount Lofty Ranges' },
    { match: /kinchina|murray bridge/i, lat: -35.100, lon: 139.330, district: 'Murraylands' },
    { match: /mount gambier|mt gambier|wheelnutz/i, lat: -37.829, lon: 140.783, district: 'Lower South East' },
    { match: /melrose/i, lat: -32.826, lon: 138.190, district: 'Flinders' }
  ];
  const REGIONS = {
    'adelaide hills': { lat: -34.95, lon: 138.75, district: 'Mount Lofty Ranges' },
    'adelaide': { lat: -34.93, lon: 138.60, district: 'Adelaide Metropolitan' },
    'fleurieu': { lat: -35.40, lon: 138.60, district: 'Mount Lofty Ranges' },
    'barossa': { lat: -34.53, lon: 138.95, district: 'Mount Lofty Ranges' },
    'murraylands': { lat: -35.12, lon: 139.27, district: 'Murraylands' },
    'limestone coast': { lat: -37.83, lon: 140.78, district: 'Lower South East' },
    'riverland': { lat: -34.18, lon: 140.75, district: 'Riverland' },
    'mid north': { lat: -33.83, lon: 138.61, district: 'Mid North' },
    'flinders ranges': { lat: -32.83, lon: 138.19, district: 'Flinders' },
    'yorke peninsula': { lat: -34.45, lon: 137.70, district: 'Yorke Peninsula' },
    'kangaroo island': { lat: -35.75, lon: 137.60, district: 'Kangaroo Island' },
    'eyre peninsula': { lat: -34.72, lon: 135.86, district: 'Lower Eyre Peninsula' }
  };

  // ---- Small helpers ----
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const isoOf = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  // Today in Adelaide, whatever time zone the visitor's phone is in.
  const adelaideToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Adelaide' }).format(new Date());
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
  const fmtDay = new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'short' });

  function raceDays(r) {
    const out = [], end = r.end_date || r.date;
    for (let d = toDate(r.date); isoOf(d) <= end && out.length < 10; d.setDate(d.getDate() + 1)) out.push(isoOf(d));
    return out;
  }

  // Where a race is, or null if we can't tell (interstate, or "venue on the entry page" with no region).
  function placeFor(r) {
    const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
    const v = VENUES.find(x => x.match.test(r.venue || '')) || REGIONS[String(r.region || '').toLowerCase()] || null;
    if (!isNaN(lat) && !isNaN(lon)) return { lat, lon, district: r.fire_district || (v && v.district) || '' };
    if (!v) return null;
    return { lat: v.lat, lon: v.lon, district: r.fire_district || v.district };
  }

  // ---- Saving answers for a while, so flicking between races doesn't ask again ----
  function remember(key, value) { try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), value })); } catch (e) { /* private mode */ } }
  function recall(key) {
    try {
      const s = JSON.parse(sessionStorage.getItem(key));
      if (s && Date.now() - s.t < KEEP_MINUTES * 60000) return s.value;
    } catch (e) { /* nothing saved */ }
    return undefined;
  }
  const pending = {};
  function once(key, make) {
    const saved = recall(key);
    if (saved !== undefined) return Promise.resolve(saved);
    if (!pending[key]) pending[key] = make().then(v => { remember(key, v); return v; }).finally(() => { delete pending[key]; });
    return pending[key];
  }
  const getJSON = url => fetch(url).then(res => { if (!res.ok) throw new Error(res.status); return res.json(); });

  // ---- Weather (Open-Meteo) ----
  // One request covers every place we need, so the list can show weather without lots of requests.
  function getWeather(places) {
    const uniq = [...new Set(places.map(p => p.lat.toFixed(3) + ',' + p.lon.toFixed(3)))];
    if (!uniq.length) return Promise.resolve({});
    const key = 'mtbsa-wx:' + uniq.join(';');
    return once(key, () => {
      const q = new URLSearchParams({
        latitude: uniq.map(u => u.split(',')[0]).join(','),
        longitude: uniq.map(u => u.split(',')[1]).join(','),
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max',
        timezone: 'Australia/Adelaide',
        forecast_days: String(WEATHER_DAYS)
      });
      return getJSON(METEO + '?' + q).then(data => {
        const list = Array.isArray(data) ? data : [data];
        const out = {};
        list.forEach((loc, i) => {
          const d = loc.daily, byDay = {};
          d.time.forEach((t, j) => {
            byDay[t] = {
              code: d.weather_code[j], hi: d.temperature_2m_max[j], lo: d.temperature_2m_min[j],
              rainChance: d.precipitation_probability_max[j], rain: d.precipitation_sum[j],
              wind: d.wind_speed_10m_max[j], gust: d.wind_gusts_10m_max[j]
            };
          });
          out[uniq[i]] = byDay;
        });
        return out;
      });
    }).then(all => place => all[place.lat.toFixed(3) + ',' + place.lon.toFixed(3)] || {});
  }

  // WMO weather codes -> plain words and an emoji.
  function describe(code) {
    if (code === 0) return ['☀️', 'Sunny'];
    if (code === 1) return ['🌤️', 'Mostly sunny'];
    if (code === 2) return ['⛅', 'Partly cloudy'];
    if (code === 3) return ['☁️', 'Cloudy'];
    if (code === 45 || code === 48) return ['🌫️', 'Foggy'];
    if (code >= 51 && code <= 57) return ['🌦️', 'Drizzle'];
    if (code === 61 || code === 80) return ['🌦️', 'Light showers'];
    if (code === 63 || code === 81) return ['🌧️', 'Rain'];
    if (code === 65 || code === 82 || code === 66 || code === 67) return ['🌧️', 'Heavy rain'];
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ['🌨️', 'Snow or sleet'];
    if (code >= 95) return ['⛈️', 'Storms'];
    return ['🌡️', 'Mixed'];
  }

  // ---- Fire danger and total fire bans (CFS / BoM) ----
  const dmy = s => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || ''); return m ? m[3] + '-' + pad(m[2]) + '-' + pad(m[1]) : ''; };
  function readFire(data) {
    const out = {};
    (data.features || []).forEach(f => {
      const a = f.attributes || {}, name = String(a.firebandistrict || '').trim().toLowerCase();
      if (!name) return;
      const days = {};
      for (let i = 0; i <= 4; i++) {
        const day = dmy(a['ratingdate_' + i]);
        if (!day) continue;
        const now = { rating: a['firedangerrating_' + i] || 'No Rating', ban: /^y/i.test(a['tfb' + i] || '') };
        // The feed sometimes lists today twice. Keep the worse rating and any fire ban.
        const had = days[day];
        if (had) { now.ban = now.ban || had.ban; if (RANK.indexOf(ratingKey(had.rating)) > RANK.indexOf(ratingKey(now.rating))) now.rating = had.rating; }
        days[day] = now;
      }
      out[name] = days;
    });
    if (!Object.keys(out).length) throw new Error('empty');
    return out;
  }
  function getFire() {
    return once('mtbsa-fire', () => {
      const fields = ['firebandistrict'];
      for (let i = 0; i <= 4; i++) fields.push('ratingdate_' + i, 'firedangerrating_' + i, 'tfb' + i);
      const q = new URLSearchParams({ where: '1=1', outFields: fields.join(','), returnGeometry: 'false', f: 'json' });
      return getJSON(CFS + '?' + q).then(readFire)
        .catch(() => getJSON(CFS_HELPER).then(readFire));
    });
  }

  // Fire danger rating colours follow the national system (green, yellow, orange, red).
  const RANK = ['no', 'moderate', 'high', 'extreme', 'catastrophic'];
  const RATING_CLASS = { moderate: 'fdr-moderate', high: 'fdr-high', extreme: 'fdr-extreme', catastrophic: 'fdr-catastrophic' };
  const ratingKey = s => String(s || '').toLowerCase().split(' ')[0];
  const isBad = f => f && (f.ban || ['extreme', 'catastrophic'].includes(ratingKey(f.rating)));

  // ---- Race page panel ----
  function fill(box, r) {
    if (!box) return;
    const place = placeFor(r);
    const today = adelaideToday();
    const days = raceDays(r).filter(d => d >= today);
    if (!days.length) { box.hidden = true; return; }
    const away = daysBetween(today, days[0]);

    if (!place) {
      box.innerHTML = head() + '<p class="muted">We don\'t know exactly where this one is, so check the forecast and fire bans for the venue on the entry page.</p>' + links();
      return;
    }
    if (away >= WEATHER_DAYS) {
      box.innerHTML = head() +
        '<p>The weather forecast shows up here about two weeks before race day, and fire danger ratings about four days before. Check back closer to the date.</p>' +
        links(place.district);
      return;
    }
    box.innerHTML = head() + '<p class="muted small">Loading the forecast…</p>';

    Promise.all([
      getWeather([place]).then(pick => pick(place)).catch(() => null),
      place.district ? getFire().then(all => all[place.district.toLowerCase()] || {}).catch(() => null) : Promise.resolve(null)
    ]).then(([wx, fire]) => {
      let html = head();
      // Big alert first if any race day has a fire ban or extreme danger.
      const banned = fire && days.filter(d => fire[d] && fire[d].ban);
      const scary = fire && days.filter(d => fire[d] && !fire[d].ban && isBad(fire[d]));
      if (banned && banned.length) {
        html += '<div class="cond-alert ban" role="alert"><b>🔥 Total fire ban</b> declared for the ' + esc(place.district) + ' district on ' +
          banned.map(d => esc(fmtDay.format(toDate(d)))).join(' and ') +
          '. Parks and forests often close on fire ban days and races can be called off, so check with the organiser before you go.</div>';
      } else if (scary && scary.length) {
        html += '<div class="cond-alert" role="alert"><b>⚠️ ' + esc(fire[scary[0]].rating) + ' fire danger</b> in the ' + esc(place.district) +
          ' district. Some parks close on these days and the race could change, so check with the organiser before you go.</div>';
      }

      html += '<div class="cond-days">' + days.map(d => {
        const w = wx && wx[d], f = fire && fire[d];
        let card = '<div class="cond-day"><p class="cond-date">' + esc(fmtDay.format(toDate(d))) + '</p>';
        if (w) {
          const [icon, words] = describe(w.code);
          card += '<p class="cond-main"><span class="cond-icon" aria-hidden="true">' + icon + '</span> <span><b>' + esc(words) + '</b><br>' +
            Math.round(w.hi) + '° top, ' + Math.round(w.lo) + '° low</span></p>' +
            '<ul class="cond-facts">' +
              '<li>Rain: ' + (w.rainChance == null ? '?' : w.rainChance) + '% chance' + (w.rain >= 0.5 ? ', about ' + Math.round(w.rain) + ' mm' : '') + '</li>' +
              '<li>Wind: up to ' + Math.round(w.wind) + ' km/h, gusts ' + Math.round(w.gust) + '</li>' +
            '</ul>';
        } else if (wx) {
          card += '<p class="muted small">No forecast for this day yet.</p>';
        } else {
          card += '<p class="muted small">The weather forecast couldn\'t load right now.</p>';
        }
        if (place.district) {
          if (f) {
            card += '<p class="fdr ' + (RATING_CLASS[ratingKey(f.rating)] || 'fdr-none') + '">Fire danger: <b>' + esc(f.rating) + '</b>' +
              (f.ban ? ' · <b>Total fire ban</b>' : '') + '</p>';
          } else if (fire) {
            card += '<p class="fdr fdr-none">Fire danger rating comes out about 4 days before.</p>';
          } else {
            card += '<p class="fdr fdr-none">Fire danger couldn\'t load right now. <a href="' + CFS_PAGE + '" target="_blank" rel="noopener">Check the CFS</a>.</p>';
          }
        }
        return card + '</div>';
      }).join('') + '</div>';

      if (away > 7) html += '<p class="muted small">Race day is still more than a week away, so this will probably change.</p>';
      html += links(place.district);
      box.innerHTML = html;
    });
  }

  function head() { return '<h2>Race-day weather and fire danger</h2>'; }
  function links(district) {
    return '<p class="cond-links small">' +
      (district ? 'Fire ban district: <b>' + esc(district) + '</b> · ' : '') +
      '<a href="' + CFS_PAGE + '" target="_blank" rel="noopener">CFS fire bans and ratings ↗</a> · ' +
      '<a href="' + BOM_PAGE + '" target="_blank" rel="noopener">BoM forecast ↗</a></p>' +
      '<p class="muted small">A guide only: always check the CFS and the organiser on the day. Weather by <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0). Fire danger from the SA CFS and the Bureau of Meteorology.</p>';
  }

  // ---- Little chips in the race list ----
  // Finds every element with data-cond="<race id>" and fills in a weather or fire chip
  // for races in the next two weeks.
  function chips(root, races) {
    if (!root) return;
    const today = adelaideToday();
    const want = [];
    root.querySelectorAll('[data-cond]').forEach(el => {
      const r = races.find(x => x.id === el.dataset.cond);
      if (!r) return;
      const day = raceDays(r).find(d => d >= today);
      const place = placeFor(r);
      if (day && place && daysBetween(today, day) < WEATHER_DAYS) want.push({ el, day, place });
    });
    if (!want.length) return;
    const needFire = want.some(w => w.place.district && daysBetween(today, w.day) <= 4);
    Promise.all([
      getWeather(want.map(w => w.place)).catch(() => null),
      needFire ? getFire().catch(() => null) : Promise.resolve(null)
    ]).then(([pick, fire]) => {
      want.forEach(({ el, day, place }) => {
        if (!el.isConnected) return;
        const f = fire && place.district && (fire[place.district.toLowerCase()] || {})[day];
        const w = pick && pick(place)[day];
        let html = '';
        if (w) { const [icon, words] = describe(w.code); html += '<span class="wx-chip" title="' + esc(words) + '">' + icon + ' ' + Math.round(w.hi) + '°</span>'; }
        if (f && f.ban) html += '<span class="wx-chip fire ban">🔥 Fire ban</span>';
        else if (isBad(f)) html += '<span class="wx-chip fire">⚠️ ' + esc(f.rating) + ' fire danger</span>';
        el.innerHTML = html;
      });
    });
  }

  window.RaceWeather = { fill, chips, placeFor };
})();
