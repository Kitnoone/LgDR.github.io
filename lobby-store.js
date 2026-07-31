/* ==================================================================
   ЛЕГЕНДЫ ПОДЗЕМЕЛИЙ · командное лобби
   ------------------------------------------------------------------
   Один документ Firestore на одну команду: teams/{CODE}
   В документе живут участники, общая порча, монеты и короткий журнал.
   Все изменения ресурсов выполняются транзакциями: одновременные нажатия
   разных игроков не перезаписывают друг друга.
   ================================================================== */

import { db } from './firebase-config.js?v=gm-html-reader-1';
import {
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MIN_MEMBERS = 3;
const MAX_MEMBERS = 8;
const MAX_TAINT = 8;
const MAX_EVENTS = 12;

let activeUid = null;
let activeCode = '';
let teamData = null;
let unsubscribeTeam = null;
let stateUnsubscribe = null;
let lastEventSeq = null;
let lastSummarySerialized = '';
let summaryTimer = null;
let busy = false;
let handlerBound = false;
let ignoreStateCode = false;
let codeSwitchTimer = null;

function app() {
  return window.LegendyApp;
}


function persistTeamCode(code) {
  ignoreStateCode = true;
  app()?.setTeamCode?.(code);
  ignoreStateCode = false;
}
function cleanText(value, max = 50) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function cleanCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function randomCode() {
  const bytes = new Uint32Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, n => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}

function memberValues(data = teamData) {
  if (!data?.members) return [];
  return (data.memberIds || [])
    .map(uid => data.members[uid])
    .filter(Boolean);
}

function statusFor(count) {
  if (count >= MAX_MEMBERS) return { key: 'full', text: `Команда заполнена · ${count}/${MAX_MEMBERS}` };
  if (count >= MIN_MEMBERS) return { key: 'active', text: `Команда готова · ${count}/${MAX_MEMBERS}` };
  return { key: 'forming', text: `Формируется · ${count}/${MIN_MEMBERS} минимум` };
}

function ownSummary() {
  const state = app()?.exportState?.() || {};
  const card = state.char ? $(`.card[data-char="${state.char}"]`) : null;
  const maxHp = card ? Number(card.dataset.hpMax || 0) : 0;
  const hp = state.char && state.hp?.[state.char] !== undefined
    ? Number(state.hp[state.char])
    : maxHp;
  const foundation = state.char === 'neophyte'
    ? String(state.choice?.['neophyte:foundation'] || '')
    : '';

  return {
    uid: activeUid,
    name: cleanText(state.characterName || 'Без имени', 40),
    archetype: String(state.char || ''),
    archetypeName: card ? cleanText($('.head .eyebrow', card)?.textContent, 50) : '',
    hp: Math.max(0, hp || 0),
    hpMax: Math.max(0, maxHp || 0),
    foundation,
    loadout: app()?.getLoadoutSummary?.() || null,
  };
}

function hasCursedFoundation(data) {
  return memberValues(data).some(member =>
    member.archetype === 'neophyte' && member.foundation === 'cursed');
}

function appendEvent(data, text, type = 'system') {
  const seq = Number(data.eventSeq || 0) + 1;
  const event = {
    seq,
    id: `${seq}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    text: cleanText(text, 180),
    actorUid: activeUid,
    atMs: Date.now(),
  };
  const events = [...(Array.isArray(data.events) ? data.events : []), event].slice(-MAX_EVENTS);
  return { seq, event, events };
}

function humanError(error) {
  const code = error?.code || '';
  const message = String(error?.message || '');
  if (message.includes('TEAM_FULL')) return 'В команде уже восемь участников.';
  if (message.includes('TEAM_NOT_FOUND')) return 'Лобби с таким кодом не найдено.';
  if (message.includes('TEAM_NOT_READY')) return 'Для общей игры нужно хотя бы три участника.';
  if (message.includes('NOT_MEMBER')) return 'Вы больше не состоите в этом лобби.';
  if (message.includes('INSUFFICIENT_COINS')) return 'В командном кошельке недостаточно монет.';
  if (message.includes('CHARACTER_REQUIRED')) return 'Сначала создайте и назовите персонажа.';
  if (message.includes('CODE_COLLISION')) return 'Не удалось создать уникальный код. Повторите.';
  if (code === 'permission-denied') return 'Firebase отклонил действие. Проверьте новые Firestore Rules.';
  if (code === 'unavailable') return 'Нет связи с Firebase. Попробуйте ещё раз после восстановления сети.';
  return 'Не удалось выполнить действие с лобби.';
}

function setLobbyMessage(text = '', kind = '') {
  const el = $('#lobby-message');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-ok', kind === 'ok');
}

function setBusy(next) {
  busy = next;
  $$('[data-lobby-act]').forEach(button => {
    if (!['open', 'close', 'member'].includes(button.dataset.lobbyAct)) button.disabled = next;
  });
}

function showLobbySheet() {
  renderLobby();
  $('#menu') && ($('#menu').hidden = true);
  $('#lobbydlg').hidden = false;
}

function hideLobbySheet() {
  $('#lobbydlg').hidden = true;
  setLobbyMessage('');
}

function renderLobby() {
  const guest = $('#lobby-empty');
  const joined = $('#lobby-joined');
  if (!guest || !joined) return;

  const hasTeam = !!(activeCode && teamData);
  guest.hidden = hasTeam;
  joined.hidden = !hasTeam;

  const topLabel = $('#top-lobby-label');
  if (topLabel) topLabel.textContent = hasTeam ? `${teamData.memberCount || 0}/8` : 'Лобби';

  if (!hasTeam) return;

  const count = Number(teamData.memberCount || memberValues().length);
  const status = statusFor(count);
  $('#lobby-name-view').textContent = teamData.name || 'Безымянная команда';
  $('#lobby-code-view').textContent = activeCode;
  $('#lobby-status').textContent = status.text;
  $('#lobby-status').dataset.state = status.key;
  $('#lobby-resource-note').textContent = count < MIN_MEMBERS
    ? 'Общие монеты и порча включатся, когда войдёт третий участник.'
    : 'Монеты и порча синхронизируются у всех участников.';

  const list = $('#lobby-members');
  list.innerHTML = '';
  (teamData.memberIds || []).forEach((uid, index) => {
    const member = teamData.members?.[uid];
    if (!member) return;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `lobby-member${uid === activeUid ? ' is-self' : ''}`;
    row.dataset.lobbyAct = 'member';
    row.dataset.memberUid = uid;
    row.innerHTML = `<span class="lobby-member-num">${index + 1}</span>` +
      `<span class="lobby-member-main"><b>${escapeHtml(member.name || 'Без имени')}</b>` +
      `<small>${escapeHtml(member.archetypeName || member.archetype || 'Архетип не выбран')}</small></span>` +
      `<span class="lobby-member-hp">${Number(member.hp || 0)}/${Number(member.hpMax || 0)}</span>` +
      `${uid === teamData.ownerId ? '<i>создатель</i>' : ''}`;
    list.appendChild(row);
  });

  const events = $('#lobby-events');
  if (events) {
    events.innerHTML = '';
    const recent = [...(Array.isArray(teamData.events) ? teamData.events : [])].slice(-6).reverse();
    if (!recent.length) {
      events.innerHTML = '<p class="lobby-events-empty">Событий пока нет.</p>';
    } else {
      recent.forEach(entry => {
        const row = document.createElement('div');
        row.className = `lobby-event lobby-event--${escapeHtml(entry.type || 'system')}`;
        const time = Number(entry.atMs || 0)
          ? new Date(Number(entry.atMs)).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
          : '';
        row.innerHTML = `<span>${escapeHtml(time)}</span><p>${escapeHtml(entry.text || '')}</p>`;
        events.appendChild(row);
      });
    }
  }

  const leave = $('#lobby-leave');
  if (leave) leave.querySelector('b').textContent =
    teamData.ownerId === activeUid && count === 1 ? 'Удалить лобби' : 'Покинуть лобби';
}

function renderPartyBar() {
  const bar = $('#partybar');
  const list = $('#party-list');
  if (!bar || !list) return;

  const visible = !!(activeCode && teamData);
  bar.hidden = !visible;
  document.body.classList.toggle('has-partybar', visible);
  list.innerHTML = '';
  if (!visible) return;

  (teamData.memberIds || []).forEach(uid => {
    const member = teamData.members?.[uid];
    if (!member) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `party-chip${uid === activeUid ? ' is-self' : ''}`;
    chip.dataset.lobbyAct = 'member';
    chip.dataset.memberUid = uid;
    chip.innerHTML = `<span>${escapeHtml(member.name || 'Без имени')}</span>` +
      `<small>${escapeHtml(member.archetypeName || '—')}</small>`;
    list.appendChild(chip);
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function openMember(uid) {
  const member = teamData?.members?.[uid];
  if (!member) return;
  const card = member.archetype ? $(`.card[data-char="${member.archetype}"]`) : null;
  $('#member-name').textContent = member.name || 'Без имени';
  $('#member-archetype').textContent = member.archetypeName || 'Архетип не выбран';
  $('#member-hp').textContent = `${Number(member.hp || 0)} / ${Number(member.hpMax || 0)}`;
  $('#member-role').textContent = card ? $('.role', card)?.textContent || '' : '';

  const loadout = $('#member-loadout');
  const equipment = member.loadout || null;
  if (loadout) {
    loadout.hidden = !equipment;
    if (equipment) {
      const weapons = Array.isArray(equipment.weaponNames) && equipment.weaponNames.length
        ? equipment.weaponNames.join(', ') : 'не выбрано';
      const gear = Array.isArray(equipment.gearNames) && equipment.gearNames.length
        ? equipment.gearNames.join(', ') : 'не выбрано';
      loadout.innerHTML = `<b>Арсенал</b>`
        + `<p>Броня: ${escapeHtml(equipment.armorName || 'Без брони')} · Класс брони ${Number(equipment.armorClass || 10)}</p>`
        + `<p>Оружие: ${escapeHtml(weapons)}</p>`
        + `<p>Снаряжение: ${escapeHtml(gear)}</p>`
        + `<p>Руки: ${Number(equipment.handsUsed || 0)} / ${Number(equipment.handsMax || 2)}</p>`;
    } else loadout.innerHTML = '';
  }

  const tips = $('#member-tips');
  tips.innerHTML = '';
  if (card) {
    $$('.tips .grid > div', card).forEach(source => {
      const item = document.createElement('div');
      item.className = 'member-tip';
      item.innerHTML = `<b>${escapeHtml($('h4', source)?.textContent || '')}</b>` +
        `<p>${escapeHtml($('p', source)?.textContent || '')}</p>`;
      tips.appendChild(item);
    });
  }
  $('#memberdlg').hidden = false;
}

function closeMember() {
  $('#memberdlg').hidden = true;
}

function applySnapshot(data, first = false) {
  teamData = data;
  if (!teamData || !(teamData.memberIds || []).includes(activeUid)) {
    void detachMissingTeam();
    return;
  }

  const seq = Number(teamData.eventSeq || 0);
  if (lastEventSeq === null || first) {
    lastEventSeq = seq;
  } else if (seq > lastEventSeq) {
    const latest = (teamData.events || []).find(event => Number(event.seq) === seq)
      || (teamData.events || []).at(-1);
    lastEventSeq = seq;
    if (latest?.text) app()?.notify?.(latest.text);
  }

  renderLobby();
  renderPartyBar();
  app()?.refresh?.();
}

async function detachMissingTeam() {
  stopTeamListener();
  activeCode = '';
  teamData = null;
  app()?.setTeamAdapter?.(null);
  persistTeamCode('');
  renderLobby();
  renderPartyBar();
  app()?.notify?.('Лобби больше не существует или вы были исключены.');
}

function stopTeamListener() {
  if (unsubscribeTeam) unsubscribeTeam();
  unsubscribeTeam = null;
  lastEventSeq = null;
}

async function connectTeam(code, silent = false) {
  stopTeamListener();
  activeCode = cleanCode(code);
  if (!activeCode) {
    teamData = null;
    app()?.setTeamAdapter?.(null);
    renderLobby();
    renderPartyBar();
    return false;
  }

  const ref = doc(db, 'teams', activeCode);
  const first = await getDoc(ref);
  if (!first.exists() || !(first.data().memberIds || []).includes(activeUid)) {
    activeCode = '';
    teamData = null;
    app()?.setTeamAdapter?.(null);
    persistTeamCode('');
    renderLobby();
    renderPartyBar();
    if (!silent) app()?.notify?.('Сохранённое лобби не найдено.');
    return false;
  }

  applySnapshot(first.data(), true);
  app()?.setTeamAdapter?.(teamAdapter);

  unsubscribeTeam = onSnapshot(ref, snapshot => {
    if (!snapshot.exists()) {
      void detachMissingTeam();
      return;
    }
    applySnapshot(snapshot.data());
  }, error => {
    console.error('Lobby listener:', error);
    app()?.notify?.(humanError(error));
  });
  scheduleSummarySync(true);
  return true;
}

async function createLobby(name) {
  const summary = ownSummary();
  if (!summary.archetype || !summary.name) throw new Error('CHARACTER_REQUIRED');
  const lobbyName = cleanText(name, 50) || `${summary.name} и отряд`;

  for (let attempt = 0; attempt < 7; attempt += 1) {
    const code = randomCode();
    const ref = doc(db, 'teams', code);
    try {
      await runTransaction(db, async transaction => {
        const existing = await transaction.get(ref);
        if (existing.exists()) throw new Error('CODE_COLLISION');
        const firstEvent = {
          seq: 1,
          id: `1-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          type: 'join',
          text: `${summary.name} создаёт лобби «${lobbyName}».`,
          actorUid: activeUid,
          atMs: Date.now(),
        };
        transaction.set(ref, {
          schemaVersion: 1,
          code,
          name: lobbyName,
          ownerId: activeUid,
          memberIds: [activeUid],
          members: { [activeUid]: summary },
          memberCount: 1,
          taint: 0,
          coins: 0,
          eventSeq: 1,
          events: [firstEvent],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });
      persistTeamCode(code);
      await connectTeam(code, true);
      return code;
    } catch (error) {
      if (!String(error?.message || '').includes('CODE_COLLISION')) throw error;
    }
  }
  throw new Error('CODE_COLLISION');
}

