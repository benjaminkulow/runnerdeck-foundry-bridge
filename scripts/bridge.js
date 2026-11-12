/**
 * RunnerDeck Bridge – Foundry-VTT-Modul
 *
 * Verbindet Foundry (im Browser dieses Spielers) per WebSocket mit RunnerDeck auf demselben PC
 * (ws://127.0.0.1:<Port>/foundry). Die Verbindung ist nur ausgehend, es braucht keine Portfreigabe.
 *
 * RunnerDeck → Foundry: Würfe als Chatkarte, Schaden/Edge/Initiative/Overwatch, Werte eines Charakters.
 * Foundry → RunnerDeck: Akteursliste, Schaden/Edge-Änderungen, Initiative und Kampfrunden.
 *
 * Es werden keine Regeltexte übertragen – nur Spielzustände und Zahlenwerte des eigenen Charakters.
 */
const MOD = "runnerdeck-bridge";
const PROTO = 1;
const FEATURES = ["share", "rollmode"];   // 0.2.0: Einträge teilen · 0.3.0: Würfelmodus aus RunnerDeck

const st = { ws: null, state: "off", error: "", retry: 0, timer: null, manual: false, rollMsgs: new Map(), app: null, info: null };

const L = (k, d = {}) => game.i18n.format(`RDB.${k}`, d);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const getProp = (o, p) => (foundry.utils && foundry.utils.getProperty ? foundry.utils.getProperty(o, p) : p.split(".").reduce((a, k) => (a == null ? a : a[k]), o));
const setting = k => game.settings.get(MOD, k);
const base = () => `127.0.0.1:${Number(setting("port")) || 8765}`;

/* ------------------------------------------------------------------ Verbindung */

function setState(s, err = "") {
  st.state = s; st.error = err;
  if (st.app && st.app.rendered) st.app.render();
  Hooks.callAll(`${MOD}.status`, s, err);
}

/** Erst ein HTTP-Ping: sagt genauer als ein WebSocket-Fehler, woran es liegt. */
export async function testConnection() {
  const url = `http://${base()}/foundry/ping`;
  let j;
  try {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(url, { cache: "no-store", signal: ctl.signal });
    clearTimeout(to);
    j = await r.json();
  } catch (e) {
    return { ok: false, reason: "unreachable", message: L("errUnreachable", { url: base() }) };
  }
  if (!j || j.app !== "RunnerDeck") return { ok: false, reason: "other", message: L("errOther", { url: base() }) };
  if (!j.enabled) return { ok: false, reason: "disabled", message: L("errDisabled") };
  if (!j.originOk) return { ok: false, reason: "origin", message: L("errOrigin") };
  return { ok: true, version: j.version, message: L("testOk", { version: j.version }) };
}

export async function connect({ code = "", manual = false } = {}) {
  clearTimeout(st.timer);
  st.manual = manual;
  if (st.ws) { try { st.ws.onclose = null; st.ws.close(); } catch (e) { } st.ws = null; }
  const token = setting("token");
  if (!token && !code) { setState("unpaired", L("needCode")); return; }
  setState("connecting");
  const t = await testConnection();
  if (!t.ok) { setState("error", t.message); if (manual) ui.notifications.warn(`RunnerDeck: ${t.message}`); scheduleRetry(t.reason); return; }
  let ws;
  try { ws = new WebSocket(`ws://${base()}/foundry`); } catch (e) { setState("error", L("errWs", { msg: e.message })); return; }
  st.ws = ws;
  ws.onopen = () => {
    send({ type: "hello", proto: PROTO, token, code: String(code || "").trim(), world: game.world.title, worldId: game.world.id, user: game.user.name, userId: game.user.id,
      system: game.system.id, systemVersion: game.system.version, foundry: game.version, module: game.modules.get(MOD)?.version, features: FEATURES });
  };
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMessage(m).catch(err => console.error(`${MOD} |`, err)); };
  ws.onerror = () => { };
  ws.onclose = () => {
    const was = st.state === "connected";
    st.ws = null;
    if (st.state !== "unpaired") setState(was ? "off" : "error", was ? "" : st.error || L("errWs", { msg: "" }));
    if (was) ui.notifications.info(L("disconnected"));
    scheduleRetry("closed");
  };
}

