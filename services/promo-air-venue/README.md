# PROMO.AIR — отдельные потоки заведений

Поток заведения = отдельный экземпляр AutoDJ на своей точке Go-стрим-сервера
(:8086), тот же VPS. Один поток ≈ 5 % CPU и ~90 МБ памяти.

Установка/обновление копии AutoDJ (боевой /opt/promofm-autodj не меняется):

    python3 /opt/promo-air-venue/make_venue_copy.py   # собирает /opt/promo-air-venue
    cp promo-air-venue@.service /etc/systemd/system/ && systemctl daemon-reload
    cp promo-air-venue /usr/local/bin/ && chmod +x /usr/local/bin/promo-air-venue

Заведение:

    promo-air-venue create zagorami-veranda --name "Zagorami · Веранда" \
        [--music-dir /var/lib/promo-air/zagorami-veranda/music] [--jingle-every 3]
    # → https://promo-music.ru/air/live/venue-zagorami-veranda
    # этот адрес админ вставляет в «Провижининг» заявки (поток на точку)
    promo-air-venue list | rebuild <slug> | stop|start|restart <slug> | remove <slug>

Папки заведения: /var/lib/promo-air/<slug>/{music,jingles,announcements}.
Джинглы и анонсы (mp3) кладутся туда; после смены музыки — `rebuild`.
Ведущий (VENUE_DJ_VOICE) выключен: диктор promo.fm не подходит заведению.
История эфира заведения в общую статистику ПРОМО.ЭИР не пишется.
Что играет: GET /server/api/venue-station/now-playing/<streamId>.
