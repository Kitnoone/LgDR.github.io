/* ==================================================================
   ЛЕГЕНДЫ ПОДЗЕМЕЛИЙ · логика карточки
   ------------------------------------------------------------------
   Всё состояние лежит в одном объекте S и пишется в localStorage.
   Командные счётчики (порча, монеты) читаются и пишутся ТОЛЬКО через
   объект Team. Когда дойдём до синхронизации между телефонами, менять
   надо будет один этот объект, остальной код останется как есть.
   ================================================================== */
'use strict';

const KEY = 'legendy.v1';

const BLANK = () => ({
  char: null,
  hp: {},        // charId -> текущее здоровье
  spent: {},     // "charId:abilId" -> сколько зарядов потрачено
  choice: {},    // "charId:group" -> id выбранного пункта
  dmgAcc: {},    // charId -> накопленный урон (для сестры)
  team: { taint: 0, coins: 0 },
});

let S = BLANK();

/* ─────────────────────────── хранилище ─────────────────────────── */

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) S = Object.assign(BLANK(), JSON.parse(raw));
    if (!S.team) S.team = { taint: 0, coins: 0 };
  } catch (e) {
    console.warn('Не удалось прочитать сохранение:', e);
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
  } catch (e) {
    console.warn('Не удалось сохранить:', e);
  }
}

/* ───────────── командные ресурсы: единственная точка входа ─────────────
   Сейчас порча и монеты живут в этом же localStorage и вводятся руками.
   Для комнаты с кодом достаточно переписать get/set на сетевой запрос
   и вызывать render() при входящем обновлении.                        */

const Team = {
  get taint() { return S.team.taint; },
  get coins() { return S.team.coins; },
  setTaint(v) { S.team.taint = Math.max(0, v | 0); save(); render(); },
  setCoins(v) { S.team.coins = Math.max(0, v | 0); save(); render(); },
  addTaint(d) { this.setTaint(this.taint + d); },
  addCoins(d) { this.setCoins(this.coins + d); },
};

/* ─────────────────────────── утилиты ─────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function activeCard() {
  return S.char ? $(`.card[data-char="${S.char}"]`) : null;
}

function hpMax(card) { return parseInt(card.dataset.hpMax, 10); }

function hpCur(card) {
  const id = card.dataset.char;
  return S.hp[id] === undefined ? hpMax(card) : S.hp[id];
}

/* ─────────────────────── выбор персонажа ─────────────────────── */

function buildChooser() {
  const grid = $('#chooser-grid');
  grid.innerHTML = '';
  $$('.card').forEach(card => {
    const b = document.createElement('button');
    b.className = 'ch-btn';
    b.dataset.pick = card.dataset.char;
    const name = $('h1', card).innerHTML.replace(/<br\s*\/?>/gi, ' ');
    b.innerHTML = `<i>${hpMax(card)}</i><b>${name}</b>` +
                  `<span>${$('.role', card).textContent}</span>`;
    b.addEventListener('click', () => pickChar(card.dataset.char));
    grid.appendChild(b);
  });
}

function pickChar(id) {
  S.char = id;
  if (S.hp[id] === undefined) S.hp[id] = hpMax($(`.card[data-char="${id}"]`));
  save();
  showApp();
}

function showChooser() {
  $('#chooser').hidden = false;
  $('#topbar').hidden = true;
  $('#teambar').hidden = true;
  $('#app').hidden = true;
}

function showApp() {
  $('#chooser').hidden = true;
  $('#topbar').hidden = false;
  $('#teambar').hidden = false;
  $('#app').hidden = false;
  render();
  window.scrollTo(0, 0);
}

/* ─────────────────────────── отрисовка ─────────────────────────── */

