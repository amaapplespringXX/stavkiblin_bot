/* E2E-прогон против локально запущенного сервера (DEV_MODE=1).
   Использование: node scripts/e2e.js [http://127.0.0.1:8080]
   Занимает ~70 секунд: ждёт реального окончания минутного события. */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';

(function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
})();
const BOT_TOKEN = process.env.BOT_TOKEN || '';

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('PASS ' + label); }
  else { failed++; console.log('FAIL ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, { user, initData, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (initData) headers.authorization = 'tma ' + initData;
  else if (user) headers['x-dev-user'] = encodeURIComponent(user);
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const get = (p, o) => call('GET', p, o);
const post = (p, body, o) => call('POST', p, { ...o, body });

function makeInitData(user, authDate) {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate || Math.floor(Date.now() / 1000)));
  params.set('query_id', 'AAE-e2e');
  params.set('user', JSON.stringify(user));
  const dcs = [...params.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

async function main() {
  // ждём сервер
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    try { const r = await fetch(BASE + '/health'); up = r.ok; } catch {}
    if (!up) await sleep(500);
  }
  if (!up) { console.log('FAIL сервер не поднялся на ' + BASE); process.exit(1); }

  const sfx = String(Date.now() % 100000);
  const U1 = 'e2e-Ася-' + sfx, U2 = 'e2e-Боря-' + sfx, ADM = 'AppleSpring';

  let r = await get('/api/state', { user: U1 });
  ok(r.status === 200 && r.data.me.balance === 10000, 'новый юзер получает 10000 ТК', r.data && r.data.me);

  r = await get('/api/state', {});
  ok(r.status === 401, 'без авторизации — 401', r.status);

  r = await get('/api/state', { user: ADM });
  ok(r.status === 200 && r.data.me.isAdmin === true, 'админ по username распознан', r.data && r.data.me);

  // --- создание пари ---
  r = await post('/api/events', { title: 'E2E: сколько страйков? ' + sfx, outcomes: ['0-3', '4+'], betMinutes: 1, eventMinutes: 1 }, { user: U1 });
  ok(r.status === 200, 'пари создано', r.data);
  const ev1 = r.data.state.events.find((e) => e.title.indexOf('E2E: сколько') === 0);
  ok(!!ev1 && ev1.outcomes.length === 2 && ev1.outcomes[0].coef === 1.5, 'стартовый коэф 1.5 у пустого пари', ev1 && ev1.outcomes);

  r = await post('/api/events', { title: '', outcomes: ['а', 'б'], betMinutes: 1, eventMinutes: 1 }, { user: U1 });
  ok(r.status === 400, 'пустой title отклонён');
  r = await post('/api/events', { title: 'x', outcomes: ['а'], betMinutes: 1, eventMinutes: 1 }, { user: U1 });
  ok(r.status === 400, 'один исход отклонён');
  r = await post('/api/events', { title: 'x', outcomes: ['а', 'А'], betMinutes: 1, eventMinutes: 1 }, { user: U1 });
  ok(r.status === 400, 'дубли исходов отклонены');
  r = await post('/api/events', { title: 'x', outcomes: ['а', 'б'], betMinutes: 5, eventMinutes: 1 }, { user: U1 });
  ok(r.status === 400, 'betMin > evMin отклонено');

  r = await post('/api/events', { title: 'E2E: отмена ' + sfx, outcomes: ['да', 'нет'], betMinutes: 1, eventMinutes: 1 }, { user: U2 });
  const ev2 = r.data.state.events.find((e) => e.title === 'E2E: отмена ' + sfx);
  ok(!!ev2, 'второе пари создано');

  // --- ставки ---
  r = await post('/api/events/' + ev1.id + '/bets', { outcome: 0, amount: 1000 }, { user: U1 });
  ok(r.status === 200 && r.data.coef === 1.5, 'первая ставка: минимум коэф 1.5', r.data && r.data.coef);
  ok(r.data.state.me.balance === 9000, 'баланс списан: 9000', r.data.state.me.balance);
  r = await post('/api/events/' + ev1.id + '/bets', { outcome: 1, amount: 500 }, { user: U2 });
  ok(r.status === 200 && r.data.coef === 3, 'вторая ставка: (1000+500)/(0+500)=3', r.data && r.data.coef);
  r = await post('/api/events/' + ev1.id + '/bets', { outcome: 0, amount: 999999 }, { user: U2 });
  ok(r.status === 400, 'ставка больше баланса отклонена', r.data);
  r = await post('/api/events/' + ev1.id + '/bets', { outcome: 5, amount: 10 }, { user: U2 });
  ok(r.status === 400, 'несуществующий исход отклонён');
  r = await post('/api/events/' + ev1.id + '/bets', { outcome: 0, amount: 10.5 }, { user: U2 });
  ok(r.status === 400, 'дробная сумма отклонена');
  r = await post('/api/events/' + ev2.id + '/bets', { outcome: 0, amount: 700 }, { user: U1 });
  ok(r.status === 200, 'ставка на второе пари принята');

  r = await post('/api/events/' + ev1.id + '/settle', { outcome: 0 }, { user: U1 });
  ok(r.status === 400, 'settle до конца события отклонён', r.data);

  // --- initData ---
  if (BOT_TOKEN) {
    const initData = makeInitData({ id: 424242, first_name: 'Тест', username: 'e2e_signed' });
    r = await get('/api/state', { initData });
    ok(r.status === 200 && r.data.me && r.data.me.balance === 10000, 'валидный initData принят', r.status);
    const badData = initData.slice(0, -1) + (initData.endsWith('0') ? '1' : '0');
    r = await get('/api/state', { initData: badData });
    ok(r.status === 401, 'подделанный initData отклонён', r.status);
    const oldData = makeInitData({ id: 424243, first_name: 'Тест2' }, Math.floor(Date.now() / 1000) - 90000);
    r = await get('/api/state', { initData: oldData });
    ok(r.status === 401, 'просроченный initData отклонён', r.status);
  } else {
    console.log('SKIP initData-тесты: нет BOT_TOKEN');
  }

  // --- ждём конца события ---
  const waitMs = ev1.eventEndsAt - Date.now() + 2000;
  console.log('...ждём окончания события ~' + Math.max(0, Math.ceil(waitMs / 1000)) + 'с');
  if (waitMs > 0) await sleep(waitMs);

  r = await post('/api/events/' + ev1.id + '/bets', { outcome: 0, amount: 10 }, { user: U2 });
  ok(r.status === 400, 'ставка после закрытия отклонена', r.data);

  r = await post('/api/events/' + ev1.id + '/settle', { outcome: 1 }, { user: U2 });
  ok(r.status === 403, 'не-создатель не может объявить результат', r.status);

  r = await post('/api/events/' + ev1.id + '/settle', { outcome: 1 }, { user: U1 });
  ok(r.status === 200, 'создатель объявил результат', r.data);

  let s2 = await get('/api/state', { user: U2 });
  ok(s2.data.me.balance === 11000, 'победителю выплачено 500×3=1500 → 11000', s2.data.me.balance);
  const myBet = s2.data.events.find((e) => e.id === ev1.id).myBets[0];
  ok(myBet.payout === 1500, 'payout в myBets = 1500', myBet);

  r = await post('/api/events/' + ev1.id + '/settle', { outcome: 0 }, { user: U1 });
  ok(r.status === 400, 'повторный settle отклонён');

  // --- отмена ---
  let s1 = await get('/api/state', { user: U1 });
  const balBefore = s1.data.me.balance; // 10000 - 1000(ev1, проиграла) - 700(ev2) = 8300
  ok(balBefore === 8300, 'баланс Аси перед отменой 8300', balBefore);

  r = await post('/api/events/' + ev2.id + '/cancel', {}, { user: U1 });
  ok(r.status === 403, 'чужой не может отменить пари', r.status);
  r = await post('/api/events/' + ev2.id + '/cancel', {}, { user: ADM });
  ok(r.status === 200, 'админ отменил пари', r.data);
  s1 = await get('/api/state', { user: U1 });
  ok(s1.data.me.balance === balBefore + 700, 'ставка возвращена при отмене (+700)', s1.data.me.balance);
  const ev2after = s1.data.events.find((e) => e.id === ev2.id);
  ok(ev2after.cancelled === true && ev2after.settled === true, 'пари помечено отменённым', ev2after && { c: ev2after.cancelled, s: ev2after.settled });

  console.log('\n=== ИТОГ: ' + passed + ' PASS, ' + failed + ' FAIL ===');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('E2E crash:', e); process.exit(1); });
