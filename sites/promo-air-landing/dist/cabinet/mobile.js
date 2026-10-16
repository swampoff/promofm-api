/* Progressive mobile controls; no native SDK or backend dependency. */
(() => {
 'use strict';
 const narrow=window.matchMedia('(max-width:700px)');
 const svg=name=>{const shapes={home:'<path d="m3 10 9-7 9 7v10H3zM9 20v-7h6v7"/>',venues:'<path d="M4 10v11h16V10M3 10l2-7h14l2 7M9 21v-7h6v7"/>',playlists:'<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',schedule:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 2v6M17 2v6M3 11h18"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',up:'<path d="m6 15 6-6 6 6"/>'};return '<svg viewBox="0 0 24 24" aria-hidden="true">'+shapes[name]+'</svg>'};
 const tabs=document.createElement('nav');tabs.className='mobile-tabs';tabs.setAttribute('aria-label','Основные разделы');
 tabs.innerHTML=[['home','Главная'],['venues','Заведения'],['playlists','Музыка'],['schedule','Расписание']].map(([id,label])=>'<button type="button" data-page="'+id+'">'+svg(id)+'<span>'+label+'</span></button>').join('')+'<button type="button" id="mobile-more" aria-label="Все разделы" aria-expanded="false">'+svg('more')+'<span>Ещё</span></button>';
 document.body.append(tabs);
 const player=document.querySelector('#player'),toggle=document.createElement('button');toggle.type='button';toggle.className='mobile-player-toggle icon-btn';toggle.innerHTML=svg('up');toggle.setAttribute('aria-controls','player');
 player.append(toggle);
 function expand(on){document.body.classList.toggle('player-expanded',on);toggle.setAttribute('aria-expanded',String(on));toggle.setAttribute('aria-label',on?'Свернуть плеер':'Развернуть плеер')}
 toggle.onclick=()=>expand(!document.body.classList.contains('player-expanded'));expand(false);
 const more=document.querySelector('#mobile-more');more.onclick=()=>{expand(false);document.querySelector('#open-menu').click()};
 function update(){const active=document.querySelector('#nav [aria-current="page"]')?.dataset.page||'home';let found=false;tabs.querySelectorAll('[data-page]').forEach(b=>{const selected=b.dataset.page===active;found ||= selected;if(selected)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});if(found)more.removeAttribute('aria-current');else more.setAttribute('aria-current','page');more.setAttribute('aria-expanded',String(document.body.classList.contains('menu-open')))}
 new MutationObserver(update).observe(document.querySelector('#nav'),{subtree:true,attributes:true,attributeFilter:['aria-current']});
 new MutationObserver(()=>more.setAttribute('aria-expanded',String(document.body.classList.contains('menu-open')))).observe(document.body,{attributes:true,attributeFilter:['class']});
 tabs.addEventListener('click',e=>{if(e.target.closest('[data-page]'))expand(false)});
 document.addEventListener('keydown',e=>{if(e.key==='Escape')expand(false)});
 document.addEventListener('click',e=>{if(document.body.classList.contains('player-expanded')&&!e.target.closest('#player')&&!e.target.closest('dialog'))expand(false)});
 const viewport=window.visualViewport;
 function keyboard(){const editable=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||'');document.body.classList.toggle('keyboard-open',Boolean(narrow.matches&&editable&&viewport&&window.innerHeight-viewport.height>140))}
 viewport?.addEventListener('resize',keyboard);document.addEventListener('focusin',keyboard);document.addEventListener('focusout',()=>setTimeout(keyboard,120));
 narrow.addEventListener('change',()=>{expand(false);keyboard()});
 // Keep drawer keyboard focus inside the open menu on small screens.
 document.addEventListener('keydown',e=>{if(e.key!=='Tab'||!narrow.matches||!document.body.classList.contains('menu-open'))return;const items=[...document.querySelector('#sidebar').querySelectorAll('a[href],button')].filter(x=>!x.disabled&&x.getClientRects().length);const first=items[0],last=items.at(-1);if(!first)return;if(e.shiftKey&&(!items.includes(document.activeElement)||document.activeElement===first)){e.preventDefault();last.focus()}else if(!e.shiftKey&&(!items.includes(document.activeElement)||document.activeElement===last)){e.preventDefault();first.focus()}});
 document.querySelector('#open-menu').addEventListener('click',()=>{if(narrow.matches)document.querySelector('#close-menu').focus()});
 document.querySelector('#close-menu').addEventListener('click',()=>document.querySelector('#open-menu').focus());
 update();
})();