function scheduleRetry(reason) {
  clearTimeout(st.timer);
  if (!setting("autoConnect") || !setting("token") || ["disabled", "origin", "pair"].includes(reason)) return;
  const wait = Math.min(60, 3 * 2 ** Math.min(st.retry++, 4)) * 1000;
  st.timer = setTimeout(() => connect(), wait);
}

export function disconnect() {
  clearTimeout(st.timer);
  if (st.ws) { st.ws.onclose = null; try { st.ws.close(); } catch (e) { } st.ws = null; }
  setState("off");
}

function send(m) {
  if (!st.ws || st.ws.readyState !== 1) return false;
  st.ws.send(JSON.stringify(m));
  return true;
}

/* ------------------------------------------------------------------ Nachrichten von RunnerDeck */

async function onMessage(m) {
  switch (m.type) {
    case "welcome":
      if (m.token) await game.settings.set(MOD, "token", m.token);
      st.retry = 0; st.info = m;
      setState("connected");
      ui.notifications.info(L(m.paired ? "paired" : "connected", { version: m.version || "" }));
      sendActors();
      sendCombat(game.combat);
      return;
    case "error":
      if (m.code === "pair") { await game.settings.set(MOD, "token", ""); setState("unpaired", m.message || L("needCode")); ui.notifications.warn(`RunnerDeck: ${m.message}`); return; }
      ui.notifications.warn(`RunnerDeck: ${m.message || m.code}`);
      return;
    case "pong": return;
    case "getActors": return sendActors();
    case "roll": return postRoll(m);
    case "share": return postShare(m);
    case "state": return applyState(m);
    case "getActor": {
      const a = game.actors.get(m.actorId);
      if (!a || !a.isOwner) return send({ type: "actorData", reqId: m.reqId, error: L("errNoActor") });
      return send({ type: "actorData", reqId: m.reqId, data: a.toObject() });
    }
    case "pushActor": return applyPush(m);
  }
}

function actorList() {
  return game.actors.filter(a => a.isOwner && (!game.user.isGM || a.hasPlayerOwner || a.type === "Player"))
    .map(a => ({ id: a.id, name: a.name, type: a.type, img: a.img }));
}
function sendActors() { send({ type: "actors", list: actorList() }); }

function rollCard(m) {
  const dice = (m.dice || []).map(d => `<span class="rdb-die${d.hit ? " hit" : d.one ? " one" : ""}${d.extra ? " extra" : ""}">${esc(d.v)}</span>`).join("");
  const unit = m.ini ? L("unitPips") : m.unit === "pips" ? L("unitPips") : m.hits === 1 ? L("unitHit") : L("unitHits");
  const thr = m.threshold ? (m.success ? L("success", { net: m.net }) : L("fail", { thr: m.threshold })) : "";
  const ini = m.ini ? `<div class="rdb-line">${L("iniTotal", { base: m.ini.base, sum: m.ini.sum, total: m.ini.base + m.ini.sum })}</div>` : "";
  return `<div class="rdb-card">
    <header><b>${esc(m.name)}</b>${m.illegal ? `<span class="rdb-ill">${L("illegal")}</span>` : ""}</header>
    <div class="rdb-res"><span class="rdb-hits">${esc(m.hits)}</span><span class="rdb-unit">${unit}<small>${esc(m.pool)} ${L("dice")}${m.offline ? " · " + L("offline") : ""}</small></span></div>
    ${dice ? `<div class="rdb-dice">${dice}</div>` : ""}
    ${m.crit ? `<div class="rdb-ban crit">${L("crit")}</div>` : m.glitch ? `<div class="rdb-ban glitch">${L("glitch")}</div>` : ""}
    ${thr ? `<div class="rdb-ban ${m.success ? "ok" : "bad"}">${thr}</div>` : ""}${ini}
    ${m.outcome ? `<div class="rdb-line rdb-out">${esc(m.outcome)}</div>` : ""}
    ${(m.edge || []).length || m.edgeSpent ? `<div class="rdb-line rdb-edge">◆ ${m.edgeSpent ? "−" + esc(m.edgeSpent) + " Edge" + ((m.edge || []).length ? ": " : "") : ""}${(m.edge || []).map(esc).join(", ")}</div>` : ""}
    ${m.formula ? `<footer>${esc(m.formula)}</footer>` : ""}<footer class="rdb-src">RunnerDeck</footer></div>`;
}

