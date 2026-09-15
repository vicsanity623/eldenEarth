// ============================================================
// Elden Earth — Orphaned Account Cleanup Script
// Deletes orphaned anonymous Firebase Auth accounts and
// merges duplicate Google accounts.
// ============================================================
//
// PREREQUISITES:
// 1. npm install firebase-admin@10.0.0
// 2. Download service account key from Firebase Console
//    → Save as ~/Desktop/eldenearth-service-account.json
//
// Run: node functions/cleanup-orphans.js
// ============================================================

const admin = require("firebase-admin");

// Initialize Firebase Admin with service account
let initialized = false;
const commonPaths = [
  require("path").join(require("os").homedir(), "Desktop", "eldenearth-service-account.json"),
  require("path").join(require("os").homedir(), "Downloads", "eldenearth-service-account.json"),
  require("path").join(__dirname, "service-account.json"),
];

if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    admin.initializeApp({ credential: admin.credential.cert(require(process.env.GOOGLE_APPLICATION_CREDENTIALS)) });
    initialized = true;
    console.log("[Cleanup] Using GOOGLE_APPLICATION_CREDENTIALS");
  } catch (e) {}
}

if (!initialized) {
  for (const p of commonPaths) {
    try {
      if (require("fs").existsSync(p)) {
        admin.initializeApp({ credential: admin.credential.cert(require(p)) });
        initialized = true;
        console.log(`[Cleanup] Using: ${p}`);
        break;
      }
    } catch (e) {}
  }
}

if (!initialized) {
  console.error("[Cleanup] No credentials found. Save service account key to ~/Desktop/eldenearth-service-account.json");
  process.exit(1);
}

const auth = admin.auth();
const db = admin.firestore();

async function cleanupOrphans() {
  console.log("[Cleanup] Starting orphaned account cleanup...\n");

  // 1. List ALL Firebase Auth users
  console.log("[Cleanup] Phase 1: Listing all Firebase Auth users...");
  const allUsers = [];
  let nextPageToken;
  do {
    const listResult = await auth.listUsers(100, nextPageToken);
    allUsers.push(...listResult.users);
    nextPageToken = listResult.pageToken;
  } while (nextPageToken);

  console.log(`[Cleanup] Found ${allUsers.length} total auth users`);

  // 2. Separate anonymous and Google users
  const anonymousUsers = allUsers.filter(u => !u.email && u.providerData.length === 0);
  const googleUsers = allUsers.filter(u => u.email && u.providerData.some(p => p.providerId === "google.com"));

  console.log(`[Cleanup]   Anonymous accounts: ${anonymousUsers.length}`);
  console.log(`[Cleanup]   Google accounts: ${googleUsers.length}`);

  // 3. For each Google user, check if they have an orphaned anonymous account
  //    that was created before the Google sign-in
  let deletedCount = 0;
  let mergedCount = 0;

  for (const googleUser of googleUsers) {
    const googleEmail = googleUser.email;
    console.log(`\n[Cleanup] Checking Google user: ${googleEmail} (${googleUser.uid})`);

    // Find saves that belong to this Google user
    const saveDoc = await db.collection("saves").doc(googleUser.uid).get();
    const saveData = saveDoc.exists ? saveDoc.data() : null;

    if (saveData) {
      console.log(`[Cleanup]   Save exists with ${Object.keys(saveData.plots || {}).length} plots`);
    } else {
      console.log(`[Cleanup]   No save file found for this Google user`);
    }

    // Check for orphaned anonymous accounts that might have this user's data
    for (const anonUser of anonymousUsers) {
      const anonSaveDoc = await db.collection("saves").doc(anonUser.uid).get();
      if (anonSaveDoc.exists) {
        const anonSave = anonSaveDoc.data();
        const anonPlots = Object.keys(anonSave.plots || {}).length;
        const anonEB = Number(anonSave.eb) || 0;

        if (anonPlots > 0 || anonEB > 1000) {
          console.log(`[Cleanup]   Found orphaned anonymous ${anonUser.uid} with ${anonPlots} plots, ${anonEB} EB`);

          // If Google user has no save or fewer plots, merge the anonymous data
          if (!saveData || Object.keys(saveData.plots || {}).length < anonPlots) {
            console.log(`[Cleanup]   Merging anonymous data into Google account...`);

            // Merge plots
            const mergedPlots = { ...(saveData?.plots || {}), ...anonSave.plots };
            const mergedEB = Math.max(Number(saveData?.eb) || 0, anonEB);
            const mergedDiamonds = Math.max(Number(saveData?.diamonds) || 0, Number(anonSave.diamonds) || 0);

            // Update Google user's save with merged data
            await db.collection("saves").doc(googleUser.uid).set({
              ...(saveData || {}),
              plots: mergedPlots,
              eb: mergedEB,
              diamonds: mergedDiamonds,
              player: {
                ...(saveData?.player || {}),
                id: googleUser.uid,
                name: googleUser.displayName || saveData?.player?.name || "Traveler",
                avatar: googleUser.photoURL ? "img:" + googleUser.photoURL : (saveData?.player?.avatar || "🙂")
              }
            }, { merge: true });

            // Update plot ownership in plots collection
            for (const tid in anonSave.plots) {
              await db.collection("plots").doc(tid).update({
                ownerId: googleUser.uid,
                ownerName: googleUser.displayName || "Traveler"
              }).catch(e => console.warn(`[Cleanup] Plot ${tid} update notice:`, e.message));
            }

            mergedCount++;
            console.log(`[Cleanup]   Merged! Google account now has ${Object.keys(mergedPlots).length} plots`);
          }

          // Delete the orphaned anonymous save
          await db.collection("saves").doc(anonUser.uid).delete();
          console.log(`[Cleanup]   Deleted orphaned save for ${anonUser.uid}`);

          // Delete the orphaned anonymous auth account
          try {
            await auth.deleteUser(anonUser.uid);
            deletedCount++;
            console.log(`[Cleanup]   Deleted orphaned auth account ${anonUser.uid}`);
          } catch (e) {
            console.warn(`[Cleanup]   Could not delete auth account ${anonUser.uid}:`, e.message);
          }
        }
      }
    }
  }

  // 4. Delete any remaining anonymous accounts with no save data
  console.log("\n[Cleanup] Phase 2: Cleaning up remaining anonymous accounts...");
  for (const anonUser of anonymousUsers) {
    const saveDoc = await db.collection("saves").doc(anonUser.uid).get();
    if (!saveDoc.exists) {
      // No save data, safe to delete
      try {
        await auth.deleteUser(anonUser.uid);
        deletedCount++;
        console.log(`[Cleanup] Deleted empty anonymous account ${anonUser.uid}`);
      } catch (e) {
        console.warn(`[Cleanup] Could not delete ${anonUser.uid}:`, e.message);
      }
    }
  }

  console.log("\n[Cleanup] ========================================");
  console.log(`[Cleanup] CLEANUP COMPLETE`);
  console.log(`[Cleanup] ========================================`);
  console.log(`[Cleanup] Accounts merged: ${mergedCount}`);
  console.log(`[Cleanup] Orphaned accounts deleted: ${deletedCount}`);
  console.log("[Cleanup] Done!\n");
}

cleanupOrphans()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("[Cleanup] Fatal error:", err);
    process.exit(1);
  });