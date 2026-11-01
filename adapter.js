// Adaptador v2.1: ofrece a la app la misma interfaz que claude.ai (db, user, assets, mcp, downloads)
// usando el puente Apps Script como base de datos. Todo se guarda primero en el teléfono.
const LSK = "pev3:";
const ls = {
  get(k, d) { try { const v = localStorage.getItem(LSK + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(LSK + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(LSK + k); } catch (e) {} }
};
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ---------- Configuración de acceso ----------
let cfg = ls.get("cfg", null); // {url, clave, rol, uid, nombre}
function leerInvitacion() {
  const h = location.hash || "";
  const m = /#(inv|ver)=([^&]+)/.exec(h);
  if (!m) return null;
  try { const o = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[2]))))); history.replaceState(null, "", location.pathname); o.ver = m[1] === "ver"; return o; } catch (e) { return null; }
}

// ---------- Llamadas al puente ----------
async function puente(body, timeoutMs) {
  if (!cfg) throw { code: "not_granted", message: "Sin acceso configurado" };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 30000);
  let r;
  try { r = await fetch(cfg.url, { method: "POST", body: JSON.stringify(Object.assign({ clave: cfg.clave }, body)), signal: ctl.signal, redirect: "follow" }).then(x => x.json()); }
  catch (e) { throw { code: "server_unavailable", message: "El puente no respondió", retryable: true }; }
  finally { clearTimeout(t); }
  if (!r.ok) throw { code: r.error === "clave_incorrecta" ? "needs_reauth" : (r.error || "tool_error"), message: r.detalle || r.error };
  return r;
}

// ---------- Copia local (espejo) y cola de envío ----------
let mirror = ls.get("mirror", {});      // ruta -> {data, actualizado}
let since = ls.get("since", 0);
let outbox = ls.get("outbox", []);     // [{id, tipo, ruta, data, uid}]
const saveMirror = () => { if (!ls.set("mirror", mirror)) console.warn("Espejo demasiado grande"); ls.set("since", since); };
const saveOutbox = () => ls.set("outbox", outbox);
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const merge = (a, b) => { const r = Object.assign({}, a); for (const k in b) r[k] = isObj(b[k]) && isObj(r[k]) ? merge(r[k], b[k]) : b[k]; return r; };
const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));

function applyOp(base, op) {
  if (op.tipo === "set") return clone(op.data);
  if (op.tipo === "update") return base == null ? base : merge(base, clone(op.data));
  return null;
}
// Estado visible = servidor + operaciones pendientes encima
function view(ruta) {
  let d = mirror[ruta] ? clone(mirror[ruta].data) : null;
  for (const op of outbox) if (op.ruta === ruta) d = applyOp(d, op);
  return d;
}
function allPaths() {
  const s = new Set(Object.keys(mirror));
  outbox.forEach(o => s.add(o.ruta));
  return [...s];
}

// ---------- Suscripciones ----------
const subs = new Set(); // {kind:'doc'|'col', path, cb}
function parentOf(p) { return p.split("/").slice(0, -1).join("/"); }
function notify(paths) {
  const set = new Set(paths);
  for (const s of subs) {
    if (s.kind === "doc" ? set.has(s.path) : [...set].some(p => parentOf(p) === s.path)) fire(s);
  }
  if (window.__outboxChanged) try { window.__outboxChanged(); } catch (e) {}
}
function docSnap(path) { const d = view(path); return { id: path.split("/").pop(), exists: d != null, data: () => clone(d), metadata: { fromCache: false, hasPendingWrites: outbox.some(o => o.ruta === path) } }; }
function colSnap(path) {
  const docs = allPaths().filter(p => parentOf(p) === path).sort().map(docSnap).filter(s => s.exists);
  return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false } };
}
function fire(s) { try { s.cb(s.kind === "doc" ? docSnap(s.path) : colSnap(s.path)); } catch (e) { console.error(e); } }