function applyMode(data, mode) {
  if (!mode || mode === "publicroll" || mode === "roll") return;
  try { if (ChatMessage.applyRollMode) { ChatMessage.applyRollMode(data, mode); return; } } catch (e) { /* Fallback unten */ }
  const gms = game.users.filter(u => u.isGM).map(u => u.id);
  if (mode === "gmroll") data.whisper = gms;
  else if (mode === "blindroll") { data.whisper = gms; data.blind = true; }
  else if (mode === "selfroll") data.whisper = [game.user.id];
}
async function postRoll(m) {
  const actor = m.actorId ? game.actors.get(m.actorId) : null;
  const content = rollCard(m);
  const prevId = st.rollMsgs.get(m.rollId), prev = prevId && game.messages.get(prevId);
  if (prev && prev.isAuthor) { await prev.update({ content }); return; }
  const data = { speaker: actor ? ChatMessage.getSpeaker({ actor }) : { alias: m.char || "RunnerDeck" }, content, flags: { [MOD]: { rollId: m.rollId } } };
  // 0.3.0: Würfelmodus aus RunnerDeck (publicroll / gmroll / blindroll); ohne Angabe gilt die Einstellung im Foundry-Chat
  const ROLL_MODES = ["publicroll", "gmroll", "blindroll", "selfroll"];
  let mode = ROLL_MODES.includes(m.rollMode) ? m.rollMode : null;
  try { if (!mode) mode = game.settings.get("core", "rollMode"); } catch (e) { /* Einstellung heißt in neueren Versionen evtl. anders – dann öffentlich */ }
  applyMode(data, mode);
  const msg = await ChatMessage.create(data);
  if (msg) { st.rollMsgs.set(m.rollId, msg.id); if (st.rollMsgs.size > 60) st.rollMsgs.delete(st.rollMsgs.keys().next().value); }
}

// 0.2.0: geteilter Eintrag (Fertigkeit, Waffe, Zauber …) als Chatkarte; to = "all" oder "gm" (geflüstert)
function shareCard(m) {
  const rows = (m.rows || []).filter(r => r && r.length >= 2).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("");
  return `<div class="rdb-card rdb-share">
    <header><b>${esc(m.title)}</b>${m.kind ? `<span class="rdb-kind">${esc(m.kind)}</span>` : ""}</header>
    ${m.sub ? `<div class="rdb-line rdb-sub">${esc(m.sub)}</div>` : ""}
    ${rows ? `<table class="rdb-tab">${rows}</table>` : ""}
    ${m.text ? `<div class="rdb-line">${esc(m.text)}</div>` : ""}
    ${m.src ? `<footer>${esc(m.src)}</footer>` : ""}<footer class="rdb-src">RunnerDeck</footer></div>`;
}
async function postShare(m) {
  const actor = m.actorId ? game.actors.get(m.actorId) : null;
  const data = { speaker: actor ? ChatMessage.getSpeaker({ actor }) : { alias: m.char || "RunnerDeck" }, content: shareCard(m), flags: { [MOD]: { share: true } } };
  if (m.to === "gm") data.whisper = game.users.filter(u => u.isGM).map(u => u.id);
  await ChatMessage.create(data);
}

const STATE_PATHS = { phys: "system.physical.dmg", stun: "system.stun.dmg", over: "system.overflow.dmg", edge: "system.edge.value", os: "system.overwatch" };

