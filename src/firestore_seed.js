/**
 * AEON FIRESTORE SEED SCRIPT
 * Architected by: Groq (Chief Architect) | Audited by: Atlas (Chief Auditor)
 * Date: 2026-05-20 23:16
 * 
 * USAGE:
 *   1. Set GOOGLE_APPLICATION_CREDENTIALS to your service account key path.
 *   2. node src/firestore_seed.js
 *
 * SCHEMA:
 *   /agents/{id}         — 12 AEON Fleet agent documents
 *   /users/{uid}         — CEO and authorized user records
 *   /projects/{id}       — Active micro-SaaS project registry
 *   /agent_telemetry/{id}— Real-time event log for Lyra's HUD
 *   /audit_log/{id}      — Immutable security + action audit trail
 */

import { initializeApp } from "firebase/app";
import {
  getFirestore,
  setDoc,
  addDoc,
  collection,
  doc,
  serverTimestamp,
} from "firebase/firestore";

const app = initializeApp({
  projectId: "second-brain-12f40",
  apiKey:    process.env.VITE_FIREBASE_API_KEY,
  authDomain: "second-brain-12f40.firebaseapp.com",
});

const db = getFirestore(app);

// ── AGENT ROSTER ────────────────────────────────────────────────
const AGENTS = [
  { id: "qwen",    name: "QWEN CODER",   role: "Head of Engineering",     color: "#00f2ff", type: "local",  layer: 3, status: "idle",   ram: "4.5GB",  model: "qwen2.5-coder:7b" },
  { id: "zenith",  name: "ZENITH",        role: "VP Strategy",             color: "#b565d6", type: "local",  layer: 2, status: "idle",   ram: "5.2GB",  model: "llama3:8b"        },
  { id: "groq",    name: "GROQ",          role: "Chief Architect",         color: "#ffffff", type: "cloud",  layer: 1, status: "warm",   ram: "0GB",    model: "llama-3.3-70b"   },
  { id: "gemini",  name: "GEMINI CORE",   role: "Integrator",              color: "#4285F4", type: "cloud",  layer: 3, status: "warm",   ram: "0GB",    model: "gemini-3.1-pro"  },
  { id: "tiny",    name: "TINYLLAMA",     role: "The Clerk",               color: "#FFD700", type: "local",  layer: 3, status: "idle",   ram: "1.2GB",  model: "tinyllama:1.1b"  },
  { id: "minni",   name: "MINNI",         role: "Local QA",                color: "#3ECF8E", type: "local",  layer: 3, status: "idle",   ram: "2.4GB",  model: "phi3:3.8b"       },
  { id: "leo",     name: "LEO",           role: "Code Architect",          color: "#00f2ff", type: "cloud",  layer: 3, status: "warm",   ram: "0GB",    model: "gemini-3.1-lite" },
  { id: "atlas",   name: "ATLAS",         role: "Chief Auditor",           color: "#FF7F50", type: "cloud",  layer: 1, status: "warm",   ram: "0GB",    model: "gemini-3.1-pro"  },
  { id: "lyra",    name: "LYRA",          role: "VP Telemetry",            color: "#3ECF8E", type: "cloud",  layer: 2, status: "warm",   ram: "0GB",    model: "gemini-3.1-lite" },
  { id: "nova",    name: "NOVA",          role: "UI Designer",             color: "#E066FF", type: "cloud",  layer: 3, status: "warm",   ram: "0GB",    model: "gemini-3.1-pro"  },
  { id: "silas",   name: "SILAS",         role: "Director of Memory",      color: "#FFD700", type: "cloud",  layer: 1, status: "warm",   ram: "0GB",    model: "gemini-3.1-pro"  },
  { id: "orion",   name: "ORION",         role: "VP DevOps",               color: "#4285F4", type: "cloud",  layer: 2, status: "warm",   ram: "0GB",    model: "gemini-3.1-pro"  },
];

// ── PROJECT REGISTRY ─────────────────────────────────────────────
const PROJECTS = [
  { id: "aeon",   name: "AEON OS",                status: "active",   phase: "v5.0",  priority: 1 },
  { id: "pwc",    name: "Palliative Wellness Care", status: "active",   phase: "95%",   priority: 2 },
  { id: "htm",    name: "Hope The Mission",         status: "active",   phase: "build", priority: 3 },
  { id: "home",   name: "Home Portal",              status: "backlog",  phase: "idea",  priority: 4 },
];

// ── SEED FUNCTION ────────────────────────────────────────────────
async function seed() {
  const ts = serverTimestamp();

  console.log("\n🔥 AEON Firestore Seed — Starting...\n");

  // Seed agents
  console.log("[1/4] Seeding /agents collection...");
  for (const agent of AGENTS) {
    await setDoc(doc(db, "agents", agent.id), {
      ...agent,
      createdAt:   ts,
      lastActive:  ts,
      tasksRun:    0,
      tokensUsed:  0,
    });
    console.log(`  ✓ ${agent.name} (${agent.type.toUpperCase()})`);
  }

  // Seed projects
  console.log("\n[2/4] Seeding /projects collection...");
  for (const project of PROJECTS) {
    await setDoc(doc(db, "projects", project.id), {
      ...project,
      createdAt: ts,
      updatedAt: ts,
    });
    console.log(`  ✓ ${project.name}`);
  }

  // Seed initial telemetry event
  console.log("\n[3/4] Seeding /agent_telemetry collection...");
  await addDoc(collection(db, "agent_telemetry"), {
    agent:     "ATLAS",
    agentId:   "atlas",
    message:   "Firestore seed complete. AEON v5.0 is fully initialized and operational.",
    status:    "active",
    timestamp: ts,
    sessionId: `seed-${Date.now()}`,
  });
  console.log("  ✓ Initial telemetry event written.");

  // Seed initial audit log
  console.log("\n[4/4] Seeding /audit_log collection...");
  await addDoc(collection(db, "audit_log"), {
    action:     "SYSTEM_INIT",
    actor:      "antigravity",
    target:     "firestore",
    detail:     "AEON v5.0 Firestore database seeded with 12-agent roster and project registry.",
    severity:   "info",
    timestamp:  ts,
  });
  console.log("  ✓ Audit log initialized.");

  console.log("\n✅ Firestore seed complete. All collections populated.\n");
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