// ---------- API db ----------
function enqueue(tipo, ruta, data) {
  if (ruta.split("/").length % 2) return Promise.reject({ code: "invalid_argument", message: "Ruta inválida" });
  if (tipo === "update" && view(ruta) == null) return Promise.reject({ code: "invalid_argument", message: "El documento no existe" });
  outbox.push({ id: rid(), tipo, ruta, data: clone(data), uid: cfg && cfg.uid });
  saveOutbox(); notify([ruta]); kick();
  return Promise.resolve();
}
function docRef(path) {
  return {
    id: path.split("/").pop(), path,
    get: async () => docSnap(path),
    set: d => enqueue("set", path, d),
    update: d => enqueue("update", path, d),
    delete: () => enqueue("delete", path, null),
    onSnapshot: cb => { const s = { kind: "doc", path, cb }; subs.add(s); setTimeout(() => fire(s), 0); return () => subs.delete(s); },
    collection: sub => colRef(path + "/" + sub)
  };
}
function colRef(path) {
  return {
    path,
    doc: id => docRef(path + "/" + (id || rid())),
    get: async () => colSnap(path),
    onSnapshot: cb => { const s = { kind: "col", path, cb }; subs.add(s); setTimeout(() => fire(s), 0); return () => subs.delete(s); }
  };
}
const db = { doc: docRef, collection: colRef };

// ---------- Ciclo de sincronización ----------
let syncing = false, lastOk = 0, lastErr = null;
// Enlace para padres: solo lectura, cada 15 s, con un resumen preparado por el puente.
let ultimaVista = 0;
async function syncVista() {
  if (Date.now() - ultimaVista < (window.__aficMs || 15000)) return;
  ultimaVista = Date.now();
  const r = await puente({ op: "vista" }, 30000);
  const nuevo = {}, t = Date.now();
  const put = (ruta, data) => { if (data != null) nuevo[ruta] = { data, actualizado: t }; };
  put("config/estado", { actual: r.actual || null });
  put("config/marca", r.marca || {});
  if (r.escudos) put("config/escudos", r.escudos);
  if (r.actual) {
    put("partidos/" + r.actual, r.partido || {});
    (r.eventos || []).forEach(e => put("partidos/" + r.actual + "/eventos/" + e.id, e));
    put("config/plantilla", { jugadores: r.jugadores || [] });
    put("config/fotos", { map: r.fotos || {} });
  }
  const tocadas = [];
  new Set(Object.keys(mirror).concat(Object.keys(nuevo))).forEach(k => {
    if (JSON.stringify(mirror[k] && mirror[k].data) !== JSON.stringify(nuevo[k] && nuevo[k].data)) tocadas.push(k);
  });
  mirror = nuevo; saveMirror();
  if (tocadas.length) notify(tocadas);
}
async function sync() {
  if (syncing || !cfg || !navigator.onLine) return;
  if (cfg.rol === "afic") {
    syncing = true;
    try { await syncVista(); lastOk = Date.now(); lastErr = null; pedirFotos(); }
    catch (e) { lastErr = e; if (e && e.code === "needs_reauth") gate(card(`<h2>El enlace ya no es válido</h2><p class="hint">Pide al entrenador el enlace nuevo para ver el partido.</p><button class="btn wide" onclick="cerrarSesion()">Salir</button>`)); }
    finally { syncing = false; }
    return;
  }
  syncing = true;
  try {
    // 1. Enviar pendientes (de a 20)
    while (outbox.length) {
      const lote = outbox.slice(0, 20);
      const r = await puente({ op: "escribir", ops: lote.map(o => ({ id: o.id, tipo: o.tipo, ruta: o.ruta, data: o.data, uid: o.uid })) });
      const res = {}; (r.resultados || []).forEach(x => res[x.id] = x);
      const tocadas = [];
      outbox = outbox.filter(o => {
        const x = res[o.id]; if (!x) return true;
        tocadas.push(o.ruta);
        if (!x.ok) { console.warn("Rechazado por el puente", o, x.error); reportar("No se guardó un cambio: " + x.error); }
        else { mirror[o.ruta] = { data: applyOp(mirror[o.ruta] ? mirror[o.ruta].data : null, o), actualizado: x.actualizado }; if (mirror[o.ruta].data == null) delete mirror[o.ruta]; }
        return false;
      });
      saveOutbox(); saveMirror(); notify(tocadas);
    }
    // 2. Recibir cambios
    const r = await puente({ op: "cambios", desde: since });
    const tocadas = [];
    (r.docs || []).forEach(d => {
      if (d.borrado) delete mirror[d.ruta]; else mirror[d.ruta] = { data: d.data, actualizado: d.actualizado };
      since = Math.max(since, d.actualizado); tocadas.push(d.ruta);
    });
    if (tocadas.length) { saveMirror(); notify(tocadas); }
    lastOk = Date.now(); lastErr = null;
    pedirFotos();
  } catch (e) {
    lastErr = e;
    if (e && e.code === "needs_reauth") { cfg = null; ls.del("cfg"); location.reload(); }
  } finally { syncing = false; if (window.__outboxChanged) try { window.__outboxChanged(); } catch (e) {} }
}
let kickT = null;
function kick() { clearTimeout(kickT); kickT = setTimeout(sync, 300); }
setInterval(() => { if (document.visibilityState === "visible") sync(); }, 4000);
addEventListener("online", kick);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kick(); });
window.__outboxCount = () => outbox.length;
window.__estadoSync = () => ({ pendientes: outbox.length, ultimo: lastOk, error: lastErr && lastErr.code });
function reportar(m) { (window.__errs = window.__errs || []).push(m); if (typeof window.toast === "function") try { window.toast(m); } catch (e) {} }

