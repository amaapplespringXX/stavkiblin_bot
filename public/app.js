/* Тотализатор — логика мини-аппки. Работает в Telegram (initData) и в dev-режиме в браузере. */
'use strict';

var tg = window.Telegram && window.Telegram.WebApp;
var IN_TG = !!(tg && tg.initData);
var devUser = null;

var state = null;        // последний ответ /api/state
var lastJson = '';       // для сравнения «изменилось ли» (чтобы не дёргать DOM зря)
var timeOffset = 0;      // serverNow - Date.now()
var ui = {};             // черновики форм ставок: {evId: {sel, amount}}
var confirmPick = {};    // выбранный исход при объявлении результата: {evId: idx}
var cancelPick = {};     // {evId: true} — подтверждение отмены пари
var phaseCache = {};     // {evId: phase} на момент последнего рендера
var timersStarted = false;

/* ---------- утилиты ---------- */
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function fmt(n){return Math.round(n).toLocaleString('ru-RU');}
function toast(msg){
  var t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('show');
  clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('show');},2600);
}
function msToStr(ms){
  if(ms<0)ms=0;
  var s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=s%60;
  function p(x){return (x<10?'0':'')+x;}
  return h>0 ? h+':'+p(m)+':'+p(sec) : p(m)+':'+p(sec);
}
function plural(n,a,b,c){n=Math.abs(n)%100;var m=n%10;if(n>10&&n<20)return c;if(m>1&&m<5)return b;if(m===1)return a;return c;}
function now(){return Date.now()+timeOffset;}

function phaseOf(ev){
  if(ev.settled)return 'done';
  if(now()>=ev.eventEndsAt)return 'await';
  if(now()>=ev.betEndsAt)return 'locked';
  return 'open';
}
var PHASE_LABEL={open:'Ставки открыты',locked:'Ставки закрыты · событие идёт',await:'Ожидает результата',done:'Завершено'};
var PHASE_CLASS={open:'st-open',locked:'st-locked',await:'st-await',done:'st-done'};

/* коэффициент для предпросмотра — та же формула, что на сервере */
var MIN_FIRST_COEF=1.5;
function coefPreview(ev,idx,stake){
  var k=Math.round(((ev.total+stake)/(ev.outcomes[idx].pool+stake))*100)/100;
  if(ev.total===0)k=Math.max(k,MIN_FIRST_COEF);
  return k;
}
function findEv(id){return state?state.events.find(function(e){return e.id===id;}):null;}

/* ---------- API ---------- */
function authHeaders(){
  if(IN_TG)return {'Authorization':'tma '+tg.initData};
  if(devUser)return {'X-Dev-User':encodeURIComponent(devUser)};
  return {};
}
async function api(path,body){
  var r=await fetch('/api'+path,{
    method:body?'POST':'GET',
    headers:Object.assign({'Content-Type':'application/json'},authHeaders()),
    body:body?JSON.stringify(body):undefined,
  });
  var data=null;
  try{data=await r.json();}catch(e){}
  if(!r.ok)throw new Error((data&&data.error)||('Ошибка '+r.status));
  return data;
}
function stableJson(s){return JSON.stringify({me:s.me,events:s.events});}
function applyState(s){
  state=s;
  timeOffset=s.serverNow-Date.now();
  lastJson=stableJson(s);
  render();
}
async function refreshQuiet(){
  try{
    var s=await api('/state');
    timeOffset=s.serverNow-Date.now();
    if(stableJson(s)!==lastJson)applyState(s);
    else state=s;
  }catch(e){/* тихо: следующий поллинг попробует снова */}
}

