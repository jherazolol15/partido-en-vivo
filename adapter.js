// Adaptador v2: ofrece a la app la misma interfaz que claude.ai (db, user, assets, mcp, downloads)
// usando Firebase (Auth + Firestore con caché sin conexión) y el puente Apps Script de la hoja.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserPopupRedirectResolver, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { initializeFirestore, memoryLocalCache, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDFiL86Q7K5LICO7UNY1xJTnHLcyQ9aJ-c",
  authDomain: "partido-en-vivo-jaguares.firebaseapp.com",
  projectId: "partido-en-vivo-jaguares",
  storageBucket: "partido-en-vivo-jaguares.firebasestorage.app",
  messagingSenderId: "76175390113",
  appId: "1:76175390113:web:1a9d089cbee86f7b7907e0"
};
const app = initializeApp(firebaseConfig);
// Sin el resolvedor de ventanas al iniciar: en la app instalada ese paso puede quedarse esperando.
const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
const fs = initializeFirestore(app, { experimentalAutoDetectLongPolling: true, localCache: memoryLocalCache() });

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
// Escrituras: sin señal o sin confirmación se reportan como "unavailable" para que la app las conserve en su cola y reintente.
const write = p => {
  const guarded = p.catch(e => { throw mapErr(e); });
  guarded.catch(err => console.warn("Escritura", err));
  if (!navigator.onLine) return Promise.reject({ code: "unavailable", message: "Sin señal" });
  return Promise.race([guarded, new Promise((_, r) => setTimeout(() => r({ code: "unavailable", message: "Sin confirmación" }), 15000))]);
};

// Escucha en vivo con respaldo: si el canal en vivo no entrega datos en 6 s, o falla, se consulta cada 20 s.
function report(path, e) {
  const m = "Datos (" + path + "): " + ((e && e.code) || "error");
  (window.__errs = window.__errs || []).push(m); console.warn(m, e);
}
function live(ref, onData, poll, err, path) {
  let got = false, timer = null, stopped = false;
  const tick = () => { if (stopped || got) return; poll().catch(e => report(path, e)).finally(() => { if (!stopped && !got) timer = setTimeout(tick, 20000); }); };
  const unsub = onSnapshot(ref, x => { onData(x); if (x.metadata && x.metadata.fromCache) return; got = true; if (timer) clearTimeout(timer); }, e => {
    report(path, e); got = false;
    if (e && e.code === "permission-denied") { err && err(mapErr(e)); return; }
    if (!stopped) timer = setTimeout(tick, 1000);
  });
  timer = setTimeout(tick, 6000);
  return () => { stopped = true; if (timer) clearTimeout(timer); unsub(); };
}
function docRef(path) {
  const ref = doc(fs, ...segs(path));
  return {
    id: ref.id, path,
    get: () => getDoc(ref).then(wrapDoc).catch(e => { throw mapErr(e); }),
    set: d => write(setDoc(ref, d)),
    update: d => write(updateDoc(ref, d)),
    delete: () => write(deleteDoc(ref)),
    onSnapshot: (next, err) => live(ref, s => next(wrapDoc(s)), () => getDoc(ref).then(s => next(wrapDoc(s))), err, path),
    collection: sub => colRef(path + "/" + sub)
  };
}
function colRef(path) {
  const ref = collection(fs, ...segs(path));
  return {
    path,
    doc: id => docRef(path + "/" + (id || Math.random().toString(36).slice(2) + Date.now().toString(36))),
    get: () => getDocs(ref).then(wrapQuery).catch(e => { throw mapErr(e); }),
    onSnapshot: (next, err) => live(ref, q => next(wrapQuery(q)), () => getDocs(ref).then(q => next(wrapQuery(q))), err, path)
  };
}
const db = { doc: docRef, collection: colRef };