function render() {
  const card = activeCard();
  $$('.card').forEach(c => c.classList.toggle('is-active', c === card));
  if (!card) return;

  const id = card.dataset.char;
  const taint = Team.taint;
  const coins = Team.coins;

  $('#tb-title').textContent = $('.head .eyebrow', card).textContent;

  /* здоровье */
  const cur = hpCur(card), max = hpMax(card);
  $('[data-hp-cur]', card).textContent = cur;
  card.classList.toggle('is-hurt', cur > 0 && cur <= max / 2);
  card.classList.toggle('is-down', cur <= 0);
  $('[data-hp-mirror]').textContent = `${cur}/${max}`;

  /* характеристики: у еретика растут от порчи */
  const boost = card.dataset.taintBoost ? taint : 0;
  $$('.nums .val', card).forEach(el => {
    const base = parseInt(el.dataset.base, 10);
    const v = base + boost;
    el.textContent = v >= 0 ? `+${v}` : `\u2212${Math.abs(v)}`;
    el.classList.toggle('neg', v < 0);
    el.classList.toggle('is-boosted', boost > 0);
  });

  /* молитвы, гаснущие от порчи */
  $$('.pick--gated', card).forEach(p => {
    const lim = parseInt(p.dataset.taintMax, 10);
    const off = taint >= lim;
    p.classList.toggle('is-gated', off);
    $('.pick-state', p).textContent = off
      ? `Молчит: порчи ${taint}, нужно меньше ${lim}`
      : '';
  });

  /* выборы одного из нескольких */
  $$('.pick--choice', card).forEach(p => {
    const group = p.dataset.group;
    const chosen = S.choice[`${id}:${group}`];
    const isMe = chosen === p.dataset.pick;
    p.classList.toggle('is-chosen', isMe);
    p.classList.toggle('is-dimmed', !!chosen && !isMe);
  });

  /* заряды */
  $$('.abil[data-uses]', card).forEach(a => {
    const total = parseInt(a.dataset.uses, 10);
    const used = S.spent[`${id}:${a.dataset.abil}`] || 0;
    $$('.uses i', a).forEach((box, i) => box.classList.toggle('is-spent', i < used));
    a.classList.toggle('is-empty', used >= total);
    const usesEl = $('.uses', a);
    const em = $('em', usesEl);
    if (em) {
      const left = total - used;
      const word = usesEl.dataset.word || '';
      em.textContent = left > 0
        ? `осталось ${left} из ${total} ${word}`.trim()
        : 'заряды кончились';
    }
  });

  /* ультимейт по карману */
  const ult = $('[data-ult]', card);
  const cost = parseInt(card.dataset.ultCost, 10);
  ult.classList.toggle('is-poor', coins < cost);

  /* командная панель */
  $('#taint-val').textContent = taint;
  $('#coins-val').textContent = coins;
  $('#teambar').classList.toggle('is-taint', taint > 0);
}

/* ─────────────────────── здоровье: урон и лечение ─────────────────────── */

let hpAmount = 1;

function openHp() {
  const card = activeCard();
  if (!card) return;
  $('#hpdlg-num').textContent = hpCur(card);
  $('#hpdlg-max').textContent = `/ ${hpMax(card)}`;
  $('#hpdlg-note').textContent = damageNote(card);
  $('#hpdlg').hidden = false;
}

function damageNote(card) {
  const notes = [];
  if (card.dataset.char === 'neophyte'
      && S.choice['neophyte:foundation'] === 'cursed' && Team.taint > 0) {
    notes.push('Проклятое основание: урон делится пополам автоматически.');
  }
  if (card.dataset.dmgToCoins) {
    notes.push(`Каждые ${card.dataset.dmgToCoins} полученного урона дают команде монету.`);
  }
  return notes.join(' ');
}

function setAmount(n) {
  hpAmount = n;
  $('#hpdlg-input').value = '';
  $$('.hpdlg-quick button').forEach(b => b.classList.toggle('is-on', +b.dataset.hpq === n));
}

