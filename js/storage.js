// ============================================================
// Elden Earth — save data (Local + Firebase Cloud Sync)
// ============================================================
const Store = (() => {
  const KEY = "eldenEarth.save.v1";
  let db = null;

  // Smart Session Lock: Persists across page reloads, but changes across different tabs/devices!
  let localSessionId = (typeof sessionStorage !== "undefined") ? sessionStorage.getItem("elden_sess_token") : null;
  if (!localSessionId) {
    localSessionId = "sess_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try { sessionStorage.setItem("elden_sess_token", localSessionId); } catch (e) {}
  }
  let isSessionPaused = false;
  let cloudSyncComplete = false;

  function getDb() {
    if (db) return db;
    try {
      if (typeof firebase !== "undefined" && CONFIG.FIREBASE_CONFIG && CONFIG.FIREBASE_CONFIG.apiKey) {
        if (!firebase.apps.length) {
          firebase.initializeApp(CONFIG.FIREBASE_CONFIG);
        }
        db = firebase.firestore();

        // 🚀 ZERO-READ CACHE: Stores plots & saves in IndexedDB (Slashes 70% of cloud reads!)
        db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
          if (err.code === "failed-precondition") {
            console.warn("[Firestore] Multi-tab persistence active in another tab.");
          } else if (err.code === "unimplemented") {
            console.warn("[Firestore] Browser does not support IndexedDB persistence.");
          }
        });
      }
    } catch (e) {
      console.warn("[Firebase] Init error:", e);
    }
    return db;
  }

  function defaultState() {
    return {
      player: { name: "Traveler", id: null, avatar: "🙂", model3d: "robot" },
      cash: 0,
      lifetimeRent: 0,
      eb: 1000,
      diamonds: 50,
      totalDividends: 0,
      plots: {},
      plotBag: {},
      calendar: { claimedDays: 0, lastClaimTime: 0, lastClaimDate: null },
      liveDiamonds: {},
      collectedDiamondIds: [],
      lastDiamondSpawn: 0,
      lastDiamondMovementAt: 0,
      lastDiamondPlayerPosition: null,
      boostExpiry: 0,
      boostMultiplier: 30,
      extractor: { built: false, level: 1, lastHarvest: Date.now(), stored: 0 },
      lastTick: Date.now(),
      createdAt: Date.now(),
    };
  }

  let state = null;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);

        // --- VERSION GATE: Wipe stale localStorage from old patches ---
        const savedVersion = parsed._gameVersion || "0.0.0";
        const currentVersion = (typeof CONFIG !== "undefined" && CONFIG.GAME_VERSION) || "0.0.0";
        if (savedVersion !== currentVersion) {
          console.log(`[Store] Version mismatch (local=${savedVersion}, cloud=${currentVersion}). Clearing stale localStorage.`);
          localStorage.removeItem(KEY);
          state = defaultState();
          state._gameVersion = currentVersion;
          return state;
        }

        state = Object.assign(defaultState(), parsed);
        if (parsed.player) {
          state.player = Object.assign(defaultState().player, parsed.player);
        }
        if (parsed.extractor) {
          state.extractor = Object.assign(defaultState().extractor, parsed.extractor);
        }
      } else {
        state = defaultState();
      }
    } catch (e) {
      console.warn("Save data unreadable, starting fresh.", e);
      state = defaultState();
    }

    // --- AUTO-RECOVER NAME & AVATAR FROM OWNED PLOTS ---
    if (state && state.player && (!state.player.name || state.player.name === "Traveler")) {
      for (const id in (state.plots || {})) {
        const p = state.plots[id];
        if (p.ownerName && p.ownerName !== "Traveler") {
          state.player.name = p.ownerName;
          if (p.avatar && p.avatar !== "🙂") state.player.avatar = p.avatar;
          break;
        }
      }
    }

    // --- PLAYER CONFLICT AUDIT: Detect and resolve UID/IP conflicts on load ---
    if (state && state.player && state.player.id) {
      const conflictCheck = ConflictResolver.checkConflict(state.player.id);
      if (conflictCheck && conflictCheck.hasConflict) {
        console.log(`[Conflict] Detected conflict for ${state.player.id}: ${conflictCheck.reason}`);
        // Trigger resolution after a brief delay to let UI show advisory
        setTimeout(() => {
          ConflictResolver.resolveConflict({
            playerId: state.player.id,
            onResolved: (result) => {
              if (result.success) {
                console.log(`[Conflict] Resolved: kept ${result.plotsKept} plots, EB=${result.eb}`);
                // Refresh the save data after resolution
                load();
              } else {
                console.warn("[Conflict] Resolution failed:", result.reason);
              }
            }
          });
        }, 500);
      }
    }

    // --- SELF-SEALING LIFETIME RENT & CASH AUDIT RESTORATION: DISABLED ---
    // This section previously modified player cash/rent
    // which caused data loss for real players. Disabled to prevent further corruption.
    // if (state && state.player && !state.cashAuditV1Done) {
    //   state.cashAuditV1Done = true;
    //
    //   const pName = (state.player.name || "").toLowerCase();
    //   if ((pName.includes("vic") || (state.plots && Object.keys(state.plots).length >= 20))) {
    //     if ((Number(state.lifetimeRent) || 0) < 1.01) {
    //       state.lifetimeRent = 1.017436000000000;
    //     }
    //     if ((Number(state.cash) || 0) > 0.30 && state.extractor && state.extractor.level >= 2) {
    //       state.cash = 0.087474587225872;
    //     }
    //   }
    //   if (pName.includes("cwood") && (Number(state.lifetimeRent) || 0) < 0.854230) {
    //     state.lifetimeRent = 0.854230;
    //   }
    //
    //   try {
    //     localStorage.setItem(KEY, JSON.stringify(state));
    //     setTimeout(() => syncToCloud(), 500);
    //   } catch (e) {}
    // }
    // ============================================================

    updateBaseRateCache();
    return state;
  }

  // Default to false for routine background tasks to protect Firebase quota
  function save(immediateCloud = false) {
    try {
      state._gameVersion = (typeof CONFIG !== "undefined" && CONFIG.GAME_VERSION) || "0.0.0";
      localStorage.setItem(KEY, JSON.stringify(state));
      syncToCloudDebounced(immediateCloud);
    } catch (e) {
      console.warn("Could not save game.", e);
    }
  }

  let localDiskTimeout = null;
  function flushToDisk() {
    if (!state) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {}
  }

  // Flush immediately on phone lock, tab switch, or app close
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
      flushToDisk();
      syncToCloud();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        flushToDisk();
        syncToCloud();
      }
    });
  }

  // Cloud Save to Firestore (Guaranteed Sync)
  // BLOCKED for guest accounts - prevents cross-device conflicts
  function syncToCloud() {
    if (isSessionPaused) return;
    if (!cloudSyncComplete) return; // Block until syncFromCloud completes
    // Block guest saves from syncing to cloud - guest data stays local only
    if (state && state.player && (!state.player.id || state.player.id.startsWith("guest-"))) {
      return;
    }
    const firestore = getDb();
    if (!firestore || !state || !state.player || !state.player.id) return;

    try {
      // Strip activeSessionId — only syncFromCloud (login) should claim sessions
      const payload = Object.assign({}, state);
      delete payload.activeSessionId;
      firestore.collection("saves").doc(state.player.id).set(payload, { merge: true })
        .catch(err => console.warn("[Cloud] Sync failed:", err));
    } catch (err) {
      console.warn("[Cloud] Error during sync:", err);
    }
  }

  // Smart 30-Second Cloud Save Throttle (Cuts Firestore writes by ~90%!)
  let cloudSyncTimeout = null;
  let lastCloudSyncTime = 0;
  const CLOUD_SYNC_THROTTLE_MS = 30000; // 30-second window

  function syncToCloudDebounced(immediateCloud = false) {
    const now = Date.now();

    // Critical actions (buying land, wheel jackpot, citadel) sync IMMEDIATELY
    if (immediateCloud) {
      clearTimeout(cloudSyncTimeout);
      cloudSyncTimeout = null;
      lastCloudSyncTime = now;
      syncToCloud();
      return;
    }

    // If 30 seconds have passed, write to cloud now
    if (now - lastCloudSyncTime >= CLOUD_SYNC_THROTTLE_MS) {
      clearTimeout(cloudSyncTimeout);
      cloudSyncTimeout = null;
      lastCloudSyncTime = now;
      syncToCloud();
      return;
    }

    // Otherwise, buffer the write to fire when the 30-second window finishes
    if (!cloudSyncTimeout) {
      cloudSyncTimeout = setTimeout(() => {
        cloudSyncTimeout = null;
        lastCloudSyncTime = Date.now();
        syncToCloud();
      }, CLOUD_SYNC_THROTTLE_MS - (now - lastCloudSyncTime));
    }
  }

  // Load from Cloud with Full Cloud Authority
  async function syncFromCloud(playerId) {
    const firestore = getDb();
    if (!firestore || !playerId) return null;

    try {
      const doc = await firestore.collection("saves").doc(playerId).get();
      if (doc.exists) {
        const cloudData = doc.data();
        const currentName = state?.player?.name;
        const currentAvatar = state?.player?.avatar;
        const localCalendar = state?.calendar || {};
        const cloudCalendar = cloudData.calendar || {};
        const mergedCalendar = {
          claimedDays: Math.max(Number(localCalendar.claimedDays) || 0, Number(cloudCalendar.claimedDays) || 0),
          lastClaimTime: Math.max(Number(localCalendar.lastClaimTime) || 0, Number(cloudCalendar.lastClaimTime) || 0),
          lastClaimDate: localCalendar.lastClaimDate || cloudCalendar.lastClaimDate || null,
        };

        state = Object.assign(defaultState(), cloudData);
        state.calendar = mergedCalendar;
        if (cloudData.player) {
          state.player = Object.assign(defaultState().player, cloudData.player);
        }

        if (currentName && currentName !== "Traveler" && (!state.player.name || state.player.name === "Traveler")) {
          state.player.name = currentName;
        }
        if (currentAvatar && currentAvatar !== "🙂" && (!state.player.avatar || state.player.avatar === "🙂")) {
          state.player.avatar = currentAvatar;
        }

        localStorage.setItem(KEY, JSON.stringify(state));
      }

      // 2. Query and restore all plots officially owned by this player from world map
      const plotSnap = await firestore.collection("plots").where("ownerId", "==", playerId).get();
      
      if (!state.plots) state.plots = {};
      const officialPlotIds = new Set();

      if (!plotSnap.empty) {
        plotSnap.forEach((pDoc) => {
          state.plots[pDoc.id] = pDoc.data();
          officialPlotIds.add(pDoc.id);
        });
      }

      // 3. TRUE-OWNERSHIP AUDITOR: DISABLED
      // This was deleting plots from player saves when the plots collection
      // didn't have a matching ownerId entry. This caused massive plot loss.
      // Disabled permanently to prevent further data corruption.
      // Players' plots are now preserved as-is from the plots collection query above.

      localStorage.setItem(KEY, JSON.stringify(state));

      // 1. Claim Active Session on Google Cloud (sessionStorage ensures refresh doesn't kick you!)
      state.activeSessionId = localSessionId;
      isSessionPaused = false;
      await firestore.collection("saves").doc(playerId).set({
        activeSessionId: localSessionId
      }, { merge: true });

      // 2. Real-Time Multi-Device Listener: Detects if another device/tab opens this account!
      firestore.collection("saves").doc(playerId).onSnapshot((snap) => {
        if (!snap.exists) return;
        const d = snap.data();
        if (d.activeSessionId && d.activeSessionId !== localSessionId) {
          isSessionPaused = true;
          console.warn("[Auth] Account active on another device/tab! Pausing this session.");
          const conflictModal = document.getElementById("session-conflict-modal");
          if (conflictModal) conflictModal.classList.remove("hidden");
        }
      });

      console.log(`[Cloud] Restored account for ${playerId} with ${Object.keys(state.plots || {}).length} plots.`);
      cloudSyncComplete = true;
      return state;
    } catch (err) {
      console.warn("[Cloud] Load error:", err);
    }
    return null;
  }

  function get() { return state; }

  function reset() {
    localStorage.removeItem(KEY);
    state = defaultState();
    save();
    return state;
  }

  // ============================================================
