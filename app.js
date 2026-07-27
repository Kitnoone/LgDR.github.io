/* ==================================================================
   ЛЕГЕНДЫ ПОДЗЕМЕЛИЙ · логика карточки
   ------------------------------------------------------------------
   Всё состояние лежит в одном объекте S и пишется в localStorage.
   Командные счётчики (порча, монеты) читаются и пишутся ТОЛЬКО через
   объект Team. Без лобби они локальные; в лобби объект получает сетевой
   адаптер из lobby-store.js и работает через транзакции Firestore.
   ================================================================== */
'use strict';

let KEY = 'legendy.v1';
let cloudSaver = null;
let suppressCloudSave = false;
let teamAdapter = null;
const stateListeners = new Set();

const BLANK = () => ({
  char: null,
  characterName: '',
  inventory: { armor: '', weapon: '', damage: '', items: [] },
  hp: {},        // charId -> текущее здоровье
  spent: {},     // "charId:abilId" -> сколько зарядов потрачено
  choice: {},    // "charId:group" -> id выбранного пункта
  dmgAcc: {},    // charId -> накопленный урон (для сестры)
  flags: { sisterFallReward: false },
  teamCode: '',
  team: { taint: 0, coins: 0 },
});

let S = BLANK();

function normalizeState(raw) {
  const base = BLANK();
  const next = Object.assign(base, raw || {});
  next.hp = Object.assign({}, raw?.hp || {});
  next.spent = Object.assign({}, raw?.spent || {});
  next.choice = Object.assign({}, raw?.choice || {});
  next.dmgAcc = Object.assign({}, raw?.dmgAcc || {});
  next.flags = Object.assign({ sisterFallReward: false }, raw?.flags || {});
  next.teamCode = String(raw?.teamCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  next.team = Object.assign({ taint: 0, coins: 0 }, raw?.team || {});
  next.inventory = Object.assign({ armor: '', weapon: '', damage: '', items: [] }, raw?.inventory || {});
  if (!Array.isArray(next.inventory.items)) next.inventory.items = [];
  next.characterName = String(next.characterName || '').trim();
  return next;
}

function cloneState() {
  return JSON.parse(JSON.stringify(S));
}

/* ─────────────────────────── хранилище ─────────────────────────── */

function load(userId) {
  KEY = `legendy.v2:${userId}`;
  S = BLANK();
  try {
    let raw = localStorage.getItem(KEY);

    /* Однократно переносим старое локальное сохранение первому вошедшему аккаунту. */
    if (!raw && !localStorage.getItem('legendy.auth.migrated')) {
      const legacy = localStorage.getItem('legendy.v1');
      if (legacy) {
        raw = legacy;
        localStorage.setItem(KEY, legacy);
      }
      localStorage.setItem('legendy.auth.migrated', '1');
    }
    if (raw) S = normalizeState(JSON.parse(raw));
    else S = normalizeState(S);
  } catch (e) {
    console.warn('Не удалось прочитать сохранение:', e);
  }
}

function saveLocal() {
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
  } catch (e) {
    console.warn('Не удалось сохранить:', e);
  }
}

function save() {
  saveLocal();
  if (!suppressCloudSave && cloudSaver) cloudSaver(cloneState());
  stateListeners.forEach(listener => {
    try { listener(cloneState()); } catch (error) { console.warn('State listener:', error); }
  });
}

/* ───────────── командные ресурсы: единственная точка входа ─────────────
   Без лобби порча и монеты живут в localStorage. После входа в лобби
   lobby-store.js подключает teamAdapter, и те же методы работают с общей
   командной записью Firestore.                                      */

