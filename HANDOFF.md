# Тотализатор — handoff для продолжения работы

> Дружеские пари на виртуальные «Толикоины» (ТК) в Telegram-миниаппке.
> Бот: [@stavkiblin_bot](https://t.me/stavkiblin_bot). Репо: `github.com/amaapplespringXX/stavkiblin_bot`.
> Это НЕ реальные деньги — просто игра между друзьями.

## 1. Что это и как устроено

Один Node-процесс делает сразу три вещи:
- отдаёт **API** (`/api/*`),
- отдаёт **статику миниаппки** (`public/`),
- крутит **Telegram-бота** на long polling (без библиотек, чистый `fetch`).

Стек намеренно простой: **Node 18+ / Express / без БД**. Состояние живёт в памяти и
атомарно сбрасывается в JSON-файл `data/data.json`. Нативных зависимостей нет (только `express`),
чтобы бесплатный контейнер не спотыкался на сборке.

### Схема деплоя (важно понять до правок инфры)

Telegram открывает миниаппы только по HTTPS, а бесплатный wispbyte даёт только HTTP на
нестандартном порту. Поэтому цепочка из двух хостов:

```
Telegram (кнопка меню бота)
      │
      ▼
https://stavkiblin.onrender.com          ← Render (free): тонкий HTTPS-прокси, proxy/server.js
      │  прозрачно проксирует всё
      ▼
http://stavkiblin.duckdns.org:12745      ← wispbyte (free): САМ бэкенд, server.js (бот + база + api + статика)
      │
      ▼
DuckDNS: stavkiblin.duckdns.org → A-запись на 78.154.103.41 (IP wispbyte-ноды FREE-EU-RO-36)
```

Почему так, а не проще:
- `*.onrender.com` НЕ в блок-листах AdGuard/anti-phishing (в отличие от `*.workers.dev` — проверено).
- Render free засыпает после 15 мин простоя → бэкенд wispbyte сам пингует `WEBAPP_URL/proxy-health`
  каждые 14 минут (см. конец `server.js`), чтобы прокси не спал.
- wispbyte выдаёт порт как env `SERVER_PORT` — сервер его читает автоматически.
- **Источник истины — только wispbyte-бэкенд.** Render — просто HTTPS-труба, своей логики/базы
  у него нет. Бот с токеном работает ТОЛЬКО на wispbyte.

## 2. Карта репозитория

```
server.js            # ВЕСЬ бэкенд: env-загрузка, хранилище, игровая математика,
                     #   валидация Telegram initData (HMAC), REST API, телеграм-бот (polling)
proxy/server.js      # HTTPS-прокси для Render (node:http, ~40 строк, форвардит всё на wispbyte)
public/index.html    # разметка + стили миниаппки (дизайн из исходного прототипа)
public/app.js        # фронт-логика: рендер, ставки, таймеры, поллинг /api/state раз в 3с
scripts/e2e.js       # e2e-прогон против запущенного сервера (39 проверок, ~70 сек)
.env.example         # образец конфигурации
README.md            # инструкции по деплою
HANDOFF.md           # этот файл
```

## 3. Правила игры (доменная логика)

- Новый игрок получает **10 000 ТК** при первом заходе.
- Любой может создать пари: вопрос, ≥2 исхода, время приёма ставок и длительность события (в минутах).
- **Коэффициент фиксируется в момент ставки:** `K = (общий банк + ставка) / (банк исхода + ставка)`,
  минимум **1.5** на самую первую ставку в пари.
- Фазы пари: `open` (ставки открыты) → `locked` (ставки закрыты, событие идёт) →
  `await` (ждём результат) → `done` (завершено).
- Результат объявляет **создатель пари или админ**. Выигравшим начисляется `ставка × коэф`,
  но суммарная выплата **капается банком пари** (нельзя выплатить больше, чем собрано — это
  закрывает «печатный станок» через соло-ставку). Остаток банка уходит в казну приложения (`treasury`).
- **Отмена пари** (возврат всех ставок): создатель — только пока `open`; админ — в любой момент
  до завершения. (Чтобы создатель не гасил свой проигрыш отменой, когда исход уже известен.)

## 4. Конфигурация (env)

Файл читается из первого существующего: `ENV_FILE` → `.env` → `config.env` → `env.txt`.
На wispbyte панель НЕ даёт создать файл с точкой в имени, поэтому там используется **`config.env`**.

```
BOT_TOKEN=<токен от @BotFather>
ADMIN_USERNAMES=AppleSpring,speafteam   # бутстрап-админы по username (без @)
ADMIN_IDS=                              # ЛУЧШЕ: числовые id админов через запятую (см. ниже)
DEV_MODE=0                              # 1 = вход по имени вне Telegram (ТОЛЬКО для локали!)
WEBAPP_URL=https://stavkiblin.onrender.com
# PORT — локально; на wispbyte порт приходит как SERVER_PORT автоматически
# BACKEND_URL — только для прокси на Render: http://stavkiblin.duckdns.org:12745
```

**Про админов:** сейчас админка держится на `ADMIN_USERNAMES`, но Telegram-username можно сменить/увести.
Надёжнее — числовые id. Бот в ответ на `/start` показывает админу его id. Как узнали —
вписать в `ADMIN_IDS=<id1>,<id2>` в `config.env` и рестартнуть контейнер.

## 5. Как запустить локально

```bash
npm install
cp .env.example .env         # вписать BOT_TOKEN, поставить DEV_MODE=1
npm start                    # http://localhost:8080  (DEV_MODE=1 → вход по имени в браузере)
npm run e2e                  # прогнать 39 проверок против запущенного сервера
```

⚠️ Нельзя держать два инстанса бота с одним токеном одновременно (локальный + серверный) —
Telegram getUpdates конфликтует (409). На время локальной отладки бота либо гаси серверный,
либо убери `BOT_TOKEN` из локального `.env`.

## 6. Деплой обновлений

Код на wispbyte и Render подтягивается из GitHub:
1. Запушить в `main`.
2. **wispbyte:** Stop → Start контейнера (при старте делает `git pull`). Первый клон репо
   зашит в Startup Command (клонирует во временную папку и копирует, не затирая `config.env`).
3. **Render:** деплоится сам на push (или Manual Deploy → Deploy latest commit).

### Startup Command на wispbyte (уже настроен, для справки)
```
if [ ! -f /home/container/server.js ]; then rm -rf /tmp/deploy && git clone https://github.com/amaapplespringXX/stavkiblin_bot.git /tmp/deploy && cp -rn /tmp/deploy/. /home/container/ && rm -rf /tmp/deploy; fi; if [[ -d /home/container/.git ]] && [[ ${AUTO_UPDATE} == "1" ]]; then git pull; fi; if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi; /usr/local/bin/node /home/container/server.js
```
JS file = `server.js`, Auto Update = `1`.

### Render (для справки)
- New Web Service из репо, Build: `npm install`, Start: `node proxy/server.js`, Free.
- Env: `BACKEND_URL=http://stavkiblin.duckdns.org:12745`.

## 7. Как проверить, что всё живо (снаружи, curl)

```bash
# бэкенд напрямую (wispbyte)
curl http://stavkiblin.duckdns.org:12745/health          # → {"ok":true}
# вся цепочка через прокси (Render)
curl https://stavkiblin.onrender.com/proxy-health        # → ok           (значит прокси жив)
curl https://stavkiblin.onrender.com/health              # → {"ok":true}  (значит прокси достаёт wispbyte)
curl https://stavkiblin.onrender.com/                    # → HTML миниаппки
```
`code=000` на первый curl = wispbyte-бэкенд лёг. `502 backend unavailable` от прокси = то же самое
(Render жив, wispbyte недоступен).

## 8. Текущий статус и что дальше

**Готово и проверено:** вся функциональность (создание пари, ставки, коэффициенты, выплаты,
роли создатель/админ, отмены), авторизация через Telegram initData (HMAC), 39/39 e2e зелёные.
Код прошёл адверсариальное ревью — 17 подтверждённых багов починены (экономика, гонки поллинга,
дабл-тап, устойчивость записи на диск, тайм-ауты бота).

**Известная нестабильность инфры (НЕ баг кода):** бесплатная нода wispbyte периодически роняет
контейнер или у неё слетает port-forward — бэкенд становится недоступен по `78.154.103.41:12745`.
Симптом у пользователя: миниаппка пишет `backend unavailable` (это честный ответ прокси).
**Лечение:** в панели wispbyte **Stop → 5 сек → Start** (не Restart). Если повторяется часто —
смотреть Console-лог wispbyte на предмет стека падения; если контейнер просто «marked as offline»
без стека — это нестабильность free-тарифа, кандидаты на решение: платный тариф wispbyte, либо
перенос бэкенда на другой always-on хост (сам код к хосту не привязан, нужен лишь HTTP-порт).

**Идеи на будущее (по желанию):** миграция на `ADMIN_IDS`; страница «мои пари»/история;
лидерборд по балансам; звуковые/пуш-уведомления о результате; перенос хранилища на SQLite,
если игроков станет много.

## 9. Доступы (передать отдельно, НЕ в этом файле)

- Токен бота (`BOT_TOKEN`) — в `config.env` на wispbyte, в гит не коммитится.
- Панель wispbyte (нода FREE-EU-RO-36, support tag 93909c09).
- Аккаунт Render (сервис `stavkiblin`).
- DuckDNS (домен `stavkiblin`, токен).
- GitHub-репо `amaapplespringXX/stavkiblin_bot` (для пуша нужен доступ на запись).
