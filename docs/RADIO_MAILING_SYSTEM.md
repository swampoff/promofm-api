# Единая система рассылки по радиостанциям

Координация cloud-Claude ↔ laptop-Claude. Цель: ОДНА база, ОДИН источник
истины «кому и когда слали», чтобы два актора (облачный крон + laptop,
который уже разослал часть вручную) не били по одним адресам дважды.

## Единственный источник истины — таблица `radio_partner_contacts`

| Колонка | Смысл |
|---|---|
| `id` uuid PK | |
| `station_name` text | имя станции (для {{name}}) |
| `email` text, UNIQUE по `LOWER(email)` | адрес |
| `region`, `city` | гео |
| `source` | откуда (`directory_2gis_19022024` / `music_editors_sorted` / `holdings` / `laptop_*`) |
| `active` bool=true | можно слать |
| `unsubscribed_at` ts | отписка (NULL = подписан) |
| `last_sent_at` ts (mig 115) | когда последний раз слали (NULL = НИ РАЗУ) |
| `send_count` int (mig 115) | сколько раз всего |

**Правило «можно слать»:** `active AND unsubscribed_at IS NULL`.
**Уже-контактированные:** `last_sent_at IS NOT NULL`.

Сейчас засеяно миграцией 114 — **1195 уникальных адресов** (2gis 931 +
муз.редакторы 211 + холдинги 53).

## Кто и как штампует last_sent_at

- **Облачный weekly-крон** (`/run-weekly`, понедельник 12:00 МСК) после
  отправки дайджеста делает
  `UPDATE radio_partner_contacts SET last_sent_at=NOW(), send_count=send_count+1
   WHERE LOWER(email)=ANY(<кому ушло>)`. Автоматически.
- **Laptop** — должен ЗАШТАМПОВАТЬ свой уже-разосланный батч (см. ниже),
  иначе холодный прогон по «оставшимся» зацепит тех, кому laptop уже слал.

## Шаги для laptop (по порядку)

### 1. Влить свою базу/адреса в единую таблицу (если есть свои, которых нет в 114)
```sql
-- station + email из своего списка; дедуп по LOWER(email) — пересечения с 114
-- молча игнорируются (ничего не дублируется).
INSERT INTO radio_partner_contacts (station_name, email, region, city, source)
VALUES ('<станция>', '<email>', '<регион>', '<город>', 'laptop_import')
ON CONFLICT (LOWER(email)) DO NOTHING;
```

### 2. Пометить адреса, которым laptop УЖЕ разослал
```sql
-- <emails> = список адресов из уже проведённой рассылки.
UPDATE radio_partner_contacts
   SET last_sent_at = COALESCE(last_sent_at, NOW()),   -- дату можно поставить реальную
       send_count   = send_count + 1
 WHERE LOWER(email) = ANY(ARRAY[ 'a@x.ru','b@y.ru', ... ]::text[]);
```
После этого они автоматически исключаются из «холодного прогона по оставшимся».

### 3. Холодный прогон по ОСТАВШИМСЯ (кому ещё ни разу не слали)
Кого слать:
```sql
SELECT station_name, email FROM radio_partner_contacts
 WHERE active AND unsubscribed_at IS NULL AND last_sent_at IS NULL;
```
Отправлять — **порциями** (прогрев домена; это холодные внешние адреса,
риск спам-репутации). После каждой порции — `UPDATE ... SET last_sent_at=NOW(),
send_count=send_count+1 WHERE LOWER(email)=ANY(...)`.

> Если хотите, чтобы холодный прогон тоже шёл автоматикой через бэкенд —
> скажите, добавлю эндпоинт `/run-coldwave?limit=N` (берёт N штук с
> `last_sent_at IS NULL`, шлёт красивым шаблоном, штампует). Тогда laptop
> просто дёргает его порциями или по крону.

### 4. Отписки
Любую отписку (жалоба, «не присылайте») — в единый стор:
```sql
UPDATE radio_partner_contacts SET unsubscribed_at=NOW(), active=false
 WHERE LOWER(email)=LOWER('<email>');
```

## Что НЕ надо делать
- Не слать в обход таблицы (тогда last_sent_at не обновится → дубли).
- Не держать второй список в Excel как «рабочий» — Excel это импорт-источник,
  рабочая база только `radio_partner_contacts`.

## Открытые вопросы к laptop
1. Каким каналом/скриптом laptop разослал свою часть и есть ли у него СПИСОК
   уже-отправленных адресов (для шага 2)?
2. Контент laptop-рассылки = weekly-дайджест новинок или отдельное «первое
   касание»? (влияет на то, нужен ли отдельный cold-wave шаблон)
3. Холодный прогон по оставшимся — гоним автоматикой (`/run-coldwave`) или
   laptop сам порциями по SQL из шага 3?
