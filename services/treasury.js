require('dotenv').config();
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc } = require('firebase/firestore');

// Initialize Firebase with the same config as the frontend
const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const { getDoc } = require('firebase/firestore');

// Core Treasury State — loaded from Firebase on boot, never reset
let baseDeficit = -100000.00;
let dailyBleed = 9.41;
let lastSyncTimestamp = Date.now();
let _bootLoaded = false;

// Inventory Module hook for recurring costs
const inventory = [];

async function loadFromFirebase() {
  try {
    const snap = await getDoc(doc(db, 'aeon_treasury', 'deficit_state'));
    if (snap.exists()) {
      const data = snap.data();
      if (data.baseDeficit !== undefined && data.baseDeficit < baseDeficit) {
        baseDeficit = data.baseDeficit;
        dailyBleed = data.dailyBleed || 9.41;
        lastSyncTimestamp = data.lastSyncTimestamp || Date.now();
        console.log(`[TREASURY] Restored from Firebase. Deficit: $${baseDeficit.toFixed(4)} | Bleed: $${dailyBleed.toFixed(2)}/day`);
      } else {
        console.log(`[TREASURY] Firebase value ($${(data.baseDeficit || 0).toFixed(4)}) not worse than default. Using default.`);
      }
    } else {
      console.log('[TREASURY] No Firebase state found. Starting fresh at -$100,000.');
    }
  } catch (e) {
    console.error('[TREASURY] Firebase load failed:', e.message, '— using default.');
  }
  _bootLoaded = true;
}

function syncCurrentDeficit() {
  const now = Date.now();
  const elapsedMs = now - lastSyncTimestamp;
  const bleedPerMs = dailyBleed / (24 * 60 * 60 * 1000);
  baseDeficit -= (elapsedMs * bleedPerMs);
  lastSyncTimestamp = now;
}

function addRecurringCost(name, dailyCost) {
  inventory.push({ name, dailyCost });
  recalculateBleed();
}

function removeRecurringCost(name) {
  const idx = inventory.findIndex(i => i.name === name);
  if (idx > -1) {
    inventory.splice(idx, 1);
    recalculateBleed();
  }
}

function logInvoice(amount) {
  // If we pay an invoice, deficit goes deeper (subtract)
  syncCurrentDeficit(); 
  baseDeficit -= amount;
  pushSync();
}

function recalculateBleed() {
  syncCurrentDeficit();
  let base = 9.41; // Base system bleed
  for (const item of inventory) {
    base += item.dailyCost;
  }
  dailyBleed = base;
  pushSync();
}

async function pushSync() {
  try {
    syncCurrentDeficit();
    await setDoc(doc(db, 'aeon_treasury', 'deficit_state'), {
      baseDeficit,
      dailyBleed,
      lastSyncTimestamp,
      principal: -100000.00,
      lastUpdated: new Date().toISOString()
    });
    console.log(`[TREASURY] Synced to Firebase. Deficit: $${baseDeficit.toFixed(4)} | Bleed: $${dailyBleed.toFixed(2)}/day`);
  } catch (error) {
    console.error('[TREASURY] Failed to sync with Firebase:', error.message);
  }
}

// Initial boot: load from Firebase FIRST, then sync forward
loadFromFirebase().then(() => {
  syncCurrentDeficit();
  pushSync();
});

// Cron hook: Daily sync at midnight
function scheduleMidnightSync() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const msUntilMidnight = tomorrow - now;
  
  setTimeout(() => {
    console.log('[TREASURY] Executing Midnight Sync');
    pushSync();
    setInterval(() => {
      console.log('[TREASURY] Executing Midnight Sync');
      pushSync();
    }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

scheduleMidnightSync();

function getLiveDeficit() {
  syncCurrentDeficit();
  return baseDeficit;
}

function getDailyBleed() {
  return dailyBleed;
}

module.exports = {
  addRecurringCost,
  removeRecurringCost,
  logInvoice,
  pushSync,
  getLiveDeficit,
  getDailyBleed,
};