async function joinLobby(code) {
  const summary = ownSummary();
  if (!summary.archetype || !summary.name) throw new Error('CHARACTER_REQUIRED');
  const normalized = cleanCode(code);
  if (normalized.length !== 6) throw new Error('TEAM_NOT_FOUND');
  const ref = doc(db, 'teams', normalized);

  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new Error('TEAM_NOT_FOUND');
    const data = snapshot.data();
    const ids = [...(data.memberIds || [])];
    if (ids.includes(activeUid)) return;
    if (ids.length >= MAX_MEMBERS) throw new Error('TEAM_FULL');

    ids.push(activeUid);
    const members = { ...(data.members || {}), [activeUid]: summary };
    const event = appendEvent(data, `${summary.name} вступает в команду.`, 'join');
    transaction.update(ref, {
      memberIds: ids,
      members,
      memberCount: ids.length,
      eventSeq: event.seq,
      events: event.events,
      updatedAt: serverTimestamp(),
    });
  });

  persistTeamCode(normalized);
  await connectTeam(normalized, true);
}

async function leaveLobby() {
  if (!activeCode) return;
  const code = activeCode;
  const ref = doc(db, 'teams', code);
  const summary = ownSummary();

  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) return;
    const data = snapshot.data();
    const ids = [...(data.memberIds || [])];
    if (!ids.includes(activeUid)) throw new Error('NOT_MEMBER');

    const nextIds = ids.filter(uid => uid !== activeUid);
    if (nextIds.length === 0) {
      transaction.delete(ref);
      return;
    }

    const members = { ...(data.members || {}) };
    delete members[activeUid];
    const nextOwner = data.ownerId === activeUid ? nextIds[0] : data.ownerId;
    const event = appendEvent(data, `${summary.name} покидает команду.`, 'leave');
    transaction.update(ref, {
      ownerId: nextOwner,
      memberIds: nextIds,
      members,
      memberCount: nextIds.length,
      eventSeq: event.seq,
      events: event.events,
      updatedAt: serverTimestamp(),
    });
  });

  stopTeamListener();
  activeCode = '';
  teamData = null;
  app()?.setTeamAdapter?.(null);
  persistTeamCode('');
  renderLobby();
  renderPartyBar();
  hideLobbySheet();
  app()?.notify?.('Вы покинули лобби.');
}