/* ---------- вход ---------- */
function showLogin(){
  document.getElementById('view-login').style.display='block';
  document.getElementById('view-app').style.display='none';
}
function login(){
  var name=document.getElementById('login-name').value.trim();
  if(!name){toast('Введи имя');return;}
  devUser=name;
  try{localStorage.setItem('tk-dev-user',name);}catch(e){}
  document.getElementById('view-login').style.display='none';
  start();
}
function logout(){
  if(IN_TG)return;
  devUser=null;state=null;lastJson='';
  try{localStorage.removeItem('tk-dev-user');}catch(e){}
  showLogin();
}
async function start(){
  try{
    applyState(await api('/state'));
  }catch(e){
    if(IN_TG){
      document.getElementById('view-app').style.display='block';
      document.getElementById('events').innerHTML='<div class="empty">'+esc(e.message)+'</div>';
    }else{
      devUser=null;
      try{localStorage.removeItem('tk-dev-user');}catch(err){}
      showLogin();
      toast(e.message);
    }
    return;
  }
  if(!timersStarted){
    timersStarted=true;
    setInterval(tick,500);
    setInterval(refreshQuiet,3000);
    document.addEventListener('visibilitychange',function(){if(!document.hidden)refreshQuiet();});
  }
}

/* ---------- создание пари ---------- */
function toggleCreate(){
  var f=document.getElementById('createform');
  var show=f.style.display==='none';
  f.style.display=show?'block':'none';
  if(show&&document.getElementById('cf-outcomes').children.length===0){
    addOutcomeField();addOutcomeField();
  }
}
function addOutcomeField(){
  var box=document.getElementById('cf-outcomes');
  var row=document.createElement('div');
  row.className='outc-row';
  row.innerHTML='<input type="text" maxlength="60" placeholder="Исход '+(box.children.length+1)+'">'+
    '<button class="ghost" onclick="this.parentNode.remove()">✕</button>';
  box.appendChild(row);
}
async function submitEvent(){
  var title=document.getElementById('cf-title').value.trim();
  var outcomes=[].slice.call(document.querySelectorAll('#cf-outcomes input'))
    .map(function(i){return i.value.trim();}).filter(function(v){return v;});
  var betMin=parseInt(document.getElementById('cf-betmin').value,10);
  var evMin=parseInt(document.getElementById('cf-evmin').value,10);
  try{
    var res=await api('/events',{title:title,outcomes:outcomes,betMinutes:betMin,eventMinutes:evMin});
    document.getElementById('cf-title').value='';
    document.getElementById('cf-outcomes').innerHTML='';
    document.getElementById('createform').style.display='none';
    toast('Пари создано');
    applyState(res.state);
  }catch(e){toast(e.message);}
}

/* ---------- ставки ---------- */
function selectOutcome(evId,idx){
  ui[evId]=ui[evId]||{};
  ui[evId].sel=idx;
  render();
}
function onAmountInput(evId,val){
  ui[evId]=ui[evId]||{};
  ui[evId].amount=val;
  updatePreview(evId);
}
function updatePreview(evId){
  var ev=findEv(evId);
  var d=ui[evId]||{};
  var el=document.getElementById('preview-'+evId);
  if(!el||!ev)return;
  var amount=parseInt(d.amount,10);
  if(d.sel==null||!(amount>0)){el.textContent='';return;}
  var k=coefPreview(ev,d.sel,amount);
  el.innerHTML='Твой коэффициент: <b>'+k.toFixed(2)+'</b> · возможный выигрыш: <b>'+fmt(amount*k)+' ТК</b>';
}
async function placeBet(evId){
  var d=ui[evId]||{};
  var amount=parseInt(d.amount,10);
  if(d.sel==null){toast('Выбери исход');return;}
  if(!(amount>0)){toast('Введи сумму ставки');return;}
  try{
    var res=await api('/events/'+evId+'/bets',{outcome:d.sel,amount:amount});
    ui[evId]={};
    toast('Ставка принята: '+fmt(amount)+' ТК, коэффициент '+res.coef.toFixed(2));
    applyState(res.state);
  }catch(e){toast(e.message);refreshQuiet();}
}