const Team = {
  get taint() { return teamAdapter ? teamAdapter.taint : S.team.taint; },
  get coins() { return teamAdapter ? teamAdapter.coins : S.team.coins; },
  get shared() { return !!teamAdapter?.shared; },
  get ready() { return !teamAdapter || !!teamAdapter.ready; },
  get memberCount() { return teamAdapter?.memberCount || 0; },

  async setTaint(v, meta = {}) {
    const target = Math.max(0, v | 0);
    if (teamAdapter) {
      const delta = target - this.taint;
      if (delta === 0) return true;
      if (target === 0) return !!(await teamAdapter.clearTaint(meta));
      try { await teamAdapter.addTaint(delta, meta); return true; } catch { return false; }
    }
    S.team.taint = target; save(); render(); return true;
  },
  async setCoins(v, meta = {}) {
    const target = Math.max(0, v | 0);
    if (teamAdapter) {
      const delta = target - this.coins;
      if (delta === 0) return true;
      try { await teamAdapter.addCoins(delta, meta); return true; } catch { return false; }
    }
    S.team.coins = target; save(); render(); return true;
  },
  async addTaint(d, meta = {}) {
    if (teamAdapter) {
      try { await teamAdapter.addTaint(d, meta); return true; } catch { return false; }
    }
    return this.setTaint(this.taint + d, meta);
  },
  async addCoins(d, meta = {}) {
    if (teamAdapter) {
      try { await teamAdapter.addCoins(d, meta); return true; } catch { return false; }
    }
    return this.setCoins(this.coins + d, meta);
  },
  async spendCoins(cost, meta = {}) {
    cost = Math.max(0, cost | 0);
    if (teamAdapter) return !!(await teamAdapter.spendCoins(cost, meta));
    if (this.coins < cost) return false;
    S.team.coins -= cost; save(); render(); return true;
  },
  async clearTaint(meta = {}) {
    if (teamAdapter) return !!(await teamAdapter.clearTaint(meta));
    S.team.taint = 0; save(); render(); return true;
  },
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
  const nameInput = $('#character-name-input');
  if (nameInput) nameInput.value = S.characterName || '';
  const chooserMessage = $('#chooser-message');
  if (chooserMessage) chooserMessage.textContent = ''; 
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
  const input = $('#character-name-input');
  const name = input ? input.value.trim() : S.characterName;
  if (!name) {
    const msg = $('#chooser-message');
    if (msg) msg.textContent = 'Сначала назови персонажа.';
    input?.focus();
    return;
  }

  S.characterName = name.slice(0, 40);
  S.char = id;
  const card = $(`.card[data-char="${id}"]`);
  if (S.hp[id] === undefined) S.hp[id] = hpMax(card);
  if (!S.inventory.armor) S.inventory.armor = card?.dataset.defaultArmor || '';
  save();
  showApp();
}