async function mutateResources(options = {}) {
  if (!activeCode || !teamData) throw new Error('NOT_MEMBER');
  const ref = doc(db, 'teams', activeCode);
  let result = null;

  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new Error('TEAM_NOT_FOUND');
    const data = snapshot.data();
    if (!(data.memberIds || []).includes(activeUid)) throw new Error('NOT_MEMBER');
    if (Number(data.memberCount || 0) < MIN_MEMBERS) throw new Error('TEAM_NOT_READY');

    const taintBefore = Math.min(MAX_TAINT, Math.max(0, Number(data.taint || 0)));
    let taint = taintBefore;
    let coins = Math.max(0, Number(data.coins || 0));
    let actualTaintDelta = Number(options.taintDelta || 0);
    const coinDelta = Number(options.coinDelta || 0);
    const coinCost = Math.max(0, Number(options.coinCost || 0));

    if (coinCost > coins) throw new Error('INSUFFICIENT_COINS');

    let cursedBonus = 0;
    if (actualTaintDelta > 0 && hasCursedFoundation(data)) {
      cursedBonus = 1;
      actualTaintDelta += 1;
    }

    if (options.clearTaint) taint = 0;
    else taint = Math.min(MAX_TAINT, Math.max(0, taint + actualTaintDelta));
    const appliedTaintDelta = taint - taintBefore;
    coins = Math.max(0, coins + coinDelta - coinCost);

    const actor = data.members?.[activeUid]?.name || ownSummary().name;
    const defaultText = options.clearTaint
      ? `${actor} сбрасывает порчу команды.`
      : appliedTaintDelta !== 0
        ? `${actor} изменяет порчу на ${appliedTaintDelta > 0 ? '+' : ''}${appliedTaintDelta}.`
        : coinCost > 0
          ? `${actor} тратит ${coinCost} монет.`
          : `${actor} изменяет монеты на ${coinDelta > 0 ? '+' : ''}${coinDelta}.`;
    let text = cleanText(options.text || defaultText, 180);
    if (cursedBonus && taint < MAX_TAINT) text += ' Проклятое основание добавляет ещё 1 порчу (не складывается).';
    else if (cursedBonus && taint >= MAX_TAINT) text += ` Достигнут предел Порчи: ${MAX_TAINT}.`;

    const event = appendEvent(data, text, options.type || 'resource');
    transaction.update(ref, {
      taint,
      coins,
      eventSeq: event.seq,
      events: event.events,
      updatedAt: serverTimestamp(),
    });
    result = { taint, coins, cursedBonus };
  });

  return result;
}

