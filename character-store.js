/* ==================================================================
   ЛЕГЕНДЫ ПОДЗЕМЕЛИЙ · облачное хранилище персонажа
   Один документ Firestore на один Firebase UID: characters/{uid}
   ================================================================== */

import { db } from './firebase-config.js?v=footer-fix-1';
import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js';

let activeUid = null;
let activeRef = null;
let unsubscribe = null;
let saveTimer = null;
let lastSerialized = '';
let statusHandler = () => {};

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function serialize(state) {
  return JSON.stringify(state);
}

async function writeNow(state) {
  if (!activeRef || !activeUid) return;
  const clean = cloneState(state);
  lastSerialized = serialize(clean);
  statusHandler('saving');
  await setDoc(activeRef, {
    ownerId: activeUid,
    schemaVersion: 2,
    state: clean,
    updatedAt: serverTimestamp(),
  }, { merge: true });
  statusHandler('synced');
}

export function queueCharacterSave(state) {
  if (!activeRef || !activeUid) return;
  const serialized = serialize(state);
  if (serialized === lastSerialized) return;
  clearTimeout(saveTimer);
  statusHandler('waiting');
  saveTimer = setTimeout(() => {
    writeNow(state).catch((error) => {
      console.error('Firestore save:', error);
      statusHandler('error', error);
    });
  }, 450);
}

export async function connectCharacterStore(uid, localState, onRemote, onStatus) {
  stopCharacterStore();
  activeUid = uid;
  activeRef = doc(db, 'characters', uid);
  statusHandler = onStatus || (() => {});
  statusHandler('loading');

  const first = await getDoc(activeRef);
  let initialState = localState;

  if (first.exists() && first.data()?.state) {
    initialState = first.data().state;
    lastSerialized = serialize(initialState);
  } else if (localState?.char || localState?.characterName) {
    await writeNow(localState);
  }

  unsubscribe = onSnapshot(activeRef, { includeMetadataChanges: true }, (snap) => {
    if (!snap.exists() || !snap.data()?.state) return;
    const incoming = snap.data().state;
    const serialized = serialize(incoming);
    const fromCache = snap.metadata.fromCache;
    const pending = snap.metadata.hasPendingWrites;

    if (serialized !== lastSerialized) {
      lastSerialized = serialized;
      onRemote(incoming);
    }

    if (pending) statusHandler('saving');
    else if (fromCache) statusHandler('offline');
    else statusHandler('synced');
  }, (error) => {
    console.error('Firestore listener:', error);
    statusHandler('error', error);
  });

  statusHandler(first.metadata?.fromCache ? 'offline' : 'synced');
  return initialState;
}

export function stopCharacterStore() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  activeUid = null;
  activeRef = null;
  lastSerialized = '';
  statusHandler = () => {};
}
