"use client";

import { useMemo, useRef, useState } from "react";

const loginUrl = "https://promo-music.ru/login";
const audioUrl =
  "https://promo-air-vinyl.fairbetta16.chatgpt.site/assets/preview-0.wav";

const characters = [
  {
    name: "Nico",
    mood: "Morning Soul",
    role: "Музыкальный куратор",
    story:
      "Нико задаёт характер звучания. Соул, солнечный грув и музыка, с которой хочется остаться.",
  },
  {
    name: "Sandra",
    mood: "Sunset Lounge",
    role: "Кофейни",
    story:
      "Бирюзовые наушники, аромат кофе и солнечное настроение. Сандра выбирает музыку для тёплых встреч.",
  },
  {
    name: "Leo",
    mood: "Night Groove",
    role: "Бары",
    story:
      "Лавандовый винил, хром и вечерний фанк. Лео знает, когда добавить ритма.",
  },
  {
    name: "Mia",
    mood: "Soft Motion",
    role: "Wellness",
    story:
      "Мятные оттенки, мягкий свет и спокойствие. Миа помогает замедлиться и восстановить силы.",
  },
];

const venues = [
  {
    tab: "Кофейни",
    title: "Пахнет кофе. Звучит прекрасно.",
    copy: "Мягкий соул, немного джаза и лёгкий грув. Музыка для неспешных разговоров и ещё одной чашки.",
    genre: "Soul / Jazz / Bossa Nova",
    color: "#fff1d9",
  },
  {
    tab: "Рестораны",
    title: "Вкус начинается с атмосферы.",
    copy: "Тёплый лаунж, живая акустика и деликатный ритм — от первого блюда до долгого десерта.",
    genre: "Lounge / Acoustic / Nu Jazz",
    color: "#ffe2d0",
  },
  {
    tab: "Бары",
    title: "Когда вечер набирает ритм.",
    copy: "Фанк, диско и электроника для ярких встреч, фирменных коктейлей и ночей, которые хочется продлить.",
    genre: "Funk / Disco / Indie Dance",
    color: "#e6d9f5",
  },
  {
    tab: "Магазины",
    title: "Музыка, которая помогает выбирать.",
    copy: "Современный поп и лёгкая электроника поддерживают темп пространства и характер коллекции.",
    genre: "Pop / Indie / Electronic",
    color: "#d8f2ff",
  },
  {
    tab: "Отели",
    title: "Гостеприимство слышно сразу.",
    copy: "Спокойное, цельное звучание для лобби, номеров, ресторана и каждой точки контакта с гостем.",
    genre: "Chillout / Ambient / Soul",
    color: "#e0f4e7",
  },
  {
    tab: "Фитнес и SPA",
    title: "Энергия и баланс в одном эфире.",
    copy: "От бодрого старта тренировки до мягкого восстановления — отдельное настроение для каждой зоны.",
    genre: "Workout / Downtempo / Ambient",
    color: "#d9f3fb",
  },
];

const dayParts = [
  { time: "09:00", title: "Morning Soul", copy: "Мягкое начало большого дня.", world: 0 },
  { time: "13:00", title: "Lunch Lounge", copy: "Лёгкий ритм для обеда и встреч.", world: 1 },
  { time: "18:00", title: "Sunset Groove", copy: "Теплее свет, насыщеннее звук.", world: 2 },
  { time: "22:00", title: "Night Disco", copy: "Когда пространство живёт на полную.", world: 3 },
];

const prices = [
  {
    kicker: "Для одного заведения",
    name: "Старт",
    monthly: 4990,
    points: ["1 точка", "Базовая библиотека", "Базовая аналитика", "Email-поддержка"],
  },
  {
    kicker: "Музыка и голос бренда",
    name: "Бизнес",
    monthly: 9990,
    featured: true,
    points: ["1 точка", "Расписание по часам", "Брендированные джинглы", "Рекламные слоты"],
  },
  {
    kicker: "Несколько пространств",
    name: "Сеть",
    monthly: 14990,
    points: ["От 2 точек под одним аккаунтом", "Премиум-каталог", "API и CRM", "Персональный менеджер"],
  },
  {
    kicker: "Собственное радио под ключ",
    name: "Радио полного цикла",
    monthly: 20000,
    points: ["Собственный эфир заведения", "Ведущие и фирменные джинглы", "Освещение событий", "Анонсы меню и акций"],
  },
];

