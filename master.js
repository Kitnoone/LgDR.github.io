import { auth, db } from './firebase-config.js?v=gm-html-reader-1';
import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js';

const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const Arsenal = window.LegendyArsenal;
const MasterData = window.LegendyMasterData;
if (!Arsenal || !MasterData) throw new Error('Не загружены данные арсенала или классов.');

const ui = {
  auth: $('#gm-auth'), denied: $('#gm-denied'), dashboard: $('#gm-dashboard'),
  authForm: $('#gm-login-form'), email: $('#gm-email'), password: $('#gm-password'), authMessage: $('#gm-auth-message'),
  deniedUid: $('#gm-denied-uid'), accountEmail: $('#gm-account-email'),
  lobbyList: $('#gm-lobby-list'), lobbyCount: $('#gm-lobby-count'), lobbyMessage: $('#gm-lobby-message'),
  scenarioList: $('#gm-scenario-list'), scenarioCount: $('#gm-scenario-count'), scenarioMessage: $('#gm-scenario-message'),
  scenarioUpload: $('#gm-scenario-upload'), scenarioTitle: $('#gm-scenario-title'), scenarioFile: $('#gm-scenario-file'), scenarioSearch: $('#gm-scenario-search'),
  teamModal: $('#gm-team-modal'), teamCode: $('#gm-team-code'), teamName: $('#gm-team-name'), teamMembers: $('#gm-team-members'), teamTaint: $('#gm-team-taint'), teamCoins: $('#gm-team-coins'), playerList: $('#gm-player-list'), dissolve: $('#gm-dissolve-team'),
  scenarioModal: $('#gm-scenario-modal'), scenarioViewTitle: $('#gm-scenario-view-title'), scenarioViewContent: $('#gm-scenario-view-content'),
  readerLobbiesButton: $('#gm-reader-lobbies-button'), readerLobbyCount: $('#gm-reader-lobby-count'), readerLobbyDrawer: $('#gm-reader-lobby-drawer'), readerLobbyList: $('#gm-reader-lobby-list'),
  toast: $('#gm-toast'),
};

let activeUser = null;
let unsubscribeTeams = null;
let unsubscribeScenarios = null;
let unsubscribeOpenTeam = null;
const characterUnsubs = new Map();
const characterStates = new Map();
let teams = [];
let scenarios = [];
let bundledScenarios = [];
let openTeamCode = '';
let openTeamData = null;
let toastTimer = null;