async function applyState(m) {
  const a = game.actors.get(m.actorId);
  if (!a || !a.isOwner) return;
  const upd = {};
  for (const [k, p] of Object.entries(STATE_PATHS)) {
    if (m[k] == null) continue;
    const cur = getProp(a, p);
    if (cur === undefined || typeof cur === "object") continue;   // Feld gibt es in diesem System nicht
    if (Number(cur) !== Number(m[k])) upd[p] = Number(m[k]);
  }
  if (Object.keys(upd).length) await a.update(upd, { [MOD]: true });
  if (m.ini != null && game.combat) {
    const cb = game.combat.combatants.find(c => c.actorId === a.id);
    if (cb && cb.isOwner && Number(cb.initiative) !== Number(m.ini)) await game.combat.setInitiative(cb.id, Number(m.ini));
  }
}

const PUSH_OK = /^(name|system\.(attributes\.[a-z]{3}\.base|skills\.[a-z_]+\.points|metatype|mortype))$/;
async function applyPush(m) {
  const a = game.actors.get(m.actorId);
  if (!a || !a.isOwner) return send({ type: "pushResult", ok: false, error: L("errNoActor") });
  try {
    const upd = {};
    for (const [p, v] of Object.entries(m.changes || {})) if (PUSH_OK.test(p) && (typeof v === "number" || typeof v === "string")) upd[p] = v;
    let n = Object.keys(upd).length;
    if (n) await a.update(upd, { [MOD]: true });
    const types = new Set(Object.keys((CONFIG.Item && (CONFIG.Item.dataModels || CONFIG.Item.typeLabels)) || {}));
    const items = (m.items || []).filter(i => i && i.name && i.type && (!types.size || types.has(i.type)))
      .map(i => ({ name: String(i.name), type: i.type, img: i.img || "icons/svg/item-bag.svg", system: i.system || {} }));
    if (items.length) { await a.createEmbeddedDocuments("Item", items); n += items.length; }
    send({ type: "pushResult", ok: true, count: n });
    ui.notifications.info(L("pushed", { n, name: a.name }));
  } catch (e) {
    console.error(`${MOD} |`, e);
    send({ type: "pushResult", ok: false, error: e.message });
  }
}

/* ------------------------------------------------------------------ Änderungen in Foundry → RunnerDeck */

function actorState(a) {
  const o = { type: "actorState", actorId: a.id };
  for (const [k, p] of Object.entries(STATE_PATHS)) { const v = getProp(a, p); if (typeof v === "number") o[k] = v; }
  return o;
}

function sendCombat(c, ended = false) {
  if (!c) return send({ type: "combat", ended: true });
  send({ type: "combat", id: c.id, round: c.round, turn: c.turn, ended, activeActor: c.combatant ? c.combatant.actorId : null, activeName: c.combatant ? c.combatant.name : "" });
}

/* ------------------------------------------------------------------ Einstellungsfenster */