// ---- Fotos guardadas en Firestore (colección blobs) ----
let blobs = {};
try { blobs = JSON.parse(localStorage.getItem("pev:blobs") || "{}"); } catch (e) {}
const saveBlobs = () => { try { localStorage.setItem("pev:blobs", JSON.stringify(blobs)); } catch (e) {} };
window.blobUrl = id => blobs[id] || "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
function watchBlobs() {
  const ref = collection(fs, "blobs");
  const apply = q => { q.docs.forEach(d => { blobs[d.id] = d.data().data; }); saveBlobs(); if (typeof window.render === "function") try { window.render(); } catch (e) {} };
  live(ref, apply, () => getDocs(ref).then(apply), null, "blobs");
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
  window.__booted = true;
  let el = document.getElementById("gate");
  if (!el) { el = document.createElement("div"); el.id = "gate"; document.body.appendChild(el); }
  el.innerHTML = html; el.hidden = !html;
}
const card = inner => `<div style="position:fixed;inset:0;z-index:100;background:var(--bg);display:grid;place-items:center;padding:24px"><div class="sec" style="max-width:420px;width:100%;text-align:center">${inner}</div></div>`;

function alertGate(e) { const el = document.getElementById("gate"); if (el) { const p = el.querySelector(".hint"); if (p) p.textContent = "No se pudo iniciar sesión: " + ((e && e.code) || e) + ". Intenta de nuevo."; } }
let authFired = false;
setTimeout(() => { if (!authFired) { window.__errs = window.__errs || []; window.__errs.push("La sesión de Google no respondió"); } }, 10000);
onAuthStateChanged(auth, async u => {
  authFired = true;
  if (!u) {
    gate(card(`<h2>Partido en vivo</h2><p class="hint">Jaguares de Córdoba · Sub-15 A. Entra con la cuenta de Google que autorizó el DT.</p><button class="btn pri wide" id="btnLogin">Entrar con Google</button>`));
    document.getElementById("btnLogin").onclick = async () => {
      const p = new GoogleAuthProvider();
      try { await signInWithPopup(auth, p, browserPopupRedirectResolver); } catch (e) { if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment" || e.code === "auth/cancelled-popup-request")) signInWithRedirect(auth, p, browserPopupRedirectResolver); else alertGate(e); }
    };
    return;
  }
  me = u;
  const key = "pev:role:" + u.uid;
  let cached = null; try { cached = JSON.parse(localStorage.getItem(key) || "null"); } catch (e) {}
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r({ code: "timeout" }), ms))]);
  let done = false;
  const finish = () => {
    if (done) return; done = true;
    if (owner) onSnapshot(doc(fs, "config", "hoja"), s => { hoja = s.exists() ? s.data() : {}; }, () => {});
    watchBlobs(); gate(""); resolveReady();
    if (window.__setReady) window.__setReady(window.claude);
  };
  const denied = () => card(`<h2>Acceso pendiente</h2><p class="hint">La cuenta <strong>${u.email}</strong> no está autorizada. Pide al DT que la agregue en Ajustes → Asistentes.</p><button class="btn wide" onclick="cerrarSesion()">Usar otra cuenta</button>`);
  // Con un rol ya conocido en este teléfono, la app abre al instante (también sin señal) y se verifica en segundo plano.
  if (cached) { owner = !!cached.owner; finish(); }
  else gate(card(`<h2>Conectando…</h2><p class="hint">Verificando tu acceso con ${u.email}.</p>`));
  try { await withTimeout(getDoc(doc(fs, "config", "plantilla")), 25000); }
  catch (e) {
    if (e && e.code === "permission-denied") { try { localStorage.removeItem(key); } catch (x) {} done = true; gate(denied()); return; }
    if (!cached) gate(card(`<h2>Sin conexión</h2><p class="hint">La primera vez la app necesita señal para verificar tu acceso. Conéctate y vuelve a intentar.</p><p class="hint" style="font-size:.8rem">Detalle: ${String((e && (e.code + " " + (e.message || ""))) || e).replace(/[<>&]/g, "").slice(0, 160)} · ${navigator.onLine ? "en línea" : "sin red"}</p><button class="btn pri wide" onclick="location.reload()">Reintentar</button><button class="btn wide" style="margin-top:8px" onclick="cerrarSesion()">Cerrar sesión</button>`));
    return;
  }
  let isOwner = false, sure = true;
  try { await withTimeout(getDoc(doc(fs, "config", "hoja")), 12000); isOwner = true; }
  catch (e) { if (!(e && e.code === "permission-denied")) { sure = false; isOwner = cached ? !!cached.owner : false; } }
  if (sure) try { localStorage.setItem(key, JSON.stringify({ owner: isOwner })); } catch (x) {}
  if (!done) { owner = isOwner; finish(); }
  else if (sure && isOwner !== owner) location.reload();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
