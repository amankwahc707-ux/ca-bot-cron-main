const admin = require("firebase-admin");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });
}

const db = admin.firestore();
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;

async function writeGlobalSignals(signalsByMode) {
  const batch = db.batch();
  for (const [mode, signals] of Object.entries(signalsByMode)) {
    // 🆕 Strip heavy fields (trend contains 250-candle arrays per timeframe)
    const lightCoins = {};
    for (const [coin, sig] of Object.entries(signals.coins || {})) {
      const light = { ...sig };
      delete light.trend;
      delete light.candles;
      delete light.closes;
      delete light.e20s;
      delete light.e50s;
      delete light.e20;
      delete light.e50;
      delete light.e200;
      lightCoins[coin] = light;
    }
    
    const lightSignals = {
      coins: lightCoins,
      watchlist: signals.watchlist || Object.keys(lightCoins),
      lastScan: signals.lastScan,
      mode: signals.mode,
    };
    
    const docRef = db.doc(`main_bot/signals_${mode}`);
    batch.set(docRef, {
      json: JSON.stringify(lightSignals),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      coin_count: Object.keys(lightCoins).length,
    });
  }
  await batch.commit();
  console.log(`📝 Wrote ${Object.keys(signalsByMode).length} mode snapshots to Firestore`);
}

async function getOfflineUsers() {
  const now = Date.now();
  const snapshot = await db.collection("users").limit(500).get();
  const offline = [];
  snapshot.forEach((doc) => {
    const data = doc.data();
    if (data.autotrade_enabled !== true) return;
    const lastSeen = data.last_seen_at || 0;
    if (lastSeen === 0 || now - lastSeen > HEARTBEAT_STALE_MS) {
      offline.push({
        uid: doc.id,
        email: data.email || "",
        mode: data.mode || "MEDIUM",
        auto_margin: data.auto_margin || 50,
        auto_lev: data.auto_lev || 10,
        capital: data.capital || 10000,
        last_seen_at: lastSeen,
      });
    }
  });
  return offline;
}

async function getUserTrades(uid) {
  const snapshot = await db.collection(`users/${uid}/trades`).get();
  const trades = [];
  snapshot.forEach((doc) => trades.push({ id: doc.id, ...doc.data() }));
  return trades;
}

async function updateTrade(uid, tradeId, updates) {
  await db.collection(`users/${uid}/trades`).doc(tradeId).update({
    ...updates,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function createTrade(uid, trade) {
  await db.collection(`users/${uid}/trades`).doc(trade.id).set({
    ...trade,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

module.exports = {
  db,
  writeGlobalSignals,
  getOfflineUsers,
  getUserTrades,
  updateTrade,
  createTrade,
};
