// Adaptador v2: ofrece a la app la misma interfaz que claude.ai (db, user, assets, mcp, downloads)
// usando Firebase (Auth + Firestore con caché sin conexión) y el puente Apps Script de la hoja.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentSingleTabManager, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDFiL86Q7K5LICO7UNY1xJTnHLcyQ9aJ-c",
  authDomain: "partido-en-vivo-jaguares.firebaseapp.com",
  projectId: "partido-en-vivo-jaguares",
  storageBucket: "partido-en-vivo-jaguares.firebasestorage.app",
  messagingSenderId: "76175390113",
  appId: "1:76175390113:web:1a9d089cbee86f7b7907e0"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({ forceOwnership: true }) }) });

const mapErr = e => {
  const c = e && e.code || "";
  if (c === "permission-denied" || c === "not-found" || c === "invalid-argument" || c === "failed-precondition") return { code: "invalid_argument", message: e.message };
  if (c === "resource-exhausted") return { code: "resource_exhausted", message: e.message };
  return { code: "unavailable", message: (e && e.message) || String(e) };
};
const wrapDoc = s => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: s.metadata });
const wrapQuery = q => ({ docs: q.docs.map(wrapDoc), size: q.size, empty: q.empty, metadata: q.metadata });
const segs = p => p.split("/");
// Escrituras: sin señal se confirman al instante (Firestore las guarda y envía después).
const write = p => {
  const guarded = p.catch(e => { throw mapErr(e); });
  if (!navigator.onLine) { guarded.catch(err => console.warn("Escritura pendiente falló", err)); return Promise.resolve(); }
  return Promise.race([guarded, new Promise(r => setTimeout(r, 8000))]);
};

function docRef(path) {
  const ref = doc(fs, ...segs(path));
  return {
    id: ref.id, path,
    get: () => getDoc(ref).then(wrapDoc).catch(e => { throw mapErr(e); }),
    set: d => write(setDoc(ref, d)),
    update: d => write(updateDoc(ref, d)),
    delete: () => write(deleteDoc(ref)),
    onSnapshot: (next, err) => onSnapshot(ref, s => next(wrapDoc(s)), e => err && err(mapErr(e))),
    collection: sub => colRef(path + "/" + sub)
  };
}
function colRef(path) {
  const ref = collection(fs, ...segs(path));
  return {
    path,
    doc: id => docRef(path + "/" + (id || Math.random().toString(36).slice(2) + Date.now().toString(36))),
    get: () => getDocs(ref).then(wrapQuery).catch(e => { throw mapErr(e); }),
    onSnapshot: (next, err) => onSnapshot(ref, q => next(wrapQuery(q)), e => err && err(mapErr(e)))
  };
}
const db = { doc: docRef, collection: colRef };

// ---- Fotos guardadas en Firestore (colección blobs) ----
const blobs = {};
window.blobUrl = id => blobs[id] || "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
function watchBlobs() {
  onSnapshot(collection(fs, "blobs"), q => {
    q.docs.forEach(d => { blobs[d.id] = d.data().data; });
    if (typeof window.render === "function") try { window.render(); } catch (e) {}
  }, () => {});
}
const assets = {
  upload: (blob, opt) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = async () => {
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const data = fr.result;
      if (data.length > 950000) { rej({ code: "too_large", message: "Imagen demasiado grande" }); return; }
      try { await write(setDoc(doc(fs, "blobs", id), { data, type: (opt && opt.type) || blob.type, ts: Date.now() })); blobs[id] = data; res({ id, url: data, sizeBytes: data.length, contentType: (opt && opt.type) || blob.type }); }
      catch (e) { rej(e); }
    };
    fr.onerror = () => rej({ code: "read_error" });
    fr.readAsDataURL(blob);
  }),
  delete: id => write(deleteDoc(doc(fs, "blobs", id))).then(() => { delete blobs[id]; return { deleted: true }; }),
  list: async () => ({ assets: Object.keys(blobs).map(id => ({ id })), usage: {} })
};