const teamAdapter = {
  get taint() { return Math.min(MAX_TAINT, Math.max(0, Number(teamData?.taint || 0))); },
  get coins() { return Math.max(0, Number(teamData?.coins || 0)); },
  get shared() { return !!teamData; },
  get ready() { return Number(teamData?.memberCount || 0) >= MIN_MEMBERS; },
  get memberCount() { return Number(teamData?.memberCount || 0); },
  async addTaint(delta, meta = {}) {
    try {
      return await mutateResources({ taintDelta: delta, text: meta.text, type: meta.type || 'taint' });
    } catch (error) {
      app()?.notify?.(humanError(error));
      throw error;
    }
  },
  async addCoins(delta, meta = {}) {
    try {
      return await mutateResources({ coinDelta: delta, text: meta.text, type: meta.type || 'coins' });
    } catch (error) {
      app()?.notify?.(humanError(error));
      throw error;
    }
  },
  async spendCoins(cost, meta = {}) {
    try {
      return await mutateResources({ coinCost: cost, text: meta.text, type: meta.type || 'spend' });
    } catch (error) {
      app()?.notify?.(humanError(error));
      return null;
    }
  },
  async clearTaint(meta = {}) {
    try {
      return await mutateResources({ clearTaint: true, text: meta.text, type: meta.type || 'taint' });
    } catch (error) {
      app()?.notify?.(humanError(error));
      return null;
    }
  },
};

