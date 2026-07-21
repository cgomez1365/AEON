import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore, enableIndexedDbPersistence } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAnalytics, isSupported } from "firebase/analytics";

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId:     import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// Firebase is an OPTIONAL tracking/session layer — it is NOT the login gate
// (that's the kernel HMAC gate). If it isn't configured, AEON degrades to
// Supabase-only instead of crashing. Tracking can be turned off from
// Settings ▸ Services (localStorage flag), so "live data tracking" is a real
// switch, not decoration.
const firebaseConfigured = !!(firebaseConfig.apiKey && firebaseConfig.projectId);
const trackingOn = () => { try { return localStorage.getItem('aeon_firebase_tracking') !== 'off'; } catch { return true; } };

let app = null, auth = null, db = null, storage = null, analytics = Promise.resolve(null);

if (firebaseConfigured) {
  console.log("[AEON] Firebase init:", firebaseConfig.projectId, trackingOn() ? '(tracking on)' : '(tracking off)');
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    enableIndexedDbPersistence(db).catch((err) => {
      if (err.code === 'failed-precondition') console.warn('[AEON] Persistence: multiple tabs open.');
      else if (err.code === 'unimplemented') console.warn('[AEON] Persistence: browser unsupported.');
    });
    storage = getStorage(app);
    if (trackingOn()) analytics = isSupported().then((yes) => yes ? getAnalytics(app) : null);
  } catch (e) {
    console.warn('[AEON] Firebase unavailable — degrading to Supabase-only:', e.message);
  }
} else {
  console.log('[AEON] Firebase not configured — running Supabase-only (this is fine).');
}

export { auth, db, storage, analytics };