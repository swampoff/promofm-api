(() => {
 'use strict';
 document.querySelectorAll('.pricing-section').forEach(section => {
  section.querySelectorAll('[data-billing]').forEach(button => {
   button.onclick = () => {
    const annual = button.dataset.billing === 'year';
    section.querySelectorAll('[data-billing]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    section.querySelectorAll('.price strong').forEach(el => el.textContent = Number(el.dataset[annual ? 'year' : 'month']).toLocaleString('ru-RU'));
    section.querySelectorAll('.price-period').forEach(el => el.textContent = annual ? 'за год, оплата одним платежом' : 'за месяц');
   };
  });
 });
 document.querySelectorAll('.swipe-track').forEach(track => {
  const note = document.createElement('p');
  note.className = 'swipe-position';
  note.textContent = 'Листайте · 1 / ' + track.children.length;
  track.after(note);
  let tick = false;
  track.addEventListener('scroll', () => {
   if (tick) return;
   tick = true;
   requestAnimationFrame(() => {
    const left = track.getBoundingClientRect().left;
    let best = 0, distance = Infinity;
    [...track.children].forEach((card, i) => {
     const d = Math.abs(card.getBoundingClientRect().left - left);
     if (d < distance) { distance = d; best = i; }
    });
    note.textContent = 'Листайте · ' + (best + 1) + ' / ' + track.children.length;
    tick = false;
   });
  }, {passive: true});
  track.addEventListener('keydown', e => {
   if (e.target !== track || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
   e.preventDefault();
   track.scrollBy({left: (e.key === 'ArrowRight' ? 1 : -1) * (track.firstElementChild.getBoundingClientRect().width + 16), behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth'});
  });
 });
})();
