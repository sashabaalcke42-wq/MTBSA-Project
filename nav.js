// Opens and closes the menu on phones.
(function () {
  const btn = document.querySelector('.menu-btn');
  const header = document.querySelector('.site-header');
  if (!btn || !header) return;
  btn.addEventListener('click', () => {
    const open = header.classList.toggle('nav-open');
    btn.setAttribute('aria-expanded', open);
  });
  const close = () => { header.classList.remove('nav-open'); btn.setAttribute('aria-expanded', false); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.addEventListener('click', e => { if (!header.contains(e.target)) close(); });
})();

// "Back to top" button. It only shows on long pages, once you've scrolled down a bit.
(function () {
  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'to-top';
  up.setAttribute('aria-label', 'Back to top');
  up.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
  document.body.appendChild(up);
  const check = () => up.classList.toggle('show', window.scrollY > window.innerHeight * 1.2);
  window.addEventListener('scroll', check, { passive: true });
  check();
  up.addEventListener('click', () => {
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' });
  });
})();