function setMessage(el, text='', kind='') { el.textContent = text; el.className = 'gm-message' + (kind ? ` is-${kind}` : ''); }
function escapeHtml(v='') { return String(v).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }
function cleanText(v, max=100) { return String(v || '').trim().replace(/\s+/g,' ').slice(0,max); }
function toast(text) { clearTimeout(toastTimer); ui.toast.textContent = text; ui.toast.hidden = false; toastTimer=setTimeout(()=>{ui.toast.hidden=true;},2600); }
function formatDate(value) { try { const d=value?.toDate ? value.toDate() : new Date(value); return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short'}).format(d); } catch { return '—'; } }
function humanError(error) { const code=error?.code||''; const known={'permission-denied':'Недостаточно прав. Проверьте роль мастера и Firestore Rules.','auth/invalid-credential':'Неверная почта или пароль.','auth/network-request-failed':'Нет связи с Firebase.'}; return known[code] || `Ошибка: ${code || error?.message || 'неизвестная'}`; }

function showGate(which) { ui.auth.hidden=which!=='auth'; ui.denied.hidden=which!=='denied'; ui.dashboard.hidden=which!=='dashboard'; }

async function hasGmRole(uid) { const snap=await getDoc(doc(db,'roles',uid)); return snap.exists() && snap.data()?.role === 'gm'; }

function stopDataListeners() {
  if (unsubscribeTeams) unsubscribeTeams(); unsubscribeTeams=null;
  if (unsubscribeScenarios) unsubscribeScenarios(); unsubscribeScenarios=null;
  closeTeam();
  teams=[]; scenarios=[];
}

function startDashboard() {
  ui.accountEmail.textContent=activeUser?.email || 'Аккаунт мастера';
  showGate('dashboard');
  void loadBundledScenarios();
  subscribeTeams();
  subscribeScenarios();
}

async function loadBundledScenarios() {
  try {
    const response = await fetch('./assets/scenarios/prolog-verstka.html?v=gm-html-reader-1', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const content = await response.text();
    bundledScenarios = [{
      id: 'bundled-prolog-arkona-prime',
      title: 'Пролог — Аркона Прайм',
      fileName: 'prolog-verstka.html',
      format: 'html',
      content,
      bundled: true,
      updatedAt: null,
    }];
    renderScenarios();
  } catch (error) {
    console.warn('Не удалось загрузить встроенный сценарий:', error);
  }
}

function allScenarios() {
  const uploadedIds = new Set(scenarios.map(item => item.id));
  return [...scenarios, ...bundledScenarios.filter(item => !uploadedIds.has(item.id))];
}

function subscribeTeams() {
  setMessage(ui.lobbyMessage,'Загружаем лобби…');
  unsubscribeTeams=onSnapshot(query(collection(db,'teams'),orderBy('updatedAt','desc')), snap=>{
    teams=snap.docs.map(d=>({id:d.id,...d.data()}));
    renderLobbies(); renderReaderLobbies(); setMessage(ui.lobbyMessage,'');
  },error=>setMessage(ui.lobbyMessage,humanError(error),'error'));
}

function subscribeScenarios() {
  unsubscribeScenarios=onSnapshot(query(collection(db,'scenarios'),orderBy('updatedAt','desc')), snap=>{
    scenarios=snap.docs.map(d=>({id:d.id,...d.data()})); renderScenarios();
  },error=>setMessage(ui.scenarioMessage,humanError(error),'error'));
}

function renderLobbies() {
  ui.lobbyCount.textContent=String(teams.length);
  if (!teams.length) { ui.lobbyList.innerHTML='<div class="gm-empty">Пока нет созданных лобби.</div>'; return; }
  ui.lobbyList.innerHTML=teams.map(team=>{
    const count=Number(team.memberCount ?? team.memberIds?.length ?? 0);
    return `<article class="gm-lobby-card"><div><span class="gm-kicker">Код ${escapeHtml(team.code||team.id)}</span><h3>${escapeHtml(team.name||'Без названия')}</h3><div class="gm-lobby-meta"><span>Игроков: <b>${count}/8</b></span><span>Обновлено: ${escapeHtml(formatDate(team.updatedAt))}</span></div></div><div class="gm-card-actions"><div class="gm-lobby-resources"><span>Порча<b>${Number(team.taint||0)}</b></span><span>Монеты<b>${Number(team.coins||0)}</b></span></div><button class="gm-card-button" type="button" data-open-team="${escapeHtml(team.id)}">Открыть</button></div></article>`;
  }).join('');
}

function statValue(state, team, stat) {
  const charId=state?.char; const data=MasterData.characters[charId];
  let value=Number(data?.stats?.[stat] || 0);
  if (charId==='heretic') {
    value += Math.max(0,Number(team?.taint||0));
    const raw=String(state?.choice?.['heretic:pact']||'').toLowerCase();
    const pact=raw.includes('гордын')||raw==='pride' ? 'pride' : raw.includes('сил')||raw==='strength'||raw==='power'||raw==='pact-strength' ? 'strength' : raw;
    if (pact==='pride') value+=1;
    if (pact==='strength' && stat==='strength') value=(value+2)*2;
  }
  return Math.min(5,value);
}

function damageText(weapon,state,team) {
  if (!weapon) return '—';
  if (!weapon.modifier) return weapon.damage || '—';
  const label=Arsenal.STAT_LABELS[weapon.modifier]||weapon.modifier;
  const multiplier=Number(weapon.modifierMultiplier||1);
  const bonus=statValue(state,team,weapon.modifier)*multiplier;
  const modText=multiplier===1 ? label : `${multiplier}×${label}`;
  return `${weapon.damage} + ${modText} (${bonus>=0?'+':''}${bonus})`;
}

function playerSnapshot(uid,member) {
  const state=characterStates.get(uid)?.state || null;
  const charId=state?.char || member?.archetype || '';
  const data=MasterData.characters[charId] || {};
  const inventory=state?.inventory || {};
  const gearIds=Array.isArray(inventory.gearIds)?inventory.gearIds:[];
  const armor=Arsenal.armorById[inventory.armorId] || Arsenal.armorById[member?.loadout?.armorId] || null;
  const armorBonus=gearIds.reduce((sum,id)=>sum+Number(Arsenal.gearById[id]?.armorBonus||0),0);
  const weaponIds=Array.isArray(inventory.weaponIds)?inventory.weaponIds:[];
  const weapons=[...(charId==='heretic'?[Arsenal.weaponById['heretic-claws']]:[]),...weaponIds.map(id=>Arsenal.weaponById[id]).filter(Boolean)];
  const gear=gearIds.map(id=>Arsenal.gearById[id]).filter(Boolean);
  const hp=state?.hp?.[charId] ?? member?.hp ?? data.hp ?? 0;
  const hpMax=data.hp ?? member?.hpMax ?? 0;
  const prefix=`${charId}:`;
  const spent=state?.spent || {};
  const abilities=(data.abilities||[]).filter(a=>a.uses!==null).map(a=>({ ...a, used:Number(spent[prefix+a.id]||0) }));
  const usedTotal=abilities.reduce((sum,a)=>sum+a.used,0);
  return {uid,state,charId,data,name:state?.characterName||member?.name||'Без имени',armor,armorClass:Number(armor?.ac||member?.loadout?.armorClass||0)+armorBonus,weapons,gear,hp,hpMax,abilities,usedTotal};
}

function syncCharacterListeners(team) {
  const wanted=new Set(team?.memberIds||[]);
  for (const [uid,unsub] of characterUnsubs) if (!wanted.has(uid)) { unsub(); characterUnsubs.delete(uid); characterStates.delete(uid); }
  wanted.forEach(uid=>{
    if (characterUnsubs.has(uid)) return;
    const unsub=onSnapshot(doc(db,'characters',uid),snap=>{ characterStates.set(uid,snap.exists()?snap.data():{}); renderOpenTeam(); },()=>{ characterStates.set(uid,{}); renderOpenTeam(); });
    characterUnsubs.set(uid,unsub);
  });
}

function openTeam(code) {
  closeTeam(); openTeamCode=code; ui.teamModal.hidden=false;
  unsubscribeOpenTeam=onSnapshot(doc(db,'teams',code),snap=>{
    if (!snap.exists()) { toast('Лобби уже распущено.'); closeTeam(); return; }
    openTeamData={id:snap.id,...snap.data()}; syncCharacterListeners(openTeamData); renderOpenTeam();
  },error=>{ toast(humanError(error)); closeTeam(); });
}

function closeTeam() {
  if (unsubscribeOpenTeam) unsubscribeOpenTeam(); unsubscribeOpenTeam=null;
  characterUnsubs.forEach(unsub=>unsub()); characterUnsubs.clear(); characterStates.clear();
  openTeamCode=''; openTeamData=null; if (ui.teamModal) ui.teamModal.hidden=true;
}

function renderOpenTeam() {
  const team=openTeamData; if (!team) return;
  ui.teamCode.textContent=team.code||team.id; ui.teamName.textContent=team.name||'Без названия';
  ui.teamMembers.textContent=`${Number(team.memberCount||team.memberIds?.length||0)} / 8`; ui.teamTaint.textContent=Number(team.taint||0); ui.teamCoins.textContent=Number(team.coins||0);
  const players=(team.memberIds||[]).map(uid=>playerSnapshot(uid,team.members?.[uid]||{}));
  ui.playerList.innerHTML=players.map(p=>{
    const weapons=p.weapons.length?p.weapons.map(w=>`<div class="gm-weapon-row"><img src="${escapeHtml(Arsenal.iconFor(w))}" alt=""><div><b>${escapeHtml(w.name)}</b><div class="gm-damage">${escapeHtml(damageText(w,p.state,team))}</div><div>${Number(w.hands||0)} ${Number(w.hands||0)===1?'рука':'руки'}</div><p class="gm-rule">${escapeHtml(Arsenal.fullRule(w)||'Особых правил нет.')}</p></div></div>`).join(''):'<div class="gm-empty">Оружие не выбрано.</div>';
    const gear=p.gear.length?p.gear.map(g=>`<div class="gm-gear-item"><b>${escapeHtml(g.name)}</b><p class="gm-rule">${escapeHtml(g.rule||'')}</p></div>`).join(''):'<div class="gm-empty">Снаряжение не выбрано.</div>';
    const abilities=p.abilities.length?p.abilities.map(a=>`<div class="gm-ability-item"><div class="gm-ability-head"><b>${escapeHtml(a.name)}</b><span class="gm-usage">Использовано ${a.used} / ${a.uses}</span></div><small>${a.reset==='day'?'Восстанавливается в новый день':'Восстанавливается в новый бой'}</small></div>`).join(''):'<div class="gm-empty">Нет способностей с зарядами.</div>';
    return `<article class="gm-player-card"><div class="gm-player-summary"><div><span class="gm-kicker">${escapeHtml(p.data.name||p.charId||'Персонаж')}</span><h3>${escapeHtml(p.name)}</h3></div><div class="gm-player-stat"><span>Здоровье</span><b>${Number(p.hp)} / ${Number(p.hpMax)}</b></div><div class="gm-player-stat"><span>Класс брони</span><b>${p.armorClass||'—'}</b></div><div class="gm-player-stat"><span>Зарядов потрачено</span><b>${p.usedTotal}</b></div></div><details class="gm-player-details"><summary>Полная карточка игрока</summary><div class="gm-player-body"><div class="gm-equipment-grid"><section class="gm-subcard"><h4>Броня</h4><b>${escapeHtml(p.armor?.name||'Без брони')}</b><div class="gm-damage">Класс брони ${p.armorClass||'—'}</div><p class="gm-rule">${escapeHtml(p.armor?.rule||'')}</p></section><section class="gm-subcard"><h4>Оружие</h4>${weapons}</section><section class="gm-subcard"><h4>Снаряжение</h4><div class="gm-gear-list">${gear}</div></section><section class="gm-subcard"><h4>Использование способностей</h4><div class="gm-ability-list">${abilities}</div></section></div></div></details></article>`;
  }).join('') || '<div class="gm-empty">В лобби нет игроков.</div>';
}

async function dissolveTeam() {
  if (!openTeamCode) return;
  const name=openTeamData?.name||openTeamCode;
  if (!confirm(`Распустить лобби «${name}»? Персонажи игроков сохранятся.`)) return;
  ui.dissolve.disabled=true;
  try { await deleteDoc(doc(db,'teams',openTeamCode)); toast('Лобби распущено.'); closeTeam(); }
  catch(error){ toast(humanError(error)); }
  finally { ui.dissolve.disabled=false; }
}

function scenarioFormat(scenario) {
  const explicit=String(scenario?.format||'').toLowerCase();
  if (['html','markdown','text'].includes(explicit)) return explicit;
  const name=String(scenario?.fileName||'').toLowerCase();
  if (/\.html?$/.test(name)) return 'html';
  if (/\.md$/.test(name)) return 'markdown';
  return 'text';
}

function scenarioPlainText(scenario) {
  const content=String(scenario?.content||'');
  if (scenarioFormat(scenario)!=='html') return content;
  try {
    return new DOMParser().parseFromString(content,'text/html').body?.textContent || '';
  } catch {
    return content.replace(/<[^>]+>/g,' ');
  }
}

function scenarioExtent(scenario) {
  if (scenarioFormat(scenario)==='html') {
    try {
      const parsed=new DOMParser().parseFromString(String(scenario.content||''),'text/html');
      const sheets=parsed.querySelectorAll('.sheet').length;
      if (sheets) return `${sheets} стр.`;
    } catch {}
  }
  return `${Math.max(1,Math.round(scenarioPlainText(scenario).length/1800))} стр. текста`;
}

function renderScenarios() {
  const needle=ui.scenarioSearch.value.trim().toLowerCase();
  const source=allScenarios();
  const filtered=source.filter(s=>!needle||`${s.title||''}\n${scenarioPlainText(s)}`.toLowerCase().includes(needle));
  ui.scenarioCount.textContent=String(source.length);
  if (!filtered.length) { ui.scenarioList.innerHTML='<div class="gm-empty">Сценарии не найдены.</div>'; return; }
  ui.scenarioList.innerHTML=filtered.map(s=>{
    const typeLabel=scenarioFormat(s)==='html'?'Готовая HTML-вёрстка':scenarioFormat(s)==='markdown'?'Markdown':'Текстовый сценарий';
    const deleteButton=s.bundled?'':`<button class="gm-danger" type="button" data-delete-scenario="${escapeHtml(s.id)}">Удалить</button>`;
    const sourceLabel=s.bundled?'<span>Встроенный пример</span>':'';
    return `<article class="gm-scenario-card"><div><span class="gm-kicker">${escapeHtml(s.fileName||typeLabel)}</span><h3>${escapeHtml(s.title||'Без названия')}</h3><div class="gm-scenario-meta"><span>${typeLabel}</span><span>${escapeHtml(scenarioExtent(s))}</span>${sourceLabel}${s.updatedAt?`<span>Обновлено: ${escapeHtml(formatDate(s.updatedAt))}</span>`:''}</div></div><div class="gm-card-actions"><button class="gm-card-button" type="button" data-open-scenario="${escapeHtml(s.id)}">Читать</button>${deleteButton}</div></article>`;
  }).join('');
}

async function uploadScenario(event) {
  event.preventDefault(); const file=ui.scenarioFile.files?.[0]; if (!file) return;
  if (file.size>700*1024) { setMessage(ui.scenarioMessage,'Файл больше 700 КБ. Разделите его на несколько частей.','error'); return; }
  const extension=(file.name.split('.').pop()||'').toLowerCase();
  const format=['html','htm'].includes(extension)||file.type==='text/html'?'html':extension==='md'||file.type==='text/markdown'?'markdown':'text';
  if (!['txt','md','html','htm'].includes(extension) && !['text/plain','text/markdown','text/html'].includes(file.type)) {
    setMessage(ui.scenarioMessage,'Поддерживаются только TXT, MD, HTML и HTM.','error'); return;
  }
  const button=$('button[type="submit"]',ui.scenarioUpload); button.disabled=true; setMessage(ui.scenarioMessage,'Читаем файл…');
  try {
    const content=await file.text(); const fallback=file.name.replace(/\.(txt|md|html?)$/i,'').replace(/[_-]+/g,' ');
    const title=cleanText(ui.scenarioTitle.value||fallback,100)||'Без названия';
    await addDoc(collection(db,'scenarios'),{title,fileName:file.name,format,content,createdBy:activeUser.uid,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
    ui.scenarioUpload.reset(); setMessage(ui.scenarioMessage,format==='html'?'HTML-сценарий добавлен.':'Сценарий добавлен.','ok');
  } catch(error){ setMessage(ui.scenarioMessage,humanError(error),'error'); }
  finally { button.disabled=false; }
}

function inlineMarkdown(text) { return escapeHtml(text).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/`([^`]+)`/g,'<code>$1</code>'); }
function renderMarkdown(text='') {
  const lines=String(text).replace(/\r/g,'').split('\n'); let html=''; let inList=false; let inCode=false;
  const closeList=()=>{if(inList){html+='</ul>';inList=false;}};
  for(const raw of lines){ const line=raw.trimEnd();
    if(line.startsWith('```')){closeList(); if(inCode){html+='</code></pre>';inCode=false;}else{html+='<pre><code>';inCode=true;} continue;}
    if(inCode){html+=escapeHtml(raw)+'\n';continue;}
    const h=line.match(/^(#{1,4})\s+(.+)$/); if(h){closeList();const n=h[1].length;html+=`<h${n}>${inlineMarkdown(h[2])}</h${n}>`;continue;}
    const li=line.match(/^[-*]\s+(.+)$/); if(li){if(!inList){html+='<ul>';inList=true;}html+=`<li>${inlineMarkdown(li[1])}</li>`;continue;}
    closeList(); if(!line.trim()){html+='<p></p>';continue;}
    if(line.startsWith('> ')){html+=`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`;continue;}
    html+=`<p>${inlineMarkdown(line)}</p>`;
  }
  closeList(); if(inCode) html+='</code></pre>'; return html;
}

function closeReaderLobbyDrawer() {
  ui.readerLobbyDrawer.hidden=true;
  ui.readerLobbiesButton.setAttribute('aria-expanded','false');
}

function toggleReaderLobbyDrawer() {
  const willOpen=ui.readerLobbyDrawer.hidden;
  ui.readerLobbyDrawer.hidden=!willOpen;
  ui.readerLobbiesButton.setAttribute('aria-expanded',String(willOpen));
  if (willOpen) renderReaderLobbies();
}

function renderReaderLobbies() {
  if (!ui.readerLobbyList) return;
  ui.readerLobbyCount.textContent=String(teams.length);
  if (!teams.length) { ui.readerLobbyList.innerHTML='<div class="gm-empty">Нет активных лобби.</div>'; return; }
  ui.readerLobbyList.innerHTML=teams.map(team=>{
    const count=Number(team.memberCount ?? team.memberIds?.length ?? 0);
    return `<article class="gm-reader-lobby-card"><div><span class="gm-kicker">Код ${escapeHtml(team.code||team.id)}</span><h4>${escapeHtml(team.name||'Без названия')}</h4><div class="gm-reader-lobby-stats"><span>Игроки <b>${count}/8</b></span><span>Порча <b>${Number(team.taint||0)}</b></span><span>Монеты <b>${Number(team.coins||0)}</b></span></div></div><button class="gm-card-button" type="button" data-open-team="${escapeHtml(team.id)}">Состав и снаряжение</button></article>`;
  }).join('');
}

function openScenario(id) {
  const scenario=allScenarios().find(item=>item.id===id); if(!scenario)return;
  ui.scenarioViewTitle.textContent=scenario.title||'Сценарий';
  ui.scenarioViewContent.replaceChildren();
  ui.scenarioViewContent.classList.toggle('is-html',scenarioFormat(scenario)==='html');
  if (scenarioFormat(scenario)==='html') {
    const frame=document.createElement('iframe');
    frame.className='gm-scenario-frame';
    frame.title=`Сценарий: ${scenario.title||'Без названия'}`;
    frame.setAttribute('sandbox','');
    frame.setAttribute('referrerpolicy','no-referrer');
    frame.srcdoc=String(scenario.content||'');
    ui.scenarioViewContent.append(frame);
  } else {
    ui.scenarioViewContent.innerHTML=renderMarkdown(scenario.content||'');
  }
  closeReaderLobbyDrawer(); renderReaderLobbies(); ui.scenarioModal.hidden=false;
}

function closeScenario() {
  ui.scenarioModal.hidden=true;
  closeReaderLobbyDrawer();
  ui.scenarioViewContent.replaceChildren();
  ui.scenarioViewContent.classList.remove('is-html');
}

async function deleteScenario(id) { const s=scenarios.find(x=>x.id===id); if(!s||!confirm(`Удалить сценарий «${s.title}»?`))return; try{await deleteDoc(doc(db,'scenarios',id));toast('Сценарий удалён.');}catch(error){toast(humanError(error));} }

function switchTab(tab) { $$('[data-gm-tab]').forEach(b=>b.classList.toggle('is-active',b.dataset.gmTab===tab)); $('#gm-tab-lobbies').hidden=tab!=='lobbies'; $('#gm-tab-scenarios').hidden=tab!=='scenarios'; }

ui.authForm.addEventListener('submit',async event=>{ event.preventDefault(); const button=$('#gm-login-button'); button.disabled=true; setMessage(ui.authMessage,'Входим…'); try{await setPersistence(auth,browserLocalPersistence);await signInWithEmailAndPassword(auth,ui.email.value.trim(),ui.password.value);}catch(error){setMessage(ui.authMessage,humanError(error),'error');}finally{button.disabled=false;} });
ui.scenarioUpload.addEventListener('submit',uploadScenario);
ui.scenarioSearch.addEventListener('input',renderScenarios);
ui.dissolve.addEventListener('click',dissolveTeam);
document.addEventListener('click',event=>{
  const tab=event.target.closest('[data-gm-tab]'); if(tab){switchTab(tab.dataset.gmTab);return;}
  const team=event.target.closest('[data-open-team]'); if(team){openTeam(team.dataset.openTeam);return;}
  const scenario=event.target.closest('[data-open-scenario]'); if(scenario){openScenario(scenario.dataset.openScenario);return;}
  const del=event.target.closest('[data-delete-scenario]'); if(del){void deleteScenario(del.dataset.deleteScenario);return;}
  const action=event.target.closest('[data-gm-action]')?.dataset.gmAction;
  if(action==='logout') void signOut(auth);
  if(action==='close-team') closeTeam();
  if(action==='close-scenario') closeScenario();
  if(action==='toggle-reader-lobbies') toggleReaderLobbyDrawer();
});
ui.teamModal.addEventListener('click',e=>{if(e.target===ui.teamModal)closeTeam();});
ui.scenarioModal.addEventListener('click',e=>{if(e.target===ui.scenarioModal)closeScenario();});
$('#gm-copy-uid').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(ui.deniedUid.textContent);toast('UID скопирован.');}catch{toast('Не удалось скопировать UID.');}});

await setPersistence(auth,browserLocalPersistence);
onAuthStateChanged(auth,async user=>{
  stopDataListeners(); activeUser=user;
  if(!user){showGate('auth');setMessage(ui.authMessage,'Введите данные аккаунта мастера.');return;}
  setMessage(ui.authMessage,'Проверяем роль мастера…');
  try { if(await hasGmRole(user.uid)) startDashboard(); else {ui.deniedUid.textContent=user.uid;showGate('denied');} }
  catch(error){showGate('auth');setMessage(ui.authMessage,humanError(error),'error');}
});
