// ============================================================
// Elden Earth — Account Cleanup, Plot & Balance Restoration
//
// 1. Finds orphaned anonymous Firebase Auth accounts
// 2. Merges their saves/plots into matching Google accounts
// 3. Deletes the orphaned anonymous accounts
// 4. Applies 3000 EA bonus + 1000 community refund + 50 diamonds + 25 free spins
// 5. Deletes orphaned Firestore saves (no matching Auth user)
// ============================================================
//
// PREREQUISITES:
// 1. npm install firebase-admin@10.0.0
// 2. Save service account key to ~/Desktop/eldenearth-service-account.json
//
// Run: node functions/restore-plots.js
// ============================================================

const admin = require("firebase-admin");

// Initialize Firebase Admin
let initialized = false;

// 1. Try GOOGLE_APPLICATION_CREDENTIALS env var
if (!initialized && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    const cred = admin.credential.cert(require(process.env.GOOGLE_APPLICATION_CREDENTIALS));
    admin.initializeApp({ credential: cred });
    initialized = true;
    console.log("[Restore] Using credentials from GOOGLE_APPLICATION_CREDENTIALS env var");
  } catch (e) {
    console.warn("[Restore] Could not load credentials from env var:", e.message);
  }
}

// 2. Try common service account locations
const commonPaths = [
  require("path").join(require("os").homedir(), "Desktop", "eldenearth-service-account.json"),
  require("path").join(require("os").homedir(), "Downloads", "eldenearth-service-account.json"),
  require("path").join(__dirname, "service-account.json"),
  require("path").join(__dirname, "eldenearth-service-account.json"),
];

if (!initialized) {
  for (const p of commonPaths) {
    try {
      const fs = require("fs");
      if (fs.existsSync(p)) {
        const cred = admin.credential.cert(require(p));
        admin.initializeApp({ credential: cred });
        initialized = true;
        console.log(`[Restore] Using credentials from: ${p}`);
        break;
      }
    } catch (e) {
      // continue to next path
    }
  }
}

// 3. Try application default credentials
if (!initialized) {
  try {
    const cred = admin.credential.applicationDefault();
    admin.initializeApp({ credential: cred });
    initialized = true;
    console.log("[Restore] Using application default credentials");
  } catch (e) {
    console.warn("[Restore] ADC not available:", e.message);
  }
}

// 4. Fallback: project ID only (limited access)
if (!initialized) {
  try {
    admin.initializeApp({ projectId: "eldenearthdev" });
    initialized = true;
    console.log("[Restore] Using projectId only (limited access)");
  } catch (e) {
    console.error("[Restore] Could not initialize Firebase Admin.");
    console.error("[Restore] Please do ONE of the following:");
    console.error("[Restore]   1. Download service account key from Firebase Console");
    console.error("[Restore]   2. Save it as ~/Desktop/eldenearth-service-account.json");
    console.error("[Restore]   3. Re-run this script");
    process.exit(1);
  }
}

const auth = admin.auth();
const db = admin.firestore();

// Restoration constants
const RESTORATION_EB = 4000;        // EA build celebration bonus (additive)
const RESTORATION_SPINS = 25;       // Free spins (no diamond cost)
const RESTORATION_DIAMONDS = 50;    // Diamond restoration

// Plot rarity rates matching CONFIG.PLOT_RARITIES (nerfed by 1/4)
const PLOT_RATES = {
  common: 0.0000000004,
  rare: 0.000000000675,
  epic: 0.0000000011,
  legendary: 0.0000000022
};

