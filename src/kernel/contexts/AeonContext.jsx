import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { collection, onSnapshot, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from './AuthContext';
import { supabase } from '../supabase';

const AeonContext = createContext();

export function useAeonContext() {
  return useContext(AeonContext);
}

const DEFAULT_DATA = {
  scheduler: { events: [], workouts: [], deadlines: [] },
  clients: [],
  inventory: [],
  links: [],
  dictionary: [],
  trash: []
};

// ── Firestore helpers ────────────────────────────────────────────────
const STATE_COLLECTION = 'aeon_state';

/** Write a state document to Firestore with error handling. */
const syncToFirestore = async (key, data) => {
  try {
    await setDoc(doc(db, STATE_COLLECTION, key), data, { merge: true });
  } catch (e) {
    console.error(`[AEON] Firestore sync error (${key}):`, e);
  }
};

/** Mirror block data to Supabase aeon_blocks table (non-blocking). */
const mirrorToSupabase = (blockTag, payload) => {
  if (!supabase) return;
  supabase
    .from('aeon_blocks')
    .upsert({ block_tag: blockTag, payload, updated_at: new Date().toISOString() }, { onConflict: 'block_tag' })
    .then(({ error }) => {
      if (error) console.error(`[AEON] Supabase mirror error (${blockTag}):`, error.message);
    });
};

// ── Provider ─────────────────────────────────────────────────────────
export function AeonProvider({ children }) {
  const [scheduler, setScheduler] = useState(DEFAULT_DATA.scheduler);
  const [clients, setClients]     = useState(DEFAULT_DATA.clients);
  const [inventory, setInventory] = useState(DEFAULT_DATA.inventory);
  const [links, setLinks] = useState(() => {
    const local = localStorage.getItem('aeon_links');
    return local ? JSON.parse(local) : DEFAULT_DATA.links;
  });
  const [dictionary, setDictionary] = useState(DEFAULT_DATA.dictionary);
  const [trash, setTrash]         = useState(DEFAULT_DATA.trash);

  const { user } = useAuth();

  // ── Real-time Firestore listeners ──────────────────────────────────
  useEffect(() => {
    if (!user || !db) {
      setClients(DEFAULT_DATA.clients);
      setScheduler(DEFAULT_DATA.scheduler);
      setInventory(DEFAULT_DATA.inventory);
      setLinks(DEFAULT_DATA.links);
      setDictionary(DEFAULT_DATA.dictionary);
      setTrash(DEFAULT_DATA.trash);
      return;
    }

    // Clients — reads from the "clients" collection (existing pattern)
    const unsubClients = onSnapshot(collection(db, "clients"), (snapshot) => {
      const fbClients = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setClients(fbClients);
    });

    // Scheduler — single document
    const unsubScheduler = onSnapshot(doc(db, STATE_COLLECTION, 'scheduler'), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setScheduler({
          events:    data.events    || [],
          workouts:  data.workouts  || [],
          deadlines: data.deadlines || [],
        });
      }
    });

    // Inventory — single document wrapping an items array
    const unsubInventory = onSnapshot(doc(db, STATE_COLLECTION, 'inventory'), (snap) => {
      if (snap.exists()) {
        setInventory(snap.data().items || []);
      }
    });

    // Links — single document wrapping an items array
    const unsubLinks = onSnapshot(doc(db, STATE_COLLECTION, 'links'), (snap) => {
      if (snap.exists()) {
        const items = snap.data().items || [];
        setLinks(items);
        localStorage.setItem('aeon_links', JSON.stringify(items));
      }
    });

    // Dictionary — single document wrapping an items array
    const unsubDictionary = onSnapshot(doc(db, STATE_COLLECTION, 'dictionary'), (snap) => {
      if (snap.exists()) {
        setDictionary(snap.data().items || []);
      }
    });

    // Trash — single document wrapping an items array
    const unsubTrash = onSnapshot(doc(db, STATE_COLLECTION, 'trash'), (snap) => {
      if (snap.exists()) {
        setTrash(snap.data().items || []);
      }
    });

    return () => {
      unsubClients();
      unsubScheduler();
      unsubInventory();
      unsubLinks();
      unsubDictionary();
      unsubTrash();
    };
  }, [user]);

  // ── Supabase auto-mirror on Firebase state changes ─────────────────
  useEffect(() => {
    if (clients.length > 0) mirrorToSupabase('clients', clients);
  }, [clients]);

  useEffect(() => {
    if (inventory.length > 0) mirrorToSupabase('inventory', inventory);
  }, [inventory]);

  // ── TRASH / RECOVERY ───────────────────────────────────────────────
  const moveToTrash = useCallback((item, storeName) => {
    const deletedItem = {
      ...item,
      _deletedAt: new Date().toISOString(),
      _originalStore: storeName
    };
    setTrash(prev => {
      const updated = [...prev, deletedItem];
      syncToFirestore('trash', { items: updated });
      return updated;
    });
  }, []);

  const restoreFromTrash = useCallback((itemIdOrName) => {
    const itemIndex = trash.findIndex(
      t => t.id === itemIdOrName || (t.name && t.name.toLowerCase() === itemIdOrName.toLowerCase())
    );
    if (itemIndex === -1) return { success: false, error: 'Item not found in trash.' };

    const item  = trash[itemIndex];
    const store = item._originalStore;

    // Strip internal trash metadata
    const restoredItem = { ...item };
    delete restoredItem._deletedAt;
    delete restoredItem._originalStore;

    // Route back to original store
    if (store === 'clients') {
      const updated = [...clients, restoredItem];
      setClients(updated);
      // Re-add to Firestore clients collection
      if (restoredItem.id && db) {
        setDoc(doc(db, "clients", restoredItem.id.toString()), restoredItem).catch(e =>
          console.error('[AEON] Firestore restore error (clients):', e)
        );
      }
    } else if (store === 'inventory') {
      const updated = [...inventory, restoredItem];
      setInventory(updated);
      syncToFirestore('inventory', { items: updated });
    } else if (store === 'links') {
      const updated = [...links, restoredItem];
      setLinks(updated);
      syncToFirestore('links', { items: updated });
    } else if (store === 'dictionary') {
      const updated = [...dictionary, restoredItem];
      setDictionary(updated);
      syncToFirestore('dictionary', { items: updated });
    } else if (store === 'workouts' || store === 'events' || store === 'deadlines') {
      const updatedScheduler = {
        ...scheduler,
        [store]: [...(scheduler[store] || []), restoredItem]
      };
      setScheduler(updatedScheduler);
      syncToFirestore('scheduler', updatedScheduler);
    }

    // Remove from trash
    const updatedTrash = trash.filter((_, i) => i !== itemIndex);
    setTrash(updatedTrash);
    syncToFirestore('trash', { items: updatedTrash });
    return { success: true, item: restoredItem };
  }, [trash, clients, inventory, links, dictionary, scheduler]);

  // ── SCHEDULER ──────────────────────────────────────────────────────
  const manageSchedule = useCallback((args) => {
    const store = args.type + 's'; // event -> events, workout -> workouts, deadline -> deadlines
    if (!scheduler[store]) return;

    if (args.action === 'add') {
      const newItem = { id: Date.now(), done: false, ...args };
      delete newItem.action; delete newItem.type;
      if (!newItem.date && !newItem.dueDate) newItem.date = new Date().toISOString().split('T')[0];
      const updated = { ...scheduler, [store]: [...scheduler[store], newItem] };
      setScheduler(updated);
      syncToFirestore('scheduler', updated);
      mirrorToSupabase('scheduler', updated);
    } else if (args.action === 'delete') {
      const target = args.targetTitle?.toLowerCase();
      const itemToDelete = scheduler[store].find(i =>
        (i.title?.toLowerCase().includes(target) || i.name?.toLowerCase().includes(target) || i.type?.toLowerCase().includes(target))
      );
      if (itemToDelete) {
        moveToTrash(itemToDelete, store);
        const updated = { ...scheduler, [store]: scheduler[store].filter(i => i.id !== itemToDelete.id) };
        setScheduler(updated);
        syncToFirestore('scheduler', updated);
        mirrorToSupabase('scheduler', updated);
      }
    } else if (args.action === 'complete') {
      const target = args.targetTitle?.toLowerCase();
      const updated = {
        ...scheduler,
        [store]: scheduler[store].map(i =>
          (i.title?.toLowerCase().includes(target) || i.name?.toLowerCase().includes(target) || i.type?.toLowerCase().includes(target))
            ? { ...i, done: true } : i
        )
      };
      setScheduler(updated);
      syncToFirestore('scheduler', updated);
      mirrorToSupabase('scheduler', updated);
    } else if (args.action === 'update') {
      const target = args.targetTitle?.toLowerCase();
      const updated = {
        ...scheduler,
        [store]: scheduler[store].map(i =>
          (i.title?.toLowerCase().includes(target) || i.name?.toLowerCase().includes(target) || i.type?.toLowerCase().includes(target))
            ? { ...i, ...args.updates } : i
        )
      };
      setScheduler(updated);
      syncToFirestore('scheduler', updated);
      mirrorToSupabase('scheduler', updated);
    }
  }, [scheduler, moveToTrash]);

  const updateSchedulerData = useCallback((data) => {
    setScheduler(data);
    syncToFirestore('scheduler', data);
    mirrorToSupabase('scheduler', data);
  }, []);

  // ── CLIENTS (Firebase-synced via "clients" collection) ─────────────
  const addClient = async (client) => {
    if (!db) { console.warn('[AEON] Firebase not configured — cannot add client.'); return; }
    const newId = client.id || Date.now().toString();
    const newClient = { ...client, invoices: client.invoices || [] };
    await setDoc(doc(db, "clients", newId), newClient);
    mirrorToSupabase('clients', [...clients, { id: newId, ...newClient }]);
  };

  const updateClients = async (data) => {
    if (!db) { console.warn('[AEON] Firebase not configured — cannot update clients.'); return; }
    for (const c of data) {
      if (c.id) {
        await setDoc(doc(db, "clients", c.id.toString()), c, { merge: true });
      }
    }
    mirrorToSupabase('clients', data);
  };

  const manageInvoice = async (args) => {
    if (!db) { console.warn('[AEON] Firebase not configured — cannot manage invoice.'); return; }
    const clientIndex = clients.findIndex(c => c.name.toLowerCase().includes(args.clientName.toLowerCase()));
    if (clientIndex === -1) return;
    const client = clients[clientIndex];

    if (args.action === 'add') {
      const newInvoice = { id: Date.now(), status: 'pending', date: new Date().toISOString().split('T')[0], ...args };
      delete newInvoice.action; delete newInvoice.clientName;
      const updatedClient = { ...client, invoices: [...(client.invoices || []), newInvoice] };
      await setDoc(doc(db, "clients", client.id.toString()), updatedClient, { merge: true });
    } else if (args.action === 'delete') {
      const invoiceToDel = (client.invoices || []).find(i => i.id === args.invoiceId || i.description?.toLowerCase().includes(args.description?.toLowerCase() || 'undefined_str'));
      if (invoiceToDel) moveToTrash({ ...invoiceToDel, clientName: client.name }, 'invoices');
      const updatedClient = { ...client, invoices: (client.invoices || []).filter(i => i.id !== invoiceToDel?.id) };
      await setDoc(doc(db, "clients", client.id.toString()), updatedClient, { merge: true });
    } else if (args.action === 'pay') {
      const invDesc = args.description?.toLowerCase() || '';
      const updatedClient = { ...client, invoices: (client.invoices || []).map(i => (i.id === args.invoiceId || i.description?.toLowerCase().includes(invDesc)) ? { ...i, status: 'paid' } : i) };
      await setDoc(doc(db, "clients", client.id.toString()), updatedClient, { merge: true });
    } else if (args.action === 'update') {
      const invDesc = args.description?.toLowerCase() || '';
      const updatedClient = { ...client, invoices: (client.invoices || []).map(i => (i.id === args.invoiceId || i.description?.toLowerCase().includes(invDesc)) ? { ...i, ...args } : i) };
      await setDoc(doc(db, "clients", client.id.toString()), updatedClient, { merge: true });
    }
  };

  const manageCrm = async (args) => {
    if (!db) { console.warn('[AEON] Firebase not configured — cannot manage CRM.'); return; }
    if (args.action === 'add') {
      const newClient = { id: Date.now().toString(), invoices: [], name: args.clientName, stage: 'Lead Identified', emrr: 0, ...args };
      delete newClient.action;
      delete newClient.clientName;
      await setDoc(doc(db, "clients", newClient.id.toString()), newClient);
      mirrorToSupabase('clients', [...clients, newClient]);
    } else if (args.action === 'delete') {
      const clientToDelete = clients.find(c => c.name.toLowerCase().includes(args.clientName.toLowerCase()));
      if (clientToDelete) {
        moveToTrash(clientToDelete, 'clients');
        await deleteDoc(doc(db, "clients", clientToDelete.id.toString()));
        mirrorToSupabase('clients', clients.filter(c => c.id !== clientToDelete.id));
      }
    } else {
      const clientToUpdate = clients.find(c => c.name.toLowerCase().includes(args.clientName.toLowerCase()));
      if (clientToUpdate) {
          const updates = { ...args };
          delete updates.action;
          delete updates.clientName;
          const merged = { ...clientToUpdate, ...updates };
          await setDoc(doc(db, "clients", clientToUpdate.id.toString()), merged, { merge: true });
          mirrorToSupabase('clients', clients.map(c => c.id === clientToUpdate.id ? merged : c));
      }
    }
  };

  // ── INVENTORY ──────────────────────────────────────────────────────
  const manageInventoryObj = useCallback((args) => {
    if (args.action === 'add') {
      const updated = [...inventory, { id: Date.now().toString(), ...args }];
      setInventory(updated);
      syncToFirestore('inventory', { items: updated });
      mirrorToSupabase('inventory', updated);
    } else if (args.action === 'delete') {
      const itemToDel = inventory.find(i => i.name?.toLowerCase().includes(args.name?.toLowerCase()));
      if (itemToDel) {
        moveToTrash(itemToDel, 'inventory');
        const updated = inventory.filter(i => i.id !== itemToDel.id);
        setInventory(updated);
        syncToFirestore('inventory', { items: updated });
        mirrorToSupabase('inventory', updated);
      }
    } else if (args.action === 'update' || args.action === 'decrement') {
      const updated = inventory.map(i => i.name?.toLowerCase().includes(args.name?.toLowerCase()) ? { ...i, ...args } : i);
      setInventory(updated);
      syncToFirestore('inventory', { items: updated });
      mirrorToSupabase('inventory', updated);
    }
  }, [inventory, moveToTrash]);

  const updateInventoryList = useCallback((data) => {
    setInventory(data);
    syncToFirestore('inventory', { items: data });
    mirrorToSupabase('inventory', data);
  }, []);

  // ── LINKS ──────────────────────────────────────────────────────────
  const manageLinks = useCallback((args) => {
    if (args.action === 'add') {
      const updated = [...links, { id: Date.now().toString(), ...args }];
      setLinks(updated);
      localStorage.setItem('aeon_links', JSON.stringify(updated));
      syncToFirestore('links', { items: updated });
    } else if (args.action === 'delete') {
      const itemToDel = links.find(l => l.name.toLowerCase().includes(args.name.toLowerCase()));
      if (itemToDel) {
        moveToTrash(itemToDel, 'links');
        const updated = links.filter(l => l.id !== itemToDel.id);
        setLinks(updated);
        localStorage.setItem('aeon_links', JSON.stringify(updated));
        syncToFirestore('links', { items: updated });
      }
    }
  }, [links, moveToTrash]);

  const updateLinks = useCallback((data) => {
    setLinks(data);
    localStorage.setItem('aeon_links', JSON.stringify(data));
    syncToFirestore('links', { items: data });
  }, []);

  // ── DICTIONARY ─────────────────────────────────────────────────────
  const manageDict = useCallback((args) => {
    if (args.action === 'add') {
      const updated = [...dictionary, { id: Date.now().toString(), ...args }];
      setDictionary(updated);
      syncToFirestore('dictionary', { items: updated });
    } else if (args.action === 'delete') {
      const itemToDel = dictionary.find(d => d.keyword.toLowerCase().includes(args.keyword.toLowerCase()));
      if (itemToDel) {
        moveToTrash(itemToDel, 'dictionary');
        const updated = dictionary.filter(d => d.id !== itemToDel.id);
        setDictionary(updated);
        syncToFirestore('dictionary', { items: updated });
      }
    }
  }, [dictionary, moveToTrash]);

  const updateDictionary = useCallback((data) => {
    setDictionary(data);
    syncToFirestore('dictionary', { items: data });
  }, []);

  // ── RENDER ─────────────────────────────────────────────────────────
  return (
    <AeonContext.Provider value={{
      scheduler, manageSchedule, updateSchedulerData,
      clients, addClient, updateClients, manageInvoice, manageCrm,
      inventory, manageInventoryObj, updateInventoryList,
      links, manageLinks, updateLinks,
      dictionary, manageDict, updateDictionary,
      trash, moveToTrash, restoreFromTrash
    }}>
      {children}
    </AeonContext.Provider>
  );
}
