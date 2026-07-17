/* Тотализатор — сервер мини-аппки: API + статика + телеграм-бот (long polling).
   Один процесс, состояние в памяти + атомарная запись в JSON-файл. */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');

/* ---------- .env (без зависимостей) ---------- */
(function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* .env нет — берём переменные окружения как есть */ }
})();

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',').map((s) => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
/* username в Telegram можно сменить/освободить (и его займёт чужой) — надёжнее числовые id.
   ADMIN_USERNAMES — бутстрап; как узнали свои id (бот подскажет в /start) — переносим в ADMIN_IDS. */
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 8080);
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const DEV_MODE = process.env.DEV_MODE === '1';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'data.json');

const START_BALANCE = 10000;
const MIN_FIRST_COEF = 1.5;
const AUTH_TTL_SEC = 24 * 3600;
const MAX_MINUTES = 30 * 24 * 60;
const MAX_BET = 1e9;
const MAX_OUTCOMES = 12;
const MAX_ACTIVE_PER_USER = 30;
const CREATE_COOLDOWN_MS = 10 * 1000;
const PRUNE_SETTLED_AFTER_MS = 30 * 24 * 3600 * 1000;
const STATE_EVENTS_LIMIT = 100;

/* ---------- хранилище ---------- */
let db = { users: {}, events: [], treasury: 0, nextId: 1 };
(function load() {
  let loaded = null;
  try {
    loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    if (fs.existsSync(DATA_FILE)) {
      /* битый файл НЕ перезаписываем молча — откладываем и пробуем .bak */
      const quarantine = DATA_FILE + '.corrupt-' + Date.now();
      try { fs.renameSync(DATA_FILE, quarantine); console.error('[db] data.json битый — отложен в ' + quarantine); } catch (e) { console.error('[db] не смог отложить битый файл:', e.message); }
      try { loaded = JSON.parse(fs.readFileSync(DATA_FILE + '.bak', 'utf8')); console.error('[db] восстановлено из .bak'); } catch { /* нет бэкапа */ }
    }
  }
  if (loaded) {
    db = Object.assign(db, loaded);
    console.log(`[db] загружено: юзеров ${Object.keys(db.users).length}, пари ${db.events.length}`);
  } else {
    console.log('[db] стартуем с пустого состояния');
  }
})();

function save() {
  /* Память — источник истины; сбой диска логируем, но запрос не роняем.
     fsync до rename — иначе после power-loss можно получить пустой data.json. */
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify(db));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    try { fs.renameSync(DATA_FILE, DATA_FILE + '.bak'); } catch { /* первой записи файла ещё нет */ }
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('[db] save не удался (память актуальна, диск отстаёт):', e.message);
  }
}

/* ---------- игровая математика (1-в-1 с прототипом totalizator.html) ---------- */
function phase(ev) {
  if (ev.settled) return 'done';
  const now = Date.now();
  if (now >= ev.eventEndsAt) return 'await';
  if (now >= ev.betEndsAt) return 'locked';
  return 'open';
}
function pools(ev) {
  const per = ev.outcomes.map(() => 0);
  let total = 0;
  for (const b of ev.bets) { per[b.outcome] += b.amount; total += b.amount; }
  return { per, total };
}
/* Коэффициент фиксируется в момент ставки: K = (общий банк + ставка) / (банк исхода + ставка).
   Для первой ставки на пари действует минимум 1.5 */
function coefFor(ev, idx, stake) {
  const p = pools(ev);
  let k = Math.round(((p.total + stake) / (p.per[idx] + stake)) * 100) / 100;
  if (p.total === 0) k = Math.max(k, MIN_FIRST_COEF);
  return k;
}
function displayCoef(ev, idx) {
  const p = pools(ev);
  if (p.total === 0) return MIN_FIRST_COEF;
  if (p.per[idx] <= 0) return null;
  return Math.round((p.total / p.per[idx]) * 100) / 100;
}

/* ---------- проверка Telegram initData ---------- */
function validateInitData(initData) {
  if (!BOT_TOKEN || typeof initData !== 'string' || initData.length > 4096) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'))) return null;
  const authDate = Number(params.get('auth_date')) || 0;
  if (Math.abs(Date.now() / 1000 - authDate) > AUTH_TTL_SEC) return null;
  try {
    const user = JSON.parse(params.get('user'));
    if (!user || user.id == null) return null;
    return user;
  } catch { return null; }
}