// ============================================================
// MAIN
// ============================================================
async function restoreAllPlayers() {
  console.log("[Restore] Starting account cleanup & restoration...\n");

  // ============================================================
  // PHASE 1: List ALL Firebase Auth users
  // ============================================================
  console.log("[Restore] Phase 1: Listing all Firebase Auth users...");
  const googleUsers = [];
  const anonUsers = [];

  let listResult = await auth.listUsers(100);
  while (listResult.users.length > 0) {
    for (const user of listResult.users) {
      const isAnon = user.providerData.length === 0 ||
        user.providerData.every(p => p.providerId === "firebase");
      if (isAnon) {
        anonUsers.push(user);
      } else {
        googleUsers.push(user);
      }
    }
    if (listResult.pageToken) {
      listResult = await auth.listUsers(100, listResult.pageToken);
    } else {
      break;
    }
  }

  console.log(`[Restore] Found ${googleUsers.length} Google accounts`);
  console.log(`[Restore] Found ${anonUsers.length} anonymous accounts`);
  for (const u of googleUsers) {
    const email = u.email || u.providerData[0]?.email || "unknown";
    console.log(`[Restore]   Google: ${email} (${u.uid})`);
  }
  for (const u of anonUsers) {
    console.log(`[Restore]   Anon:   ${u.uid}`);
  }

  // ============================================================
  // PHASE 2: Read ALL saves and plots from Firestore
  // ============================================================
  console.log("\n[Restore] Phase 2: Reading Firestore data...");

  const allSaves = {};
  const saveSnap = await db.collection("saves").get();
  saveSnap.forEach(doc => {
    const data = doc.data();
    if (data && data.player) {
      const id = data.player.id || doc.id;
      allSaves[id] = { docId: doc.id, data };
    }
  });
  console.log(`[Restore] Found ${saveSnap.size} saves in Firestore`);

  const allPlots = {};
  const plotSnap = await db.collection("plots").get();
  plotSnap.forEach(doc => {
    const data = doc.data();
    if (data && data.ownerId) {
      if (!allPlots[data.ownerId]) allPlots[data.ownerId] = {};
      allPlots[data.ownerId][doc.id] = data;
    }
  });
  console.log(`[Restore] Found ${plotSnap.size} plots across ${Object.keys(allPlots).length} owners`);

  // ============================================================
  // PHASE 3: Merge orphaned anonymous accounts into Google accounts
  //
  // Strategy: For each anonymous account with plots or a save,
  // find a Google account to merge into. Priority:
  //   1. Google account with same name (from display name match)
  //   2. Google account with no plots yet (best candidate)
  //   3. Google account with lowest EB (needs the data most)
  //
  // Then:
  //   - Merge save data (take max of both: plots, EB, diamonds, etc.)
  //   - Update plots collection ownerId to point to Google account
  //   - Delete the orphaned anonymous Auth account
  // ============================================================
  console.log("\n[Restore] Phase 3: Merging orphaned anonymous accounts...");

  let merged = 0;
  let anonDeleted = 0;
  let anonSkipped = 0;

  // Build a list of Google accounts that still need data
  const availableGoogle = [...googleUsers];

  for (const anonUser of anonUsers) {
    const anonUid = anonUser.uid;
    const anonSave = allSaves[anonUid];
    const anonPlots = allPlots[anonUid] || {};

    // Check if anonymous account has any meaningful data
    const hasPlots = Object.keys(anonPlots).length > 0;
    const hasSave = !!anonSave;
    const hasEB = hasSave && (Number(anonSave.data.eb) || 0) > 0;
    const hasDiamonds = hasSave && (Number(anonSave.data.diamonds) || 0) > 0;

    if (!hasPlots && !hasSave) {
      // Anonymous account with no data — just delete it
      try {
        await auth.deleteUser(anonUid);
        anonDeleted++;
        console.log(`[Restore]   Deleted empty anon: ${anonUid}`);
      } catch (err) {
        console.error(`[Restore]   Failed to delete empty anon ${anonUid}:`, err.message);
      }
      continue;
    }

    if (!hasPlots && !hasEB && !hasDiamonds) {
      // Anonymous account with nothing meaningful
      try {
        await auth.deleteUser(anonUid);
        anonDeleted++;
        console.log(`[Restore]   Deleted worthless anon: ${anonUid}`);
      } catch (err) {
        console.error(`[Restore]   Failed to delete worthless anon ${anonUid}:`, err.message);
      }
      continue;
    }

    // Find the best Google account to merge into
    let targetGoogle = null;

    // Priority 1: Google account with no plots (cleanest merge)
    for (const g of availableGoogle) {
      const gPlots = allPlots[g.uid] || {};
      if (Object.keys(gPlots).length === 0) {
        targetGoogle = g;
        break;
      }
    }

    // Priority 2: Google account with lowest EB (needs the data most)
    if (!targetGoogle && availableGoogle.length > 0) {
      let lowestEB = Infinity;
      for (const g of availableGoogle) {
        const gSave = allSaves[g.uid];
        const gEB = gSave ? (Number(gSave.data.eb) || 0) : 0;
        if (gEB < lowestEB) {
          lowestEB = gEB;
          targetGoogle = g;
        }
      }
    }

    if (!targetGoogle) {
      console.warn(`[Restore]   No Google account found to merge anon ${anonUid} — keeping anonymous account`);
      anonSkipped++;
      continue;
    }

    const targetUid = targetGoogle.uid;
    const targetEmail = targetGoogle.email || targetGoogle.providerData[0]?.email || "unknown";
    console.log(`[Restore]   Merging anon ${anonUid} → Google ${targetEmail} (${targetUid})`);

    try {
      // MERGE SAVE DATA
      let targetSave = allSaves[targetUid]?.data || createDefaultSave(targetUid);
      const anonSaveData = anonSave?.data || null;

      if (anonSaveData) {
        // Take the higher EB
        const targetEB = Number(targetSave.eb) || 0;
        const anonEB = Number(anonSaveData.eb) || 0;
        if (anonEB > targetEB) {
          targetSave.eb = anonEB;
          console.log(`[Restore]     EB: ${targetEB} → ${anonEB} (took anon's higher balance)`);
        }

        // Take the higher diamond count
        const targetDiamonds = Number(targetSave.diamonds) || 0;
        const anonDiamonds = Number(anonSaveData.diamonds) || 0;
        if (anonDiamonds > targetDiamonds) {
          targetSave.diamonds = anonDiamonds;
        }

        // Merge free spins (additive)
        const anonFreeSpins = Number(anonSaveData.player?.freeSpins) || 0;
        if (anonFreeSpins > 0) {
          targetSave.player.freeSpins = (Number(targetSave.player.freeSpins) || 0) + anonFreeSpins;
          targetSave.player.freeSpinsNoDiamondCost = true;
        }

        // MOVE PLOTS TO PLOTBAG — so the player can place them in their radius
        targetSave.plotBag = targetSave.plotBag || {};
        let plotsToBag = 0;

        // Count plots from anon's save's plots dict by rarity
        const anonPlotsData = anonSaveData.plots || {};
        for (const plotId in anonPlotsData) {
          const p = anonPlotsData[plotId];
          const rarity = p.rarity || p.rarityKey || "common";
          let slot = rarity;
          let suffix = 0;
          while (Number(targetSave.plotBag[slot]) >= 99) {
            suffix++;
            slot = `${rarity}_${suffix}`;
          }
          targetSave.plotBag[slot] = (Number(targetSave.plotBag[slot]) || 0) + 1;
          plotsToBag++;
        }

        // Also count plots from Firestore plots collection (authoritative source)
        const anonPlotsCollection = allPlots[anonUid] || {};
        for (const plotId in anonPlotsCollection) {
          // Skip if already counted from save dict
          if (anonPlotsData[plotId]) continue;
          const p = anonPlotsCollection[plotId];
          const rarity = p.rarity || p.rarityKey || "common";
          let slot = rarity;
          let suffix = 0;
          while (Number(targetSave.plotBag[slot]) >= 99) {
            suffix++;
            slot = `${rarity}_${suffix}`;
          }
          targetSave.plotBag[slot] = (Number(targetSave.plotBag[slot]) || 0) + 1;
          plotsToBag++;
        }

        if (plotsToBag > 0) {
          console.log(`[Restore]     Moved ${plotsToBag} plots to plotBag for placement`);
        }

        // Remove plots from the placed dict (they're now in plotBag to re-place)
        targetSave.plots = {};

        // Use more advanced player info if target is still default
        if (anonSaveData.player?.name && targetSave.player?.name === "Traveler") {
          targetSave.player.name = anonSaveData.player.name;
        }
        if (anonSaveData.player?.avatar && targetSave.player?.avatar === "🙂") {
          targetSave.player.avatar = anonSaveData.player.avatar;
        }
      }

      // MERGE PLOTS COLLECTION — reassign anon plots to Google account
      const plotsToReassign = allPlots[anonUid] || {};
      let reassignedPlots = 0;
      for (const plotId in plotsToReassign) {
        try {
          await db.collection("plots").doc(plotId).update({ ownerId: targetUid });
          reassignedPlots++;
        } catch (err) {
          console.warn(`[Restore]     Could not reassign plot ${plotId}:`, err.message);
        }
      }
      if (reassignedPlots > 0) {
        console.log(`[Restore]     Reassigned ${reassignedPlots} plots in Firestore`);
      }

      // Update save target ID
      targetSave.player.id = targetUid;

      // Save merged data
      await db.collection("saves").doc(targetUid).set(targetSave, { merge: true });

      // Delete the anonymous save from Firestore
      if (anonSave && anonSave.docId !== targetUid) {
        try {
          await db.collection("saves").doc(anonSave.docId).delete();
        } catch (err) {
          // docId might equal anonUid which may not exist as a doc
        }
      }

      // Delete the anonymous Firebase Auth account
      try {
        await auth.deleteUser(anonUid);
        anonDeleted++;
        console.log(`[Restore]     Deleted anon Auth account ${anonUid}`);
      } catch (err) {
        console.error(`[Restore]     Failed to delete anon Auth ${anonUid}:`, err.message);
      }

      merged++;

      // Update in-memory cache
      allSaves[targetUid] = { docId: targetUid, data: targetSave };
    } catch (err) {
      console.error(`[Restore]   Failed to merge anon ${anonUid}:`, err.message);
    }
  }

  // ============================================================
  // PHASE 4: Clean up orphaned Firestore saves
  // (saves with no matching Firebase Auth user)
  // ============================================================
  console.log("\n[Restore] Phase 4: Cleaning orphaned Firestore saves...");

  const allAuthUids = new Set([...googleUsers.map(u => u.uid), ...anonUsers.map(u => u.uid)]);
  // Note: we already deleted anon users above, so remaining auth users = google users
  const remainingGoogleUids = new Set(googleUsers.map(u => u.uid));

  let orphanedSavesDeleted = 0;
  for (const [playerId, saveInfo] of Object.entries(allSaves)) {
    if (!remainingGoogleUids.has(playerId)) {
      // This save belongs to a deleted anonymous account that wasn't merged
      try {
        await db.collection("saves").doc(saveInfo.docId).delete();
        orphanedSavesDeleted++;
        console.log(`[Restore]   Deleted orphaned save: ${playerId}`);
      } catch (err) {
        console.warn(`[Restore]   Could not delete orphaned save ${playerId}:`, err.message);
      }
    }
  }

  // Also clean up orphaned plots (plots pointing to deleted anon UIDs)
  let orphanedPlotsDeleted = 0;
  for (const [ownerId, plots] of Object.entries(allPlots)) {
    if (!remainingGoogleUids.has(ownerId)) {
      for (const plotId in plots) {
        try {
          await db.collection("plots").doc(plotId).delete();
          orphanedPlotsDeleted++;
        } catch (err) {
          // ignore
        }
      }
    }
  }
  if (orphanedPlotsDeleted > 0) {
    console.log(`[Restore]   Deleted ${orphanedPlotsDeleted} orphaned plots from Firestore`);
  }

  // Clean up orphaned presence documents (deleted anon accounts still showing online)
  console.log("\n[Restore] Phase 4b: Cleaning orphaned presence documents...");
  const presenceSnap = await db.collection("presence").get();
  let presenceDeleted = 0;
  for (const doc of presenceSnap.docs) {
    if (!remainingGoogleUids.has(doc.id)) {
      try {
        await db.collection("presence").doc(doc.id).delete();
        presenceDeleted++;
      } catch (err) {
        // ignore
      }
    }
  }
  if (presenceDeleted > 0) {
    console.log(`[Restore]   Deleted ${presenceDeleted} orphaned presence documents`);
  }

  // Clean up orphaned feed messages (chat from deleted anon accounts)
  // Feed docs don't have senderId — player name is embedded in message HTML
  // Deleted anon accounts all used default name "Traveler"
  console.log("\n[Restore] Phase 4c: Cleaning orphaned feed/chat messages...");
  const feedSnap = await db.collection("feed").get();
  let feedDeleted = 0;
  for (const doc of feedSnap.docs) {
    const data = doc.data();
    const msg = data.message || "";
    // Delete feed messages from "Traveler" (default anon name) for daily login, spin, land claim types
    if (data.type === "daily" || data.type === "jackpot" || data.type === "diamond_jackpot" || data.type === "land") {
      if (msg.includes("<strong>Traveler</strong>") || msg.includes("Traveler")) {
        try {
          await db.collection("feed").doc(doc.id).delete();
          feedDeleted++;
        } catch (err) {
          // ignore
        }
      }
    }
  }
  if (feedDeleted > 0) {
    console.log(`[Restore]   Deleted ${feedDeleted} orphaned feed messages (Traveler entries)`);
  }

  // Clean up orphaned usernames (anon accounts holding username slots)
  console.log("\n[Restore] Phase 4d: Cleaning orphaned usernames...");
  const usernamesSnap = await db.collection("usernames").get();
  let usernamesDeleted = 0;
  for (const doc of usernamesSnap.docs) {
    const data = doc.data();
    const uid = data.uid || data.userId || data.playerId || doc.id;
    if (!remainingGoogleUids.has(uid)) {
      try {
        await db.collection("usernames").doc(doc.id).delete();
        usernamesDeleted++;
      } catch (err) {
        // ignore
      }
    }
  }
  if (usernamesDeleted > 0) {
    console.log(`[Restore]   Deleted ${usernamesDeleted} orphaned usernames`);
  }

  // Clean up orphaned dividends
  console.log("\n[Restore] Phase 4e: Cleaning orphaned dividends...");
  const divSnap = await db.collection("dividends").get();
  let divDeleted = 0;
  for (const doc of divSnap.docs) {
    const data = doc.data();
    const uid = data.uid || data.userId || data.playerId || doc.id;
    if (!remainingGoogleUids.has(uid)) {
      try {
        await db.collection("dividends").doc(doc.id).delete();
        divDeleted++;
      } catch (err) {
        // ignore
      }
    }
  }
  if (divDeleted > 0) {
    console.log(`[Restore]   Deleted ${divDeleted} orphaned dividends`);
  }

  // ============================================================
  // PHASE 5: Apply restoration bonus to ALL Google accounts
  // ============================================================
  console.log("\n[Restore] Phase 5: Applying restoration bonus to all accounts...");

  // Re-read saves after merges
  const finalSaves = {};
  const finalSaveSnap = await db.collection("saves").get();
  finalSaveSnap.forEach(doc => {
    const data = doc.data();
    if (data && data.player) {
      finalSaves[data.player.id || doc.id] = { docId: doc.id, data };
    }
  });

  // Re-read plots after reassignment
  const finalPlots = {};
  const finalPlotSnap = await db.collection("plots").get();
  finalPlotSnap.forEach(doc => {
    const data = doc.data();
    if (data && data.ownerId) {
      if (!finalPlots[data.ownerId]) finalPlots[data.ownerId] = {};
      finalPlots[data.ownerId][doc.id] = data;
    }
  });

  let bonusApplied = 0;
  let bonusSkipped = 0;
  for (const googleUser of googleUsers) {
    const uid = googleUser.uid;
    const email = googleUser.email || googleUser.providerData[0]?.email || "unknown";

    let saveData = finalSaves[uid]?.data || createDefaultSave(uid);
    const plotsForPlayer = finalPlots[uid] || {};
    const restoreVersion = saveData.restorationVersion || 0;

    // Skip if already processed with current version (safe to re-run)
    if (restoreVersion >= 4) {
      console.log(`[Restore]   Skipped ${email}: already at version ${restoreVersion}`);
      bonusSkipped++;
      continue;
    }

    // FLAT SET — exact amounts, not additive (prevents stacking on re-runs)
    saveData.eb = RESTORATION_EB;
    saveData.diamonds = RESTORATION_DIAMONDS;
    saveData.player.freeSpins = RESTORATION_SPINS;
    saveData.player.freeSpinsNoDiamondCost = true;
    saveData.player.eaBuildBonusClaimed = true;
    if (!saveData.player.eaSignInDate) saveData.player.eaSignInDate = Date.now();
    saveData.restorationVersion = 4;
    saveData.restorationPlotCount = Object.keys(plotsForPlayer).length;

    // Keep existing placed plots — don't clear them
    saveData.plots = saveData.plots || {};

    // Move Firestore plots to plotBag ONLY if not already placed
    saveData.plotBag = saveData.plotBag || {};
    let plotsToBag = 0;
    for (const plotId in plotsForPlayer) {
      if (saveData.plots[plotId]) continue; // Already placed, skip
      const p = plotsForPlayer[plotId];
      const rarity = p.rarity || p.rarityKey || "common";
      let slot = rarity;
      let suffix = 0;
      while (Number(saveData.plotBag[slot]) >= 99) {
        suffix++;
        slot = `${rarity}_${suffix}`;
      }
      saveData.plotBag[slot] = (Number(saveData.plotBag[slot]) || 0) + 1;
      plotsToBag++;
    }

    await db.collection("saves").doc(uid).set(saveData, { merge: true });
    bonusApplied++;
      console.log(`[Restore]   ${email}: set to ${saveData.eb} EB (3000 EA + 1000 refund), ${saveData.diamonds} diamonds, ${RESTORATION_SPINS} spins, ${plotsToBag} plots to bag`);
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log("\n[Restore] ========================================");
  console.log("[Restore] RESTORATION COMPLETE");
  console.log("[Restore] ========================================");
  console.log(`[Restore] Google accounts found:    ${googleUsers.length}`);
  console.log(`[Restore] Anonymous accounts found: ${anonUsers.length}`);
  console.log(`[Restore] Anon accounts merged:     ${merged}`);
  console.log(`[Restore] Anon accounts deleted:    ${anonDeleted}`);
  console.log(`[Restore] Anon accounts skipped:    ${anonSkipped}`);
  console.log(`[Restore] Orphaned saves deleted:   ${orphanedSavesDeleted}`);
  console.log(`[Restore] Orphaned plots deleted:   ${orphanedPlotsDeleted}`);
  console.log(`[Restore] Restoration bonus given:  ${bonusApplied}`);
  console.log(`[Restore] Restoration bonus skipped: ${bonusSkipped} (already up to date)`);
  console.log(`[Restore]   Each player received (flat):`);
  console.log(`[Restore]   = 4000 EB (3000 EA bonus + 1000 community refund)`);
  console.log(`[Restore]   = 50 Diamonds`);
  console.log(`[Restore]   = 25 Free Spins (no diamond cost)`);
  console.log("[Restore] Done!\n");
}

// ============================================================
// HELPERS
// ============================================================

function createDefaultSave(playerId) {
  return {
    player: {
      name: "Traveler",
      id: playerId,
      avatar: "🙂",
      model3d: "robot"
    },
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
    createdAt: Date.now()
  };
}

// ============================================================
// RUN
// ============================================================
restoreAllPlayers()
  .then(() => {
    console.log("[Restore] Script completed successfully");
    process.exit(0);
  })
  .catch(err => {
    console.error("[Restore] Fatal error:", err);
    process.exit(1);
  });
