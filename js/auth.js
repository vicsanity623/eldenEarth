// ============================================================
// Elden Earth — Authentication Bridge (Google Only)
// Guest mode removed — all players sign in with Google.
// ============================================================
const Auth = (() => {

  function init(onSignedIn) {
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