/* ---------- HTTP ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

/* авторизация всех /api-запросов */
app.use('/api', (req, res, next) => {
  let tgUser = null;
  const auth = req.get('authorization') || '';
  if (auth.startsWith('tma ')) tgUser = validateInitData(auth.slice(4));
  if (!tgUser && DEV_MODE) {
    const raw = req.get('x-dev-user');
    if (raw) {
      let name = raw;
      try { name = decodeURIComponent(raw); } catch { /* берём как есть */ }
      name = String(name).trim().slice(0, 24);
      if (name) tgUser = { id: 'dev:' + name.toLowerCase(), first_name: name, username: name };
    }
  }
  if (!tgUser) return res.status(401).json({ error: 'Открой приложение через Telegram' });

  const id = String(tgUser.id);
  const username = (tgUser.username || '').toLowerCase();
  const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim()
    || tgUser.username || 'id' + id;
  let u = db.users[id];
  if (!u) {
    u = db.users[id] = { id, name, username, balance: START_BALANCE, createdAt: Date.now() };
    save();
  } else if (u.name !== name || u.username !== username) {
    u.name = name;
    u.username = username;
    save();
  }
  u.isAdmin = ADMIN_IDS.includes(id) || ADMIN_USERNAMES.includes(username);
  req.user = u;
  next();
});

function bad(res, msg, code) { return res.status(code || 400).json({ error: msg }); }
function findEvent(id) { return db.events.find((e) => e.id === id); }

function evToJson(ev, u) {
  const p = pools(ev);
  return {
    id: ev.id,
    title: ev.title,
    creatorId: ev.creatorId,
    creatorName: ev.creatorName,
    createdAt: ev.createdAt,
    betEndsAt: ev.betEndsAt,
    eventEndsAt: ev.eventEndsAt,
    outcomes: ev.outcomes.map((name, i) => ({ name, pool: p.per[i], coef: displayCoef(ev, i) })),
    total: p.total,
    settled: ev.settled,
    cancelled: !!ev.cancelled,
    result: ev.result,
    paidTotal: ev.paidTotal,
    winnersCount: ev.winnersCount,
    myBets: ev.bets
      .filter((b) => b.userId === u.id)
      .map((b) => ({ outcome: b.outcome, amount: b.amount, coef: b.coef, payout: b.payout == null ? null : b.payout })),
  };
}
function stateFor(u) {
  return {
    serverNow: Date.now(),
    me: { id: u.id, name: u.name, balance: u.balance, isAdmin: !!u.isAdmin },
    events: db.events.slice(0, STATE_EVENTS_LIMIT).map((ev) => evToJson(ev, u)),
  };
}

app.get('/api/state', (req, res) => res.json(stateFor(req.user)));

const lastCreateAt = new Map(); // userId -> ts, простой анти-флуд на создание

app.post('/api/events', (req, res) => {
  const body = req.body || {};
  const title = String(body.title || '').trim().slice(0, 120);
  let outcomes = Array.isArray(body.outcomes) ? body.outcomes : [];
  outcomes = outcomes.map((o) => String(o || '').trim().slice(0, 60)).filter(Boolean);
  const betMinutes = Number(body.betMinutes);
  const eventMinutes = Number(body.eventMinutes);

  if (!title) return bad(res, 'Укажи название события');
  if (outcomes.length < 2) return bad(res, 'Нужно минимум 2 исхода');
  if (outcomes.length > MAX_OUTCOMES) return bad(res, `Максимум ${MAX_OUTCOMES} исходов`);
  if (new Set(outcomes.map((o) => o.toLowerCase())).size !== outcomes.length) {
    return bad(res, 'Исходы не должны повторяться');
  }
  if (!(Number.isInteger(betMinutes) && betMinutes >= 1 && betMinutes <= MAX_MINUTES)) {
    return bad(res, 'Время приёма ставок — минимум 1 минута');
  }
  if (!(Number.isInteger(eventMinutes) && eventMinutes >= 1 && eventMinutes <= MAX_MINUTES)) {
    return bad(res, 'Длительность события — минимум 1 минута');
  }
  if (betMinutes > eventMinutes) return bad(res, 'Время ставок не может быть больше длительности события');

  const now = Date.now();
  if (now - (lastCreateAt.get(req.user.id) || 0) < CREATE_COOLDOWN_MS) {
    return bad(res, 'Слишком часто — подожди несколько секунд');
  }
  if (db.events.filter((e) => !e.settled && e.creatorId === req.user.id).length >= MAX_ACTIVE_PER_USER) {
    return bad(res, 'У тебя слишком много активных пари — заверши старые');
  }
  /* старые завершённые пари выкидываем, иначе массив растёт вечно */
  const cutoff = now - PRUNE_SETTLED_AFTER_MS;
  db.events = db.events.filter((e) => !e.settled || (e.settledAt || e.eventEndsAt) >= cutoff);
  lastCreateAt.set(req.user.id, now);
  db.events.unshift({
    id: db.nextId++,
    title,
    creatorId: req.user.id,
    creatorName: req.user.name,
    outcomes,
    createdAt: now,
    betEndsAt: now + betMinutes * 60000,
    eventEndsAt: now + eventMinutes * 60000,
    bets: [], // {userId, userName, outcome, amount, coef, payout?}
    settled: false,
    cancelled: false,
    result: null,
    paidTotal: 0,
    winnersCount: 0,
  });
  save();
  res.json({ state: stateFor(req.user) });
});