// ---------- Fotos: IndexedDB en el teléfono + carpeta privada en Drive ----------
const fotos = {};
let idb = null;
function abrirIDB() {
  return new Promise(res => {
    try {
      const rq = indexedDB.open("pev3-fotos", 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore("f");
      rq.onsuccess = () => { idb = rq.result; res(); };
      rq.onerror = () => res();
    } catch (e) { res(); }
  });
}
function idbAll() {
  return new Promise(res => {
    if (!idb) return res();
    try {
      const tx = idb.transaction("f", "readonly"); const st = tx.objectStore("f"); const rq = st.openCursor();
      rq.onsuccess = () => { const c = rq.result; if (c) { fotos[c.key] = c.value; c.continue(); } else res(); };
      rq.onerror = () => res();
    } catch (e) { res(); }
  });
}
function idbPut(id, v) { try { idb && idb.transaction("f", "readwrite").objectStore("f").put(v, id); } catch (e) {} }
function idbDel(id) { try { idb && idb.transaction("f", "readwrite").objectStore("f").delete(id); } catch (e) {} }
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const faltan = new Set();
window.blobUrl = id => { if (!id) return PIXEL; if (fotos[id]) return fotos[id]; faltan.add(id); return PIXEL; };
let pidiendo = false;
async function pedirFotos() {
  if (pidiendo || !faltan.size || !navigator.onLine || !cfg) return;
  pidiendo = true;
  try {
    const ids = [...faltan].filter(id => !fotos[id]).slice(0, 10);
    if (!ids.length) { faltan.clear(); return; }
    const r = await puente({ op: "fotoLeer", ids }, 60000);
    ids.forEach(id => faltan.delete(id));
    let nuevas = 0;
    for (const id in (r.fotos || {})) { fotos[id] = r.fotos[id]; idbPut(id, r.fotos[id]); nuevas++; }
    if (nuevas && typeof window.render === "function") try { window.render(); } catch (e) {}
    if (faltan.size) setTimeout(pedirFotos, 500);
  } catch (e) {} finally { pidiendo = false; }
}
const assets = {
  upload: (blob, opt) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = async () => {
      const id = rid(); const data = fr.result;
      try { await puente({ op: "fotoGuardar", id, data }, 90000); fotos[id] = data; idbPut(id, data); res({ id, url: data, sizeBytes: data.length, contentType: (opt && opt.type) || blob.type }); }
      catch (e) { rej(e.code === "server_unavailable" ? { code: "server_unavailable", message: "Sin señal: sube la foto cuando tengas conexión" } : e); }
    };
    fr.onerror = () => rej({ code: "read_error" });
    fr.readAsDataURL(blob);
  }),
  delete: async id => { await puente({ op: "fotoBorrar", id }); delete fotos[id]; idbDel(id); return { deleted: true }; },
  list: async () => ({ assets: Object.keys(fotos).map(id => ({ id })), usage: {} })
};