function scheduleSummarySync(force = false) {
  if (!activeCode || !teamData || !activeUid) return;
  const summary = ownSummary();
  const serialized = JSON.stringify(summary);
  if (!force && serialized === lastSummarySerialized) return;
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(() => void syncOwnSummary(summary, serialized), 550);
}

async function syncOwnSummary(summary, serialized) {
  if (!activeCode || !teamData || !activeUid) return;
  const ref = doc(db, 'teams', activeCode);
  try {
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) throw new Error('TEAM_NOT_FOUND');
      const data = snapshot.data();
      if (!(data.memberIds || []).includes(activeUid)) throw new Error('NOT_MEMBER');
      const members = { ...(data.members || {}), [activeUid]: summary };
      transaction.update(ref, { members, updatedAt: serverTimestamp() });
    });
    lastSummarySerialized = serialized;
  } catch (error) {
    console.warn('Member summary sync:', error);
  }
}

async function copyCode() {
  if (!activeCode) return;
  try {
    await navigator.clipboard.writeText(activeCode);
    setLobbyMessage('Код скопирован.', 'ok');
  } catch {
    const el = $('#lobby-code-view');
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    setLobbyMessage('Код выделен. Скопируйте его вручную.', 'ok');
  }
}

async function handleLobbyAction(event) {
  const button = event.target.closest('[data-lobby-act]');
  if (!button) return;
  const action = button.dataset.lobbyAct;

  if (action === 'open') { showLobbySheet(); return; }
  if (action === 'close') { hideLobbySheet(); return; }
  if (action === 'member') { openMember(button.dataset.memberUid); return; }
  if (action === 'close-member') { closeMember(); return; }
  if (busy) return;

  setBusy(true);
  setLobbyMessage('');
  try {
    if (action === 'create') {
      const code = await createLobby($('#lobby-create-name').value);
      setLobbyMessage(`Лобби создано. Код: ${code}`, 'ok');
    } else if (action === 'join') {
      await joinLobby($('#lobby-join-code').value);
      setLobbyMessage('Вы вошли в лобби.', 'ok');
    } else if (action === 'copy') {
      await copyCode();
    } else if (action === 'leave') {
      if (confirm('Покинуть лобби?')) await leaveLobby();
    }
  } catch (error) {
    console.error('Lobby action:', error);
    setLobbyMessage(humanError(error), 'error');
  } finally {
    setBusy(false);
    renderLobby();
  }
}

