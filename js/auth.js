// ============================================================
// Elden Earth — Authentication Bridge
// Passes Google Token & Seamlessly Migrates Guest Saves to Google
// ============================================================
const Auth = (() => {

  function decodeJwt(token) {
    try {
      const payload = token.split(".")[1];
      const json = decodeURIComponent(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
        .split("").map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join(""));
      return JSON.parse(json);
    } catch (e) { return null; }
  }

  function init(onSignedIn) {
    const guestBtn = document.getElementById("guest-btn");
    const slot = document.getElementById("g_id_signin_slot");
    let completedUid = null;

    function completeSignIn(player, uid) {
      if (completedUid === uid) return;
      completedUid = uid;
      onSignedIn(player);
    }

    // Ensure Firebase App is initialized via Store
    if (typeof Store !== "undefined" && Store.getDb) {
      Store.getDb();
    }

    // Initialize Firebase Auth Listener
    if (typeof firebase !== "undefined" && firebase.auth) {
      try {
        firebase.auth().onAuthStateChanged(async (user) => {
          if (user) {
            // ⛔ BAN QUARANTINE CHECK: Block banned UIDs instantly
            const db = Store.getDb();
            if (db) {
              const bannedDoc = await db.collection("banned_users").doc(user.uid).get();
              if (bannedDoc.exists) {
                localStorage.clear();
                sessionStorage.clear();
                document.body.innerHTML = `
                  <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#050203;color:#ff4757;font-family:sans-serif;text-align:center;padding:24px;">
                    <div style="font-size:76px;margin-bottom:16px;">⛔</div>
                    <h1 style="font-size:26px;margin-bottom:10px;">ACCOUNT PERMANENTLY TERMINATED</h1>
                    <p style="color:#ff6b81;max-width:420px;line-height:1.6;font-size:14px;">This account is permanently banned.</p>
                  </div>
                `;
                return; // Stop boot!
              }
            }

            console.log(`[FirebaseAuth] Active session authenticated: ${user.uid} (${user.isAnonymous ? "Guest" : "Google"})`);
            
            const s = Store.get();
            if (s && s.player) {
              s.player.id = user.uid;

              if (!user.isAnonymous) {
                if (user.displayName && (!s.player.name || s.player.name === "Traveler")) {
                  s.player.name = user.displayName;
                }
                if (user.photoURL && (!s.player.avatar || s.player.avatar === "🙂")) {
                  s.player.avatar = "img:" + user.photoURL;
                }
              }

              await Store.syncFromCloud(user.uid);
              completeSignIn(s.player, user.uid);
            }
          }
        });
      } catch (e) {
        console.warn("[Auth] Firebase auth listener notice:", e);
      }
    }

    // --- GUEST LOGIN HANDLER (Firebase Anonymous Auth) ---
    let guestTriggered = false;
    async function handleGuestLogin(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (guestTriggered) return;
      guestTriggered = true;

      try {
        if (firebase.auth) {
          const cred = await firebase.auth().signInAnonymously();
          const s = Store.get();
          s.player.id = cred.user.uid;
          if (!s.player.name) s.player.name = "Traveler";
          Store.save();
          completeSignIn(s.player, cred.user.uid);
        }
      } catch (err) {
        console.warn("[Auth] Anonymous login notice, falling back to local:", err);
        const s = Store.get();
        if (!s.player.id) s.player.id = "guest-" + Math.random().toString(36).slice(2, 10);
        Store.save();
        completeSignIn(s.player, s.player.id);
      }
    }

    if (guestBtn) {
      guestBtn.addEventListener("click", handleGuestLogin);
      guestBtn.addEventListener("touchend", handleGuestLogin);
    }

    // --- GOOGLE SIGN-IN & GUEST-TO-CLOUD MIGRATION HANDOFF ---
    if (!CONFIG.GOOGLE_CLIENT_ID) return;

    let attempts = 0;
    const tryInit = () => {
      attempts++;
      if (!window.google || !google.accounts || !google.accounts.id) {
        if (attempts < 50) {
          setTimeout(tryInit, 150);
        } else if (slot) {
          slot.innerHTML = `<p class="fine-print" style="color:var(--text-dim);font-size:11.5px;margin-bottom:12px;">🔒 Google Sign-In unavailable in Private Mode.<br>Continue as Guest below or open in a normal tab.</p>`;
        }
        return;
      }

      try {
        google.accounts.id.initialize({
          client_id: CONFIG.GOOGLE_CLIENT_ID,
          callback: async (resp) => {
            if (!resp.credential) return;

            const credential = firebase.auth.GoogleAuthProvider.credential(resp.credential);
            const currentUser = firebase.auth().currentUser;

            // 1. Snapshot Guest State in Memory BEFORE signing in
            const localState = Store.get() || {};
            const isGuest = currentUser ? currentUser.isAnonymous : (!localState.player?.id || localState.player.id.startsWith("guest-"));
            
            const guestPlots = Object.assign({}, localState.plots || {});
            const guestPlotsCount = Object.keys(guestPlots).length;
            const guestEB = localState.eb;
            const guestDiamonds = localState.diamonds;
            const guestCash = localState.cash || 0;
            const guestLifetime = localState.lifetimeRent || 0;
            const guestExtractor = Object.assign({}, localState.extractor || {});
            const guestCapsule = Object.assign({}, localState.capsule || {});
            const oldGuestId = localState.player?.id;

            try {
              let fbUser = null;

              // 2. Try native credential linking (Keeps identical UID with 0 data loss!)
              if (currentUser && currentUser.isAnonymous) {
                try {
                  const linkResult = await currentUser.linkWithCredential(credential);
                  fbUser = linkResult.user;
                  console.log("[Auth] Successfully linked Guest account to Google UID:", fbUser.uid);
                } catch (linkErr) {
                  // If Google account already exists on another device, sign into it directly
                  const signInResult = await firebase.auth().signInWithCredential(credential);
                  fbUser = signInResult.user;
                }
              } else {
                const signInResult = await firebase.auth().signInWithCredential(credential);
                fbUser = signInResult.user;
              }

              if (!fbUser) return;

              // 3. Check Cloud Save status
              const cloudState = await Store.syncFromCloud(fbUser.uid);
              const cloudPlotsCount = Object.keys(cloudState?.plots || {}).length;

              // 4. MIGRATION: If guest had plots/EB and the Google account is new, adopt guest data!
              const s = Store.get();
              s.player.id = fbUser.uid;
              if (!s.player.name || s.player.name === "Traveler") {
                s.player.name = fbUser.displayName || "Traveler";
              }
              if (!s.player.avatar || s.player.avatar === "🙂") {
                s.player.avatar = fbUser.photoURL ? "img:" + fbUser.photoURL : "🙂";
              }

              if (isGuest && guestPlotsCount > 0 && cloudPlotsCount === 0) {
                console.log(`[Auth] Migrating ${guestPlotsCount} plots & ${guestEB} EB into Google Account...`);
                s.plots = guestPlots;
                s.eb = guestEB;
                s.diamonds = guestDiamonds;
                s.cash = Math.max(Number(s.cash) || 0, guestCash);
                s.lifetimeRent = Math.max(Number(s.lifetimeRent) || 0, guestLifetime);
                s.extractor = guestExtractor;
                s.capsule = guestCapsule;

                // Update plot ownership on Firestore to the new Google UID
                const db = Store.getDb();
                if (db) {
                  for (const tid in guestPlots) {
                    db.collection("plots").doc(tid).update({
                      ownerId: fbUser.uid,
                      ownerName: s.player.name,
                      avatar: s.player.avatar
                    }).catch(e => console.warn("[Auth] Plot owner re-assign notice:", e));
                  }
                  // Clean up old guest save in Firestore
                  if (oldGuestId && oldGuestId !== fbUser.uid) {
                    db.collection("saves").doc(oldGuestId).delete().catch(() => {});
                  }
                }
              }

              // 5. Persist immediately to Google Cloud
              Store.save(true);
              completeSignIn(s.player, fbUser.uid);
            } catch (authErr) {
              console.error("[Auth] Google sign-in / migration failed:", authErr);
            }
          },
        });

        google.accounts.id.renderButton(slot, {
          theme: "filled_black",
          shape: "pill",
          size: "large",
          width: 280,
        });
      } catch (err) {
        console.error("[Auth] Google setup error:", err);
      }
    };

    tryInit();
  }

  return { init };
})();
