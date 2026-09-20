import React, { createContext, useContext, useEffect, useState } from "react";
import { auth, db } from "../firebase";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { logout as kernelLogout } from "../auth";

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  // Start with a local admin if on localhost, otherwise null
  const [user, setUser] = useState(() => {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return {
        uid: "local-admin-dev",
        email: "ceo@aeon.local",
        displayName: "AEON Command (Localhost)",
        role: "ceo"
      };
    }
    return null;
  });

  // Found live, 2026-09-20: this called ONLY signOut(auth) — Firebase's own
  // session, which AeonContext.jsx already treats as optional tracking, not
  // the real gate (AuthGate.jsx decides open/login/locked from the kernel's
  // /api/kernel/security-availability, independent of Firebase's `user`
  // state — see git history: Google/Firebase OAuth was replaced at the boot
  // gate by commit 28a8253). So the header's "Log Out" button never cleared
  // aeon_session_token, the token AuthGate actually checks: the operator
  // clicked Log Out and stayed logged in. It also crashed outright when
  // Firebase isn't configured — signOut(auth) with auth === null, which is
  // every install by default (.env.example ships every VITE_FIREBASE_* key
  // empty, and SetupWizard.jsx offers "Skip Firebase" for exactly this case).
  // The kernel logout is the one that matters; Firebase's is best-effort and
  // optional, matching how AeonContext.jsx already treats it.
  const logout = async () => {
    await kernelLogout();
    if (auth) { try { await signOut(auth); } catch { /* optional tracking, not the real session */ } }
    // AuthGate re-derives its screen from the token this just cleared; a
    // reload is the one deterministic way every consumer of `user` (this
    // context, AeonContext, the layouts) picks that up in one step.
    if (typeof window !== 'undefined') window.location.reload();
  };

  useEffect(() => {
    // If we're on localhost, skip Firebase Auth bindings entirely
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return;
    }
    // No Firebase configured at all (the default) — auth is null off
    // localhost too, e.g. opening AEON from a phone on the LAN, or through a
    // tunnel. onAuthStateChanged(null, …) throws synchronously, which the
    // app's one error boundary (main.jsx) turns into a full-screen crash on
    // every load from a second device. AeonContext.jsx already guards this
    // correctly for Firestore; this is the same guard for Auth.
    if (!auth) return;

    // Failsafe: if Firebase never responds in 5s, treat as logged out
    const timeout = setTimeout(() => {
      if (user === undefined) {
        console.warn("[AEON] Auth timeout — defaulting to logged out.");
        setUser(null);
      }
    }, 5000);

    const unsub = onAuthStateChanged(auth, async (u) => {
      clearTimeout(timeout);
      if (u) {
        try {
          await setDoc(doc(db, "users", u.uid), {
            uid:         u.uid,
            email:       u.email,
            displayName: u.displayName,
            photoURL:    u.photoURL,
            role:        "ceo",
            lastLogin:   serverTimestamp(),
          }, { merge: true });
        } catch (err) {
          console.error("[AEON] Firestore upsert failed:", err.message);
        }
      }
      setUser(u ?? null);
    });

    return () => { unsub(); clearTimeout(timeout); };
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading: user === undefined, logout }}>
      {children}
    </AuthContext.Provider>
  );
}