/* ---------- результат и отмена ---------- */
function pickResult(evId,idx){confirmPick[evId]=idx;render();}
function cancelResult(evId){delete confirmPick[evId];render();}
async function confirmResult(evId){
  var idx=confirmPick[evId];
  if(idx==null)return;
  try{
    var res=await api('/events/'+evId+'/settle',{outcome:idx});
    delete confirmPick[evId];
    toast('Результат объявлен');
    applyState(res.state);
  }catch(e){toast(e.message);refreshQuiet();}
}
function askCancelEvent(evId){cancelPick[evId]=true;render();}
function undoCancelPick(evId){delete cancelPick[evId];render();}
async function doCancelEvent(evId){
  try{
    var res=await api('/events/'+evId+'/cancel');
    delete cancelPick[evId];
    toast('Пари отменено, ставки возвращены');
    applyState(res.state);
  }catch(e){toast(e.message);refreshQuiet();}
}

/* ---------- рендер ---------- */
function render(){
  if(!state)return;
  document.getElementById('view-login').style.display='none';
  document.getElementById('view-app').style.display='block';
  document.getElementById('hdr-name').textContent=state.me.name+(state.me.isAdmin?' ★':'');
  document.getElementById('hdr-balance').textContent=fmt(state.me.balance)+' ТК';
  document.getElementById('btn-logout').style.display=IN_TG?'none':'';

  var box=document.getElementById('events');
  box.innerHTML=state.events.length
    ? state.events.map(renderEvent).join('')
    : '<div class="empty">Пока нет ни одного пари. Создай первое!</div>';

  phaseCache={};
  state.events.forEach(function(ev){
    phaseCache[ev.id]=phaseOf(ev);
    var d=ui[ev.id];
    var inp=document.getElementById('amount-'+ev.id);
    if(inp&&d&&d.amount!=null)inp.value=d.amount;
    updatePreview(ev.id);
  });
  updateCountdowns();
}