function makeApp() {
  const AppV2 = foundry.applications && foundry.applications.api && foundry.applications.api.ApplicationV2;
  if (!AppV2) return null;
  return class RunnerDeckBridgeApp extends AppV2 {
    static DEFAULT_OPTIONS = { id: "runnerdeck-bridge", tag: "div", window: { title: "RunnerDeck Bridge", icon: "fa-solid fa-dice-d6" }, position: { width: 460 } };
    async _renderHTML() {
      const d = document.createElement("div"); d.className = "rdb-app";
      const S = { off: L("stOff"), connecting: L("stConnecting"), connected: L("stConnected"), error: L("stError"), unpaired: L("stUnpaired") };
      d.innerHTML = `<p class="rdb-state rdb-${st.state}"><b>${S[st.state] || st.state}</b>${st.info && st.state === "connected" ? ` · RunnerDeck ${esc(st.info.version || "")}` : ""}</p>
        ${st.error ? `<p class="rdb-err">${esc(st.error)}</p>` : ""}
        <div class="form-group"><label>${L("port")}</label><input type="number" name="port" value="${esc(setting("port"))}" min="1" max="65535"></div>
        <div class="form-group"><label>${L("code")}</label><input type="text" name="code" placeholder="${setting("token") ? L("codeAgain") : "123456"}" inputmode="numeric" maxlength="6"></div>
        <p class="notes">${L("help")}</p>
        <div class="rdb-btns"><button type="button" data-act="test">${L("btnTest")}</button><button type="button" data-act="connect">${L("btnConnect")}</button><button type="button" data-act="disconnect">${L("btnDisconnect")}</button>${setting("token") ? `<button type="button" data-act="forget">${L("btnForget")}</button>` : ""}</div>`;
      return d;
    }
    _replaceHTML(result, content) {
      content.replaceChildren(result);
      result.addEventListener("click", async ev => {
        const b = ev.target.closest("[data-act]"); if (!b) return;
        const port = result.querySelector("[name=port]").value, code = result.querySelector("[name=code]").value;
        if (Number(port) && Number(port) !== Number(setting("port"))) await game.settings.set(MOD, "port", Number(port));
        if (b.dataset.act === "test") { const t = await testConnection(); (t.ok ? ui.notifications.info : ui.notifications.warn)(`RunnerDeck: ${t.message}`); setState(st.state === "connected" ? "connected" : t.ok ? st.state : "error", t.ok ? "" : t.message); }
        if (b.dataset.act === "connect") connect({ code, manual: true });
        if (b.dataset.act === "disconnect") disconnect();
        if (b.dataset.act === "forget") { await game.settings.set(MOD, "token", ""); disconnect(); setState("unpaired", L("needCode")); }
      });
    }
  };
}
export function openApp() {
  const C = makeApp();
  if (!C) return ui.notifications.error("RunnerDeck Bridge: ApplicationV2 fehlt (Foundry 13+ nötig)");
  if (!st.app) st.app = new C();
  st.app.render({ force: true });
}

/* ------------------------------------------------------------------ Hooks */

Hooks.once("init", () => {
  game.settings.register(MOD, "port", { name: "RDB.port", hint: "RDB.portHint", scope: "client", config: true, type: Number, default: 8765 });
  game.settings.register(MOD, "autoConnect", { name: "RDB.auto", hint: "RDB.autoHint", scope: "client", config: true, type: Boolean, default: true });
  game.settings.register(MOD, "token", { scope: "client", config: false, type: String, default: "" });
  const C = makeApp();
  if (C) game.settings.registerMenu(MOD, "connection", { name: "RDB.menu", label: "RDB.menuLabel", hint: "RDB.menuHint", icon: "fa-solid fa-plug", type: C, restricted: false });
});

Hooks.once("ready", () => {
  game.modules.get(MOD).api = { connect, disconnect, testConnection, openApp, status: () => ({ state: st.state, error: st.error }) };
  if (setting("autoConnect") && setting("token")) connect();
  else if (!setting("token")) setState("unpaired", L("needCode"));
});

Hooks.on("updateActor", (a, changes, options) => {
  if (st.state !== "connected" || options?.[MOD] || !a.isOwner) return;
  const flat = foundry.utils.flattenObject ? foundry.utils.flattenObject(changes) : changes;
  if (!Object.keys(flat).some(k => Object.values(STATE_PATHS).some(p => k.startsWith(p)))) return;
  send(actorState(a));
});
Hooks.on("createActor", () => { if (st.state === "connected") sendActors(); });
Hooks.on("deleteActor", () => { if (st.state === "connected") sendActors(); });
Hooks.on("updateActor", (a, changes) => { if (st.state === "connected" && "name" in changes) sendActors(); });
Hooks.on("updateCombat", c => { if (st.state === "connected" && c === game.combat) sendCombat(c); });
Hooks.on("combatStart", c => { if (st.state === "connected") sendCombat(c); });
Hooks.on("deleteCombat", c => { if (st.state === "connected") send({ type: "combat", id: c.id, ended: true }); });
Hooks.on("updateCombatant", (cb, changes) => {
  if (st.state !== "connected" || !("initiative" in changes) || !cb.actor || !cb.actor.isOwner || cb.initiative == null) return;
  send({ type: "ini", actorId: cb.actorId, value: cb.initiative });
});
// /rd oder /runnerdeck im Chat öffnet das Verbindungsfenster
Hooks.on("chatMessage", (log, text) => {
  if (/^\/(rd|runnerdeck)\b/i.test(String(text).trim())) { openApp(); return false; }
});
