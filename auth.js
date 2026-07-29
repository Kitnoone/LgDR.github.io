/* ==================================================================
   ЛЕГЕНДЫ ПОДЗЕМЕЛИЙ · Firebase Authentication
   Регистрация, вход, восстановление пароля и выход.
   ================================================================== */

import { auth, db } from './firebase-config.js?v=gm-html-reader-1';
import { connectCharacterStore, queueCharacterSave, stopCharacterStore } from './character-store.js?v=gm-html-reader-1';
import { startLobbySession, stopLobbySession } from './lobby-store.js?v=gm-html-reader-1';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js';

const $ = (selector) => document.querySelector(selector);

const ui = {
  screen: $('#auth-screen'),
  form: $('#auth-form'),
  email: $('#auth-email'),
  password: $('#auth-password'),
  confirmWrap: $('#auth-confirm-wrap'),
  confirm: $('#auth-confirm'),
  submit: $('#auth-submit'),
  reset: $('#auth-reset'),
  message: $('#auth-message'),
  tabs: Array.from(document.querySelectorAll('[data-auth-mode]')),
  accountEmail: $('#auth-user-email'),
  gmLink: $('#gm-dashboard-link'),
};

let mode = 'login';
let busy = false;

function setMessage(text = '', kind = '') {
  ui.message.textContent = text;
  ui.message.className = 'auth-message';
  if (kind) ui.message.classList.add(`is-${kind}`);
}

function setBusy(value) {
  busy = value;
  ui.submit.disabled = value;
  ui.reset.disabled = value;
  ui.tabs.forEach((tab) => { tab.disabled = value; });
  ui.submit.textContent = value
    ? 'Подождите…'
    : mode === 'register' ? 'Создать аккаунт' : 'Войти';
}

function setMode(nextMode) {
  mode = nextMode === 'register' ? 'register' : 'login';
  ui.tabs.forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.authMode === mode);
  });
  ui.confirmWrap.hidden = mode !== 'register';
  ui.confirm.required = mode === 'register';
  ui.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  ui.reset.hidden = mode !== 'login';
  ui.submit.textContent = mode === 'register' ? 'Создать аккаунт' : 'Войти';
  setMessage('');
}

function humanError(error) {
  const code = error?.code || '';
  const known = {
    'auth/invalid-email': 'Проверьте адрес электронной почты.',
    'auth/missing-email': 'Введите электронную почту.',
    'auth/missing-password': 'Введите пароль.',
    'auth/weak-password': 'Пароль слишком простой. Нужно не меньше 6 символов.',
    'auth/password-does-not-meet-requirements': 'Пароль не соответствует требованиям Firebase.',
    'auth/email-already-in-use': 'Аккаунт с такой почтой уже существует.',
    'auth/invalid-credential': 'Неверная почта или пароль.',
    'auth/user-disabled': 'Этот аккаунт отключён администратором.',
    'auth/too-many-requests': 'Слишком много попыток. Подождите немного и повторите.',
    'auth/network-request-failed': 'Нет связи с Firebase. Проверьте интернет.',
    'auth/operation-not-allowed': 'В Firebase ещё не включён вход Email/Password.',
    'auth/unauthorized-domain': 'Домен сайта не добавлен в Authorized domains Firebase.',
    'auth/internal-error': 'Firebase вернул внутреннюю ошибку. Повторите попытку.',
  };
  return known[code] || `Не удалось выполнить действие (${code || 'неизвестная ошибка'}).`;
}

async function submitAuth(event) {
  event.preventDefault();
  if (busy) return;

  const email = ui.email.value.trim();
  const password = ui.password.value;
  const confirmation = ui.confirm.value;

  if (!email || !password) {
    setMessage('Введите электронную почту и пароль.', 'error');
    return;
  }
  if (mode === 'register' && password !== confirmation) {
    setMessage('Пароли не совпадают.', 'error');
    return;
  }

  setBusy(true);
  setMessage('');
  try {
    await setPersistence(auth, browserLocalPersistence);
    if (mode === 'register') {
      await createUserWithEmailAndPassword(auth, email, password);
      setMessage('Аккаунт создан.', 'ok');
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
    ui.form.reset();
  } catch (error) {
    console.error('Firebase Authentication:', error);
    setMessage(humanError(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function resetPassword() {
  if (busy) return;
  const email = ui.email.value.trim();
  if (!email) {
    setMessage('Сначала введите электронную почту.', 'error');
    ui.email.focus();
    return;
  }

  setBusy(true);
  try {
    await sendPasswordResetEmail(auth, email);
    setMessage('Письмо для смены пароля отправлено.', 'ok');
  } catch (error) {
    console.error('Password reset:', error);
    setMessage(humanError(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function logout() {
  if (busy) return;
  try {
    await signOut(auth);
  } catch (error) {
    console.error('Sign out:', error);
    setMessage(humanError(error), 'error');
  }
}


async function refreshGmLink(user) {
  if (!ui.gmLink) return;
  ui.gmLink.hidden = true;
  if (!user) return;
  try {
    const role = await getDoc(doc(db, 'roles', user.uid));
    ui.gmLink.hidden = !(role.exists() && role.data()?.role === 'gm');
  } catch (error) {
    console.warn('GM role check:', error);
  }
}

function showSignedOut() {
  void refreshGmLink(null);
  stopLobbySession();
  stopCharacterStore();
  window.LegendyApp?.setCloudSaver(null);
  window.LegendyApp?.stop();
  ui.screen.hidden = false;
  ui.accountEmail.textContent = '—';
  setMode('login');
  setMessage('');
  setTimeout(() => ui.email.focus(), 0);
}

async function showSignedIn(user) {
  void refreshGmLink(user);
  ui.accountEmail.textContent = user.email || 'Пользователь Firebase';
  ui.screen.hidden = false;
  setMessage('Загружаем персонажа из хроники…');

  const localState = window.LegendyApp?.prepare(user.uid);
  try {
    const initialState = await connectCharacterStore(
      user.uid,
      localState,
      (remoteState) => window.LegendyApp?.applyCloudState(remoteState),
      (status, error) => window.LegendyApp?.setCloudStatus(status, error),
    );
    window.LegendyApp?.applyCloudState(initialState);
    window.LegendyApp?.setCloudSaver(queueCharacterSave);
    window.LegendyApp?.present();
    await startLobbySession(user.uid);
    ui.screen.hidden = true;
  } catch (error) {
    console.error('Firestore connect:', error);
    window.LegendyApp?.setCloudStatus('error', error);
    window.LegendyApp?.setCloudSaver(null);
    window.LegendyApp?.present();
    await startLobbySession(user.uid);
    ui.screen.hidden = true;
    window.LegendyApp?.notify('Облако недоступно. Состояние пока сохраняется только на этом устройстве.');
  }
}

ui.tabs.forEach((tab) => {
  tab.addEventListener('click', () => setMode(tab.dataset.authMode));
});
ui.form.addEventListener('submit', submitAuth);
ui.reset.addEventListener('click', resetPassword);
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-auth-action="logout"]')) logout();
});

setMode('login');
setMessage('Проверяем вход…');

try {
  await setPersistence(auth, browserLocalPersistence);
  onAuthStateChanged(auth, (user) => {
    if (user) void showSignedIn(user);
    else showSignedOut();
  }, (error) => {
    console.error('Auth state:', error);
    ui.screen.hidden = false;
    setMessage(humanError(error), 'error');
  });
} catch (error) {
  console.error('Firebase init:', error);
  ui.screen.hidden = false;
  setMessage(humanError(error), 'error');
}