// ---------- Conexión con la hoja Plantilla (solo DT) ----------
const toBridgeValue = v => {
  if (typeof v === "string") { const m = /^=DATE\((\d+);(\d+);(\d+)\)$/.exec(v); if (m) return { fecha: m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0") }; }
  return v;
};
// Las lecturas que llegan juntas se agrupan en un solo pedido al puente.
let lecturas = null;
function leerAgrupado(sheetId, range) {
  return new Promise((res, rej) => {
    if (!lecturas || lecturas.sheetId !== sheetId) {
      const grupo = lecturas = { sheetId, items: [] };
      setTimeout(async () => {
        if (lecturas === grupo) lecturas = null;
        try {
          const r = await puente({ op: "getMany", sheetId, ranges: grupo.items.map(i => i.range) }, 90000);
          grupo.items.forEach((it, k) => it.res({ payload: { values: (r.valuesList || [])[k] || [] }, content: [] }));
        } catch (e) { grupo.items.forEach(it => it.rej(e)); }
      }, 60);
    }
    lecturas.items.push({ range, res, rej });
  });
}
const mcp = {
  async callTool(server, tool, input) {
    if (!navigator.onLine) throw { code: "server_unavailable", message: "Sin señal", retryable: true };
    if (tool === "get_values") return leerAgrupado(input.spreadsheetId || "", input.range);
    const body = { sheetId: input.spreadsheetId || "", range: input.range };
    if (tool === "get_values") body.op = "get";
    else if (tool === "update_values") { body.op = "set"; body.values = (input.values || []).map(r => r.map(toBridgeValue)); }
    else throw { code: "bad_request", message: "Operación no soportada" };
    const r = await puente(body, 60000);
    return { payload: r.values ? { values: r.values } : {}, content: [] };
  }
};
window.probarPuente = async (url, clave) => fetch(url, { method: "POST", body: JSON.stringify({ clave, op: "ping" }) }).then(x => x.json());
window.importarCarpetaDrive = async link => {
  const r = await puente({ op: "importarCarpeta", carpeta: link }, 330000);
  // Las fotos reimportadas conservan su identificador: se borra la copia local para traer la nueva.
  const ids = Object.values(r.jugadores || {}).concat([r.logo, r.dt].filter(Boolean));
  ids.forEach(id => { delete fotos[id]; idbDel(id); faltan.add(id); });
  setTimeout(pedirFotos, 100);
  return r;
};
// Escudos de rivales: se traen de la carpeta de Drive y se dejan listos (máx. 256 px, fondo transparente, sin bordes sobrantes).
function normalizarEscudo(data) {
  return new Promise(res => {
    const im = new Image();
    im.onload = () => {
      try {
        const k = Math.min(1, 256 / Math.max(im.width, im.height)); const w = Math.max(1, Math.round(im.width * k)), h = Math.max(1, Math.round(im.height * k));
        const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.drawImage(im, 0, 0, w, h);
        const d = g.getImageData(0, 0, w, h), px = d.data; let borde = 0, transp = 0, blanco = 0;
        const mirar = i => { borde++; if (px[i + 3] < 250) transp++; else if (Math.min(px[i], px[i + 1], px[i + 2]) > 228) blanco++; };
        for (let x = 0; x < w; x++) { mirar(x * 4); mirar(((h - 1) * w + x) * 4); }
        for (let y = 0; y < h; y++) { mirar(y * w * 4); mirar((y * w + w - 1) * 4); }
        let cambio = k < 1 || !/^data:image\/png/.test(data);
        // Sin transparencia y con borde blanco (JPG o miniatura): se quita el blanco que toca los bordes.
        if (transp / borde < 0.05 && blanco / borde > 0.7) {
          const vis = new Uint8Array(w * h), cola = [];
          const es = p => Math.min(px[p * 4], px[p * 4 + 1], px[p * 4 + 2]) > 228 && px[p * 4 + 3] > 0;
          const add = p => { if (!vis[p] && es(p)) { vis[p] = 1; cola.push(p); } };
          for (let x = 0; x < w; x++) { add(x); add((h - 1) * w + x); }
          for (let y = 0; y < h; y++) { add(y * w); add(y * w + w - 1); }
          while (cola.length) { const p = cola.pop(), x = p % w, y = (p - x) / w; px[p * 4 + 3] = 0; if (x > 0) add(p - 1); if (x < w - 1) add(p + 1); if (y > 0) add(p - w); if (y < h - 1) add(p + w); }
          g.putImageData(d, 0, 0); cambio = true;
        }
        // Recorte de márgenes vacíos
        const d2 = g.getImageData(0, 0, w, h).data; let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d2[(y * w + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 >= 0 && (x0 > 0 || y0 > 0 || x1 < w - 1 || y1 < h - 1)) {
          const c2 = document.createElement("canvas"); c2.width = x1 - x0 + 1; c2.height = y1 - y0 + 1; c2.getContext("2d").drawImage(c, x0, y0, c2.width, c2.height, 0, 0, c2.width, c2.height);
          return res({ data: c2.toDataURL("image/png"), cambio: true });
        }
        res({ data: cambio ? c.toDataURL("image/png") : data, cambio });
      } catch (e) { res({ data, cambio: false }); }
    };
    im.onerror = () => res({ data, cambio: false });
    im.src = data;
  });
}
window.importarEscudosDrive = async (carpeta, progreso) => {
  const r = await puente({ op: "importarEscudos", carpeta: carpeta || "ESCUDOS" }, 330000);
  const ids = (r.escudos || []).map(e => e.id);
  ids.forEach(id => { delete fotos[id]; idbDel(id); });
  for (let i = 0; i < ids.length; i += 8) {
    const lote = ids.slice(i, i + 8);
    const l = await puente({ op: "fotoLeer", ids: lote }, 90000);
    for (const id of lote) {
      const orig = (l.fotos || {})[id]; if (!orig) continue;
      const n = await normalizarEscudo(orig);
      if (n.cambio) { try { await puente({ op: "fotoGuardar", id, data: n.data }, 60000); } catch (e) {} }
      fotos[id] = n.data; idbPut(id, n.data);
    }
    if (progreso) try { progreso(Math.min(ids.length, i + 8), ids.length); } catch (e) {}
  }
  if (typeof window.render === "function") try { window.render(); } catch (e) {}
  return r;
};
window.invitacionPadres = async renovar => {
  const r = await puente({ op: renovar ? "renovarAfic" : "invitacionAfic" });
  const tok = btoa(unescape(encodeURIComponent(JSON.stringify({ url: cfg.url, clave: r.claveAfic }))));
  return location.origin + location.pathname + "#ver=" + encodeURIComponent(tok);
};
window.invitacionAsistente = async () => {
  const r = await puente({ op: "invitacion" });
  const tok = btoa(unescape(encodeURIComponent(JSON.stringify({ url: cfg.url, clave: r.claveAsistente }))));
  return location.origin + location.pathname + "#inv=" + encodeURIComponent(tok);
};

// ---------- Descargas ----------
const downloads = {
  save: async ({ filename, data }) => {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const u = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000); return { status: "saved" };
  }
};

// ---------- Usuario ----------
const user = {
  isOwner: async () => !!cfg && cfg.rol === "dt", canEdit: async () => !!cfg && cfg.rol === "dt", can: async () => null,
  id: async () => cfg && cfg.uid, me: async () => ({ id: cfg && cfg.uid, name: (cfg && cfg.nombre) || "", isOwner: !!cfg && cfg.rol === "dt" })
};
const api = { use: async name => ({ db, user, assets, mcp, downloads })[name] || null };
window.cerrarSesion = () => { ls.del("cfg"); ls.del("mirror"); ls.del("since"); location.reload(); };

// ---------- Pantalla de acceso ----------
function gate(html) {
  window.__booted = true;
  let el = document.getElementById("gate");
  if (!el) { el = document.createElement("div"); el.id = "gate"; document.body.appendChild(el); }
  el.innerHTML = html; el.hidden = !html;
}
const card = inner => `<div style="position:fixed;inset:0;z-index:100;background:var(--bg);display:grid;place-items:center;padding:24px;overflow:auto"><div class="sec" style="max-width:440px;width:100%">${inner}</div></div>`;
async function entrar(url, clave, nombre) {
  const r = await fetch(url, { method: "POST", body: JSON.stringify({ clave, op: "quien" }) }).then(x => x.json());
  if (!r.ok) throw new Error(r.error === "clave_incorrecta" ? "La clave no es correcta." : "El puente respondió con un error: " + (r.detalle || r.error));
  const prev = ls.get("cfg", null);
  cfg = { url, clave, rol: r.rol, uid: (prev && prev.uid) || ("u_" + rid()), nombre: nombre || "" };
  ls.set("cfg", cfg);
}
function pantallaAcceso(pre, msg) {
  gate(card(`<h2 style="text-align:center">Partido en vivo</h2><p class="hint" style="text-align:center">Jaguares de Córdoba · Sub-15</p>
    ${msg ? `<div class="banner err">${msg}</div>` : ""}
    <label class="f">URL del puente<input id="accUrl" value="${(pre && pre.url) || ""}" placeholder="https://script.google.com/macros/s/…/exec"></label>
    <label class="f">Clave<input id="accClave" type="password" value="${(pre && pre.clave) || ""}" autocomplete="off"></label>
    <label class="f">Tu nombre<input id="accNombre" value="${(pre && pre.nombre) || ""}" placeholder="Ej. Juan Pablo"></label>
    <button class="btn pri wide" id="accBtn">Entrar</button>`));
  document.getElementById("accBtn").onclick = async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "Verificando…";
    const url = document.getElementById("accUrl").value.trim(), clave = document.getElementById("accClave").value.trim(), nombre = document.getElementById("accNombre").value.trim();
    try {
      if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) throw new Error("La URL debe ser la del puente (termina en /exec).");
      await entrar(url, clave, nombre); location.reload();
    } catch (err) { pantallaAcceso({ url, clave, nombre }, (err && err.message) || "No se pudo contactar el puente. Revisa la señal y la URL."); }
  };
}

