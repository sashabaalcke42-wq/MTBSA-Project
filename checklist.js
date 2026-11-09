// Race-day checklist: counts ticks and remembers them on this device.
(function () {
  const KEY = 'mtbsa-checklist';
  const boxes = [...document.querySelectorAll('.cl input[type=checkbox]')];
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { saved = []; }
  boxes.forEach((b, i) => { b.checked = !!saved[i]; });

  function update() {
    const done = boxes.filter(b => b.checked).length;
    document.getElementById('cl-done').textContent = done;
    document.getElementById('cl-fill').style.width = (boxes.length ? done / boxes.length * 100 : 0) + '%';
    document.querySelector('.cl-progress').classList.toggle('all-done', done === boxes.length);
    document.querySelectorAll('.cl-group').forEach(g => {
      const bs = [...g.querySelectorAll('input[type=checkbox]')];
      const n = bs.filter(b => b.checked).length;
      g.querySelector('.cl-count').textContent = n + '/' + bs.length;
      g.classList.toggle('done', n === bs.length);
    });
    try { localStorage.setItem(KEY, JSON.stringify(boxes.map(b => b.checked))); } catch (e) { /* private mode: ticks just won't be saved */ }
  }
  boxes.forEach(b => b.addEventListener('change', update));
  document.getElementById('cl-reset').addEventListener('click', () => { boxes.forEach(b => { b.checked = false; }); update(); });
  update();
})();
