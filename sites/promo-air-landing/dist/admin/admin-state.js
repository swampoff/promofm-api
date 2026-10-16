/* Pure demo model. No credentials, network calls or production writes. */
(() => {
 'use strict';
 const statuses=['active','pending','attention','offline','blocked','rejected'];
 const plans=['Старт','Бизнес','Сеть','Радио полного цикла'];
 function seed(){return {version:1,venues:[
  {id:'v1',name:'Surf Coffee',city:'Москва',category:'Кофейня',plan:'Бизнес',status:'active',devices:8,music:'Играет',owner:'Анна Смирнова',art:0},
  {id:'v2',name:'PROMO Bar',city:'Москва',category:'Бар',plan:'Сеть',status:'active',devices:12,music:'Играет',owner:'Марк Волков',art:2},
  {id:'v3',name:'Good Mood',city:'Москва',category:'Ресторан',plan:'Бизнес',status:'pending',devices:4,music:'Пауза',owner:'Елена Миронова',art:1},
  {id:'v4',name:'Hotel Chill',city:'Сочи',category:'Отель',plan:'Сеть',status:'active',devices:20,music:'Играет',owner:'Игорь Соколов',art:4},
  {id:'v5',name:'Fit Zone',city:'Санкт-Петербург',category:'Фитнес',plan:'Старт',status:'attention',devices:3,music:'Офлайн',owner:'Ирина Лебедева',art:3},
  {id:'v6',name:'Spa Mia',city:'Казань',category:'СПА',plan:'Бизнес',status:'active',devices:6,music:'Играет',owner:'София Белова',art:5},
  {id:'v7',name:'Sky Lounge',city:'Екатеринбург',category:'Бар',plan:'Бизнес',status:'offline',devices:0,music:'Нет музыки',owner:'Денис Орлов',art:2},
  {id:'v8',name:'Luna Cafe',city:'Москва',category:'Кофейня',plan:'Старт',status:'pending',devices:0,music:'Нет музыки',owner:'Лилия Крылова',art:0},
  {id:'v9',name:'Riverside Bar',city:'Санкт-Петербург',category:'Бар',plan:'Бизнес',status:'pending',devices:0,music:'Нет музыки',owner:'Павел Мартов',art:2},
  {id:'v10',name:'Mint Restaurant',city:'Казань',category:'Ресторан',plan:'Бизнес',status:'pending',devices:0,music:'Нет музыки',owner:'Мила Котова',art:1}
 ],logs:[],messages:[]}}
 function validate(s){return Boolean(s&&s.version===1&&Array.isArray(s.venues)&&s.venues.length<=200&&new Set(s.venues.map(v=>v.id)).size===s.venues.length&&s.venues.every(v=>v&&['id','name','city','category','plan','status','music','owner'].every(k=>typeof v[k]==='string'&&v[k].length<=160)&&statuses.includes(v.status)&&plans.includes(v.plan)&&Number.isInteger(v.art)&&v.art>=0&&v.art<6&&Number.isInteger(v.devices)&&v.devices>=0&&v.devices<=10000)&&Array.isArray(s.logs)&&s.logs.length<=100&&s.logs.every(x=>x&&typeof x.text==='string'&&typeof x.at==='string')&&Array.isArray(s.messages)&&s.messages.length<=100&&s.messages.every(x=>x&&typeof x.venue==='string'&&typeof x.text==='string'))}
 function filter(venues,{query='',status='',city='',plan=''}={}){const q=query.trim().toLocaleLowerCase('ru');return venues.filter(v=>(!q||[v.name,v.city,v.owner,v.category].join(' ').toLocaleLowerCase('ru').includes(q))&&(!status||v.status===status)&&(!city||v.city===city)&&(!plan||v.plan===plan))}
 function transition(venue,action,reason=''){if(!venue)throw Error('Заведение не найдено');if(action==='block'&&venue.status==='blocked')throw Error('Заведение уже заблокировано');if(['approve','reject'].includes(action)&&venue.status!=='pending')throw Error('Заявка уже рассмотрена');if(['reject','block'].includes(action)&&!reason.trim())throw Error('Укажите причину');const next={...venue};if(action==='approve')next.status='active';else if(action==='reject')next.status='rejected';else if(action==='block'){next.previousStatus=venue.status;next.status='blocked'}else if(action==='restore'){if(venue.status!=='blocked')throw Error('Заведение не заблокировано');next.status=statuses.includes(venue.previousStatus)&&venue.previousStatus!=='blocked'?venue.previousStatus:'offline';delete next.previousStatus}else throw Error('Неизвестное действие');return next}
 function totals(payments){return payments.reduce((r,p)=>{if(p.status==='paid')r.paid+=p.amount;if(p.status==='pending')r.pending+=p.amount;if(p.status==='refunded')r.refunded+=p.amount;return r},{paid:0,pending:0,refunded:0})}
 function csvCell(v){let s=String(v??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'}
 globalThis.AdminModel={seed,validate,filter,transition,totals,csvCell,statuses,plans};
})();