function showChooser() {
  const input = $('#character-name-input');
  if (input) input.value = S.characterName || '';
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
  $('#tb-character-name').textContent = S.characterName || 'Без имени';

  const defaultArmor = card.dataset.defaultArmor || '';
  const armor = S.inventory.armor || defaultArmor;
  const weapon = S.inventory.weapon || 'Не указано';
  const damage = S.inventory.damage ? ` · ${S.inventory.damage}` : '';
  const items = S.inventory.items.length ? S.inventory.items.join(', ') : 'Не указаны';
  $('[data-gear-armor]', card).textContent = armor;
  $('[data-gear-weapon]', card).textContent = weapon + damage;
  $('[data-gear-items]', card).textContent = items;

  /* здоровье */
  const cur = hpCur(card), max = hpMax(card);
  $('[data-hp-cur]', card).textContent = cur;
  card.classList.toggle('is-hurt', cur > 0 && cur <= max / 2);
  card.classList.toggle('is-down', cur <= 0);
  $('[data-hp-mirror]').textContent = `${cur}/${max}`;

  /* Характеристики.
     Еретик получает бонусы одновременно от порчи и выбранного пакта:
     — Пакт гордыни: +1 ко всем характеристикам;
     — Пакт силы: базовая Сила удваивается, затем получает +2,
       а командная порча добавляется как обычно. */
  const boost = card.dataset.taintBoost ? taint : 0;
  const hereticPact = id === 'heretic' ? S.choice['heretic:pact'] : null;

  $$('.nums .val', card).forEach(el => {
    const base = parseInt(el.dataset.base, 10);
    const statName = el.closest('div')?.querySelector('.lab')?.textContent.trim() || '';
    let v = base + boost;

    if (id === 'heretic') {
      if (hereticPact === 'pride') v += 1;
      if (hereticPact === 'strength' && statName === 'Сила') {
        v = base * 2 + 2 + boost;
      }
    }

    el.textContent = v >= 0 ? `+${v}` : `\u2212${Math.abs(v)}`;
    el.classList.toggle('neg', v < 0);
    el.classList.toggle('is-boosted', v !== base);
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
  $('#teambar').classList.toggle('is-shared', Team.shared);
  $('#teambar').classList.toggle('is-forming', Team.shared && !Team.ready);
  $$('.tb-cell--team button').forEach(button => { button.disabled = Team.shared && !Team.ready; });
  const mode = $('#team-resource-mode');
  if (mode) mode.textContent = Team.shared
    ? (Team.ready ? `лобби · ${Team.memberCount}/8` : `ждём 3 игроков · ${Team.memberCount}/3`)
    : 'локально';
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

async function applyDamage(raw) {
  const card = activeCard();
  const id = card.dataset.char;
  let dmg = raw;

  if (id === 'neophyte' && S.choice['neophyte:foundation'] === 'cursed' && Team.taint > 0) {
    dmg = Math.floor(dmg / 2);
    toast(`Проклятое основание: урон уменьшен до ${dmg}`);
  }

  const beforeHp = hpCur(card);
  const previousAcc = S.dmgAcc[id] || 0;
  const previousFallReward = !!S.flags.sisterFallReward;
  S.hp[id] = Math.max(0, beforeHp - dmg);

  const step = parseInt(card.dataset.dmgToCoins || '0', 10);
  let earned = 0;
  if (step > 0) {
    const acc = previousAcc + raw;
    earned = Math.floor(acc / step);
    S.dmgAcc[id] = acc % step;
  }

  const fellNow = id === 'sister' && beforeHp > 0 && S.hp[id] === 0 && !previousFallReward;
  if (fellNow) S.flags.sisterFallReward = true;
  save(); render();
  $('#hpdlg-num').textContent = hpCur(card);
  if (hpCur(card) === 0) toast('Выведен из строя');

  const reward = earned + (fellNow ? 5 : 0);
  if (reward > 0) {
    const parts = [];
    if (earned > 0) parts.push(`${earned} за полученный урон`);
    if (fellNow) parts.push('5 за падение');
    const ok = await Team.addCoins(reward, {
      type: fellNow ? 'martyr-fall' : 'martyr',
      text: `${S.characterName}: Мученица императора приносит команде ${reward} монет (${parts.join(', ')}).`,
    });
    if (!ok) {
      S.dmgAcc[id] = previousAcc;
      S.flags.sisterFallReward = previousFallReward;
      save(); render();
      toast('Монеты Сестры не записались. Накопление урона сохранено для повторной попытки.');
    } else if (!Team.shared) {
      toast(`Мученица императора: команде +${reward} монет`);
    }
  }
}

function applyHeal(n) {
  const card = activeCard();
  const id = card.dataset.char;
  S.hp[id] = Math.min(hpMax(card), hpCur(card) + n);
  save(); render();
  $('#hpdlg-num').textContent = hpCur(card);
}

/* ─────────────────────── имя и снаряжение ─────────────────────── */

function openProfile() {
  const card = activeCard();
  if (!card) return;
  $('#profile-name').value = S.characterName || '';
  $('#profile-armor').value = S.inventory.armor || card.dataset.defaultArmor || '';
  $('#profile-weapon').value = S.inventory.weapon || '';
  $('#profile-damage').value = S.inventory.damage || '';
  $('#profile-items').value = S.inventory.items.join('\n');
  $('#profiledlg').hidden = false;
}

function saveProfile() {
  const name = $('#profile-name').value.trim();
  if (!name) {
    toast('Имя персонажа не может быть пустым');
    return;
  }
  S.characterName = name.slice(0, 40);
  S.inventory.armor = $('#profile-armor').value.trim().slice(0, 80);
  S.inventory.weapon = $('#profile-weapon').value.trim().slice(0, 80);
  S.inventory.damage = $('#profile-damage').value.trim().slice(0, 40);
  S.inventory.items = $('#profile-items').value
    .split(/\n|,/)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 30);
  save();
  render();
  $('#profiledlg').hidden = true;
  toast('Персонаж и снаряжение сохранены');
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
  if (!confirm(Team.shared
    ? 'Сбросить здоровье, заряды и выборы этого персонажа? Общие ресурсы лобби останутся.'
    : 'Сбросить здоровье, заряды, выборы, порчу и монеты?')) return;
  const keep = {
    char: S.char,
    characterName: S.characterName,
    inventory: JSON.parse(JSON.stringify(S.inventory)),
    teamCode: S.teamCode,
    team: JSON.parse(JSON.stringify(S.team)),
  };
  S = BLANK();
  S.char = keep.char;
  S.characterName = keep.characterName;
  S.inventory = keep.inventory;
  S.teamCode = keep.teamCode;
  S.team = keep.team;
  save(); render();
  toast(Team.shared ? 'Личный персонаж сброшен. Ресурсы лобби не изменены.' : 'Всё сброшено');
}

/* ─────────────────────── обработчики ─────────────────────── */

async function onClick(e) {
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
    case 'edit-profile': $('#menu').hidden = true; openProfile(); break;
    case 'save-profile': saveProfile(); break;
    case 'close-profile': $('#profiledlg').hidden = true; break;
    case 'switch':      $('#menu').hidden = true; showChooser(); break;
    case 'reset':       $('#menu').hidden = true; resetAll(); break;
    case 'print':       $('#menu').hidden = true; setTimeout(() => window.print(), 60); break;

    case 'hp':          openHp(); break;
    case 'close-hp':    $('#hpdlg').hidden = true; break;
    case 'damage': {
      const n = readAmount();
      if (n > 0) await applyDamage(n); else toast('Укажи количество');
      break;
    }
    case 'heal': {
      const n = readAmount();
      if (n > 0) applyHeal(n); else toast('Укажи количество');
      break;
    }

    case 'taint-plus':
      await Team.addTaint(1, { type: 'taint', text: `${S.characterName} добавляет команде порчу.` });
      break;
    case 'taint-minus':
      await Team.addTaint(-1, { type: 'taint', text: `${S.characterName} снимает 1 порчу команды.` });
      break;
    case 'coins-plus':
      await Team.addCoins(1, { type: 'coins', text: `${S.characterName} добавляет команде 1 монету.` });
      break;
    case 'coins-minus':
      await Team.addCoins(-1, { type: 'coins', text: `${S.characterName} убирает 1 монету из кошелька.` });
      break;

    case 'psy-fumble': {
      const paid = await Team.spendCoins(3, {
        type: 'psy-fumble',
        text: `${S.characterName} платит 3 монеты за крит-провал псайкера. Демон не приходит.`,
      });
      if (paid && !Team.shared) toast('Списано 3 монеты. Демон не пришёл');
      else if (!paid && !Team.shared) {
        toast(`В кошельке ${Team.coins} — не хватает. Получи урон за каждую неуплаченную монету`);
      }
      break;
    }

    case 'ult': {
      if (!card) break;
      const cost = parseInt(card.dataset.ultCost, 10);
      const ultName = $('.ult h3', card)?.textContent || 'Ультимейт';
      const paid = await Team.spendCoins(cost, {
        type: 'ultimate',
        text: `${S.characterName} применяет «${ultName}» и тратит ${cost} монет.`,
      });
      if (!paid) {
        if (!Team.shared) toast(`Нужно ${cost}, в кошельке ${Team.coins}`);
        break;
      }
      if (card.dataset.char === 'heretic') {
        await Team.clearTaint({
          type: 'apotheosis',
          text: `${S.characterName} завершает Апофеоз. Порча команды сброшена.`,
        });
        if (!Team.shared) toast('Апофеоз: монеты списаны, порча сброшена');
      } else if (!Team.shared) {
        toast(`Ультимейт применён, списано ${cost}`);
      }
      break;
    }
  }
}

/* ─────────────────────── запуск после Firebase Auth ─────────────────────── */

let eventsBound = false;
let activeUserId = null;

function bindEventsOnce() {
  if (eventsBound) return;
  eventsBound = true;

  document.addEventListener('click', onClick);

  $$('.hpdlg-quick button').forEach(b =>
    b.addEventListener('click', () => setAmount(+b.dataset.hpq)));
  $('#hpdlg-input').addEventListener('input', () =>
    $$('.hpdlg-quick button').forEach(b => b.classList.remove('is-on')));
  setAmount(1);

  $$('.sheetmenu').forEach(sm => sm.addEventListener('click', e => {
    if (e.target === sm) sm.hidden = true;
  }));

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(err =>
      console.warn('Service worker не зарегистрирован:', err));
  }
}

