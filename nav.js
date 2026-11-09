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
