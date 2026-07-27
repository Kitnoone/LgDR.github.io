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
const Arsenal = window.LegendyArsenal;
if (!Arsenal) throw new Error('arsenal.js не загружен');

const BLANK = () => ({
  char: null,
  characterName: '',
  inventory: {
    armorId: '',
    weaponIds: [],
    gearIds: [],
    /* старые поля оставлены только для однократной миграции */
    armor: '', weapon: '', damage: '', items: [],
  },
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
  next.inventory = Object.assign({
    armorId: '', weaponIds: [], gearIds: [],
    armor: '', weapon: '', damage: '', items: [],
  }, raw?.inventory || {});
  if (!Array.isArray(next.inventory.weaponIds)) next.inventory.weaponIds = [];
  if (!Array.isArray(next.inventory.gearIds)) next.inventory.gearIds = [];
  if (!Array.isArray(next.inventory.items)) next.inventory.items = [];

  /* Миграция старой ручной записи снаряжения в новый каталог. */
  if (!next.inventory.armorId && next.inventory.armor) {
    next.inventory.armorId = Arsenal.findArmorByName(next.inventory.armor)?.id || '';
  }
  if (!next.inventory.weaponIds.length && next.inventory.weapon) {
    const migratedWeapon = Arsenal.findWeaponByName(next.inventory.weapon);
    if (migratedWeapon && !migratedWeapon.builtIn) next.inventory.weaponIds = [migratedWeapon.id];
  }
  if (!next.inventory.gearIds.length && next.inventory.items.length) {
    next.inventory.gearIds = next.inventory.items
      .map(name => Arsenal.findGearByName(name)?.id)
      .filter(Boolean);
  }

  next.inventory.weaponIds = next.inventory.weaponIds
    .filter(id => !!Arsenal.weaponById[id] && !Arsenal.weaponById[id].builtIn)
    .slice(0, 12);
  const seenGear = new Set();
  next.inventory.gearIds = next.inventory.gearIds
    .filter(id => {
      const item = Arsenal.gearById[id];
      if (!item) return false;
      if (next.char && !Arsenal.allowed(item, next.char)) return false;
      if (!item.stackable && seenGear.has(id)) return false;
      seenGear.add(id);
      return true;
    })
    .slice(0, 40);
  if (!next.inventory.armorId && next.char) {
    next.inventory.armorId = Arsenal.DEFAULT_ARMOR[next.char] || '';
  }
  if (next.inventory.armorId && next.char) {
    const armor = Arsenal.armorById[next.inventory.armorId];
    if (!armor || !Arsenal.allowed(armor, next.char)) {
      next.inventory.armorId = Arsenal.DEFAULT_ARMOR[next.char] || '';
    }
  }
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
  const currentArmor = Arsenal.armorById[S.inventory.armorId];
  if (!currentArmor || !Arsenal.allowed(currentArmor, id)) {
    S.inventory.armorId = card?.dataset.defaultArmorId || Arsenal.DEFAULT_ARMOR[id] || '';
  }
  S.inventory.gearIds = S.inventory.gearIds.filter(itemId =>
    Arsenal.allowed(Arsenal.gearById[itemId], id));
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

/* ─────────────────────────── арсенал ─────────────────────────── */

let arsenalMode = 'armor';
let arsenalSearch = '';
let detailContext = null;

function inventory() {
  if (!S.inventory) S.inventory = BLANK().inventory;
  if (!Array.isArray(S.inventory.weaponIds)) S.inventory.weaponIds = [];
  if (!Array.isArray(S.inventory.gearIds)) S.inventory.gearIds = [];
  return S.inventory;
}

function equippedArmor() {
  return Arsenal.armorById[inventory().armorId] || null;
}

function handCapacity(armor = equippedArmor()) {
  return 2 + Number(armor?.extraHands || 0);
}

function usedHands() {
  const inv = inventory();
  return inv.weaponIds.reduce((sum, id) => sum + Number(Arsenal.weaponById[id]?.hands || 0), 0)
    + inv.gearIds.reduce((sum, id) => sum + Number(Arsenal.gearById[id]?.hands || 0), 0);
}

function armorClass() {
  const armor = equippedArmor();
  const base = Number(armor?.ac || 10);
  const bonus = inventory().gearIds.reduce((sum, id) => sum + Number(Arsenal.gearById[id]?.armorBonus || 0), 0);
  return base + bonus;
}

const HERETIC_PACT_ALIASES = Object.freeze({
  strength: 'strength',
  power: 'strength',
  'pact-strength': 'strength',
  'Пакт силы': 'strength',
  'пакт силы': 'strength',
  pride: 'pride',
  'Пакт гордыни': 'pride',
  'пакт гордыни': 'pride',
  eternity: 'eternity',
  'Пакт вечности': 'eternity',
  'пакт вечности': 'eternity',
});

function selectedHereticPact() {
  const raw = S.choice['heretic:pact'];
  if (raw == null) return null;
  const value = String(raw).trim();
  return HERETIC_PACT_ALIASES[value] || value.toLowerCase();
}

function effectiveStatValue(card, stat, taint = Team.taint) {
  const el = $(`.nums .val[data-stat="${stat}"]`, card);
  if (!el) return 0;

  const base = Number.parseInt(el.dataset.base, 10) || 0;
  const id = card.dataset.char;
  const taintBonus = card.dataset.taintBoost
    ? Math.max(0, Number.parseInt(taint, 10) || 0)
    : 0;

  /* Сначала формируем текущую характеристику, включая постоянный бонус
     Еретика от порчи. Пакт силы сначала даёт +2 к Силе, а затем удваивает
     итоговое значение. При нулевой порче: (0 + 2) × 2 = +4. */
  let value = base + taintBonus;
  if (id !== 'heretic') return value;

  const pact = selectedHereticPact();
  if (pact === 'pride') value += 1;
  if (pact === 'strength' && stat === 'strength') value = (value + 2) * 2;
  return value;
}

function weaponDamageText(weapon, card = activeCard()) {
  if (!weapon) return 'Урон не указан';
  if (!weapon.modifier || !card) return weapon.damage;
  const label = Arsenal.STAT_LABELS[weapon.modifier] || weapon.modifier;
  const value = effectiveStatValue(card, weapon.modifier);
  const multiplier = Number(weapon.modifierMultiplier || 1);
  if (multiplier === 1) return `${weapon.damage} + ${label} (${value >= 0 ? '+' : ''}${value})`;
  const total = value * multiplier;
  return `${weapon.damage} + ${multiplier}×${label} (${total >= 0 ? '+' : ''}${total})`;
}

function handsText(count) {
  count = Number(count || 0);
  if (count === 0) return 'не занимает рук';
  if (count === 1) return '1 рука';
  return `${count} руки`;
}

function restrictionFor(item, kind) {
  const card = activeCard();
  const archetype = card?.dataset.char || S.char || '';
  if (!Arsenal.allowed(item, archetype)) return item.restriction || 'Недоступно этому архетипу.';

  if (kind === 'armor') {
    const capacity = handCapacity(item);
    if (usedHands() > capacity) {
      const deficit = usedHands() - capacity;
      return `Сначала освободите ${deficit} ${deficit === 1 ? 'руку' : 'руки'}: эта броня оставляет только ${capacity}.`;
    }
    return '';
  }

  if (kind === 'gear' && !item.stackable && inventory().gearIds.includes(item.id)) {
    return 'Этот предмет уже находится в снаряжении.';
  }

  const free = handCapacity() - usedHands();
  if (Number(item.hands || 0) > free) {
    return `Не хватает свободных рук: нужно ${item.hands}, свободно ${Math.max(0, free)}.`;
  }
  return '';
}

function renderLoadout(card) {
  const inv = inventory();
  const armor = equippedArmor();
  const ac = armorClass();
  const capacity = handCapacity(armor);
  const occupied = usedHands();

  const armorButton = $('[data-loadout-armor-button]', card);
  if (armorButton) {
    armorButton.dataset.itemId = armor?.id || '';
    armorButton.dataset.kind = 'armor';
    armorButton.dataset.arsenalAction = armor ? 'detail' : 'open';
  }
  const armorName = $('[data-loadout-armor-name]', card);
  const armorMeta = $('[data-loadout-armor-meta]', card);
  const armorRule = $('[data-loadout-armor-rule]', card);
  if (armorName) armorName.textContent = armor?.name || 'Без брони';
  if (armorMeta) armorMeta.textContent = `КБ ${ac}${armor?.extraHands ? ' · 3 руки' : ''}`;
  if (armorRule) {
    const shieldBonus = ac - Number(armor?.ac || 10);
    const parts = [armor ? Arsenal.fullRule(armor) : 'Базовый класс брони: 10.'];
    if (shieldBonus > 0) parts.push(`Снаряжение повышает КБ ещё на ${shieldBonus}.`);
    armorRule.textContent = parts.filter(Boolean).join(' ');
  }

  const hands = $('[data-loadout-hands]', card);
  if (hands) {
    hands.innerHTML = '';
    for (let i = 0; i < capacity; i += 1) {
      const dot = document.createElement('i');
      dot.className = i < occupied ? 'is-used' : '';
      hands.appendChild(dot);
    }
  }
  const handsValue = $('[data-loadout-hands-value]', card);
  if (handsValue) handsValue.textContent = `${occupied} / ${capacity} занято`;
  const handsRow = $('.loadout-hands-row', card);
  if (handsRow) handsRow.classList.toggle('is-over', occupied > capacity);

  const weapons = $('[data-loadout-weapons]', card);
  if (weapons) {
    weapons.innerHTML = '';
    if (card.dataset.char === 'heretic') {
      weapons.appendChild(makeLoadoutChip('weapon', Arsenal.weaponById['heretic-claws'], -1, true, card));
    }
    inv.weaponIds.forEach((id, index) => {
      const item = Arsenal.weaponById[id];
      if (item) weapons.appendChild(makeLoadoutChip('weapon', item, index, false, card));
    });
    if (!weapons.children.length) weapons.innerHTML = '<span class="loadout-empty">Оружие не выбрано</span>';
  }

  const gear = $('[data-loadout-gear]', card);
  if (gear) {
    gear.innerHTML = '';
    const grouped = [];
    inv.gearIds.forEach((id, index) => {
      const previous = grouped.find(entry => entry.id === id);
      if (previous) previous.count += 1;
      else grouped.push({ id, index, count:1 });
    });
    grouped.forEach(entry => {
      const item = Arsenal.gearById[entry.id];
      if (item) gear.appendChild(makeLoadoutChip('gear', item, entry.index, false, card, entry.count));
    });
    if (!gear.children.length) gear.innerHTML = '<span class="loadout-empty">Снаряжение не выбрано</span>';
  }
}

function makeLoadoutChip(kind, item, index, builtIn, card, count = 1) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `loadout-chip${builtIn ? ' is-built-in' : ''}`;
  button.dataset.arsenalAction = 'detail';
  button.dataset.kind = kind;
  button.dataset.itemId = item.id;
  button.dataset.itemIndex = String(index);
  const subtitle = kind === 'weapon'
    ? `${weaponDamageText(item, card)} · ${handsText(item.hands)}`
    : `${handsText(item.hands)}${item.armorBonus ? ` · КБ +${item.armorBonus}` : ''}`;
  const rule = Arsenal.fullRule(item);
  button.innerHTML = `<b>${escapeForHtml(item.name)}${count > 1 ? ` ×${count}` : ''}</b>`
    + `<small>${escapeForHtml(subtitle)}</small>`
    + (rule ? `<p>${escapeForHtml(rule)}</p>` : '');
  return button;
}

function escapeForHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function openArsenal(kind) {
  arsenalMode = kind;
  arsenalSearch = '';
  const search = $('#arsenal-search');
  if (search) search.value = '';
  renderArsenalList();
  $('#arsenaldlg').hidden = false;
}

function closeArsenal() {
  $('#arsenaldlg').hidden = true;
}

function renderArsenalList() {
  const titles = { armor:'Выбор брони', weapon:'Выбор оружия', gear:'Выбор снаряжения' };
  $('#arsenal-title').textContent = titles[arsenalMode] || 'Арсенал';
  const list = $('#arsenal-list');
  list.innerHTML = '';
  const source = arsenalMode === 'armor' ? Arsenal.ARMOR : arsenalMode === 'weapon' ? Arsenal.WEAPONS.filter(x => !x.builtIn) : Arsenal.GEAR;
  const query = arsenalSearch.toLowerCase().trim();
  const groups = new Map();

  source.filter(item => !query || `${item.name} ${item.group || ''} ${Arsenal.fullRule(item)}`.toLowerCase().includes(query))
    .forEach(item => {
      const group = item.group || (arsenalMode === 'armor' ? 'Броня' : 'Прочее');
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(item);
    });

  groups.forEach((items, groupName) => {
    const section = document.createElement('section');
    section.className = 'arsenal-group';
    section.innerHTML = `<h3>${escapeForHtml(groupName)}</h3>`;
    items.forEach(item => {
      const reason = restrictionFor(item, arsenalMode);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `arsenal-row${reason ? ' is-disabled' : ''}`;
      row.dataset.arsenalAction = reason ? 'blocked' : 'equip';
      row.dataset.kind = arsenalMode;
      row.dataset.itemId = item.id;
      row.dataset.reason = reason;
      const primary = arsenalMode === 'armor'
        ? `КБ ${item.ac}${item.extraHands ? ' · 3 руки' : ''}`
        : arsenalMode === 'weapon'
          ? `${weaponDamageText(item)} · ${handsText(item.hands)}`
          : `${handsText(item.hands)}${item.armorBonus ? ` · КБ +${item.armorBonus}` : ''}`;
      row.innerHTML = `<span><b>${escapeForHtml(item.name)}</b><small>${escapeForHtml(primary)}</small></span>`
        + `<em>${escapeForHtml(reason || 'Выбрать')}</em>`;
      section.appendChild(row);
    });
    list.appendChild(section);
  });

  if (!list.children.length) list.innerHTML = '<p class="arsenal-empty">Ничего не найдено.</p>';
}

function equipArsenal(kind, itemId) {
  const inv = inventory();
  const map = kind === 'armor' ? Arsenal.armorById : kind === 'weapon' ? Arsenal.weaponById : Arsenal.gearById;
  const item = map[itemId];
  if (!item) return;
  const reason = restrictionFor(item, kind);
  if (reason) { toast(reason); return; }

  if (kind === 'armor') inv.armorId = item.id;
  else if (kind === 'weapon') inv.weaponIds.push(item.id);
  else inv.gearIds.push(item.id);

  save();
  render();
  closeArsenal();
  toast(`${item.name}: добавлено`);
}

function openItemDetail(kind, itemId, index = -1) {
  const map = kind === 'armor' ? Arsenal.armorById : kind === 'weapon' ? Arsenal.weaponById : Arsenal.gearById;
  const item = map[itemId];
  if (!item) return;
  detailContext = { kind, itemId, index:Number(index) };
  $('#item-detail-kicker').textContent = kind === 'armor' ? 'Броня' : kind === 'weapon' ? 'Оружие' : 'Снаряжение';
  $('#item-detail-name').textContent = item.name;
  $('#item-detail-primary').textContent = kind === 'armor'
    ? `Класс брони: ${item.ac}${item.extraHands ? ' · даёт третью руку' : ''}`
    : kind === 'weapon'
      ? `Урон: ${weaponDamageText(item)} · ${handsText(item.hands)}`
      : `${handsText(item.hands)}${item.armorBonus ? ` · КБ +${item.armorBonus}` : ''}`;
  $('#item-detail-rule').textContent = Arsenal.fullRule(item) || 'Дополнительных правил нет.';
  const change = $('.item-change', $('#itemdetaildlg'));
  if (change) change.textContent = kind === 'armor' ? 'Выбрать другую броню' : 'Открыть арсенал';
  const remove = $('#item-detail-remove');
  const builtIn = !!item.builtIn;
  remove.hidden = builtIn;
  remove.disabled = false;
  remove.textContent = kind === 'armor' ? '✕ Снять броню' : kind === 'weapon' ? '✕ Снять оружие' : '✕ Снять предмет';
  const note = $('#item-detail-note');
  note.textContent = builtIn ? 'Врождённое оружие Еретика. Его нельзя снять.' : '';
  if (kind === 'armor' && handCapacity(null) < usedHands()) {
    remove.disabled = true;
    const deficit = usedHands() - 2;
    note.textContent = `Сначала освободите ${deficit} ${deficit === 1 ? 'руку' : 'руки'}: без этой брони останется только две.`;
  }
  $('#itemdetaildlg').hidden = false;
}

function removeDetailedItem() {
  if (!detailContext) return;
  const { kind, itemId, index } = detailContext;
  const inv = inventory();
  if (kind === 'armor') {
    if (usedHands() > 2) { toast('Сначала освободите лишнюю руку'); return; }
    inv.armorId = '';
  } else if (kind === 'weapon') {
    if (index < 0) return;
    inv.weaponIds.splice(index, 1);
  } else {
    const actualIndex = index >= 0 && inv.gearIds[index] === itemId ? index : inv.gearIds.indexOf(itemId);
    if (actualIndex >= 0) inv.gearIds.splice(actualIndex, 1);
  }
  save(); render();
  $('#itemdetaildlg').hidden = true;
  detailContext = null;
  toast('Предмет снят');
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

  /* здоровье */
  const cur = hpCur(card), max = hpMax(card);
  $('[data-hp-cur]', card).textContent = cur;
  card.classList.toggle('is-hurt', cur > 0 && cur <= max / 2);
  card.classList.toggle('is-down', cur <= 0);
  $('[data-hp-mirror]').textContent = `${cur}/${max}`;

  /* Характеристики.
     Числовые эффекты пактов считаются по устойчивому data-stat, а не по
     видимой подписи. Так Пакт силы работает одинаково на телефоне, ПК
     и после любых правок текста карточки. */
  $$('.nums .val', card).forEach(el => {
    const base = parseInt(el.dataset.base, 10);
    const stat = el.dataset.stat || '';
    const v = effectiveStatValue(card, stat, taint);
    el.textContent = v >= 0 ? `+${v}` : `\u2212${Math.abs(v)}`;
    el.classList.toggle('neg', v < 0);
    el.classList.toggle('is-boosted', v !== base);
  });

  renderLoadout(card);

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

    const state = $('.pick-state', p);
    if (state && id === 'heretic' && group === 'pact' && p.dataset.pick === 'strength') {
      const strength = effectiveStatValue(card, 'strength', taint);
      state.textContent = isMe
        ? `Пакт действует · текущая Сила ${strength >= 0 ? '+' : ''}${strength}`
        : '';
      state.setAttribute('aria-hidden', isMe ? 'false' : 'true');
    }
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
  if (!activeCard()) return;
  $('#profile-name').value = S.characterName || '';
  $('#profiledlg').hidden = false;
}

function saveProfile() {
  const name = $('#profile-name').value.trim();
  if (!name) {
    toast('Имя персонажа не может быть пустым');
    return;
  }
  S.characterName = name.slice(0, 40);
  save();
  render();
  $('#profiledlg').hidden = true;
  toast('Имя персонажа сохранено');
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

  const arsenalButton = e.target.closest('[data-arsenal-action]');
  if (arsenalButton) {
    const action = arsenalButton.dataset.arsenalAction;
    const kind = arsenalButton.dataset.kind || '';
    const itemId = arsenalButton.dataset.itemId || '';
    const index = Number(arsenalButton.dataset.itemIndex ?? -1);
    if (action === 'open') openArsenal(kind);
    else if (action === 'close') closeArsenal();
    else if (action === 'equip') equipArsenal(kind, itemId);
    else if (action === 'blocked') toast(arsenalButton.dataset.reason || 'Этот предмет недоступен');
    else if (action === 'detail') openItemDetail(kind, itemId, index);
    else if (action === 'close-detail') { $('#itemdetaildlg').hidden = true; detailContext = null; }
    else if (action === 'remove') removeDetailedItem();
    else if (action === 'change') { $('#itemdetaildlg').hidden = true; openArsenal(detailContext?.kind || kind); }
    return;
  }

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
    const nextChoice = S.choice[key] === pick.dataset.pick ? undefined : pick.dataset.pick;
    if (nextChoice) S.choice[key] = nextChoice;
    else delete S.choice[key];

    /* Отрисовываем производные характеристики до сетевого сохранения.
       Поэтому изменение видно немедленно даже при медленном Firestore. */
    render();
    save();

    if (card.dataset.char === 'heretic' && pick.dataset.group === 'pact') {
      const pact = selectedHereticPact();
      if (pact === 'strength') {
        const strength = effectiveStatValue(card, 'strength');
        toast(`Пакт силы применён: Сила ${strength >= 0 ? '+' : ''}${strength}`);
      } else if (pact === 'pride') {
        toast('Пакт гордыни: +1 ко всем характеристикам');
      }
    }
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

  const arsenalSearchInput = $('#arsenal-search');
  if (arsenalSearchInput) arsenalSearchInput.addEventListener('input', event => {
    arsenalSearch = event.target.value || '';
    renderArsenalList();
  });

  $$('.sheetmenu').forEach(sm => sm.addEventListener('click', e => {
    if (e.target === sm) sm.hidden = true;
  }));

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js?v=pact-strength-3', { updateViaCache: 'none' }).catch(err =>
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
  ['#chooser', '#topbar', '#partybar', '#teambar', '#app', '#menu', '#hpdlg', '#profiledlg', '#arsenaldlg', '#itemdetaildlg', '#lobbydlg', '#memberdlg'].forEach(sel => {
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
  getEffectiveStats() {
    const card = activeCard();
    if (!card) return {};
    return Object.fromEntries($$('.nums .val[data-stat]', card).map(el => [
      el.dataset.stat,
      effectiveStatValue(card, el.dataset.stat),
    ]));
  },
  getSelectedHereticPact: selectedHereticPact,
  getLoadoutSummary() {
    const card = activeCard();
    const armor = equippedArmor();
    return {
      armorId: armor?.id || '',
      armorName: armor?.name || 'Без брони',
      armorClass: armorClass(),
      weaponNames: [
        ...(card?.dataset.char === 'heretic' ? [Arsenal.weaponById['heretic-claws'].name] : []),
        ...inventory().weaponIds.map(id => Arsenal.weaponById[id]?.name).filter(Boolean),
      ],
      gearNames: inventory().gearIds.map(id => Arsenal.gearById[id]?.name).filter(Boolean),
      handsUsed: usedHands(),
      handsMax: handCapacity(),
    };
  },
  get userId() { return activeUserId; },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindEventsOnce, { once: true });
} else {
  bindEventsOnce();
}