function prepareForUser(userId) {
  if (!userId) return BLANK();
  bindEventsOnce();
  activeUserId = userId;
  load(userId);
  buildChooser();
  return cloneState();
}

function presentForUser() {
  if (S.char && S.characterName && $(`.card[data-char="${S.char}"]`)) showApp();
  else showChooser();
}

function applyCloudState(nextState) {
  if (!nextState) return;
  suppressCloudSave = true;
  S = normalizeState(nextState);
  saveLocal();
  suppressCloudSave = false;
  stateListeners.forEach(listener => {
    try { listener(cloneState()); } catch (error) { console.warn('State listener:', error); }
  });
  buildChooser();
  if (S.char && S.characterName) showApp();
  else showChooser();
}

function setCloudSaver(fn) {
  cloudSaver = typeof fn === 'function' ? fn : null;
}

function setCloudStatus(status, error) {
  const el = $('#cloud-status');
  if (!el) return;
  const labels = {
    loading: 'Облако: загрузка…',
    waiting: 'Облако: ждёт сохранения',
    saving: 'Облако: сохраняем…',
    synced: 'Облако: синхронизировано',
    offline: 'Облако: нет сети, есть локальная копия',
    error: 'Облако: ошибка доступа',
  };
  el.textContent = labels[status] || 'Облако: —';
  el.dataset.state = status || '';
  if (error) el.title = error.code || error.message || String(error);
}

function stopForLogout() {
  activeUserId = null;
  cloudSaver = null;
  S = BLANK();
  ['#chooser', '#topbar', '#partybar', '#teambar', '#app', '#menu', '#hpdlg', '#profiledlg', '#lobbydlg', '#memberdlg'].forEach(sel => {
    const el = $(sel);
    if (el) el.hidden = true;
  });
}

function setTeamAdapter(adapter) {
  teamAdapter = adapter || null;
  render();
}

function setTeamCode(code) {
  S.teamCode = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  save();
}

function onStateChange(listener) {
  if (typeof listener !== 'function') return () => {};
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

window.LegendyApp = {
  prepare: prepareForUser,
  present: presentForUser,
  stop: stopForLogout,
  applyCloudState,
  setCloudSaver,
  setCloudStatus,
  setTeamAdapter,
  setTeamCode,
  onStateChange,
  refresh: render,
  notify: toast,
  exportState: cloneState,
  get userId() { return activeUserId; },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindEventsOnce, { once: true });
} else {
  bindEventsOnce();
}