app.post('/api/events/:id/bets', (req, res) => {
  const ev = findEvent(Number(req.params.id));
  if (!ev) return bad(res, 'Пари не найдено', 404);
  if (phase(ev) !== 'open') return bad(res, 'Ставки на это пари закрыты');
  const idx = req.body && req.body.outcome;
  const amount = req.body && req.body.amount;
  if (!Number.isInteger(idx) || idx < 0 || idx >= ev.outcomes.length) return bad(res, 'Некорректный исход');
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_BET) return bad(res, 'Введи целую сумму ставки');
  const u = req.user;
  if (amount > u.balance) return bad(res, 'Недостаточно ТК на балансе');
  const coef = coefFor(ev, idx, amount);
  u.balance -= amount;
  ev.bets.push({ userId: u.id, userName: u.name, outcome: idx, amount, coef });
  save();
  res.json({ coef, state: stateFor(u) });
});

app.post('/api/events/:id/settle', (req, res) => {
  const ev = findEvent(Number(req.params.id));
  if (!ev) return bad(res, 'Пари не найдено', 404);
  if (ev.settled) return bad(res, 'Пари уже завершено');
  if (phase(ev) !== 'await') return bad(res, 'Событие ещё не завершилось');
  const u = req.user;
  if (ev.creatorId !== u.id && !u.isAdmin) return bad(res, 'Результат объявляет создатель пари или админ', 403);
  const idx = req.body && req.body.outcome;
  if (!Number.isInteger(idx) || idx < 0 || idx >= ev.outcomes.length) return bad(res, 'Некорректный исход');

  const p = pools(ev);
  const winBets = ev.bets.filter((b) => b.outcome === idx);
  /* Выплаты не могут превысить банк пари: иначе соло-ставка с гарантированным
     коэфом 1.5 + самообъявление результата = печать ТК из воздуха. Если
     зафиксированные коэфы дают больше банка — делим банк пропорционально. */
  const raws = winBets.map((b) => Math.round(b.amount * b.coef));
  const rawTotal = raws.reduce((s, w) => s + w, 0);
  let paid = 0;
  winBets.forEach((b, i) => {
    const w = rawTotal > p.total ? Math.floor(raws[i] * p.total / rawTotal) : raws[i];
    const bu = db.users[b.userId];
    if (bu) bu.balance += w;
    b.payout = w;
    paid += w;
  });
  /* остаток банка (в т.ч. крохи округления) — в банк приложения; в минус не уходит */
  db.treasury += p.total - paid;
  ev.settled = true;
  ev.result = idx;
  ev.paidTotal = paid;
  ev.winnersCount = winBets.length;
  ev.settledBy = u.id;
  ev.settledAt = Date.now();
  save();
  res.json({ state: stateFor(u) });
});

app.post('/api/events/:id/cancel', (req, res) => {
  const ev = findEvent(Number(req.params.id));
  if (!ev) return bad(res, 'Пари не найдено', 404);
  if (ev.settled) return bad(res, 'Пари уже завершено');
  const u = req.user;
  if (ev.creatorId !== u.id && !u.isAdmin) return bad(res, 'Отменить пари может создатель или админ', 403);
  /* создателю нельзя отменять после закрытия ставок: в фазе await исход уже
     известен, и отмена — способ аннулировать свой проигрыш. Админ-арбитр может всегда. */
  if (!u.isAdmin && phase(ev) !== 'open') {
    return bad(res, 'Ставки уже закрыты — теперь отменить пари может только админ');
  }
  for (const b of ev.bets) {
    const bu = db.users[b.userId];
    if (bu) bu.balance += b.amount;
  }
  ev.settled = true;
  ev.cancelled = true;
  ev.result = null;
  ev.settledBy = u.id;
  ev.settledAt = Date.now();
  save();
  res.json({ state: stateFor(u) });
});