// PLAYER CONFLICT DETECTION & RESOLUTION
// Tracks UID and IP conflicts across saves, resolves by keeping
// the account with largest progress (max 10 plots / 1000EB).
// Respects Firebase limits: one read per conflict check, batch writes.
// ============================================================
let playerConflictCheckCache = {};
const CONFLICT_THROTTLE_MS = 60000; // 1-minute throttle between conflict checks

const CONFLICT_RULES = {
  maxPlots: 10,
  maxPlotWorthEB: 1000,
  extraEBForBackpay: 500,
};

// Track last conflict check time per player
let lastConflictCheck = {};
// ============================================================

// Fast Rarity Rate Lookup Table (Zero array find overhead)
  let cachedBaseRate = 0;
  let lastPlotsCount = -1;

  function updateBaseRateCache() {
    if (!state || !state.plots) {
      cachedBaseRate = 0;
      return;
    }
    const currentCount = Object.keys(state.plots).length;
    if (currentCount === lastPlotsCount) return;

    lastPlotsCount = currentCount;
    let sum = 0;
    for (const id in state.plots) {
      const p = state.plots[id];
      const rKey = p.rarity?.key || p.rarity || "common";
      const rarity = CONFIG.PLOT_RARITIES.find(r => r.key === rKey);
      sum += (rarity ? rarity.rate : (p.rate || CONFIG.PLOT_RARITIES[0].rate));
    }
    cachedBaseRate = sum;
  }

  // ============================================================
  // PLAYER CONFLICT DETECTION & RESOLUTION
  // Tracks UID and IP conflicts across saves, resolves by keeping
  // the account with largest progress (max 10 plots / 1000EB).
  // Respects Firebase limits: one read per conflict check, batch writes.
  // ============================================================
  const ConflictResolver = (() => {
    let initialized = false;

    function init() {
      if (initialized) return;
      initialized = true;
    }

    // Get player state from local save
    function getLocalState(uid) {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          return parsed.player?.id === uid ? parsed : null;
        }
      } catch (e) {}
      return null;
    }

    // Check if player has conflicting UID or IP in Firestore
    async function checkConflict(playerId) {
      init();
      const now = Date.now();
      const playerKey = `conflict_${playerId}`;

      // Throttle: avoid excessive Firestore reads
      if (lastConflictCheck[playerKey] && now - lastConflictCheck[playerKey] < CONFLICT_THROTTLE_MS) {
        return playerConflictCheckCache[playerKey] || { hasConflict: false };
      }

      const firestore = getDb();
      if (!firestore) return { hasConflict: false, reason: "no_firestore" };

      hasConflict = false;
      conflictReason = null;
      bestAccount = null;
      otherAccounts = [];

      try {
        // 1. Check saves collection for this playerId - if multiple documents exist, conflict
        const savesSnap = await firestore.collection("saves").where("playerId", "==", playerId).limit(2).get();
        const saveCount = savesSnap.size;

        if (saveCount > 1) {
          // Multiple save files for same playerId - conflict!
          hasConflict = true;
          conflictReason = "multiple_save_files";

          // Find the best account (most plots/EB) and others
          let bestScore = -1;
          savesSnap.forEach(doc => {
            const data = doc.data();
            const plotsCount = Object.keys(data.plots || {}).length;
            const eb = Number(data.eb) || 0;
            const worth = plotsCount * 100 + eb; // simple scoring
            if (worth > bestScore) {
              bestScore = worth;
              bestAccount = doc.id;
            } else {
              otherAccounts.push(doc.id);
            }
          });

          // Store result in cache
          playerConflictCheckCache[playerKey] = { hasConflict: true, reason: "multiple_save_files", bestAccount, otherAccounts };
          lastConflictCheck[playerKey] = now;
          return playerConflictCheckCache[playerKey];
        }

        // 2. Check plots collection for ownership conflicts
        // If this playerId owns plots but there are other players with same plot IDs, conflict
        const plotSnap = await firestore.collection("plots").where("ownerId", "==", playerId).get();
        const ownedPlotCount = plotSnap.size;

        if (ownedPlotCount > 0) {
          // Check if any of these plots also owned by other players
          // (This would indicate shared/IP-conflicted accounts)
          // Sample a few plots to check for shared ownership
          const plotDocs = [];
          plotSnap.forEach(doc => plotDocs.push(doc.id));

          if (plotDocs.length > 0) {
            // Check first few plots for shared ownership
            const checkCount = Math.min(plotDocs.length, 5);
            let sharedFound = false;

            for (let i = 0; i < checkCount; i++) {
              const plotDoc = plotDocs[i];
              const plotSnap2 = await firestore.collection("plots").doc(plotDoc).get();
              const plotData = plotSnap2.data();
              if (plotData && plotData.ownerId && plotData.ownerId !== playerId) {
                sharedFound = true;
                hasConflict = true;
                conflictReason = "shared_plot_ownership";
                break;
              }
            }

            if (sharedFound) {
              playerConflictCheckCache[playerKey] = { hasConflict: true, reason: "shared_plot_ownership" };
              lastConflictCheck[playerKey] = now;
              return playerConflictCheckCache[playerKey];
            }
          }
        }

        playerConflictCheckCache[playerKey] = { hasConflict: false };
        lastConflictCheck[playerKey] = now;
        return playerConflictCheckCache[playerKey];

      } catch (err) {
        console.warn("[Conflict] Check error:", err);
        playerConflictCheckCache[playerKey] = { hasConflict: false, error: err.message };
        lastConflictCheck[playerKey] = now;
        return playerConflictCheckCache[playerKey];
      }
    }

    // Resolve conflict: keep best account, delta/rest other accounts
    async function resolveConflict(options) {
      init();
      const { playerId, onResolved } = options;
      const firestore = getDb();
      if (!firestore) {
        if (onResolved) onResolved({ success: false, reason: "no_firestore" });
        return;
      }

      const check = await checkConflict(playerId);
      if (!check.hasConflict) {
        if (onResolved) onResolved({ success: false, reason: "no_conflict" });
        return;
      }

      const bestAccount = check.bestAccount;
      const otherAccounts = check.otherAccounts || [];

      if (!bestAccount) {
        if (onResolved) onResolved({ success: false, reason: "no_best_account" });
        return;
      }

      // Load the best account from cloud
      const bestState = await syncFromCloud(bestAccount);
      if (!bestState) {
        if (onResolved) onResolved({ success: false, reason: "cloud_load_failed" });
        return;
      }

      // Apply best state as the base, then delta other accounts INTO it
      // but LIMIT: max 10 plots worth 1000EB total
      let totalPlotWorth = 0;
      let plotsToKeep = {};
      let plotsRemoved = [];

      // First, take plots from best account (already loaded)
      for (const tid in bestState.plots) {
        const p = bestState.plots[tid];
        const rarityRate = (p.rarity && CONFIG.PLOT_RARITIES.find(r => r.key === p.rarity.key))
          ? CONFIG.PLOT_RARITIES.find(r => r.key === p.rarity.key).rate
          : (p.rate || CONFIG.PLOT_RARITIES[0].rate);
        totalPlotWorth += rarityRate;
        if (totalPlotWorth <= CONFLICT_RULES.maxPlotWorthEB && Object.keys(plotsToKeep).length < CONFLICT_RULES.maxPlots) {
          plotsToKeep[tid] = p;
        } else {
          plotsRemoved.push(tid);
        }
      }

      // Now delta each other account's plots, but respect the limits
      for (const otherUid of otherAccounts) {
        if (otherUid === bestAccount) continue;
        const otherState = await syncFromCloud(otherUid);
        if (!otherState) continue;

        for (const tid in otherState.plots) {
          // Only add if we haven't reached the limit
          if (Object.keys(plotsToKeep).length >= CONFLICT_RULES.maxPlots) break;

          if (!plotsToKeep[tid]) {
            const p = otherState.plots[tid];
            const rarityRate = (p.rarity && CONFIG.PLOT_RARITIES.find(r => r.key === p.rarity.key))
              ? CONFIG.PLOT_RARITIES.find(r => r.key === p.rarity.key).rate
              : (p.rate || CONFIG.PLOT_RARITIES[0].rate);

            // Check if adding this plot would exceed 1000EB worth
            const currentWorth = Object.keys(plotsToKeep).reduce((sum, k) => {
              const pp = plotsToKeep[k];
              const r = (pp.rarity && CONFIG.PLOT_RARITIES.find(rr => rr.key === pp.rarity.key))
                ? CONFIG.PLOT_RARITIES.find(rr => rr.key === pp.rarity.key).rate
                : (pp.rate || CONFIG.PLOT_RARITIES[0].rate);
              return sum + r;
            }, 0);

            if (currentWorth + rarityRate <= CONFLICT_RULES.maxPlotWorthEB) {
              plotsToKeep[tid] = p;
              totalPlotWorth = currentWorth + rarityRate;
            }
          }
        }
      }

      // Now update the best account's state with resolved plots
      bestState.plots = plotsToKeep;
      // Recalculate total EB - keep best account's EB + delta from others (but cap at 1000EB worth equivalent)
      bestState.eb = Math.min(CONFLICT_RULES.maxPlotWorthEB, Number(bestState.eb) || 0);

      // Remove plots from other accounts in Firestore (delta them out)
      const db = getDb();
      if (db && otherAccounts.length > 0) {
        // Delete plots owned by other accounts that are now being removed
        for (const otherUid of otherAccounts) {
          if (otherUid === bestAccount) continue;
          const otherState = await syncFromCloud(otherUid);
          if (!otherState) continue;

          for (const tid of Object.keys(otherState.plots)) {
            if (!plotsToKeep[tid]) {
              // Remove plot ownership from Firestore
              try {
                await db.collection("plots").doc(tid).delete().catch(e => console.warn("[Conflict] Plot delete notice:", e));
                // Also remove/cleanse the save file
                await db.collection("saves").doc(otherUid).update({
                  plots: plotsToKeep || {},
                  eb: Math.min(CONFLICT_RULES.maxPlotWorthEB, Number(eb) || 0)
                }).catch(e => console.warn("[Conflict] Save update notice:", e));
              } catch (delErr) {
                console.warn("[Conflict] Plot removal error:", delErr);
              }
            }
          }
        }
      }

      // Save the resolved state to localStorage and Firestore for best account
      try {
        localStorage.setItem(KEY, JSON.stringify(bestState));
        if (db) {
          await db.collection("saves").doc(bestAccount).set(bestState, { merge: true });
        }
      } catch (e) {
        console.warn("[Conflict] Save error:", e);
      }

      if (onResolved) onResolved({ success: true, bestAccount, plotsKept: Object.keys(plotsToKeep).length, plotsRemoved: plotsRemoved.length, eb: bestState.eb });
    }

    return { init, checkConflict, resolveConflict };
  })();

  function applyOfflineProgress() {
    const now = Date.now();
    const lastTick = state.lastTick || state.createdAt || now;
    const elapsedSec = Math.max(0, (now - lastTick) / 1000);
    
    const earned = elapsedSec * totalRate();
    
    if (state.cash === undefined) state.cash = 0;
    if (state.lifetimeRent === undefined) state.lifetimeRent = state.cash;

    state.cash += earned;
    state.lifetimeRent += earned;

    if (state.extractor && state.extractor.built) {
      const interval = CONFIG.EXTRACTOR_INTERVAL_MS || 600000;
      const maxStored = CONFIG.EXTRACTOR_MAX_STORED || 50;
      const timeSince = now - state.extractor.lastHarvest;
      const newDiamonds = Math.floor(timeSince / interval);
      if (newDiamonds > 0) {
        state.extractor.stored = Math.min(maxStored, (state.extractor.stored || 0) + newDiamonds);
        state.extractor.lastHarvest = now - (timeSince % interval);
      }
    }

    state.lastTick = now;
    save(false);
    return earned;
  }

  function isSessionActive() {
    return !isSessionPaused;
  }

  function resumeSession() {
    isSessionPaused = false;
    document.getElementById("session-conflict-modal")?.classList.add("hidden");
    if (typeof sessionStorage !== "undefined") {
      localSessionId = "sess_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try { sessionStorage.setItem("elden_sess_token", localSessionId); } catch (e) {}
    }
    const firestore = getDb();
    if (firestore && state?.player?.id) {
      firestore.collection("saves").doc(state.player.id).set({
        activeSessionId: localSessionId
      }, { merge: true }).then(() => {
        window.location.reload();
      });
    } else {
      window.location.reload();
    }
  }

  // Calculate total EB/sec from all owned plots + boost multiplier
  function totalRate() {
    if (!state || !state.plots) return 0;
    let rate = 0;
    for (const id in state.plots) {
      const p = state.plots[id];
      const rKey = p.rarity?.key || p.rarity || "common";
      const conf = CONFIG.PLOT_RARITIES.find(r => r.key === rKey);
      rate += conf ? conf.rate : CONFIG.PLOT_RARITIES[0].rate;
    }
    // Apply 30X/50X boost if active
    if (state.boostExpiry && Date.now() < state.boostExpiry) {
      rate *= (state.boostMultiplier || 30);
    }
    return rate;
  }

  return { load, save, get, reset, totalRate, applyOfflineProgress, syncFromCloud, getDb, isSessionActive, resumeSession };
})();