function readAmount() {
  const raw = $('#hpdlg-input').value.trim();
  const n = raw === '' ? hpAmount : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function applyDamage(raw) {
  const card = activeCard();
  const id = card.dataset.char;
  let dmg = raw;

  if (id === 'neophyte' && S.choice['neophyte:foundation'] === 'cursed' && Team.taint > 0) {
    dmg = Math.floor(dmg / 2);
    toast(`Проклятое основание: урон уменьшен до ${dmg}`);
  }

  S.hp[id] = Math.max(0, hpCur(card) - dmg);

  const step = parseInt(card.dataset.dmgToCoins || '0', 10);
  if (step > 0) {
    const acc = (S.dmgAcc[id] || 0) + raw;
    const earned = Math.floor(acc / step);
    S.dmgAcc[id] = acc % step;
    if (earned > 0) {
      Team.addCoins(earned);
      toast(`Мученица императора: команде ${earned === 1 ? '1 монета' : earned + ' монеты'}`);
    }
  }

  save(); render();
  $('#hpdlg-num').textContent = hpCur(card);
  if (hpCur(card) === 0) toast('Выведен из строя');
}

function applyHeal(n) {
  const card = activeCard();
  const id = card.dataset.char;
  S.hp[id] = Math.min(hpMax(card), hpCur(card) + n);
  save(); render();
  $('#hpdlg-num').textContent = hpCur(card);
}

/* ─────────────────────── сбросы ─────────────────────── */

function resetCharges(scope) {
  const card = activeCard();
  if (!card) return;
  const id = card.dataset.char;
  $$('.abil[data-uses]', card).forEach(a => {
    if (scope === 'day' || a.dataset.reset === 'battle') {
      delete S.spent[`${id}:${a.dataset.abil}`];
    }
  });
  $$('.pick--choice', card).forEach(p => {
    const reset = card.dataset.choiceReset;
    if (reset && (scope === 'day' || reset === 'battle')) {
      delete S.choice[`${id}:${p.dataset.group}`];
    }
  });
}

function newBattle() {
  resetCharges('battle');
  save(); render();
  toast('Новый бой: заряды «за бой» восстановлены');
}

function newDay() {
  const card = activeCard();
  resetCharges('day');
  if (card) {
    S.hp[card.dataset.char] = hpMax(card);
    S.dmgAcc[card.dataset.char] = 0;
  }
  save(); render();
  toast('Новый день: здоровье и все заряды восстановлены');
}

function resetAll() {
  if (!confirm('Сбросить здоровье, заряды, выборы, порчу и монеты?')) return;
  const keep = S.char;
  S = BLANK();
  S.char = keep;
  save(); render();
  toast('Всё сброшено');
}

/* ─────────────────────── обработчики ─────────────────────── */

function onClick(e) {
  const card = activeCard();

  /* заряды */
  const box = e.target.closest('.uses i');
  if (box && card) {
    const abil = box.closest('.abil');
    const key = `${card.dataset.char}:${abil.dataset.abil}`;
    const idx = $$('.uses i', abil).indexOf(box);
    const used = S.spent[key] || 0;
    S.spent[key] = (idx < used) ? idx : idx + 1;
    save(); render();
    return;
  }

  /* выбор одного из нескольких */
  const pick = e.target.closest('.pick--choice');
  if (pick && card) {
    const key = `${card.dataset.char}:${pick.dataset.group}`;
    S.choice[key] = (S.choice[key] === pick.dataset.pick) ? undefined : pick.dataset.pick;
    if (!S.choice[key]) delete S.choice[key];
    save(); render();
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;

  switch (act) {
    case 'menu':        $('#menu').hidden = false; break;
    case 'close-menu':  $('#menu').hidden = true; break;
    case 'new-battle':  $('#menu').hidden = true; newBattle(); break;
    case 'new-day':     $('#menu').hidden = true; newDay(); break;
    case 'switch':      $('#menu').hidden = true; showChooser(); break;
    case 'reset':       $('#menu').hidden = true; resetAll(); break;
    case 'print':       $('#menu').hidden = true; setTimeout(() => window.print(), 60); break;

    case 'hp':          openHp(); break;
    case 'close-hp':    $('#hpdlg').hidden = true; break;
    case 'damage': {
      const n = readAmount();
      if (n > 0) applyDamage(n); else toast('Укажи количество');
      break;
    }
    case 'heal': {
      const n = readAmount();
      if (n > 0) applyHeal(n); else toast('Укажи количество');
      break;
    }

    case 'taint-plus':  Team.addTaint(1); break;
    case 'taint-minus': Team.addTaint(-1); break;
    case 'coins-plus':  Team.addCoins(1); break;
    case 'coins-minus': Team.addCoins(-1); break;

    case 'psy-fumble': {
      if (Team.coins >= 3) {
        Team.addCoins(-3);
        toast('Списано 3 монеты. Демон не пришёл');
      } else {
        toast(`В кошельке ${Team.coins} — не хватает. Получи урон за каждую неуплаченную монету`);
      }
      break;
    }

    case 'ult': {
      if (!card) break;
      const cost = parseInt(card.dataset.ultCost, 10);
      if (Team.coins < cost) {
        toast(`Нужно ${cost}, в кошельке ${Team.coins}`);
        break;
      }
      Team.addCoins(-cost);
      if (card.dataset.char === 'heretic') {
        Team.setTaint(0);
        toast('Апофеоз: монеты списаны, порча сброшена');
      } else {
        toast(`Ультимейт применён, списано ${cost}`);
      }
      break;
    }
  }
}

/* ─────────────────────── запуск ─────────────────────── */

function init() {
  load();
  buildChooser();

  document.addEventListener('click', onClick);

  $$('.hpdlg-quick button').forEach(b =>
    b.addEventListener('click', () => setAmount(+b.dataset.hpq)));
  $('#hpdlg-input').addEventListener('input', () =>
    $$('.hpdlg-quick button').forEach(b => b.classList.remove('is-on')));
  setAmount(1);

  /* клик по затемнению закрывает шторку */
  $$('.sheetmenu').forEach(sm => sm.addEventListener('click', e => {
    if (e.target === sm) sm.hidden = true;
  }));

  if (S.char && $(`.card[data-char="${S.char}"]`)) showApp();
  else showChooser();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