// ---------- Arranque ----------
(async function arranque() {
  const inv = leerInvitacion();
  if (inv && inv.ver && inv.url && inv.clave) {
    const abrir = async () => {
      gate(card(`<h2 style="text-align:center">Partido en vivo</h2><p class="hint" style="text-align:center">Abriendo el partido…</p>`));
      try { ls.del("mirror"); ls.del("since"); await entrar(inv.url, inv.clave, "Aficionado"); location.reload(); }
      catch (e) { gate(card(`<h2>El enlace ya no es válido</h2><p class="hint">Pide al entrenador el enlace nuevo para ver el partido.</p>`)); }
    };
    if (cfg && cfg.rol !== "afic") {
      gate(card(`<h2>Enlace para padres</h2><p class="hint">Este teléfono ya tiene la app abierta como ${cfg.rol === "dt" ? "DT" : "asistente"}. Si continúas como aficionado, se cerrará esa sesión.</p><button class="btn pri wide" id="afSi">Ver como aficionado</button><button class="btn wide" id="afNo">Seguir como ${cfg.rol === "dt" ? "DT" : "asistente"}</button>`));
      document.getElementById("afSi").onclick = abrir;
      document.getElementById("afNo").onclick = () => location.reload();
      return;
    }
    await abrir(); return;
  }
  if (inv && inv.url && inv.clave) { pantallaAcceso({ url: inv.url, clave: inv.clave }, ""); return; }
  if (!cfg) { pantallaAcceso(null, ""); return; }
  await abrirIDB(); await idbAll();
  gate("");
  window.__esAfic = cfg.rol === "afic";
  if (window.__setReady) window.__setReady(api);
  kick();
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
