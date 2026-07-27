import { initializeApp } from
  "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";

import { getAuth } from
  "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDTv1nN-LnEDm3G8WUj4ekgWp8GrPMApww",
  authDomain: "legendsdungeon-1ac12.firebaseapp.com",
  projectId: "legendsdungeon-1ac12",
  storageBucket: "legendsdungeon-1ac12.firebasestorage.app",
  messagingSenderId: "1073858279830",
  appId: "1:1073858279830:web:228d821391a766e14685b7",
  measurementId: "G-2VEEV57Q03"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);