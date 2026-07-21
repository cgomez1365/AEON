import React, { createContext, useContext, useEffect, useState } from "react";
import { auth, db } from "../firebase";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";

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

  const logout = () => signOut(auth);

  useEffect(() => {
    // If we're on localhost, skip Firebase Auth bindings entirely
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return;
    }

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