// ---- Puente con la hoja (Apps Script) ----
let hoja = {};
const toBridgeValue = v => {
  if (typeof v === "string") { const m = /^=DATE\((\d+);(\d+);(\d+)\)$/.exec(v); if (m) return { fecha: m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0") }; }
  return v;
};
const mcp = {
  async callTool(server, tool, input) {
    if (!hoja.puenteUrl || !hoja.clave) throw { code: "server_not_connected", message: "Configura la conexión con tu hoja en Ajustes." };
    if (!navigator.onLine) throw { code: "server_unavailable", message: "Sin señal", retryable: true };
    const body = { clave: hoja.clave, sheetId: input.spreadsheetId || "", range: input.range };
    if (tool === "get_values") body.op = "get";
    else if (tool === "update_values") { body.op = "set"; body.values = (input.values || []).map(r => r.map(toBridgeValue)); }
    else throw { code: "bad_request", message: "Operación no soportada" };
    let r;
    try { r = await fetch(hoja.puenteUrl, { method: "POST", body: JSON.stringify(body) }).then(x => x.json()); }
    catch (e) { throw { code: "server_unavailable", message: "La hoja no respondió", retryable: true }; }
    if (!r.ok) throw { code: r.error === "clave_incorrecta" ? "needs_reauth" : "tool_error", message: r.detalle || r.error };
    return { payload: r.values ? { values: r.values } : {}, content: [] };
  }
};
window.probarPuente = async (url, clave) => {
  const r = await fetch(url, { method: "POST", body: JSON.stringify({ clave, op: "ping" }) }).then(x => x.json());
  return r;
};

// ---- Descargas ----
const downloads = {
  save: async ({ filename, data }) => {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const u = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000); return { status: "saved" };
  }
};

// ---- Sesión y roles ----
let resolveReady; const ready = new Promise(r => resolveReady = r);
let me = null, owner = false;
const user = {
  isOwner: async () => owner, canEdit: async () => owner, can: async () => null,
  id: async () => me && me.uid, me: async () => ({ id: me && me.uid, name: (me && me.displayName) || "", email: me && me.email, isOwner: owner, canEdit: owner })
};
window.claude = { use: async name => { await ready; return { db, user, assets, mcp, downloads }[name] || null; } };
window.cerrarSesion = () => signOut(auth).then(() => location.reload());

function gate(html) {
  let el = document.getElementById("gate");
  if (!el) { el = document.createElement("div"); el.id = "gate"; document.body.appendChild(el); }
  el.innerHTML = html; el.hidden = !html;
}
const card = inner => `<div style="position:fixed;inset:0;z-index:100;background:var(--bg);display:grid;place-items:center;padding:24px"><div class="sec" style="max-width:420px;width:100%;text-align:center">${inner}</div></div>`;

onAuthStateChanged(auth, async u => {
  if (!u) {
    gate(card(`<h2>Partido en vivo</h2><p class="hint">Jaguares de Córdoba · Sub-15 A. Entra con la cuenta de Google que autorizó el DT.</p><button class="btn pri wide" id="btnLogin">Entrar con Google</button>`));
    document.getElementById("btnLogin").onclick = async () => {
      const p = new GoogleAuthProvider();
      try { await signInWithPopup(auth, p); } catch (e) { if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) signInWithRedirect(auth, p); }
    };
    return;
  }
  me = u;
  try { await getDoc(doc(fs, "config", "plantilla")); }
  catch (e) {
    if (e && e.code === "permission-denied") {
      gate(card(`<h2>Acceso pendiente</h2><p class="hint">La cuenta <strong>${u.email}</strong> no está autorizada. Pide al DT que la agregue en Ajustes → Asistentes.</p><button class="btn wide" onclick="cerrarSesion()">Usar otra cuenta</button>`));
      return;
    }
  }
  try { await getDoc(doc(fs, "config", "hoja")); owner = true; } catch (e) { owner = false; }
  if (owner) onSnapshot(doc(fs, "config", "hoja"), s => { hoja = s.exists() ? s.data() : {}; }, () => {});
  watchBlobs();
  gate("");
  resolveReady();
  if (window.__setReady) window.__setReady(window.claude);
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