export async function startLobbySession(uid) {
  stopLobbySession(false);
  activeUid = uid;
  if (!handlerBound) {
    document.addEventListener('click', handleLobbyAction);
    handlerBound = true;
  }
  stateUnsubscribe = app()?.onStateChange?.((state) => {
    const nextCode = cleanCode(state?.teamCode || '');
    if (!ignoreStateCode && nextCode !== activeCode) {
      clearTimeout(codeSwitchTimer);
      codeSwitchTimer = setTimeout(() => {
        void connectTeam(nextCode, true).catch(error => console.warn('Lobby code sync:', error));
      }, 20);
      return;
    }
    scheduleSummarySync();
  }) || null;
  const state = app()?.exportState?.() || {};
  try {
    if (state.teamCode) await connectTeam(state.teamCode, true);
    else {
      app()?.setTeamAdapter?.(null);
      renderLobby();
      renderPartyBar();
    }
  } catch (error) {
    console.error('Lobby start:', error);
    activeCode = '';
    teamData = null;
    app()?.setTeamAdapter?.(null);
    renderLobby();
    renderPartyBar();
    app()?.notify?.(humanError(error));
  }
}

export function stopLobbySession(removeHandler = true) {
  clearTimeout(summaryTimer);
  clearTimeout(codeSwitchTimer);
  summaryTimer = null;
  codeSwitchTimer = null;
  stopTeamListener();
  if (stateUnsubscribe) stateUnsubscribe();
  stateUnsubscribe = null;
  if (removeHandler && handlerBound) {
    document.removeEventListener('click', handleLobbyAction);
    handlerBound = false;
  }
  activeUid = null;
  activeCode = '';
  teamData = null;
  lastSummarySerialized = '';
  app()?.setTeamAdapter?.(null);
  renderLobby();
  renderPartyBar();
}

export function refreshLobbyFromState() {
  scheduleSummarySync(true);
}