function renderEvent(ev){
  var ph=phaseOf(ev);
  var d=ui[ev.id]||{};
  var me=state.me;
  var canManage=(ev.creatorId===me.id)||me.isAdmin;
  var h='<div class="card">';
  h+='<span class="status '+PHASE_CLASS[ph]+'">'+(ev.cancelled?'Отменено':PHASE_LABEL[ph]);
  if(ph==='open')h+=' · <span class="countdown" data-cd="bet-'+ev.id+'"></span>';
  if(ph==='locked')h+=' · до конца <span class="countdown" data-cd="ev-'+ev.id+'"></span>';
  h+='</span>';
  h+='<h3>'+esc(ev.title)+'</h3>';
  h+='<div class="meta">Создал: '+esc(ev.creatorName)+' · Банк: '+fmt(ev.total)+' ТК</div>';

  /* исходы */
  ev.outcomes.forEach(function(o,i){
    var cls='outcome';
    var clickable=(ph==='open');
    if(clickable&&d.sel===i)cls+=' sel';
    if(!clickable)cls+=' static';
    if(ev.settled&&ev.result===i)cls+=' win';
    h+='<div class="'+cls+'"'+(clickable?' onclick="selectOutcome('+ev.id+','+i+')"':'')+'>';
    h+='<span class="o-name">'+esc(o.name)+(ev.settled&&ev.result===i?' — победил':'')+'</span>';
    h+='<span class="o-pool">'+fmt(o.pool)+' ТК</span>';
    h+='<span class="o-coef">'+(o.coef?o.coef.toFixed(2):'—')+'</span>';
    h+='</div>';
  });

  /* форма ставки */
  if(ph==='open'){
    h+='<div class="betform">';
    h+='<input type="number" min="1" step="1" id="amount-'+ev.id+'" placeholder="Сумма, ТК" oninput="onAmountInput('+ev.id+',this.value)">';
    h+='<button onclick="placeBet('+ev.id+')">Поставить</button>';
    h+='</div>';
    h+='<div class="preview" id="preview-'+ev.id+'"></div>';
  }

  /* мои ставки */
  if(ev.myBets.length){
    h+='<div class="mybets"><b>Мои ставки</b>';
    ev.myBets.forEach(function(b){
      var line=esc(ev.outcomes[b.outcome].name)+' — '+fmt(b.amount)+' ТК, коэф. '+b.coef.toFixed(2);
      if(ev.cancelled)h+='<div>'+line+' → возвращена</div>';
      else if(ev.settled){
        if(b.outcome===ev.result)h+='<div class="win-line">'+line+' → выигрыш '+fmt(b.payout)+' ТК</div>';
        else h+='<div class="lose-line">'+line+' → не сыграла</div>';
      }else{
        h+='<div>'+line+' → возможный выигрыш '+fmt(b.amount*b.coef)+' ТК</div>';
      }
    });
    h+='</div>';
  }

  /* объявление результата */
  if(ph==='await'&&!ev.settled){
    if(canManage){
      h+='<div class="resultbox"><p>Событие завершилось. Выбери победивший исход — выигрыши будут начислены сразу.</p>';
      if(confirmPick[ev.id]==null){
        ev.outcomes.forEach(function(o,i){
          h+='<button class="ghost" style="margin:0 8px 8px 0" onclick="pickResult('+ev.id+','+i+')">'+esc(o.name)+'</button>';
        });
      }else{
        h+='<div class="confirmbar">Победил: <b>'+esc(ev.outcomes[confirmPick[ev.id]].name)+'</b>'+
           '<button onclick="confirmResult('+ev.id+')">Подтвердить</button>'+
           '<button class="ghost" onclick="cancelResult('+ev.id+')">Отмена</button></div>';
      }
      h+='</div>';
    }else{
      h+='<div class="resultbox"><p>Событие завершилось. Ждём, пока '+esc(ev.creatorName)+' объявит результат.</p></div>';
    }
  }

  /* итог */
  if(ev.settled){
    h+='<div class="resultbox"><p>'+
      (ev.cancelled
        ? 'Пари отменено, все ставки возвращены.'
        : (ev.winnersCount
          ? 'Выплачено '+fmt(ev.paidTotal)+' ТК, выигравших ставок: '+ev.winnersCount+'.'
          : 'Победителей нет — банк '+fmt(ev.total)+' ТК ушёл приложению.'))+
      '</p></div>';
  }

  /* отмена пари (создатель или админ, пока не завершено) */
  if(!ev.settled&&canManage){
    if(cancelPick[ev.id]){
      h+='<div class="confirmbar">Отменить пари и вернуть все ставки?'+
         '<button class="danger" onclick="doCancelEvent('+ev.id+')">Да, отменить</button>'+
         '<button class="ghost" onclick="undoCancelPick('+ev.id+')">Нет</button></div>';
    }else{
      h+='<div style="margin-top:10px"><button class="ghost-danger" onclick="askCancelEvent('+ev.id+')">Отменить пари</button></div>';
    }
  }

  h+='</div>';
  return h;
}

/* ---------- таймеры ---------- */
function updateCountdowns(){
  if(!state)return;
  var els=document.querySelectorAll('[data-cd]');
  for(var i=0;i<els.length;i++){
    var v=els[i].getAttribute('data-cd').split('-');
    var ev=findEv(+v[1]);
    if(!ev)continue;
    els[i].textContent=msToStr((v[0]==='bet'?ev.betEndsAt:ev.eventEndsAt)-now());
  }
}
function tick(){
  if(!state)return;
  var flip=false;
  state.events.forEach(function(ev){
    if(phaseCache[ev.id]&&phaseCache[ev.id]!==phaseOf(ev))flip=true;
  });
  if(flip){render();return;}
  updateCountdowns();
}

/* ---------- запуск ---------- */
(function boot(){
  if(IN_TG){
    try{tg.ready();tg.expand();}catch(e){}
    start();
    return;
  }
  try{devUser=localStorage.getItem('tk-dev-user')||null;}catch(e){}
  if(devUser)start();
  else showLogin();
})();