function Brand({ light = false }: { light?: boolean }) {
  return (
    <span className={`brand${light ? " brand--light" : ""}`}>
      PROMO.<b>AIR</b>
      <small>BY PROMO.MUSIC</small>
    </span>
  );
}

function PlayIcon({ playing = false }: { playing?: boolean }) {
  return <span aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span>;
}

function SectionTitle({
  eyebrow,
  children,
  copy,
}: {
  eyebrow: string;
  children: React.ReactNode;
  copy?: React.ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{children}</h2>
      </div>
      {copy ? <p className="section-copy">{copy}</p> : null}
    </div>
  );
}

export default function Home() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [venue, setVenue] = useState(0);
  const [dayPart, setDayPart] = useState(0);
  const [yearly, setYearly] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(65);
  const audioRef = useRef<HTMLAudioElement>(null);

  const currentVenue = venues[venue];
  const currentDay = dayParts[dayPart];

  const formattedPrices = useMemo(
    () =>
      prices.map((plan) => {
        const value = yearly ? Math.round(plan.monthly * 0.85) : plan.monthly;
        return new Intl.NumberFormat("ru-RU").format(value);
      }),
    [yearly],
  );

  const toggleAudio = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume / 100;
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    try {
      await audio.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  };

  return (
    <>
      <a className="skip" href="#main">К содержанию</a>
      <audio ref={audioRef} src={audioUrl} onEnded={() => setPlaying(false)} preload="none" />

      <header className="site-header shell">
        <a href="#main" aria-label="PROMO.AIR — на главную"><Brand /></a>
        <nav className={menuOpen ? "nav nav--open" : "nav"} aria-label="Разделы">
          <a href="#spaces" onClick={() => setMenuOpen(false)}>Для бизнеса</a>
          <a href="#heroes" onClick={() => setMenuOpen(false)}>Музыка</a>
          <a href="#radio" onClick={() => setMenuOpen(false)}>Радио</a>
          <a href="#network" onClick={() => setMenuOpen(false)}>Сеть</a>
        </nav>
        <div className="header-actions">
          <a className="login" href={loginUrl}>Войти</a>
          <a className="button button--small" href={loginUrl}>Подключиться</a>
          <button
            className="menu-button"
            type="button"
            aria-label={menuOpen ? "Закрыть меню" : "Открыть меню"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <span /> <span />
          </button>
        </div>
      </header>

      <main id="main">
        <section className="hero shell">
          <div className="hero-copy">
            <p className="eyebrow eyebrow--dot">YOUR SPACE. YOUR SOUND.</p>
            <h1>У каждого<br />места <em>свой<br />звук.</em></h1>
            <p className="lead">Музыка, которая создаёт атмосферу.<br />Собственное радио для кафе, ресторанов,<br />магазинов, отелей и SPA.</p>
            <div className="hero-actions">
              <a className="button" href={loginUrl}>Попробовать бесплатно</a>
              <a className="text-link" href="#heroes">Послушать демо</a>
            </div>
            <p className="fine">7 дней без оплаты · Ваше пространство, ваша музыка</p>
          </div>

          <div className="hero-visual">
            <img src="/assets/hero.webp" alt="Виниловый Нико парит над миниатюрной кофейней" />
            <div className={`floating-player${playing ? " is-playing" : ""}`}>
              <span className="vinyl" aria-hidden="true" />
              <div>
                <small>НАСТРОЕНИЕ ВАШЕГО МЕСТА</small>
                <strong>Morning Soul</strong>
                <span>Soul / Jazz · музыкальный эскиз</span>
              </div>
              <button className="play" type="button" aria-label={playing ? "Пауза" : "Слушать музыкальный эскиз"} onClick={toggleAudio}>
                <PlayIcon playing={playing} />
              </button>
            </div>
          </div>
        </section>

        <section className="section shell" id="heroes">
          <SectionTitle
            eyebrow="MEET YOUR SOUND / ГЕРОИ PROMO.AIR"
            copy="Четыре проводника в мир вашего звучания. Выберите настроение и познакомьтесь ближе."
          >
            Ваши проводники<br />в мир музыки.
          </SectionTitle>
          <div className="character-grid" aria-label="Герои PROMO.AIR">
            {characters.map((character, index) => (
              <article className="character-card" key={character.name}>
                <div className={`portrait portrait--${index}`} role="img" aria-label={`${character.name}, виниловый музыкальный герой`} />
                <div className="card-body">
                  <small>{character.name}</small>
                  <h3>{character.mood}</h3>
                  <a href={`#day`} className="card-link">Познакомиться со звучанием <span>↗</span></a>
                  <b>{character.role}</b>
                  <p>{character.story}</p>
                </div>
              </article>
            ))}
          </div>
          <p className="mobile-hint">Листайте · 1 / 4</p>
        </section>

        <div className="ticker" aria-hidden="true">
          <div>
            <span>Создайте атмосферу</span><i>●</i>
            <span>Задайте настроение</span><i>●</i>
            <span>Дайте бренду голос</span><i>●</i>
            <span>Будьте собой</span><i>●</i>
            <span>Создайте атмосферу</span>
          </div>
        </div>

        <section className="section shell" id="spaces">
          <SectionTitle
            eyebrow="01 / ВАШЕ ПРОСТРАНСТВО"
            copy={<>От первого эспрессо до последнего коктейля.<br />Найдите настроение своего заведения.</>}
          >
            Разные места.<br />Одинаково хороший вкус.
          </SectionTitle>
          <div className="tabs" role="group" aria-label="Тип заведения">
            {venues.map((item, index) => (
              <button key={item.tab} type="button" aria-pressed={venue === index} onClick={() => setVenue(index)}>
                {item.tab}
              </button>
            ))}
          </div>
          <div className="space-stage" style={{ background: currentVenue.color }}>
            <div className={`world world--${venue}`} role="img" aria-label={`Музыкальная атмосфера: ${currentVenue.tab}`} />
            <div className="space-content">
              <span className="pill">МУЗЫКА ДЛЯ ВАШЕГО БИЗНЕСА</span>
              <h3>{currentVenue.title}</h3>
              <p>{currentVenue.copy}</p>
              <strong className="genre">{currentVenue.genre}</strong>
              <a className="text-link" href="#day">Послушать эфир PROMO.AIR</a>
              <small className="visual-note">Визуальная концепция музыкального формата</small>
            </div>
          </div>
        </section>

        <section className="section feature-section" id="features">
          <div className="shell feature-layout">
            <div>
              <p className="eyebrow">02 / МУЗЫКА ПОД КОНТРОЛЕМ</p>
              <h2>Умная музыка.<br /><em>Красивый бизнес.</em></h2>
              <p className="feature-lead">Вы занимаетесь гостями.<br />Музыка становится частью вашего ритма.</p>
              <div className="feature-list">
                {[
                  ["Ваш музыкальный формат", "Подборки под концепцию и настроение места."],
                  ["Расписание на весь день", "Разное звучание утром, днём и вечером."],
                  ["Зоны и заведения", "Музыка для зала, террасы и всей сети."],
                  ["Голос вашего бренда", "Джинглы, приветствия и аудиообъявления."],
                ].map(([title, copy], index) => (
                  <article key={title}>
                    <span>0{index + 1}</span>
                    <div><h3>{title}</h3><p>{copy}</p></div>
                  </article>
                ))}
              </div>
            </div>

            <div className="dashboard" aria-label="Демо кабинета PROMO.AIR">
              <div className="dash-top"><Brand /><span>ДЕМО КАБИНЕТА</span></div>
              <div className="dash-body">
                <aside>
                  <b>Музыка</b><span>Расписание</span><span>Зоны</span><span>Заведения</span>
                </aside>
                <div className="dash-main">
                  <small>ВАШЕ ПРОСТРАНСТВО</small>
                  <h3>Хороший день начинается здесь.</h3>
                  <div className="dash-track">
                    <div className="portrait portrait--0" />
                    <div>
                      <small>Кофейня на углу</small>
                      <h3>Morning Soul</h3>
                      <p>Soul · Jazz · Хорошее утро</p>
                      <button className="play play--small" type="button" onClick={toggleAudio} aria-label={playing ? "Пауза" : "Слушать музыкальный эскиз"}>
                        <PlayIcon playing={playing} />
                      </button>
                    </div>
                  </div>
                  <div className={`wave${playing ? " wave--active" : ""}`} aria-hidden="true" />
                  <label className="volume">Громкость
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={volume}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setVolume(next);
                        if (audioRef.current) audioRef.current.volume = next / 100;
                      }}
                      aria-label="Громкость"
                    />
                    <output>{volume}%</output>
                  </label>
                  <p className="demo-note">Музыкальный эскиз. Управление заведением показано в деморежиме.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section shell" id="day">
          <SectionTitle
            eyebrow="03 / В РИТМЕ ДНЯ"
            copy={<>Одно место. Четыре настроения.<br />Выберите время и почувствуйте разницу.</>}
          >
            Ваш день звучит<br />по-разному.
          </SectionTitle>
          <div className="day-layout">
            <div className={`day-scene day-scene--${dayPart}`}>
              <div className="day-label"><span>{currentDay.time}</span><h3>{currentDay.title}</h3><p>{currentDay.copy}</p></div>
              <div className={`world world--${currentDay.world}`} />
            </div>
            <div className="time-tabs" role="group" aria-label="Время дня">
              {dayParts.map((item, index) => (
                <button key={item.time} type="button" aria-pressed={dayPart === index} onClick={() => setDayPart(index)}>
                  <span>{item.time}</span><b>{item.title}</b>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="section shell radio" id="radio">
          <div>
            <p className="eyebrow">04 / У БРЕНДА ЕСТЬ ГОЛОС</p>
            <h2>Собственное радио<br /><em>для заведений.</em></h2>
            <p className="radio-lead">Пусть ваш бренд не только видят,<br />но и слышат.</p>
            <p>Фирменные джинглы, персональные приветствия, анонсы событий и специальные предложения. Всё в одном эфире.</p>
            <a className="text-link" href="#plans">Больше о собственном радио</a>
          </div>
          <div className="radio-art"><img src="/assets/microphone.webp" alt="Хромированный микрофон с оранжевыми вставками" /></div>
        </section>

        <section className="section network" id="network">
          <div className="shell">
            <SectionTitle
              eyebrow="05 / ВМЕСТЕ ЗВУЧИТ ЛУЧШЕ"
              copy={<>Сохраняйте характер каждого места<br />и общее звучание вашего бренда.</>}
            >
              Один кабинет.<br />Все ваши заведения.
            </SectionTitle>
            <div className="network-map">
              {[0, 1].map((index) => <div className="network-place" key={index}><div className={`world world--${index}`} /><span>{index === 0 ? "Кофейня" : "Ресторан"}</span></div>)}
              <div className="network-hub"><Brand /><strong>Единый центр управления</strong><span>ВИЗУАЛЬНАЯ СХЕМА</span></div>
              {[3, 4].map((index) => <div className="network-place" key={index}><div className={`world world--${index}`} /><span>{index === 3 ? "Магазин" : "Отель"}</span></div>)}
            </div>
            <a className="text-link centered-link" href="#plans">Решение для сети</a>
          </div>
        </section>

        <section className="section shell" id="start">
          <SectionTitle eyebrow="06 / ПРОСТО НАЧАТЬ">Проще, чем<br />выбрать плейлист.</SectionTitle>
          <div className="steps">
            {[
              ["Создайте аккаунт", "Войдите в экосистему PROMO.MUSIC и выберите роль заведения."],
              ["Найдите свой звук", "Выберите формат вашего пространства и музыкальное настроение."],
              ["Включите атмосферу", "Запустите эфир на совместимом устройстве с подключёнными колонками."],
            ].map(([title, copy], index) => (
              <article key={title}><span>0{index + 1}</span><h3>{title}</h3><p>{copy}</p></article>
            ))}
          </div>
        </section>

        <section className="section shell" id="plans">
          <div className="pricing-head">
            <SectionTitle eyebrow="ТАРИФЫ PROMO.AIR">Свой звук.<br />Понятная стоимость.</SectionTitle>
            <span className="trial">7 дней без оплаты</span>
          </div>
          <div className="billing" role="group" aria-label="Период оплаты">
            <button type="button" aria-pressed={!yearly} onClick={() => setYearly(false)}>За месяц</button>
            <button type="button" aria-pressed={yearly} onClick={() => setYearly(true)}>За год <span>выгоднее</span></button>
          </div>
          <div className="price-grid" aria-label="Тарифы">
            {prices.map((plan, index) => (
              <article className={`price-card${plan.featured ? " price-card--featured" : ""}`} key={plan.name}>
                <span className="pill">{plan.kicker}</span>
                <h3>{plan.name}</h3>
                <div className="price"><strong>{formattedPrices[index]}</strong><span> ₽</span></div>
                <p>{yearly ? "в месяц при оплате за год" : "за месяц"}</p>
                <ul>{plan.points.map((point) => <li key={point}>{point}</li>)}</ul>
                <a className="button" href={loginUrl}>Выбрать тариф</a>
              </article>
            ))}
          </div>
          <p className="mobile-hint">Листайте тарифы · 1 / 4</p>
          <p className="legal-note">Цены из опубликованного предложения PROMO.AIR на 15.10.2026. Окончательная стоимость, состав и лимиты подтверждаются при оформлении. Enterprise и нестандартные задачи рассчитываются индивидуально.</p>
        </section>

        <section className="section shell rights" id="rights">
          <div>
            <p className="eyebrow">МУЗЫКА И ПРАВА</p>
            <h2>Музыка без РАО и ВОИС:<br />важен состав каталога.</h2>
            <p>Собственный каталог и прямые соглашения с правообладателями позволяют организовать музыкальное оформление на индивидуальных условиях.</p>
            <p>Для режима без отдельных платежей РАО и ВОИС нужно подтвердить права на произведения, исполнения и фонограммы, а также основания неприменения коллективного сбора. Прямой договор сам по себе не отменяет все возможные обязанности.</p>
            <p>Перед подключением согласуйте перечень треков, территорию, способ использования и документы на права. Условия такого каталога не распространяются автоматически на стороннюю музыку.</p>
            <a className="text-link" href="#footer">Разобраться в правах на музыку</a>
          </div>
          <aside className="rights-card">
            <p className="eyebrow">ДО ПЕРВОГО ЭФИРА</p>
            <h3>Ваш комплект<br />для подключения</h3>
            <ul>
              <li>Договор на выбранный формат</li>
              <li>Состав разрешённого каталога</li>
              <li>Подтверждение прав и оснований использования</li>
              <li>Условия для ваших адресов и зон</li>
            </ul>
          </aside>
        </section>

        <section className="final-cta shell">
          <div>
            <p className="eyebrow">YOUR SPACE. YOUR SOUND.</p>
            <h2>Ваш бизнес заслуживает<br />хорошего звучания.</h2>
            <a className="button" href={loginUrl}>Создать своё радио</a>
          </div>
          <span className="air-word" aria-hidden="true">AIR</span>
        </section>
      </main>

      <footer className="footer shell" id="footer">
        <div><Brand /><p>У каждого места свой звук.</p></div>
        <nav aria-label="Подвал">
          <a href="#heroes">Музыка и плеер</a>
          <a href="#radio">Аудиобрендинг</a>
          <a href="#network">Для сетей</a>
          <a href="#rights">Условия подключения</a>
          <a href={loginUrl}>Войти в PROMO.MUSIC</a>
        </nav>
        <div className="footer-meta"><span>© 2026 PROMO.AIR · Дизайн-концепция</span><span>Design by <b>Promo.Art</b></span></div>
      </footer>
    </>
  );
}
