// ============================================================
// Elden Earth — Authentication Bridge (Google Only)
// Guest mode removed — all players sign in with Google.
// ============================================================
const Auth = (() => {

  async function checkBan(uid, email) {
    try {
      const firestore = Store.getDb();
      if (!firestore) return false;
      const banDoc = await firestore.collection("banned_users").doc(uid).get();
      if (banDoc.exists) {
        const ban = banDoc.data();
        console.warn(`[Auth] BANNED user attempted login: ${uid} (${email}) — reason: ${ban.reason || "none"}`);
        return true;
      }
    } catch (e) {}
    return false;
  }

  async function logPlayerIP(uid, email) {
    try {
      const res = await fetch("https://api.ipify.org?format=json");
      const data = await res.json();
      const ip = data.ip;
      const firestore = Store.getDb();
      if (firestore && uid) {
        await firestore.collection("player_ips").doc(uid).set({
          uid: uid,
          email: email || "",
          ip: ip,
          timestamp: Date.now(),
          userAgent: navigator.userAgent
        }, { merge: true });
      }
    } catch (e) {}
  }

  function showBannedScreen(reason) {
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0e17;color:#e8e8e8;font-family:system-ui;text-align:center;padding:20px;">
        <div>
          <h1 style="color:#ff4444;font-size:28px;margin-bottom:12px;">Account Suspended</h1>
          <p style="color:#999;font-size:16px;margin-bottom:8px;">This account has been permanently banned from Elden Earth.</p>
          <p style="color:#666;font-size:13px;">${reason ? "Reason: " + reason : "If you believe this is an error, contact us on Discord."}</p>
          <a href="https://discord.gg/WJjyMJahZA" style="display:inline-block;margin-top:20px;padding:10px 24px;background:#5865F2;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Join Discord</a>
        </div>
      </div>`;
  }

  function init(onSignedIn) {
    const slot = document.getElementById("g_id_signin_slot");
    let completedUid = null;

    async function completeSignIn(player, uid) {
      if (completedUid === uid) return;
      completedUid = uid;

      const email = firebase.auth().currentUser?.email || "";
      const banned = await checkBan(uid, email);
      if (banned) {
        const firestore = Store.getDb();
        let reason = "";
        if (firestore) {
          try {
            const snap = await firestore.collection("banned_users").doc(uid).get();
            reason = snap.data()?.reason || "";
          } catch (e) {}
        }
        showBannedScreen(reason);
        firebase.auth().signOut();
        return;
      }

      logPlayerIP(uid, email);
      onSignedIn(player);
    }

    // Ensure Firebase App is initialized via Store
    if (typeof Store !== "undefined" && Store.getDb) {
      Store.getDb();
    }

    // Firebase Auth Listener — auto-restore session on page reload
    if (typeof firebase !== "undefined" && firebase.auth) {
      try {
        firebase.auth().onAuthStateChanged(async (user) => {
          if (user) {
            console.log(`[FirebaseAuth] Active session: ${user.uid} (Google)`);

            const s = Store.get();
            if (s && s.player) {
              s.player.id = user.uid;

              if (user.displayName && (!s.player.name || s.player.name === "Traveler")) {
                s.player.name = user.displayName;
              }
              if (user.photoURL && (!s.player.avatar || s.player.avatar === "🙂")) {
                s.player.avatar = "img:" + user.photoURL;
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

    // --- GOOGLE SIGN-IN ONLY ---
    if (!CONFIG.GOOGLE_CLIENT_ID) return;

    let attempts = 0;
    const tryInit = () => {
      attempts++;
      if (!window.google || !google.accounts || !google.accounts.id) {
        if (attempts < 50) {
          setTimeout(tryInit, 150);
        } else if (slot) {
          slot.innerHTML = `<p class="fine-print" style="color:var(--text-dim);font-size:11.5px;margin-bottom:12px;">🔒 Google Sign-In unavailable in Private Mode.<br>Please open in a normal tab.</p>`;
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

            try {
              let fbUser = null;

              if (currentUser && currentUser.isAnonymous) {
                try {
                  const linkResult = await currentUser.linkWithCredential(credential);
                  fbUser = linkResult.user;
                  console.log("[Auth] Linked anonymous account to Google:", fbUser.uid);
                } catch (linkErr) {
                  const signInResult = await firebase.auth().signInWithCredential(credential);
                  fbUser = signInResult.user;
                }
              } else {
                const signInResult = await firebase.auth().signInWithCredential(credential);
                fbUser = signInResult.user;
              }

              if (!fbUser) return;
              console.log("[Auth] Google signed in:", fbUser.uid);
            } catch (err) {
              console.error("[Auth] Google sign-in error:", err);
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
