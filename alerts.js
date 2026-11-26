// Race alerts: notifications on phones and computers, plus the calendar feed.
//
// Any button with data-alerts opens the Race alerts panel. Any button with
// data-follow="<race id>" turns on a reminder for that one race (race pages).
// Alerts are free web push: the browser gives us an address to send to, the
// address is saved by functions/api/alerts, and the daily site check sends
// the alerts each morning. No names, emails or accounts.
//
// iPhone and iPad only allow this once the site is added to the Home Screen
// (Apple's rule), so the panel walks people through that and offers the
// calendar feed as the other option.

(function () {
  const API = '/api/alerts/';
  const STORE = 'mtbsa-alerts';
  const WEEK = 7 * 864e5;
  const DEFAULTS = { open: true, close: false, new: true };

  const canPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

  let publicKey = null;   // null while loading, false when alerts aren't set up on the server
  let state = read();     // { topics, races, endpoint, checked } when alerts are on here

  function read() { try { return JSON.parse(localStorage.getItem(STORE)) || null; } catch (e) { return null; } }
  function write(s) {
    state = s;
    try { s ? localStorage.setItem(STORE, JSON.stringify(s)) : localStorage.removeItem(STORE); } catch (e) { /* private mode */ }
    refresh();
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = (path, body) => fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  function keyBytes(b64) {
    const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  }
  const anyOn = c => c.races.length > 0 || Object.values(c.topics).some(Boolean);
  const pushReady = () => canPush && !!publicKey && !(iOS && !installed);

  async function getSubscription(create) {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    return sub;
  }

  // Saves what this device wants. Must be called straight from a tap, because
  // browsers only show the "Allow notifications?" question after a tap.
  async function save(choices) {
    if (!anyOn(choices)) {
      const sub = canPush && await getSubscription(false).catch(() => null);
      if (sub) { await post('unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
      write(null);
      return 'off';
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(permission === 'denied' ? 'blocked' : 'dismissed');
    const sub = await getSubscription(true);
    const res = await post('subscribe', { subscription: sub.toJSON(), topics: choices.topics, races: choices.races });
    if (!res.ok) throw new Error('server');
    write({ topics: choices.topics, races: choices.races, endpoint: sub.endpoint, checked: Date.now() });
    return 'on';
  }

  function problem(e) {
    const m = e && e.message;
    if (m === 'blocked') return 'Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.';
    if (m === 'dismissed') return 'No worries. Tap the button again whenever you want alerts.';
    return 'Sorry, that didn\'t work. Please try again in a minute.';
  }

  // Keeps this device signed up if the browser quietly swapped its address,
  // and checks once a week that the server still has it.
  async function keepFresh() {
    if (!state || !pushReady()) return;
    if (Notification.permission !== 'granted') { write(null); return; }
    try {
      const sub = await getSubscription(true);
      let resend = sub.endpoint !== state.endpoint;
      if (!resend && Date.now() - (state.checked || 0) > WEEK) {
        const res = await post('me', { endpoint: sub.endpoint });
        resend = res.status === 404;
        if (res.ok) write(Object.assign({}, state, { checked: Date.now() }));
      }
      if (resend) {
        const res = await post('subscribe', { subscription: sub.toJSON(), topics: state.topics, races: state.races });
        if (res.ok) write(Object.assign({}, state, { endpoint: sub.endpoint, checked: Date.now() }));
      }
    } catch (e) { /* try again next visit */ }
  }

  // ---- Panel ----
  let dialog;
  function feedLinks() {
    const feed = location.host + '/api/calendar';
    return '<h3>Or add every race to your calendar</h3>' +
      '<p class="muted small">Subscribe once and every race, plus the days entries open and close, shows up in your calendar app. ' +
      'New races and date changes appear by themselves. This works on every phone, iPhone included.</p>' +
      '<div class="alerts-cal">' +
        '<a class="btn btn-small" href="webcal://' + esc(feed) + '">iPhone, Mac or Outlook</a>' +
        '<a class="btn btn-small" href="https://calendar.google.com/calendar/render?cid=' + encodeURIComponent('webcal://' + feed) + '" target="_blank" rel="noopener">Google Calendar</a>' +
        '<button type="button" class="link-btn" data-copy="https://' + esc(feed) + '">Copy the link</button>' +
      '</div>';
  }

  function pushSection() {
    if (publicKey === false) return '';
    if (publicKey === null) return '<p class="muted small">Loading…</p>';
    if (iOS && !installed) {
      return '<div class="callout"><p><strong>On iPhone or iPad, add this site to your Home Screen first.</strong> ' +
        'Apple only allows website alerts from Home Screen apps.</p>' +
        '<ol class="alerts-steps"><li>Tap the <strong>Share</strong> button (the square with an arrow) at the bottom or top of Safari.</li>' +
        '<li>Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>' +
        '<li>Open <strong>MTB SA</strong> from the new icon, and tap <strong>Race alerts</strong> again.</li></ol>' +
        '<p class="muted small">Needs iOS 16.4 or newer. Not keen? The calendar option below works straight away.</p></div>';
    }
    if (!canPush) return '<p class="callout">This browser can\'t show website alerts. Try Chrome, Edge, Firefox or Safari, or use the calendar option below.</p>';
    const t = (state && state.topics) || DEFAULTS;
    const box = (k, label, help) => '<label class="alerts-opt"><input type="checkbox" name="' + k + '"' + (t[k] ? ' checked' : '') + '>' +
      '<span><strong>' + label + '</strong><small>' + help + '</small></span></label>';
    const followed = state && state.races.length
      ? '<p class="muted small">You\'ll also get reminders for ' + state.races.length + ' race' + (state.races.length > 1 ? 's' : '') +
        ' you picked on race pages.</p>' : '';
    return '<p class="muted">Get a notification on this ' + (/Mobi|Android/.test(navigator.userAgent) ? 'phone' : 'device') +
      '. Free, no sign-up, and you can turn it off any time.</p>' +
      '<fieldset class="alerts-opts" aria-label="What to send">' +
      box('open', 'Entries open today', 'On the morning entries open for any race on the calendar.') +
      box('close', 'Entries close tomorrow', 'A last-chance reminder the day before entries close.') +
      box('new', 'New race added', 'When a new race goes on the calendar.') +
      '</fieldset>' + followed +
      '<div class="actions"><button type="button" class="btn btn-main" data-save>' + (state ? 'Save' : 'Turn on alerts') + '</button>' +
      (state ? '<button type="button" class="btn" data-off>Turn off alerts</button>' : '') + '</div>' +
      '<p class="alerts-msg" aria-live="polite"></p>' +
      '<p class="muted small">Alerts go out once a day, around 8 AM Adelaide time. Entry times vary, so check the entry page.</p>';
  }

  function drawPanel() {
    dialog.innerHTML = '<div class="alerts-panel"><button type="button" class="alerts-x" data-close aria-label="Close">×</button>' +
      '<h2>Race alerts</h2>' + pushSection() + feedLinks() + '</div>';
  }

  function openPanel() {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'alerts-dialog';
      dialog.setAttribute('aria-label', 'Race alerts');
      document.body.appendChild(dialog);
      dialog.addEventListener('click', onPanelClick);
    }
    drawPanel();
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
  }

  async function onPanelClick(e) {
    if (e.target === dialog || e.target.closest('[data-close]')) { dialog.close ? dialog.close() : dialog.removeAttribute('open'); return; }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); copy.textContent = 'Copied'; }
      catch (err) { copy.textContent = copy.dataset.copy; }
      return;
    }
    const btn = e.target.closest('[data-save], [data-off]');
    if (!btn) return;
    const msg = dialog.querySelector('.alerts-msg');
    const topics = {};
    dialog.querySelectorAll('.alerts-opts input').forEach(i => { topics[i.name] = btn.hasAttribute('data-off') ? false : i.checked; });
    const races = btn.hasAttribute('data-off') ? [] : ((state && state.races) || []);
    btn.disabled = true;
    try {
      const done = await save({ topics, races });
      drawPanel();
      dialog.querySelector('.alerts-msg').textContent = done === 'off' ? 'Alerts are off on this device.' : 'Done. Alerts are on for this device.';
      if (window.siteStat) window.siteStat(done === 'off' ? 'alerts_off' : 'alerts_on', topics);
    } catch (err) {
      btn.disabled = false;
      msg.textContent = problem(err);
    }
  }

  // ---- Race page reminder buttons ----
  function refresh() {
    document.querySelectorAll('[data-follow]').forEach(b => {
      b.hidden = publicKey === null || publicKey === false;
      const on = !!(state && state.races.includes(b.dataset.follow));
      b.setAttribute('aria-pressed', on);
      b.textContent = on ? 'Reminder on' : (b.dataset.label || 'Remind me');
      b.classList.toggle('ic-after', on); b.classList.toggle('ic-check', on);
    });
  }

  async function onFollow(b) {
    const id = b.dataset.follow;
    if (!pushReady()) { openPanel(); return; }
    const cur = state || { topics: { open: false, close: false, new: false }, races: [] };
    const races = cur.races.includes(id) ? cur.races.filter(r => r !== id) : cur.races.concat(id);
    const note = document.getElementById('follow-msg');
    b.disabled = true;
    try {
      const done = await save({ topics: cur.topics, races });
      if (note) note.textContent = races.includes(id)
        ? 'Reminder on. You\'ll get a notification the morning entries open and the day before they close.'
        : (done === 'off' ? 'Reminder off.' : 'Reminder off for this race.');
      if (window.siteStat) window.siteStat(races.includes(id) ? 'race_followed' : 'race_unfollowed', { race_id: id });
    } catch (err) {
      if (note) note.textContent = problem(err);
    }
    b.disabled = false;
    refresh();
  }

  document.addEventListener('click', e => {
    const open = e.target.closest('[data-alerts]');
    if (open) { e.preventDefault(); openPanel(); return; }
    const follow = e.target.closest('[data-follow]');
    if (follow) { e.preventDefault(); onFollow(follow); }
  });

  fetch(API + 'key')
    .then(r => r.ok ? r.json() : null)
    .then(j => { publicKey = (j && j.publicKey) || false; })
    .catch(() => { publicKey = false; })
    .then(() => { refresh(); if (dialog && dialog.open) drawPanel(); keepFresh(); });

  window.RaceAlerts = { refresh, open: openPanel };
})();