/* ошибки: битый JSON и всё прочее — в JSON-ответ */
app.use((err, _req, res, _next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(400).json({ error: 'Некорректный запрос' });
  }
  console.error('[api] ошибка:', err);
  res.status(500).json({ error: 'Внутренняя ошибка' });
});

/* ---------- телеграм-бот: long polling, без библиотек ---------- */
async function tgApi(method, body, timeoutMs) {
  /* без таймаута молча оборванный long-poll висит до дефолтных 300с undici */
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  return r.json();
}

const WELCOME =
  'Привет! Это «Тотализатор» — дружеские пари на Толикоины (ТК).\n' +
  'Новым игрокам начисляется 10 000 ТК.\n\n' +
  'Создавай пари, ставь на исходы — коэффициент фиксируется в момент ставки.';

async function handleUpdate(upd) {
  const msg = upd.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const kb = WEBAPP_URL.startsWith('https://')
    ? { inline_keyboard: [[{ text: '🎲 Открыть Тотализатор', web_app: { url: WEBAPP_URL } }]] }
    : undefined;
  /* админу (по username) подсказываем его числовой id — чтобы переехать на ADMIN_IDS */
  const uname = ((msg.from && msg.from.username) || '').toLowerCase();
  const adminHint = ADMIN_USERNAMES.includes(uname)
    ? `\n\nТы админ. Твой Telegram ID: ${msg.from.id} — впиши его в ADMIN_IDS в .env (username можно увести, id — нет).`
    : '';
  await tgApi('sendMessage', {
    chat_id: msg.chat.id,
    text: WELCOME + (kb ? '' : '\n\n(Мини-аппка ещё не подключена — скоро.)') + adminHint,
    reply_markup: kb,
  });
}

async function botLoop() {
  let offset = 0;
  for (;;) {
    try {
      const res = await tgApi('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] }, 50000);
      if (!res.ok) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      for (const upd of res.result) {
        offset = upd.update_id + 1;
        try { await handleUpdate(upd); } catch (e) { console.error('[bot] update:', e.message); }
      }
    } catch (e) {
      console.error('[bot] poll:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function startBot() {
  if (!BOT_TOKEN) { console.log('[bot] BOT_TOKEN не задан — бот выключен'); return; }
  try {
    const me = await tgApi('getMe');
    if (!me.ok) {
      /* насовсем сдаёмся только на плохом токене; 429/5xx от Telegram — транзиент, ретраим */
      if (me.error_code === 401 || me.error_code === 404) {
        console.error('[bot] токен не принят:', JSON.stringify(me));
        return;
      }
      console.error('[bot] getMe не ok, повтор через 10с:', JSON.stringify(me));
      setTimeout(startBot, 10000);
      return;
    }
    console.log(`[bot] запущен как @${me.result.username}`);
    await tgApi('deleteWebhook', {});
    if (WEBAPP_URL.startsWith('https://')) {
      await tgApi('setChatMenuButton', {
        menu_button: { type: 'web_app', text: 'Тотализатор', web_app: { url: WEBAPP_URL } },
      });
      console.log('[bot] кнопка меню → ' + WEBAPP_URL);
    }
    botLoop();
  } catch (e) {
    console.error('[bot] старт не удался, повтор через 10с:', e.message);
    setTimeout(startBot, 10000);
  }
}

/* ---------- запуск ---------- */
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';
let server;
if (TLS_CERT && TLS_KEY) {
  server = https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app);
} else {
  server = http.createServer(app);
}
server.listen(PORT, () => {
  console.log(`[http] слушаю ${TLS_CERT ? 'https' : 'http'}://0.0.0.0:${PORT}` + (DEV_MODE ? ' (DEV_MODE)' : ''));
});
startBot();

/* Render free tier засыпает после 15 мин простоя — будим прокси каждые 14 минут */
const PING_URL = process.env.PROXY_PING_URL
  || (WEBAPP_URL.startsWith('https://') ? WEBAPP_URL.replace(/\/+$/, '') + '/proxy-health' : '');
if (PING_URL) {
  setInterval(() => { fetch(PING_URL).catch(() => {}); }, 14 * 60 * 1000);
  console.log('[keepalive] пингуем ' + PING_URL + ' каждые 14 мин');
}
