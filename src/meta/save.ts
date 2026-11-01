import { normalizeProfile, type Profile } from "./profile";

// 改名前の名前のまま。変えると、それまでのセーブが読めなくなる
const DB_NAME = "sensor-extraction";
const STORE = "save";
const KEY = "profile";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 保存がなければ null。IndexedDB が使えないときも null */
export async function loadProfile(): Promise<Profile | null> {
  try {
    const db = await openDb();
    const raw = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return raw ? normalizeProfile(raw as Partial<Profile>) : null;
  } catch {
    return null;
  }
}

export async function saveProfile(p: Profile): Promise<boolean> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(JSON.parse(JSON.stringify(p)), KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}

export function exportProfile(p: Profile): string {
  return JSON.stringify(p, null, 2);
}

/** 形が合わなければ例外 */
export function importProfile(text: string): Profile {
  const raw = JSON.parse(text) as Partial<Profile>;
  if (typeof raw !== "object" || raw === null || typeof raw.money !== "number") {
    throw new Error("セーブデータの形が違う");
  }
  return normalizeProfile(raw);
}
