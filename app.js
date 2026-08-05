// ============================================================
// 4TH & COLD — CHIP DRAW · app.js (vanilla ES modules + Firebase v10)
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, onSnapshot, setDoc, updateDoc, deleteDoc,
  addDoc, getDocs, query, orderBy, limit, runTransaction, writeBatch,
  serverTimestamp, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import * as CFG from "./firebase-config.js";

const BUILD = "2026.08.05-a";
console.log("[chip-draw] build " + BUILD);

const app  = initializeApp(CFG.firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// Admin tiers — POWER_ADMIN_EMAILS / PAYMENT_ADMIN_EMAILS in firebase-config.js
// (falls back to the old ADMIN_EMAILS list as power admins)
const POWER = (CFG.POWER_ADMIN_EMAILS || CFG.ADMIN_EMAILS || []).map(e=>e.toLowerCase());
const PAY   = (CFG.PAYMENT_ADMIN_EMAILS || []).map(e=>e.toLowerCase());

// Default collectors (same as the squares board) — editable in admin Settings
const DEFAULT_VENMO = [
  { label: "Marcus", handle: "marcus-dawes",  note: "" },
  { label: "Dan",    handle: "dan-huskerson", note: "" },
  { label: "Randyn", handle: "randyn-tenery", note: "" }
];
const venmoList = () => {
  const l = (S.game?.venmoList || []).filter(v => v && v.handle);
  return l.length ? l : DEFAULT_VENMO;
};

// ---------- state ----------
const S = {
  uid: null, email: null, playerKey: null,
  isPower: false, isPay: false, isAdmin: false,
  game: null, bag: null, me: null, liveDraw: null,
  players: {}, chips: {}, prizes: {}, alerts: {},
  ready: { game:false, bag:false, chips:false, prizes:false, players:false },
  admins: { power: [], payment: [] },
  view: "chips", adminDirty: false, oddsOpen: false,
  unsubAlerts: null, wheelKey: null, wheelDismissed: null
};

// ---------- helpers ----------
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = n => "$" + (Math.round(n * 100) / 100).toLocaleString();
const emailKey = e => String(e).trim().toLowerCase().replace(/[^a-z0-9]/g, "_");
const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function cryptoRandInt(n){
  if (n <= 0) throw new Error("empty");
  const max = Math.floor(0xFFFFFFFF / n) * n;
  const a = new Uint32Array(1);
  do { crypto.getRandomValues(a); } while (a[0] >= max);
  return a[0] % n;
}

const CHIP_COLORS = [
  { c:"#EDE6D6", dark:false }, { c:"#B23A32", dark:true },
  { c:"#2E5E9E", dark:true },  { c:"#2F7D4F", dark:true },
  { c:"#3A3A3C", dark:true },  { c:"#6C3FA0", dark:true },
  { c:"#FFC53D", dark:false }, { c:"#BF5700", dark:true }
];
const bagValues = () => (S.bag?.groups || []).map(g => g.value).sort((a,b)=>a-b);
function chipStyle(value){
  const i = Math.max(0, bagValues().indexOf(value)) % CHIP_COLORS.length;
  return CHIP_COLORS[i];
}
function chipHTML(value, size=""){
  const st = chipStyle(value);
  return `<div class="chip ${size} ${st.dark?"dark":""}" style="--c:${st.c}"><span>$${value}</span></div>`;
}

let toastT = null;
function toast(msg){
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastT); toastT = setTimeout(()=>t.classList.add("hidden"), 3600);
}
function confirmDialog(title, html, yesLabel){
  return new Promise(res => {
    $("#confirm-title").textContent = title;
    $("#confirm-text").innerHTML = html;
    const yes = $("#confirm-yes"), no = $("#confirm-no");
    yes.textContent = yesLabel || "Confirm";
    const m = $("#modal-confirm"); m.classList.remove("hidden");
    const done = ok => { m.classList.add("hidden");
      yes.removeEventListener("click",oy); no.removeEventListener("click",on); res(ok); };
    const oy = () => done(true), on = () => done(false);
    yes.addEventListener("click", oy); no.addEventListener("click", on);
  });
}
function audit(action, detail){
  addDoc(collection(db,"audit"), { at: serverTimestamp(),
    who: S.email || S.me?.name || S.uid || "?", action, detail: detail || "" }).catch(()=>{});
}
function venmoBtns(amount){
  const memo = encodeURIComponent(S.game?.title || "4th & Cold Chip Draw");
  const btns = venmoList().map(v =>
    `<a class="btn primary mini" target="_blank" rel="noopener"
      href="https://venmo.com/${esc(v.handle)}?txn=pay&amount=${amount.toFixed(2)}&note=${memo}">Pay ${esc(v.label)}</a>`
  ).join("");
  const notes = venmoList().filter(v => v.note)
    .map(v => `<div class="small muted">${esc(v.label)}: ${esc(v.note)}</div>`).join("");
  return `<div class="venmoBtns">${btns}</div>${notes}`;
}

// derived
const chipsArr  = () => Object.entries(S.chips).map(([id,c]) => ({id, ...c}));
const prizesArr = () => Object.entries(S.prizes).map(([id,p]) => ({id, ...p}))
  .sort((a,b) => (a.order??0) - (b.order??0));
const myChips   = () => chipsArr().filter(c => c.owner === S.playerKey);
const owedBy    = uid => chipsArr().filter(c=>c.owner===uid).reduce((s,c)=>s+c.value,0);
const balanceOf = uid => owedBy(uid) - (S.players[uid]?.paid || 0);
const drawnCount   = v   => chipsArr().filter(c=>c.value===v).length;
const bucketCount  = pid => chipsArr().filter(c=>c.bucket===pid).length;
const myBucketCount= pid => myChips().filter(c=>c.bucket===pid).length;
const anyUnpaid = () => Object.keys(S.players).some(u => balanceOf(u) > 0.005);
const bucketEntries = pid => chipsArr().filter(c => c.bucket === pid)
  .sort((a,b) => a.id < b.id ? -1 : 1);   // deterministic order on every device
// multi-winner prizes: winners array with legacy single-winner fallback
const effWinners = p => (p.winners && p.winners.length) ? p.winners
  : (p.winnerChipId ? [{ chipId: p.winnerChipId, owner: S.chips[p.winnerChipId]?.owner || "",
      name: p.winnerName || S.chips[p.winnerChipId]?.ownerName || "?",
      email: p.winnerEmail || "", value: p.winnerValue ?? 0, at: 0 }] : []);
const numW = p => Math.max(1, p.numWinners || 1);
const prizeDone = p => effWinners(p).length >= numW(p);
function eligibleEntries(pid, p){
  let entries = bucketEntries(pid);
  const already = effWinners(p).map(w => w.chipId);
  entries = entries.filter(c => !already.includes(c.id));
  if (p.uniqueWinners){
    const owners = effWinners(p).map(w => w.owner);
    entries = entries.filter(c => !owners.includes(c.owner));
  }
  return entries;
}
const perkOf = v => ((S.bag?.groups || []).find(g => g.value === v)?.perk || "");
const chipPerk = c => (c.perk !== undefined ? (c.perk || "") : perkOf(c.value));
// drawn count for a specific bag row (rows can share a price, e.g. $5 Mulligan + $5 String)
function drawnFor(groups, idx){
  const g = groups[idx];
  const firstOfValue = groups.findIndex(x => x.value === g.value) === idx;
  return chipsArr().filter(c => c.gid ? c.gid === g.gid
    : (firstOfValue && c.value === g.value)).length;
}
function bagRemaining(){
  const gs = [...(S.bag?.groups||[])].filter(g=>g.remaining>0).sort((a,b)=>a.value-b.value);
  const total = gs.reduce((s,g)=>s+g.remaining,0);
  return { groups: gs, total,
    min: gs.length ? gs[0].value : 0, max: gs.length ? gs[gs.length-1].value : 0 };
}
function bagInfoHTML(withOdds){
  const b = bagRemaining();
  if (!b.total) return `<b>The bag is empty.</b>`;
  const range = b.min === b.max ? money(b.min) : `${money(b.min)}–${money(b.max)}`;
  let html = `<b>${b.total}</b> chip${b.total===1?"":"s"} left in the bag · ${range} still out there`;
  if (withOdds){
    html += `<details class="bagodds" ${S.oddsOpen?"open":""}><summary>What are my odds?</summary>` +
      b.groups.map(g => `
        <div class="bag-row">
          ${chipHTML(g.value,"mini")}${g.perk?`<span class="perkTag">${esc(g.perk)}</span>`:""}
          <div class="bag-bar"><i style="width:${(g.remaining/b.total*100).toFixed(1)}%"></i></div>
          <div class="bag-nums"><b>${g.remaining}</b> left · ${(g.remaining/b.total*100).toFixed(0)}%</div>
        </div>`).join("") +
      `<p class="muted small" style="margin-top:8px">Chips are pulled with the browser's cryptographic random generator (crypto.getRandomValues) — the same class of randomness used for security keys. Every draw is logged.</p></details>`;
  }
  return html;
}

// ---------- boot / auth ----------
getRedirectResult(auth).catch(e => toast("Sign-in failed: " + (e.code || e.message)));
onAuthStateChanged(auth, user => {
  if (!user){ signInAnonymously(auth).catch(bootError); return; }
  S.uid = user.uid;
  S.email = (user.email || "").toLowerCase() || null;
  computeRoles();
  if (S.email && !S.isAdmin) toast(`${S.email} isn't on the admin list.`);
  startListeners();
});
function computeRoles(){
  const wasAdmin = S.isAdmin;
  S.isPower = !!S.email && (POWER.includes(S.email) || S.admins.power.includes(S.email));
  S.isPay   = !!S.email && (PAY.includes(S.email)   || S.admins.payment.includes(S.email));
  S.isAdmin = S.isPower || S.isPay;
  if (S.isAdmin !== wasAdmin) watchAlerts();
}
function bootError(e){
  $("#screen-loading").innerHTML =
    `<p class="err">Couldn't connect: ${esc(e.message)}</p>
     <p class="muted small">Check firebase-config.js and that Anonymous auth is enabled.</p>`;
}

let started = false;
function startListeners(){
  if (started){ watchAlerts(); renderAll(); return; }
  started = true;
  onSnapshot(doc(db,"config","game"), async snap => {
    if (!snap.exists()){
      if (S.isPower){
        try{
          await setDoc(doc(db,"config","game"), { title:"Chip Draw Raffle",
            state:"setup", unassignedRule:"warn", unpaidCap:0, unpaidAtLock:false });
        }catch(e){ toast("Setup failed — check firestore.rules email list: " + (e.code||e.message)); }
        return;
      }
      S.game = null;
    } else S.game = snap.data();
    S.ready.game = true; renderAll();
  }, bootError);
  onSnapshot(doc(db,"config","bag"), snap => {
    S.bag = snap.exists() ? snap.data() : { groups: [] };
    S.ready.bag = true; renderAll();
  });
  onSnapshot(doc(db,"config","admins"), snap => {
    if (snap.exists()){
      const d = snap.data();
      S.admins.power   = (d.power   || []).map(e=>String(e).toLowerCase());
      S.admins.payment = (d.payment || []).map(e=>String(e).toLowerCase());
    } else if (S.email && POWER.includes(S.email)){
      setDoc(doc(db,"config","admins"), { power: [], payment: [] }).catch(()=>{});
    }
    computeRoles(); renderAll();
  });
  onSnapshot(doc(db,"config","liveDraw"), snap => {
    S.liveDraw = snap.exists() ? snap.data() : null;
    handleLiveDraw();
  });
  onSnapshot(collection(db,"chips"), qs => {
    S.chips = {}; qs.forEach(d => S.chips[d.id] = d.data());
    S.ready.chips = true; renderAll();
  });
  onSnapshot(collection(db,"prizes"), qs => {
    S.prizes = {}; qs.forEach(d => S.prizes[d.id] = d.data());
    S.ready.prizes = true; renderAll();
  });
  onSnapshot(collection(db,"players"), qs => {
    S.players = {}; qs.forEach(d => S.players[d.id] = d.data());
    S.me = S.playerKey ? (S.players[S.playerKey] || null) : null;
    S.ready.players = true; renderAll();
  });
  watchAlerts();
}
function watchAlerts(){
  if (S.unsubAlerts){ S.unsubAlerts(); S.unsubAlerts = null; }
  if (!S.isAdmin){ S.alerts = {}; return; }
  S.unsubAlerts = onSnapshot(collection(db,"adminAlerts"), qs => {
    S.alerts = {}; qs.forEach(d => S.alerts[d.id] = d.data());
    renderAll();
  });
}

const allReady = () => Object.values(S.ready).every(Boolean);
function maybeShow(){
  if (!allReady()) return;
  $("#screen-loading").classList.add("hidden");
  if (!S.playerKey || !S.me){
    $("#screen-join").classList.remove("hidden");
    $("#app").classList.add("hidden");
  } else {
    $("#screen-join").classList.add("hidden");
    $("#app").classList.remove("hidden");
  }
}

// ---------- join ----------
$("#join-form").addEventListener("submit", e => { e.preventDefault(); $("#join-btn").click(); });
$("#join-btn").addEventListener("click", async () => {
  const err = $("#join-err");
  err.classList.add("hidden");
  const e1 = $("#join-email").value.trim().toLowerCase();
  if (!e1 || !e1.includes("@")){ err.textContent = "Enter your email."; err.classList.remove("hidden"); return; }
  const key = emailKey(e1);
  const existing = S.players[key];
  if (existing){
    S.playerKey = key;
    toast(`Welcome back, ${existing.name}!`);
    renderAll();
    return;
  }
  // first-time: reveal name + confirm-email, require both
  const newBox = $("#join-new");
  if (newBox.classList.contains("hidden")){
    newBox.classList.remove("hidden");
    err.textContent = "New here — confirm your name and retype your email.";
    err.classList.remove("hidden");
    return;
  }
  const name = $("#join-name").value.trim();
  const e2 = $("#join-email2").value.trim().toLowerCase();
  if (!name){ err.textContent = "Name is required."; err.classList.remove("hidden"); return; }
  if (e1 !== e2){ err.textContent = "Emails don't match."; err.classList.remove("hidden"); return; }
  try{
    await setDoc(doc(db,"players",key), {
      name, email: e1, paid: 0, notices: [], createdAt: serverTimestamp()
    });
    S.playerKey = key;
    audit("join", `${name} <${e1}>`);
    renderAll();
  }catch(ex){ err.textContent = ex.message; err.classList.remove("hidden"); }
});

// ---------- view switching ----------
$$("#seg button").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
function setView(v){
  S.view = v;
  $$("#seg button").forEach(x => x.classList.toggle("active", x.dataset.view === v));
  $("#seg").classList.toggle("hidden", v === "admin");
  $("#tab-chips").classList.toggle("hidden", v !== "chips");
  $("#tab-prizes").classList.toggle("hidden", v !== "prizes");
  $("#tab-live").classList.toggle("hidden", v !== "live");
  $("#panel-admin").classList.toggle("hidden", v !== "admin");
  $("#adminBtn").textContent = v === "admin" ? "Exit admin" : "Admin";
  renderAll();
}

$("#adminBtn").addEventListener("click", async () => {
  if (S.view === "admin"){ setView("chips"); return; }
  if (S.isAdmin){ setView("admin"); return; }
  const ok = await confirmDialog("Admin sign-in",
    `<p class="small">Admins only. This signs you in with Google — if you've been playing on this device, your chips stay tied to the account you drew them with.</p>`,
    "Sign in with Google");
  if (!ok) return;
  try{
    await signInWithPopup(auth, new GoogleAuthProvider());
    location.reload();
  }catch(e){
    if (["auth/popup-blocked","auth/popup-closed-by-user","auth/cancelled-popup-request",
         "auth/operation-not-supported-in-this-environment"].includes(e.code)){
      try{ await signInWithRedirect(auth, new GoogleAuthProvider()); }
      catch(e2){ toast("Sign-in failed: " + (e2.code || e2.message)); }
    } else {
      toast("Sign-in failed: " + (e.code || e.message));
    }
  }
});

// ---------- render ----------
function renderAll(){
  if (!allReady()) return;
  S.me = S.playerKey ? (S.players[S.playerKey] || null) : null;
  maybeShow();
  if (!S.me) return;
  $("#brandSeason").textContent = (S.game?.title || "CHIP DRAW").toUpperCase();
  const live = !!S.game?.raffleLive;
  $("#segLive").classList.toggle("hidden", !live && S.view !== "live");
  if (!live && S.view === "live") setView("prizes");
  renderBalancePill(); renderBanners();
  renderChipsTab(); renderPrizesTab(); renderLiveTab();
  if (S.view === "admin"){
    if (S.isAdmin) renderAdminPanel(); else setView("chips");
  }
}

function renderBalancePill(){
  const bal = balanceOf(S.playerKey);
  const p = $("#balance-pill");
  p.textContent = bal > 0.005 ? `Owe ${money(bal)}` : "Paid up";
  p.classList.toggle("owe", bal > 0.005);
}

function renderBanners(){
  const B = [];
  const state = S.game?.state;
  const myWins = prizesArr().map(p => {
    const n = effWinners(p).filter(w => w.owner === S.playerKey
      || (w.chipId && S.chips[w.chipId]?.owner === S.playerKey)).length;
    return n ? (esc(p.name) + (n > 1 ? ` ×${n}` : "")) : null;
  }).filter(Boolean);
  if (myWins.length)
    B.push(`<div class="banner win"><div class="grow">🏆 <b>You won:</b> ${myWins.join(", ")}. See the Prizes tab.</div></div>`);
  (S.me?.notices || []).forEach(n => {
    B.push(`<div class="banner info"><div class="grow">${esc(n.msg)}<br>
      <button class="btn mini" style="margin-top:6px" data-dismiss="${esc(n.id)}">Got it 👍</button></div></div>`);
  });
  const bal = balanceOf(S.playerKey);
  if (bal > 0.005 && state !== "setup"){
    B.push(`<div class="banner warn"><div class="grow">You owe <b>${money(bal)}</b> for your chips.
      ${venmoBtns(bal)}</div></div>`);
  }
  const un = myChips().filter(c => !c.bucket).length;
  if (un > 0 && state === "open"){
    B.push(`<div class="banner info"><div class="grow">You have <b>${un}</b> chip${un>1?"s":""} not placed on a prize yet — hit the Prizes tab.</div></div>`);
  }
  if (S.isAdmin){
    if ((state === "locked" || state === "complete") && anyUnpaid()){
      const list = Object.keys(S.players).filter(u => balanceOf(u) > 0.005)
        .map(u => `${esc(S.players[u].name)} &lt;${esc(S.players[u].email)}&gt; (${money(balanceOf(u))})`).join(", ");
      B.push(`<div class="banner alert"><div class="grow"><b>Admin — unpaid balances after lock:</b> ${list}</div></div>`);
    }
    if (S.game?.unpaidAtLock && (state === "locked" || state === "complete")){
      B.push(`<div class="banner warn"><div class="grow"><b>Admin:</b> game locked with unpaid chips still counted as valid entries (per settings).</div></div>`);
    }
    Object.entries(S.alerts).filter(([,a]) => !a.resolved).forEach(([id,a]) => {
      const emails = (a.impacted||[]).map(x=>x.email).join(", ");
      const lines = (a.impacted||[]).map(x=>`${esc(x.name)} — ${x.chips} chip${x.chips>1?"s":""}`).join("<br>");
      B.push(`<div class="banner alert"><div class="grow"><b>Prize removed: ${esc(a.prizeName)}.</b> Chips returned to owners:<br>${lines}
        <br><button class="btn mini" data-copy="${esc(emails)}">Copy emails</button>
        <button class="btn mini" data-resolve="${id}">Mark handled</button></div></div>`);
    });
  }
  $("#banners").innerHTML = B.join("");
}

$("#banners").addEventListener("click", async e => {
  const d = e.target.dataset;
  if (d.dismiss){
    const notices = (S.me.notices||[]).filter(n => n.id !== d.dismiss);
    await updateDoc(doc(db,"players",S.playerKey), { notices }).catch(x=>toast(x.message));
  }
  if (d.copy){ try{ await navigator.clipboard.writeText(d.copy); toast("Emails copied"); }catch{ toast("Copy failed"); } }
  if (d.resolve){ await updateDoc(doc(db,"adminAlerts",d.resolve), { resolved:true }).catch(x=>toast(x.message)); }
});

// ---------- MY CHIPS ----------
function renderChipsTab(){
  const el = $("#tab-chips");
  if (S.view !== "chips") return;
  const state = S.game?.state;
  const mine = myChips();
  const owed = owedBy(S.playerKey), paid = S.me?.paid || 0;
  const bag = bagRemaining();

  const cap = S.game?.unpaidCap || 0;
  const capped = cap > 0 && (owed - paid) >= cap;
  let drawDisabled = "", drawNote = "";
  if (state === "setup"){ drawDisabled="disabled"; drawNote="The game hasn't opened yet."; }
  else if (state !== "open"){ drawDisabled="disabled"; drawNote="Buckets are locked — no more draws."; }
  else if (!bag.total){ drawDisabled="disabled"; drawNote="The bag is empty!"; }
  else if (capped){ drawDisabled="disabled"; drawNote=`Pay down your balance to keep drawing (limit ${money(cap)} unpaid).`; }

  const groups = {};
  mine.forEach(c => {
    const pk = chipPerk(c);
    const k = c.value + "|" + pk + "|" + (c.bucket||"");
    groups[k] = groups[k] || { value:c.value, perk:pk, bucket:c.bucket||null, n:0 };
    groups[k].n++;
  });
  const rows = Object.values(groups).sort((a,b)=>a.value-b.value).map(g => {
    const where = g.bucket ? (S.prizes[g.bucket]?.name || "Removed prize") : "Not placed";
    const perk = g.perk;
    return `<div class="place-row">
      <div class="stack-item">${chipHTML(g.value,"mini")}<span class="stack-count">×${g.n}</span></div>
      <div class="grow small">${perk?`<span class="perkTag">${esc(perk)}</span> `:""}${esc(where)}</div>
    </div>`;
  }).join("");

  el.innerHTML = `
    <div class="card center">
      <button id="btn-draw" class="btn primary block" ${drawDisabled}>🎒 Draw a chip</button>
      ${drawNote ? `<p class="muted small" style="margin-top:8px">${drawNote}</p>` : ""}
      <div class="baginfo">${bagInfoHTML(true)}</div>
    </div>
    <h2>Your chips (${mine.length})</h2>
    ${mine.length ? rows : `<p class="muted">No chips yet — pull one from the bag.</p>`}
    <h2>Your tab</h2>
    <div class="card">
      <div class="row spread"><span>Chips drawn</span><b class="num">${mine.length}</b></div>
      <div class="row spread"><span>Total owed</span><b class="num">${money(owed)}</b></div>
      <div class="row spread"><span>Paid</span><b class="num">${money(paid)}</b></div>
      <div class="row spread"><span>Balance</span>
        <b class="num ${owed-paid>0.005?"owefig":"okfig"}">${money(owed-paid)}</b></div>
      ${owed-paid>0.005 ? venmoBtns(owed-paid) : ""}
      <p class="muted small" style="margin-top:10px">Every chip = one entry on whatever prize you place it. The dollar value is what you pay — it doesn't change your odds. Place and move chips from the Prizes tab.</p>
    </div>`;
  $("#btn-draw")?.addEventListener("click", openDraw);
  el.querySelector(".bagodds")?.addEventListener("toggle",
    e => { S.oddsOpen = e.target.open; });
}

// ---------- draw ----------
function openDraw(){ $("#modal-draw").classList.remove("hidden"); runDraw(); }
async function runDraw(){
  const bagEl = $("#draw-bag"), chipEl = $("#draw-chip"),
        txt = $("#draw-text"), actions = $("#draw-actions"), info = $("#draw-baginfo");
  actions.classList.add("hidden"); chipEl.classList.add("hidden");
  bagEl.classList.remove("hidden");
  bagEl.classList.remove("shake"); void bagEl.offsetWidth; bagEl.classList.add("shake");
  txt.textContent = "Reaching in…"; info.innerHTML = "";
  $("#draw-total").innerHTML = "";
  try{
    const minShake = new Promise(r => setTimeout(r, 650));
    const drawn = await drawChipTx();
    const value = drawn.value;
    await minShake;
    bagEl.classList.add("hidden");
    const st = chipStyle(value);
    chipEl.className = `chip big ${st.dark?"dark":""} reveal`;
    chipEl.style.setProperty("--c", st.c);
    chipEl.querySelector("span").textContent = "$" + value;
    chipEl.classList.remove("hidden");
    txt.innerHTML = `You pulled a <b>${money(value)}</b> chip!`
      + (drawn.perk ? `<br><span class="perkLine">🏌️ Good for: <b>${esc(drawn.perk)}</b></span>` : "");
    const n = myChips().length, owedNow = owedBy(S.playerKey);
    $("#draw-total").innerHTML =
      `Your stack: <b>${n}</b> chip${n===1?"":"s"} · total owed <b>${money(owedNow)}</b>`;
    info.innerHTML = bagInfoHTML(false);
    audit("draw", `${S.me.name} drew $${value}${drawn.perk ? " ("+drawn.perk+")" : ""}`);
  }catch(ex){
    txt.textContent = ex.message === "empty" ? "The bag is empty!" : ("Draw failed: " + ex.message);
  }
  actions.classList.remove("hidden");
}
async function drawChipTx(){
  if (S.game?.state !== "open") throw new Error("Draws are closed.");
  const cap = S.game?.unpaidCap || 0;
  if (cap > 0 && balanceOf(S.playerKey) >= cap)
    throw new Error(`Unpaid limit reached (${money(cap)}). Pay down your tab first.`);
  const chipRef = doc(collection(db,"chips"));
  let drawnValue = null;
  await runTransaction(db, async tx => {
    const bagRef = doc(db,"config","bag");
    const snap = await tx.get(bagRef);
    if (!snap.exists()) throw new Error("empty");
    const groups = snap.data().groups || [];
    const total = groups.reduce((s,g)=>s+g.remaining,0);
    if (!total) throw new Error("empty");
    let idx = cryptoRandInt(total);
    let gi = 0;
    for (; gi < groups.length; gi++){
      if (idx < groups[gi].remaining) break;
      idx -= groups[gi].remaining;
    }
    groups[gi] = { ...groups[gi], remaining: groups[gi].remaining - 1 };
    drawnValue = { value: groups[gi].value, perk: groups[gi].perk || "" };
    tx.update(bagRef, { groups });
    tx.set(chipRef, {
      owner: S.playerKey, ownerName: S.me.name, ownerEmail: S.me.email,
      value: drawnValue.value, perk: drawnValue.perk, gid: groups[gi].gid || null,
      bucket: null, drawnAt: serverTimestamp()
    });
  });
  return drawnValue;
}
$("#draw-again").addEventListener("click", runDraw);
$("#draw-done").addEventListener("click", () => $("#modal-draw").classList.add("hidden"));

// ---------- PRIZES ----------
function renderPrizesTab(){
  const el = $("#tab-prizes");
  if (S.view !== "prizes") return;
  const state = S.game?.state;
  const ps = prizesArr();
  if (!ps.length){ el.innerHTML = `<p class="muted" style="margin-top:20px">No prizes posted yet.</p>`; return; }
  const unallocated = myChips().filter(c=>!c.bucket).length;
  el.innerHTML = `
    ${state==="open" ? `<p class="muted small" style="margin:10px 0">You have <b>${unallocated}</b> unplaced chip${unallocated===1?"":"s"}. Every chip on a prize is one entry in that drawing — move them around any time until buckets lock.</p>` : ""}
    ${state==="locked" ? `<div class="banner info"><div class="grow">Buckets are <b>locked</b>. Watch for live drawings — the wheel pops up right here when one starts.</div></div>` : ""}
    ${ps.map(p => {
      const total = bucketCount(p.id), mine = myBucketCount(p.id);
      const wins = effWinners(p);
      const won = prizeDone(p);
      return `<div class="prize ${won?"won":""}">
        ${p.img ? `<img src="${p.img}" alt="${esc(p.name)}">` : ""}
        <div class="pad">
          <h3 style="margin:0">${esc(p.name)}</h3>
          ${p.desc ? `<p class="muted small" style="margin-top:4px">${esc(p.desc)}</p>` : ""}
          <div class="counts"><span><b class="num">${total}</b> chip${total===1?"":"s"} in</span>
            <span>yours: <b class="num">${mine}</b></span>
            ${numW(p)>1 ? `<span>winners: <b class="num">${wins.length}/${numW(p)}</b></span>` : ""}</div>
          ${wins.length ? `<div class="winline">${wins.map((w,i)=>`🏆 ${esc(w.name||"?")}${numW(p)>1?` <span class="muted small">(#${i+1})</span>`:""}`).join("<br>")}</div>` : ""}
          ${state==="open" ? `<div class="btnrow">
              <button class="btn mini primary" data-upd="${p.id}">Update chips${mine?` (${mine} here)`:""}</button>
            </div>` : ""}
        </div></div>`;
    }).join("")}`;
  el.querySelectorAll("[data-upd]").forEach(b => b.addEventListener("click", () => openUpdateSheet(b.dataset.upd)));
}

// ---------- place / move sheets ----------
let placeAction = null;
function openSheet(title, contentHTML, onConfirm){
  $("#place-title").textContent = title;
  $("#place-content").innerHTML = contentHTML;
  placeAction = onConfirm;
  $("#modal-place").classList.remove("hidden");
}
$("#place-cancel").addEventListener("click", () => $("#modal-place").classList.add("hidden"));
$("#place-confirm").addEventListener("click", async () => {
  if (placeAction){ try{ await placeAction(); }catch(e){ toast(e.message); } }
  $("#modal-place").classList.add("hidden");
});
function openUpdateSheet(pid){
  const p = S.prizes[pid]; if (!p) return;
  const mine = myChips();
  const onThis = mine.filter(c => c.bucket === pid).length;
  const unplaced = mine.filter(c => !c.bucket).length;
  const max = onThis + unplaced;
  openSheet(`${p.name}`, `
    <p class="small muted">You have <b>${mine.length}</b> chip${mine.length===1?"":"s"} total ·
      <b>${unplaced}</b> not placed. Chip type doesn't matter — every chip is one entry.</p>
    <div class="place-row"><div class="grow small">Your chips on this prize</div>
      <div class="stepper">
        <button type="button" id="upd-dec">−</button>
        <input id="upd-count" type="number" min="0" max="${max}" value="${onThis}">
        <button type="button" id="upd-inc">+</button>
      </div></div>
    <button type="button" class="btn mini" id="upd-all" style="margin-top:8px">Put all remaining here (${max} total)</button>`,
    async () => {
      let want = Math.round(Number($("#upd-count").value) || 0);
      want = Math.max(0, Math.min(max, want));
      const diff = want - onThis;
      if (!diff) return;
      const batch = writeBatch(db);
      if (diff > 0){
        mine.filter(c => !c.bucket).slice(0, diff).forEach(c =>
          batch.update(doc(db,"chips",c.id), { bucket: pid, movedAt: serverTimestamp() }));
      } else {
        mine.filter(c => c.bucket === pid).slice(0, -diff).forEach(c =>
          batch.update(doc(db,"chips",c.id), { bucket: null, movedAt: serverTimestamp() }));
      }
      await batch.commit();
      toast(`${p.name}: now ${want} of your chips`);
    });
  const inp = $("#upd-count");
  $("#upd-dec").addEventListener("click", () => inp.value = Math.max(0, Number(inp.value||0) - 1));
  $("#upd-inc").addEventListener("click", () => inp.value = Math.min(max, Number(inp.value||0) + 1));
  $("#upd-all").addEventListener("click", () => inp.value = max);
}

// ---------- LIVE tab ----------
function renderLiveTab(){
  const el = $("#tab-live");
  if (S.view !== "live") return;
  const ps = prizesArr();
  const rowsOut = [];
  ps.forEach(p => effWinners(p).forEach((w,i) =>
    rowsOut.push({ prize: p.name, tag: numW(p)>1 ? ` #${i+1}` : "", name: w.name, at: w.at||0 })));
  rowsOut.sort((a,b) => a.at - b.at);
  const totalSlots = ps.reduce((s2,p)=>s2+numW(p),0);
  const pendingSlots = totalSlots - rowsOut.length;
  el.innerHTML = `
    <div class="card center" style="margin-top:14px">
      <p class="eyebrow"><span class="livedot"></span> RAFFLE IS LIVE</p>
      <p class="small" style="margin-top:8px">Your color on the wheel:
        <span class="swatch" style="background:#BF5700"></span> burnt orange
        — your slices also get a gold ring.</p>
      <p class="muted small" style="margin-top:6px">Keep this open — the wheel pops up automatically when each drawing starts.</p>
    </div>
    <h2>Results (${rowsOut.length}/${totalSlots})</h2>
    <div class="card results">
      ${rowsOut.length ? rowsOut.map(r => `<div class="place-row">
          <div class="grow small"><b>${esc(r.prize)}${esc(r.tag)}</b></div>
          <div class="small">🏆 ${esc(r.name || "?")}</div></div>`).join("")
        : `<p class="muted small">No winners drawn yet.</p>`}
      ${pendingSlots ? `<p class="muted small" style="margin-top:8px">${pendingSlots} drawing${pendingSlots===1?"":"s"} still to run.</p>` : ""}
    </div>`;
}

// ============================================================
// LIVE DRAW WHEEL
// ============================================================
let wheelRAF = null;
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
function ownerHue(uid){
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
  // keep other players off burnt-orange hues (those are yours)
  return 45 + (h % 285);
}
function mulberry32(seed){
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Same seed on every phone -> same scattered wheel everywhere.
function seededShuffle(arr, seed){
  const a = [...arr], rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--){
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function handleLiveDraw(){
  const ld = S.liveDraw;
  const m = $("#modal-wheel");
  if (!ld || !ld.startedAtMs || ld.status === "cleared"){
    m.classList.add("hidden"); stopWheel(); S.wheelKey = null; return;
  }
  const key = ld.prizeId + "|" + ld.startedAtMs;
  if (S.wheelDismissed === key) return;
  const elapsed = Date.now() - ld.startedAtMs;
  // stale draw from long ago — don't pop it up
  if (ld.status === "done" && elapsed > (ld.durationMs||10000) + 120000) return;
  if (S.wheelKey !== key){
    S.wheelKey = key;
    m.classList.remove("hidden");
    startWheel(ld);
  }
  // safety net: finalize if the starting device dropped off
  if (S.isAdmin && ld.status === "spinning" && elapsed > (ld.durationMs||10000) + 5000)
    finalizeLive(ld);
}
function startWheel(ld){
  stopWheel();
  $("#wheel-prize").textContent = (ld.prizeName || "")
    + (ld.of > 1 ? ` — winner ${ld.round} of ${ld.of}` : "");
  $("#wheel-winner").classList.add("hidden");
  $("#wheel-winner").textContent = "";
  const base = bucketEntries(ld.prizeId).filter(c => !(ld.excluded || []).includes(c.id));
  const entries = seededShuffle(base, (ld.startedAtMs || 1) % 2147483647);
  const N = entries.length;
  const winIdx = entries.findIndex(c => c.id === ld.winnerChipId);
  const cv = $("#wheel"), ctx = cv.getContext("2d");
  const D = ld.durationMs || 10000;
  $("#wheel-status").textContent = `${N} chip${N===1?"":"s"} in — spinning…`;
  const myCount = entries.filter(c => c.owner === S.playerKey).length;
  $("#wheel-mycolor").innerHTML = myCount
    ? `Your color: <span class="swatch" style="background:#BF5700"></span> burnt orange
       — ${myCount} slice${myCount===1?"":"s"}, gold ring`
    : `<span class="muted">You have no chips on this prize.</span>`;
  if (!N || winIdx < 0){ showWheelResult(ld); return; }
  const slice = (Math.PI * 2) / N;
  // land the winning slice's center under the top pointer (-90°)
  const target = Math.PI * 2 * 6 + ((Math.PI * 2) - (winIdx + 0.5) * slice) - Math.PI / 2;
  const draw = angle => {
    const r = cv.width / 2;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.translate(r, r);
    ctx.rotate(angle);
    for (let i = 0; i < N; i++){
      const c = entries[i];
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r - 6, i * slice, (i + 1) * slice);
      ctx.closePath();
      ctx.fillStyle = c.owner === S.playerKey
        ? "#BF5700"
        : `hsl(${ownerHue(c.owner)},52%,60%)`;
      ctx.fill();
      if (c.owner === S.playerKey){
        ctx.lineWidth = 2; ctx.strokeStyle = "#FFC53D"; ctx.stroke();
      } else if (N <= 120){
        ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.stroke();
      }
    }
    ctx.restore();
    // hub
    ctx.beginPath(); ctx.arc(r, r, 26, 0, Math.PI * 2);
    ctx.fillStyle = "#201A16"; ctx.fill();
    ctx.fillStyle = "#FAF6F0";
    ctx.font = "700 13px 'Barlow Semi Condensed',sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(N), r, r);
  };
  const tick = () => {
    const p = Math.min(1, (Date.now() - ld.startedAtMs) / D);
    draw(target * easeOutCubic(p));
    if (p < 1){ wheelRAF = requestAnimationFrame(tick); }
    else { wheelRAF = null; showWheelResult(ld); }
  };
  tick();
}
function stopWheel(){ if (wheelRAF){ cancelAnimationFrame(wheelRAF); wheelRAF = null; } }
function showWheelResult(ld){
  $("#wheel-status").textContent = "Winning chip:";
  const w = $("#wheel-winner");
  w.textContent = "🏆 " + (ld.winnerName || "?");
  w.classList.remove("hidden");
}
$("#wheel-close").addEventListener("click", () => {
  S.wheelDismissed = S.wheelKey;
  $("#modal-wheel").classList.add("hidden");
  stopWheel();
});
async function startLiveDraw(pid){
  const p = S.prizes[pid]; if (!p || prizeDone(p)) return;
  const entries = eligibleEntries(pid, p);
  if (!entries.length){
    toast(p.uniqueWinners && bucketCount(pid)
      ? "No eligible chips left — everyone remaining already won this prize."
      : "No chips in that bucket.");
    return;
  }
  const win = entries[cryptoRandInt(entries.length)];
  const excluded = bucketEntries(pid).filter(c => !entries.some(e => e.id === c.id)).map(c => c.id);
  const D = 10000;
  await setDoc(doc(db,"config","liveDraw"), {
    prizeId: pid, prizeName: p.name,
    winnerChipId: win.id, winnerName: win.ownerName,
    round: effWinners(p).length + 1, of: numW(p), excluded,
    startedAtMs: Date.now(), durationMs: D, status: "spinning"
  });
  audit("live-draw", `${p.name} — wheel started (round ${effWinners(p).length + 1}/${numW(p)}, ${entries.length} eligible)`);
  setTimeout(() => finalizeLive({ prizeId: pid, winnerChipId: win.id,
    winnerName: win.ownerName, winnerEmail: win.ownerEmail, winnerValue: win.value }), D + 600);
}
async function finalizeLive(ld){
  try{
    const p = S.prizes[ld.prizeId];
    if (p && !effWinners(p).some(w => w.chipId === ld.winnerChipId) && !prizeDone(p)){
      const chip = S.chips[ld.winnerChipId] || {};
      const winners = [...effWinners(p), {
        chipId: ld.winnerChipId, owner: chip.owner || "",
        name: ld.winnerName || chip.ownerName || "?",
        email: ld.winnerEmail || chip.ownerEmail || "",
        value: ld.winnerValue ?? chip.value ?? 0, at: Date.now() }];
      await updateDoc(doc(db,"prizes",ld.prizeId), {
        winners,
        winnerChipId: ld.winnerChipId,
        winnerName: ld.winnerName || chip.ownerName || "?",
        winnerEmail: ld.winnerEmail || chip.ownerEmail || "",
        winnerValue: ld.winnerValue ?? chip.value ?? 0,
        drawnAt: serverTimestamp()
      });
      audit("winner", `${p.name} → ${ld.winnerName || chip.ownerName} (live wheel, winner ${winners.length}/${numW(p)})`);
    }
    await updateDoc(doc(db,"config","liveDraw"), { status: "done" }).catch(()=>{});
  }catch(e){ toast("Finalize failed: " + (e.code || e.message)); }
}

// ---------- ADMIN PANEL ----------
function adminEditing(){
  const a = document.activeElement;
  return a && $("#panel-admin")?.contains(a) &&
    ["INPUT","SELECT","TEXTAREA"].includes(a.tagName);
}
function renderAdminPanel(force){
  const el = $("#panel-admin");
  if (!force && (adminEditing() || S.adminDirty)) return;
  const g = S.game || {};
  const groups = [...(S.bag?.groups||[])];
  const ps = prizesArr();
  const state = g.state || "setup";
  const totChips = groups.reduce((s,x)=>s+x.total,0);
  const totVal = groups.reduce((s,x)=>s+x.total*x.value,0);
  const unallocAll = chipsArr().filter(c=>!c.bucket).length;
  const allDrawn = ps.length && ps.every(p=>prizeDone(p));

  const raffleLive = !!g.raffleLive;
  const dashDrawn = chipsArr().length;
  const dashRemaining = groups.reduce((s2,x)=>s2+x.remaining,0);
  const dashDrawnVal = chipsArr().reduce((s2,c)=>s2+c.value,0);
  const dashPaid = Object.values(S.players).reduce((s2,p)=>s2+(p.paid||0),0);
  const dashboard = `
    <div class="dash">
      <div class="tile"><b class="num">${dashDrawn}</b><span>Chips drawn</span></div>
      <div class="tile"><b class="num">${dashRemaining}</b><span>Chips remaining</span></div>
      <div class="tile"><b class="num">${money(dashDrawnVal)}</b><span>Drawn value</span></div>
      <div class="tile"><b class="num ${dashPaid>=dashDrawnVal-0.005?"okfig":"owefig"}">${money(dashPaid)}</b><span>Paid so far</span></div>
    </div>`;
  const drawingSection = `
    <h2>Drawings</h2>
    ${state!=="locked" && state!=="complete"
      ? `<p class="muted small">Lock buckets first — drawings run after the lock.</p>`
      : (!raffleLive ? `<div class="card center">
          <button class="btn primary block" data-act="startraffle">🔴 Start raffle</button>
          <p class="muted small" style="margin-top:8px">Resolves any unplaced chips (you'll see who), then opens the Live tab on every player's phone. Wheels can spin after this.</p>
        </div>` : `<div class="banner win"><div class="grow">🔴 <b>Raffle is live.</b> Run each prize below — everyone sees the wheel.</div></div>`)
      + ps.map(p=>{
          const wins = effWinners(p), nw = numW(p), done = prizeDone(p);
          const winsHtml = wins.length
            ? `<p class="small" style="color:var(--orange-deep);font-weight:700;margin-top:6px">${wins.map((w,i)=>`🏆 ${esc(w.name||"?")}${nw>1?` <span class="muted">(#${i+1})</span>`:""}`).join("<br>")}</p>` : "";
          return `<div class="card">
          <div class="row spread"><b>${esc(p.name)}${nw>1?` <span class="muted small num">(${wins.length}/${nw} drawn)</span>`:""}</b>
            <span class="muted small num">${bucketCount(p.id)} chips</span></div>
          ${winsHtml}
          ${done ? "" : `<div class="row gap">
                <button class="btn mini gold" data-livedraw="${p.id}" ${raffleLive?"":"disabled"}>🎡 Live wheel${nw>1?` — winner ${wins.length+1} of ${nw}`:" draw"}</button>
                <button class="btn mini" data-drawwin="${p.id}">Quick draw</button>
              </div>`}
        </div>`;}).join("")}
    <p class="muted small" style="margin:4px 0 8px">Live wheel: everyone with the site open sees the same 10-second spin on their phone, then the winner. Quick draw records instantly with no show.</p>`;

  const paymentsSection = `
    <h2>Payments</h2>
    <div class="card" style="overflow-x:auto">
      <table><thead><tr><th>Player</th><th>Chips</th><th>Owed</th><th>Paid</th><th>Bal</th><th></th></tr></thead>
      <tbody>${Object.entries(S.players).map(([u,pl])=>{
        const o = owedBy(u), bal = o - (pl.paid||0);
        return `<tr>
          <td>${esc(pl.name)}<br><span class="muted small">${esc(pl.email)}</span></td>
          <td class="num">${chipsArr().filter(c=>c.owner===u).length}</td>
          <td class="num">${money(o)}</td>
          <td class="num">${money(pl.paid||0)}</td>
          <td class="num ${bal>0.005?"owefig":"okfig"}">${money(bal)}</td>
          <td><button class="btn mini" data-logpay="${u}">Log payment</button>
              <button class="btn mini danger" data-release="${u}">Release chips</button></td>
        </tr>`;}).join("")}</tbody></table>
    </div>
    <div class="card">
      <h3>Payment log</h3>
      <div class="row gap" style="margin-top:0;flex-wrap:wrap">
        <button class="btn mini" data-act="loadpaylog">Load payment log</button>
        <button class="btn mini" data-act="dlpaylog">⬇ Download pay log CSV</button>
      </div>
      <div id="paylog-out" style="margin-top:10px"></div>
    </div>`;

  const footer = `
    <p class="muted small" style="margin:8px 0 4px">Signed in as ${esc(S.email)}
      (${S.isPower ? "power admin" : "payment admin"}) ·
      <button class="btn mini ghost" data-act="signout">Sign out</button></p>
    <p class="muted small" style="margin:0 0 30px">If you're playing too, draw your chips while signed in with Google so they stay tied to this account.<br>
      <span style="opacity:.7">Build ${BUILD}</span></p>`;

  if (!S.isPower){
    // payment admins: drawings + payments only
    el.innerHTML = dashboard
      + `<h2>Game state: <span style="color:var(--orange)">${state.toUpperCase()}</span></h2>`
      + drawingSection + paymentsSection + footer;
    wireAdmin(el);
    return;
  }

  el.innerHTML = dashboard + `
    <h2>Game state: <span style="color:var(--orange)">${state.toUpperCase()}</span></h2>
    <div class="card">
      <p class="muted small" style="margin-bottom:10px">Flow: <b>SETUP</b> (build bag + prizes) → <b>OPEN</b> (drawing &amp; placing) → <b>LOCKED</b> (run drawings) → <b>COMPLETE</b>. Buttons below move to the <i>next</i> step.</p>
      ${state==="setup" ? `<button class="btn primary block" data-act="open">▶ Open the game (start drawing)</button>` : ""}
      ${state==="open" ? `<button class="btn primary block" data-act="lock">🔒 Lock buckets (end placing)</button>
        <p class="muted small" style="margin-top:8px">${unallocAll} unplaced chip${unallocAll===1?"":"s"} across all players.
        Rule on lock: <b>${g.unassignedRule==="warn" ? "warn me (blocks lock)" : "auto-move to " + esc(S.prizes[g.unassignedRule]?.name || "?")}</b></p>` : ""}
      ${state==="locked" ? `
        <button class="btn block" data-act="reopen">↩ Reopen (undo lock)</button>
        ${allDrawn ? `<button class="btn gold block" style="margin-top:8px" data-act="complete">🏁 Mark game complete</button>` : ""}` : ""}
      ${state==="complete" ? `<p class="muted">Game complete. 🏁 Archive it below, then clear for the next run.</p>` : ""}
    </div>

    <h2>Settings</h2>
    <div class="card">
      <label>Game title<input id="set-title" value="${esc(g.title||"")}"></label>
      <label>Unpaid limit — block draws once a player owes this much ($0 = off)
        <input id="set-cap" type="number" min="0" step="1" value="${g.unpaidCap||0}"></label>
      <h3 style="margin-top:14px">Venmo collectors</h3>
      <p class="muted small" style="margin-bottom:8px">Name · Venmo handle (no @) · note on who should pay them. Players see one Pay button per row, preloaded with their balance.</p>
      <div id="vm-rows">
        ${venmoList().map(v=>`<div class="bb-row vm-row">
          <input class="vm-label" placeholder="Name" value="${esc(v.label||"")}" style="max-width:90px">
          <input class="vm-handle" placeholder="venmo-handle" value="${esc(v.handle||"")}" style="max-width:150px">
          <input class="vm-note" placeholder="who pays them (note)" value="${esc(v.note||"")}">
          <button class="btn mini danger vm-del">✕</button>
        </div>`).join("")}
      </div>
      <button class="btn mini" id="vm-add" type="button">+ Add collector</button>
      <label>Unplaced chips when locking
        <select id="set-rule">
          <option value="warn" ${g.unassignedRule==="warn"?"selected":""}>Warn me and block the lock</option>
          ${ps.length
            ? ps.map(p=>`<option value="${p.id}" ${g.unassignedRule===p.id?"selected":""}>Auto-move to: ${esc(p.name)}</option>`).join("")
            : `<option disabled>(add prizes below — each becomes an auto-move option)</option>`}
        </select></label>
      <p class="muted small" style="margin-top:-6px;margin-bottom:10px">This decides what happens to chips nobody placed when you hit Lock: either the lock is blocked so you can chase people down, or the chips auto-move into the prize you pick here. Add prizes and they'll show up as options.</p>
      <button class="btn block" data-act="savesettings">Save settings</button>
    </div>

    <h2>The bag</h2>
    <div class="card" id="bag-builder">
      <p class="muted small" style="margin-bottom:10px">One row per denomination. You can add chips mid-game; you can't cut a denomination below what's already been drawn. <b>Perk</b> is optional (e.g. Mulligan, String extension) — if set, players see it when they pull that chip.</p>
      ${groups.map((x,i)=>{
        const d = drawnFor(groups, i);
        return `<div class="bb-row" data-i="${i}" data-gid="${esc(x.gid||"")}">
          <input type="number" class="bb-val num" min="1" step="1" value="${x.value}" placeholder="$" ${d? "disabled":""}>
          <span class="muted">×</span>
          <input type="number" class="bb-count num" min="${d}" step="1" value="${x.total}" placeholder="#">
          <input class="bb-perk" value="${esc(x.perk||"")}" placeholder="perk (optional)" style="max-width:150px">
          <span class="muted small num">${d} drawn</span>
          <button class="btn mini danger bb-del" ${d? "disabled":""}>✕</button>
        </div>`;}).join("")}
      <button class="btn mini" id="bb-add">+ Add denomination</button>
      <div class="bb-total row spread"><span>Pool</span>
        <b class="num">${totChips} chips · ${money(totVal)}</b></div>
      <button class="btn primary block" style="margin-top:10px" data-act="savebag">Save bag</button>
    </div>

    <h2>Prizes (${ps.length}/30)</h2>
    ${ps.map(p=>{
      const wins = effWinners(p);
      return `<div class="card">
      <div class="row spread"><b>${esc(p.name)}</b>
        <span class="muted small num">${bucketCount(p.id)} chips</span></div>
      <div class="row gap" style="margin-top:8px;flex-wrap:wrap">
        <label style="margin:0;max-width:120px" class="small">Winners
          <input type="number" class="pz-nw num" data-p="${p.id}" min="${Math.max(1,wins.length)}" max="30" value="${numW(p)}"></label>
        <label style="margin:0;font-weight:600" class="small"><input type="checkbox" class="pz-unique" data-p="${p.id}" ${p.uniqueWinners?"checked":""} style="width:auto;margin-right:6px">No repeats</label>
        <button class="btn mini" data-pzsave="${p.id}">Save</button>
      </div>
      ${wins.length ? `<p class="small" style="color:var(--orange-deep);font-weight:700;margin-top:6px">${wins.map((w,i)=>`🏆 ${esc(w.name||"?")}${numW(p)>1?` <span class="muted">(#${i+1})</span>`:""}`).join("<br>")}</p>` : ""}
      ${state!=="complete" && !wins.length ? `<button class="btn mini danger" style="margin-top:8px" data-delprize="${p.id}">Remove prize</button>` : ""}
    </div>`;}).join("")}
    ${ps.length < 30 ? `
    <div class="card">
      <h3>Add a prize</h3>
      <label>Name<input id="np-name" maxlength="60"></label>
      <label>Description<textarea id="np-desc" rows="2" maxlength="240"></textarea></label>
      <label>Image (optional)<input id="np-img" type="file" accept="image/*"></label>
      <div class="row gap" style="margin-top:0">
        <label style="margin:0;max-width:170px">Number of winners
          <input id="np-nw" type="number" min="1" max="30" value="1"></label>
        <label style="margin:0;font-weight:600"><input id="np-unique" type="checkbox" style="width:auto;margin-right:6px">No repeat winners</label>
      </div>
      <p class="muted small" style="margin:6px 0 10px">More than 1 winner = one bucket, multiple drawings (e.g. "Raffle prizes", drawn 3×). "No repeat winners" means once someone wins this prize, their other chips are skipped on redraws.</p>
      <button class="btn block" data-act="addprize">Add prize</button>
    </div>` : ""}

    ${drawingSection}
    ${paymentsSection}

    <h2>Share the game</h2>
    <div class="card center">
      <img src="qr.png" alt="QR code" style="width:190px;max-width:60vw" onerror="this.closest('div').querySelector('.qrmiss').classList.remove('hidden');this.remove()">
      <p class="muted small qrmiss hidden">Upload qr.png to the repo to show the code here.</p>
      <p class="small" style="margin-top:8px;word-break:break-all">https://roberthlawrence.github.io/Fourth-and-Cold-Chips/</p>
      <p class="muted small">Print the QR (it's in the repo as qr.png / qr-print.png) — players scan it, enter their email, and they're in.</p>
    </div>

    <h2>Admins</h2>
    <div class="card">
      <p class="muted small" style="margin-bottom:10px">Signed in as <b>${esc(S.email)}</b>
        <button class="btn mini" data-act="copyemail">Copy</button> ·
        <button class="btn mini" data-act="permcheck">Run permissions check</button></p>
      <div id="perm-out"></div>
      <h3 style="margin-top:8px">Power admins</h3>
      <p class="muted small">Full control. Baked-in from firebase-config.js: ${POWER.map(esc).join(", ") || "(none)"}</p>
      ${S.admins.power.map(e=>`<div class="place-row"><div class="grow small">${esc(e)}</div>
        <button class="btn mini danger" data-rmadmin="power|${esc(e)}">✕</button></div>`).join("")}
      <div class="row gap" style="margin-top:8px">
        <input id="add-power" type="email" placeholder="name@gmail.com" style="flex:1">
        <button class="btn mini" data-act="addpower">Add</button>
      </div>
      <h3 style="margin-top:16px">Payment admins</h3>
      <p class="muted small">Payments + running drawings only. Baked-in: ${PAY.map(esc).join(", ") || "(none)"}</p>
      ${S.admins.payment.map(e=>`<div class="place-row"><div class="grow small">${esc(e)}</div>
        <button class="btn mini danger" data-rmadmin="payment|${esc(e)}">✕</button></div>`).join("")}
      <div class="row gap" style="margin-top:8px">
        <input id="add-payment" type="email" placeholder="name@gmail.com" style="flex:1">
        <button class="btn mini" data-act="addpayment">Add</button>
      </div>
      <p class="muted small" style="margin-top:10px">Adds take effect immediately — the new admin just signs in with that Google account via the Admin button.</p>
    </div>

    <h2>History &amp; archives</h2>
    <div class="card">
      <button class="btn mini" data-act="loadaudit">Load audit trail</button>
      <div id="audit-out" style="margin-top:10px"></div>
    </div>
    <div class="card">
      <p class="muted small" style="margin-bottom:10px">Backups save everything — game, bag, players, chips, prizes — as JSON (full restore) + CSV (readable). Cloud archives are stored in Firestore with prize photos stripped to fit.</p>
      <div class="row gap" style="flex-wrap:wrap;margin-top:0">
        <button class="btn mini" data-act="backup">⬇ Download backup (JSON + CSV)</button>
        <button class="btn mini" data-act="cloudarchive">☁ Save archive to cloud</button>
        <button class="btn mini" data-act="listarchives">List cloud archives</button>
      </div>
      <div id="archive-out" style="margin-top:10px"></div>
      <div class="divider"></div>
      <label>Restore from a backup JSON file
        <input id="restore-file" type="file" accept=".json,application/json"></label>
      <button class="btn mini" data-act="restore">Restore from file</button>
      <div class="divider"></div>
      <button class="btn danger block" data-act="cleargame">🏈 New season reset — archive &amp; clear everything</button>
    </div>
    ${footer}
  `;
  wireAdmin(el);
}
function wireAdmin(el){
  el.querySelectorAll("input,select,textarea").forEach(i =>
    i.addEventListener("input", () => { S.adminDirty = true; }));
  const KEEP_VIEW = ["loadaudit","loadpaylog","listarchives","permcheck","copyemail","csv","dlpaylog","backup"];
  el.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", async () => {
    try{ await adminAct(b.dataset.act); }
    catch(e){ toast((e.code === "permission-denied"
      ? "Permission denied — is your email in the firestore.rules list? "
      : "") + (e.code || e.message)); }
    if (!KEEP_VIEW.includes(b.dataset.act)){
      S.adminDirty = false; renderAdminPanel(true);
    }
  }));
  el.querySelectorAll("[data-delprize]").forEach(b => b.addEventListener("click", () => removePrize(b.dataset.delprize)));
  el.querySelectorAll("[data-pzsave]").forEach(b => b.addEventListener("click", async () => {
    const pid = b.dataset.pzsave;
    const nw = Math.max(1, Math.min(30, Number(el.querySelector(`.pz-nw[data-p="${pid}"]`)?.value) || 1));
    const uq = !!el.querySelector(`.pz-unique[data-p="${pid}"]`)?.checked;
    try{
      await updateDoc(doc(db,"prizes",pid), { numWinners: nw, uniqueWinners: uq });
      audit("prize", `${S.prizes[pid]?.name}: winners=${nw}, noRepeats=${uq}`);
      toast("Prize updated");
      S.adminDirty = false; renderAdminPanel(true);
    }catch(e){ toast(e.code || e.message); }
  }));
  el.querySelectorAll("[data-rmadmin]").forEach(b => b.addEventListener("click", async () => {
    const [tier, email] = b.dataset.rmadmin.split("|");
    try{
      const list = S.admins[tier].filter(e => e !== email);
      await updateDoc(doc(db,"config","admins"), { [tier]: list });
      audit("admins", `removed ${email} from ${tier}`);
      S.adminDirty = false; renderAdminPanel(true);
    }catch(e){ toast(e.code || e.message); }
  }));
  el.querySelectorAll("[data-drawwin]").forEach(b => b.addEventListener("click",
    () => drawWinner(b.dataset.drawwin).catch(e=>toast(e.code||e.message))));
  el.querySelectorAll("[data-livedraw]").forEach(b => b.addEventListener("click",
    () => startLiveDraw(b.dataset.livedraw).catch(e=>toast(e.code||e.message))));
  el.querySelectorAll("[data-logpay]").forEach(b => b.addEventListener("click", () => openLogPayment(b.dataset.logpay)));
  el.querySelectorAll("[data-release]").forEach(b => b.addEventListener("click",
    () => releaseChips(b.dataset.release).catch(e=>toast(e.code||e.message))));
  $("#vm-add")?.addEventListener("click", () => {
    S.adminDirty = true;
    const holder = $("#vm-rows");
    const row = document.createElement("div");
    row.className = "bb-row vm-row";
    row.innerHTML = `<input class="vm-label" placeholder="Name" style="max-width:90px">
      <input class="vm-handle" placeholder="venmo-handle" style="max-width:150px">
      <input class="vm-note" placeholder="who pays them (note)">
      <button class="btn mini danger vm-del">✕</button>`;
    holder.appendChild(row);
    row.querySelectorAll("input").forEach(i => i.addEventListener("input", () => { S.adminDirty = true; }));
    row.querySelector(".vm-del").addEventListener("click", () => row.remove());
  });
  el.querySelectorAll(".vm-del").forEach(b =>
    b.addEventListener("click", () => { S.adminDirty = true; b.closest(".vm-row").remove(); }));
  $("#bb-add")?.addEventListener("click", () => {
    S.adminDirty = true;
    const holder = $("#bag-builder");
    const row = document.createElement("div");
    row.className = "bb-row";
    row.innerHTML = `<input type="number" class="bb-val num" min="1" step="1" placeholder="$">
      <span class="muted">×</span>
      <input type="number" class="bb-count num" min="0" step="1" placeholder="#">
      <input class="bb-perk" placeholder="perk (optional)" style="max-width:150px">
      <span class="muted small num">0 drawn</span>
      <button class="btn mini danger bb-del">✕</button>`;
    holder.insertBefore(row, $("#bb-add"));
    row.querySelector("input").addEventListener("input", () => { S.adminDirty = true; });
    row.querySelector(".bb-del").addEventListener("click", () => row.remove());
  });
  el.querySelectorAll(".bb-del:not([disabled])").forEach(b =>
    b.addEventListener("click", () => { S.adminDirty = true; b.closest(".bb-row").remove(); }));
}

async function adminAct(act){
  const gRef = doc(db,"config","game");
  if (act === "savesettings"){
    const vms = $$(".vm-row").map(r => ({
      label: r.querySelector(".vm-label").value.trim(),
      handle: r.querySelector(".vm-handle").value.trim().replace(/^@/,""),
      note: r.querySelector(".vm-note").value.trim()
    })).filter(v => v.label && v.handle);
    await updateDoc(gRef, {
      title: $("#set-title").value.trim() || "Chip Draw Raffle",
      unpaidCap: Number($("#set-cap").value) || 0,
      unassignedRule: $("#set-rule").value,
      venmoList: vms
    });
    toast("Settings saved"); audit("settings","updated");
  }
  if (act === "savebag"){
    const rows = $$("#bag-builder .bb-row");
    const groups = [];
    for (const r of rows){
      const value = Number(r.querySelector(".bb-val").value);
      const total = Number(r.querySelector(".bb-count").value);
      if (!value || value < 1 || total < 0 || !Number.isFinite(total)) continue;
      groups.push({
        gid: r.dataset.gid || ("g" + Date.now().toString(36) + Math.random().toString(36).slice(2,7)),
        value, total, remaining: 0,
        perk: (r.querySelector(".bb-perk")?.value || "").trim()
      });
    }
    for (let i = 0; i < groups.length; i++){
      const g = groups[i], drawn = drawnFor(groups, i);
      if (g.total < drawn){
        toast(`$${g.value}${g.perk?` (${g.perk})`:""}: can't set below ${drawn} already drawn.`);
        return;
      }
      g.remaining = g.total - drawn;
    }
    // rows with drawn chips can't be deleted
    for (const gid of new Set(chipsArr().map(c=>c.gid).filter(Boolean))){
      if (!groups.some(g => g.gid === gid)){
        toast("A row with drawn chips can't be removed."); return;
      }
    }
    for (const v of new Set(chipsArr().filter(c=>!c.gid).map(c=>c.value))){
      if (!groups.some(g => g.value === v)){
        toast(`$${v} chips have been drawn — keep a $${v} row.`); return;
      }
    }
    // soft heads-up: identical rows (same price AND same perk) are probably a typo
    const tally = {};
    groups.forEach(g => {
      const k = g.value + "|" + (g.perk || "").toLowerCase();
      tally[k] = (tally[k] || 0) + 1;
    });
    const dupes = Object.entries(tally).filter(([,n]) => n > 1)
      .map(([k,n]) => {
        const [v, pk] = k.split("|");
        return `${n} rows of $${v}${pk ? " (" + esc(pk) + ")" : ""}`;
      });
    if (dupes.length){
      const ok = await confirmDialog("Heads up — identical rows",
        `<p class="small">The bag has ${dupes.join(" and ")}. Different perks at the same price are fine, but identical rows are usually a typo — the chips would all look the same.</p>
         <p class="muted small">Save anyway, or cancel and combine them.</p>`,
        "Save anyway");
      if (!ok) return;
    }
    await setDoc(doc(db,"config","bag"), { groups });
    toast("Bag saved");
    audit("bag", groups.map(g=>`${g.total}x$${g.value}${g.perk?"("+g.perk+")":""}`).join(", "));
  }
  if (act === "open"){
    if (!(S.bag?.groups||[]).length){ toast("Fill the bag first."); return; }
    await updateDoc(gRef, { state:"open" });
    toast("Game is OPEN — players can draw"); audit("state","open");
  }
  if (act === "lock") await lockGame();
  if (act === "reopen"){
    const ok = await confirmDialog("Reopen the game?", "Players will be able to draw and move chips again.");
    if (ok){ await updateDoc(gRef, { state:"open" }); audit("state","reopened"); }
  }
  if (act === "complete"){ await updateDoc(gRef, { state:"complete", raffleLive:false }); audit("state","complete"); }
  if (act === "addprize") await addPrize();
  if (act === "csv") downloadCSV();
  if (act === "startraffle") await startRaffle();
  if (act === "loadpaylog") await loadPayLog();
  if (act === "dlpaylog") await downloadPayLog();
  if (act === "signout"){ await signOut(auth); location.reload(); }
  if (act === "loadaudit") await loadAudit();
  if (act === "backup") downloadBackup();
  if (act === "cloudarchive") await cloudArchive();
  if (act === "listarchives") await listArchives();
  if (act === "restore") await restoreFromFile();
  if (act === "cleargame") await clearGame();
  if (act === "addpower" || act === "addpayment"){
    const tier = act === "addpower" ? "power" : "payment";
    const inp = $(act === "addpower" ? "#add-power" : "#add-payment");
    const email = inp.value.trim().toLowerCase();
    if (!email || !email.includes("@")){ toast("Enter a valid email."); return; }
    await setDoc(doc(db,"config","admins"), {
      power: tier==="power" ? [...new Set([...S.admins.power, email])] : S.admins.power,
      payment: tier==="payment" ? [...new Set([...S.admins.payment, email])] : S.admins.payment
    });
    audit("admins", `added ${email} as ${tier} admin`);
    toast(`${email} added as ${tier} admin`);
  }
  if (act === "copyemail"){
    try{ await navigator.clipboard.writeText(S.email || ""); toast("Email copied — paste it into firestore.rules"); }
    catch{ toast(S.email || ""); }
  }
  if (act === "permcheck") await permCheck();
}

async function permCheck(){
  const out = $("#perm-out");
  const results = [];
  const tryIt = async (label, fn) => {
    try{ await fn(); results.push(`✅ ${label}`); }
    catch(e){ results.push(`❌ ${label} — ${e.code || e.message}`); }
    out.innerHTML = results.map(r=>`<p class="small" style="margin:2px 0">${r}</p>`).join("");
  };
  out.innerHTML = `<p class="muted small">Testing as ${esc(S.email || "(not signed in with Google!)")}…</p>`;
  await tryIt("Write game settings (power)", () =>
    updateDoc(doc(db,"config","game"), { permCheck: serverTimestamp() }));
  let testRef = null;
  await tryIt("Create a prize (power)", async () => {
    testRef = await addDoc(collection(db,"prizes"), { name:"__permtest__", desc:"", img:"",
      order: 0, winnerChipId: null, createdAt: serverTimestamp() });
  });
  if (testRef) await tryIt("Delete the test prize (power)", () => deleteDoc(testRef));
  await tryIt("Write live-draw doc (power or payment)", () =>
    setDoc(doc(db,"config","liveDraw"), { status:"cleared" }));
  results.push(`<span class="muted">Any ❌ with permission-denied means this exact email isn't in the matching list inside <b>firestore.rules</b> in the Firebase console (and that you pasted rules into the CHIP-DRAW project, not fourth-and-cold). Copy the email above, fix the list, Publish, re-test.</span>`);
  out.innerHTML = results.map(r=>`<p class="small" style="margin:2px 0">${r}</p>`).join("");
}

async function lockGame(){
  const un = chipsArr().filter(c=>!c.bucket).length;
  const flag = anyUnpaid();
  await updateDoc(doc(db,"config","game"), { state:"locked", unpaidAtLock: flag });
  audit("state", "locked" + (flag ? " (unpaid balances outstanding — still valid entries)" : ""));
  toast("Buckets locked" + (un ? ` — ${un} unplaced chip${un===1?"":"s"} will be resolved at Start Raffle` : ""));
}

// Start Raffle: resolve unplaced chips (with the roster shown), then go live
async function startRaffle(){
  const un = chipsArr().filter(c => !c.bucket);
  if (un.length){
    const byOwner = {};
    un.forEach(c => {
      byOwner[c.owner] = byOwner[c.owner] || { name:c.ownerName, email:c.ownerEmail, n:0 };
      byOwner[c.owner].n++;
    });
    const roster = Object.values(byOwner)
      .map(o => `${esc(o.name)} &lt;${esc(o.email)}&gt; — ${o.n} chip${o.n===1?"":"s"}`).join("<br>");
    const rule = S.game?.unassignedRule;
    const opts = prizesArr().filter(p=>!p.winnerChipId).map(p =>
      `<option value="${p.id}" ${p.id===rule?"selected":""}>${esc(p.name)}</option>`).join("");
    const ok = await confirmDialog("Unplaced chips",
      `<p class="small"><b>${un.length}</b> chip${un.length===1?"":"s"} never got placed:</p>
       <p class="small">${roster}</p>
       <label style="margin-top:10px">Move them all into
         <select id="raffle-dest">${opts}</select></label>
       <p class="muted small">Proceed moves the chips and starts the live raffle.</p>`,
      "Move chips & start");
    if (!ok) return;
    const dest = $("#raffle-dest")?.value;
    if (!dest || !S.prizes[dest]){ toast("Pick a destination prize."); return; }
    const batch = writeBatch(db);
    un.forEach(c => batch.update(doc(db,"chips",c.id), { bucket: dest, movedAt: serverTimestamp() }));
    await batch.commit();
    audit("raffle", `moved ${un.length} unplaced chips to ${S.prizes[dest].name} at raffle start`);
  }
  await updateDoc(doc(db,"config","game"), { raffleLive: true });
  audit("raffle", "raffle started — live tab open for all players");
  toast("🔴 Raffle is live — players now have the Live tab");
}

function readImage(file){
  return new Promise((res, rej) => {
    if (!file) return res("");
    const img = new Image();
    img.onload = () => {
      const max = 900;
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width*sc); cv.height = Math.round(img.height*sc);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      let out = cv.toDataURL("image/jpeg", .8);
      if (out.length > 700000) out = cv.toDataURL("image/jpeg", .55);
      if (out.length > 900000) return rej(new Error("Image too large — try a smaller photo."));
      res(out);
    };
    img.onerror = () => rej(new Error("Couldn't read that image."));
    img.src = URL.createObjectURL(file);
  });
}
async function addPrize(){
  const name = $("#np-name").value.trim();
  if (!name){ toast("Prize needs a name."); return; }
  if (prizesArr().length >= 30){ toast("Max 30 prizes."); return; }
  const img = await readImage($("#np-img").files[0]);
  await addDoc(collection(db,"prizes"), {
    name, desc: $("#np-desc").value.trim(), img,
    order: Date.now(), winnerChipId: null, createdAt: serverTimestamp()
  });
  audit("prize", `added: ${name}`); toast("Prize added");
}
async function removePrize(pid){
  const p = S.prizes[pid]; if (!p) return;
  const affected = chipsArr().filter(c => c.bucket === pid);
  const byOwner = {};
  affected.forEach(c => {
    byOwner[c.owner] = byOwner[c.owner] || { name:c.ownerName, email:c.ownerEmail, chips:0 };
    byOwner[c.owner].chips++;
  });
  const ok = await confirmDialog(`Remove "${p.name}"?`,
    `<p class="small">${affected.length} chip${affected.length===1?"":"s"} in this bucket will go back to their owners as unplaced. Owners get a notice at next login, and you'll get their emails to follow up.</p>`);
  if (!ok) return;
  try{
    const batch = writeBatch(db);
    affected.forEach(c => batch.update(doc(db,"chips",c.id), { bucket:null, movedAt: serverTimestamp() }));
    Object.entries(byOwner).forEach(([uid, info]) => {
      batch.update(doc(db,"players",uid), { notices: arrayUnion({
        id: "pr-" + pid + "-" + Date.now(),
        msg: `The prize "${p.name}" was removed. ${info.chips} of your chip${info.chips>1?"s":""} went back to your unplaced stack — put them on another prize.`,
        at: Date.now()
      })});
    });
    batch.delete(doc(db,"prizes",pid));
    await batch.commit();
    if (affected.length){
      await addDoc(collection(db,"adminAlerts"), {
        type:"prizeRemoved", prizeName: p.name,
        impacted: Object.values(byOwner), at: serverTimestamp(), resolved:false
      });
    }
    audit("prize", `removed: ${p.name} (${affected.length} chips returned)`);
    toast("Prize removed");
  }catch(e){ toast(e.code || e.message); }
}
async function drawWinner(pid, quiet){
  const p = S.prizes[pid]; if (!p || prizeDone(p)) return;
  const entries = eligibleEntries(pid, p);
  if (!entries.length){
    if(!quiet) toast(p.uniqueWinners && bucketCount(pid)
      ? "No eligible chips left — everyone remaining already won this prize."
      : "No chips in that bucket.");
    return;
  }
  const win = entries[cryptoRandInt(entries.length)];
  const winners = [...effWinners(p), { chipId: win.id, owner: win.owner,
    name: win.ownerName, email: win.ownerEmail, value: win.value, at: Date.now() }];
  await updateDoc(doc(db,"prizes",pid), {
    winners,
    winnerChipId: win.id, winnerName: win.ownerName,
    winnerEmail: win.ownerEmail, winnerValue: win.value, drawnAt: serverTimestamp()
  });
  audit("winner", `${p.name} → ${win.ownerName} (winner ${winners.length}/${numW(p)}, ${entries.length} eligible, quick draw)`);
  if (!quiet) toast(`🏆 ${win.ownerName} wins ${p.name}!`);
}

// ---------- payments: log / unpay / release ----------
function openLogPayment(key){
  const pl = S.players[key]; if (!pl) return;
  const bal = Math.max(0, balanceOf(key));
  const opts = venmoList().map(v => `<option>${esc(v.label)}</option>`).join("")
    + `<option>Cash / Other</option>`;
  openSheet(`Log payment — ${pl.name}`, `
    <p class="small muted">${esc(pl.name)} &lt;${esc(pl.email)}&gt; · balance ${money(bal)}</p>
    <label>Amount paid<input id="pay-amt" type="number" min="0.01" step="0.01" value="${bal.toFixed(2)}"></label>
    <label>Paid to<select id="pay-to">${opts}</select></label>`,
    async () => {
      const amount = Math.round((Number($("#pay-amt").value) || 0) * 100) / 100;
      const to = $("#pay-to").value;
      if (amount <= 0){ toast("Enter an amount."); return; }
      await addDoc(collection(db,"payments"), {
        playerKey: key, playerName: pl.name, playerEmail: pl.email,
        amount, to, at: serverTimestamp(), by: S.email || "admin"
      });
      await updateDoc(doc(db,"players",key), { paid: (pl.paid||0) + amount });
      audit("payment", `${pl.name} <${pl.email}> paid ${money(amount)} to ${to}`);
      toast(`Logged ${money(amount)} from ${pl.name}`);
    });
}
async function loadPayLog(){
  const out = $("#paylog-out");
  out.innerHTML = `<p class="muted small">Loading…</p>`;
  const qs = await getDocs(query(collection(db,"payments"), orderBy("at","desc"), limit(200)));
  const entries = {}; const rows = [];
  qs.forEach(d => {
    const p = d.data(); entries[d.id] = p;
    const when = p.at?.toDate ? p.at.toDate().toLocaleDateString() : "";
    rows.push(`<div class="place-row">
      <div class="grow small">${esc(p.playerName)} <span class="muted">&lt;${esc(p.playerEmail)}&gt;</span><br>
        <span class="muted">${esc(when)} → ${esc(p.to)}</span></div>
      <b class="num small">${money(p.amount)}</b>
      <button class="btn mini danger" data-unpay="${d.id}">Unpay</button></div>`);
  });
  out.innerHTML = rows.length ? rows.join("") : `<p class="muted small">No payments logged yet.</p>`;
  out.querySelectorAll("[data-unpay]").forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.unpay, p = entries[id];
    const ok = await confirmDialog("Undo this payment?",
      `<p class="small">${esc(p.playerName)} &lt;${esc(p.playerEmail)}&gt; — ${money(p.amount)} to ${esc(p.to)}.<br>Their balance goes back up by ${money(p.amount)}.</p>`, "Unpay");
    if (!ok) return;
    try{
      await deleteDoc(doc(db,"payments",id));
      const pl = S.players[p.playerKey];
      if (pl) await updateDoc(doc(db,"players",p.playerKey),
        { paid: Math.max(0, (pl.paid||0) - p.amount) });
      audit("payment", `UNPAID: ${p.playerName} ${money(p.amount)} (was to ${p.to})`);
      toast("Payment removed"); loadPayLog();
    }catch(e){ toast(e.code || e.message); }
  }));
}
async function downloadPayLog(){
  const qs = await getDocs(query(collection(db,"payments"), orderBy("at","desc"), limit(1000)));
  const rows = [["Date","Player","Email","Amount","Paid to","Logged by"]];
  qs.forEach(d => {
    const p = d.data();
    rows.push([p.at?.toDate ? p.at.toDate().toLocaleString() : "", p.playerName,
      p.playerEmail, p.amount, p.to, p.by]);
  });
  const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g,'""')}"`).join(",")).join("\n");
  downloadFile(`pay-log-${stamp()}.csv`, csv, "text/csv");
}
async function releaseChips(key){
  const pl = S.players[key]; if (!pl) return;
  const theirs = chipsArr().filter(c => c.owner === key);
  if (!theirs.length){ toast("They have no chips."); return; }
  const owed = owedBy(key);
  const ok = await confirmDialog("Release chips back to the bag?",
    `<p class="small"><b>${esc(pl.name)}</b> &lt;${esc(pl.email)}&gt;</p>
     <p class="small">This deletes all <b>${theirs.length}</b> of their chips, puts them back in the bag,
     and clears the <b>${money(owed)}</b> they owed. Their entries in every prize are removed.</p>
     <p class="muted small">Logged payments stay — use Unpay in the payment log if any need reversing.</p>`,
    "Yes, release chips");
  if (!ok) return;
  const batch = writeBatch(db);
  theirs.forEach(c => batch.delete(doc(db,"chips",c.id)));
  await batch.commit();
  const groups = (S.bag?.groups || []).map(x => ({ ...x }));
  theirs.forEach(c => {
    let gi = c.gid ? groups.findIndex(x => x.gid === c.gid) : -1;
    if (gi < 0) gi = groups.findIndex(x => x.value === c.value);
    if (gi >= 0) groups[gi].remaining += 1;
  });
  await setDoc(doc(db,"config","bag"), { groups });
  audit("release", `${pl.name} <${pl.email}> — ${theirs.length} chips (${money(owed)}) returned to the bag`);
  toast(`${theirs.length} chips back in the bag`);
}

// ---------- audit viewer ----------
async function loadAudit(){
  const out = $("#audit-out");
  out.innerHTML = `<p class="muted small">Loading…</p>`;
  const qs = await getDocs(query(collection(db,"audit"), orderBy("at","desc"), limit(100)));
  const rows = [];
  qs.forEach(d => {
    const a = d.data();
    const when = a.at?.toDate ? a.at.toDate().toLocaleString() : "";
    rows.push(`<tr><td class="small muted" style="white-space:nowrap">${esc(when)}</td>
      <td class="small">${esc(a.who)}</td><td class="small"><b>${esc(a.action)}</b> ${esc(a.detail)}</td></tr>`);
  });
  out.innerHTML = rows.length
    ? `<div style="overflow-x:auto"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<p class="muted small">No audit entries yet.</p>`;
}

// ---------- backups / archives / restore ----------
function snapshotData(stripImages){
  const prizes = {};
  Object.entries(S.prizes).forEach(([id,p]) => {
    prizes[id] = stripImages ? { ...p, img: "" } : { ...p };
  });
  return { v: 1, savedAt: new Date().toISOString(),
    game: S.game, bag: S.bag, players: S.players, chips: S.chips, prizes };
}
function downloadFile(name, content, type){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click();
}
function stamp(){ return new Date().toISOString().slice(0,10); }
function downloadBackup(){
  downloadFile(`chip-draw-${stamp()}.json`,
    JSON.stringify(snapshotData(false), null, 1), "application/json");
  downloadCSV();
  toast("Backup downloaded (JSON + CSV)");
}
function downloadCSV(){
  const rows = [["Player","Email","Chip value","Prize bucket","Owed","Paid","Balance"]];
  chipsArr().forEach(c => rows.push([
    c.ownerName, c.ownerEmail, c.value,
    c.bucket ? (S.prizes[c.bucket]?.name || "removed") : "unplaced", "", "", ""
  ]));
  Object.entries(S.players).forEach(([u,pl]) => rows.push([
    pl.name, pl.email, "", "TOTALS", owedBy(u), pl.paid||0, balanceOf(u)
  ]));
  prizesArr().forEach(p => rows.push([
    p.winnerName || "", p.winnerEmail || "", p.winnerValue ?? "",
    "WINNER: " + p.name, "", "", ""
  ]));
  const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g,'""')}"`).join(",")).join("\n");
  downloadFile(`chip-draw-${stamp()}.csv`, csv, "text/csv");
}
async function cloudArchive(){
  const data = snapshotData(true); // strip prize photos to stay under the 1MB doc cap
  const json = JSON.stringify(data);
  if (json.length > 900000){ toast("Too large for a cloud archive — use the file download."); return; }
  await addDoc(collection(db,"archives"), {
    tag: (S.game?.title || "Chip Draw") + " — " + stamp(),
    at: serverTimestamp(), json
  });
  audit("archive", "saved to cloud");
  toast("Archived to cloud (prize photos not included)");
}
async function listArchives(){
  const out = $("#archive-out");
  out.innerHTML = `<p class="muted small">Loading…</p>`;
  const qs = await getDocs(query(collection(db,"archives"), orderBy("at","desc"), limit(20)));
  const rows = [];
  qs.forEach(d => {
    const a = d.data();
    rows.push(`<div class="place-row"><div class="grow small">${esc(a.tag)}</div>
      <button class="btn mini" data-dlarch="${d.id}">⬇</button>
      <button class="btn mini" data-restorearch="${d.id}">Restore</button></div>`);
  });
  out.innerHTML = rows.length ? rows.join("") : `<p class="muted small">No cloud archives yet.</p>`;
  const docsById = {}; qs.forEach(d => docsById[d.id] = d.data());
  out.querySelectorAll("[data-dlarch]").forEach(b => b.addEventListener("click", () => {
    const a = docsById[b.dataset.dlarch];
    downloadFile(`archive-${esc(a.tag)}.json`, a.json, "application/json");
  }));
  out.querySelectorAll("[data-restorearch]").forEach(b => b.addEventListener("click", async () => {
    try{ await restoreData(JSON.parse(docsById[b.dataset.restorearch].json)); }
    catch(e){ toast(e.code || e.message); }
  }));
}
async function restoreFromFile(){
  const f = $("#restore-file")?.files[0];
  if (!f){ toast("Pick a backup JSON file first."); return; }
  const data = JSON.parse(await f.text());
  await restoreData(data);
}
async function restoreData(data){
  if (!data || !data.game || !data.chips){ toast("That doesn't look like a chip-draw backup."); return; }
  const ok = await confirmDialog("Restore this backup?",
    `<p class="small">Saved ${esc(data.savedAt || "?")} — ${Object.keys(data.chips).length} chips, ${Object.keys(data.players||{}).length} players, ${Object.keys(data.prizes||{}).length} prizes.</p>
     <p class="small muted"><b>This wipes the current game</b> and replaces it with the backup. A safety backup of the current state downloads first.</p>`, "Wipe & restore");
  if (!ok) return;
  downloadBackup();
  await wipeCollections();
  const batchWrites = [];
  let batch = writeBatch(db), n = 0;
  const push = (ref, d) => { batch.set(ref, d); if (++n >= 400){ batchWrites.push(batch.commit()); batch = writeBatch(db); n = 0; } };
  Object.entries(data.players||{}).forEach(([id,d]) => push(doc(db,"players",id), d));
  Object.entries(data.chips||{}).forEach(([id,d]) => push(doc(db,"chips",id), d));
  Object.entries(data.prizes||{}).forEach(([id,d]) => push(doc(db,"prizes",id), d));
  batchWrites.push(batch.commit());
  await Promise.all(batchWrites);
  await setDoc(doc(db,"config","bag"), data.bag || { groups: [] });
  await setDoc(doc(db,"config","game"), data.game);
  audit("restore", `restored backup from ${data.savedAt || "?"}`);
  toast("Backup restored");
}
async function wipeCollections(){
  for (const col of ["chips","prizes","players","adminAlerts"]){
    const qs = await getDocs(collection(db,col));
    let batch = writeBatch(db), n = 0; const jobs = [];
    qs.forEach(d => { batch.delete(d.ref); if (++n >= 400){ jobs.push(batch.commit()); batch = writeBatch(db); n = 0; } });
    jobs.push(batch.commit());
    await Promise.all(jobs);
  }
  await deleteDoc(doc(db,"config","liveDraw")).catch(()=>{});
}
async function clearGame(){
  const ok = await confirmDialog("New season reset?",
    `<p class="small">This archives the current game first (cloud + file download), then wipes chips, prizes, players, and payments, empties the bag, and resets to SETUP.</p>`, "Archive & clear");
  if (!ok) return;
  downloadBackup();
  await cloudArchive().catch(()=>{});
  await wipeCollections();
  await setDoc(doc(db,"config","bag"), { groups: [] });
  await setDoc(doc(db,"config","game"), { title: S.game?.title || "Chip Draw Raffle",
    state:"setup", unassignedRule:"warn", unpaidCap: S.game?.unpaidCap || 0,
    unpaidAtLock:false, raffleLive:false, venmoList: S.game?.venmoList || [] });
  audit("clear", "game cleared for new run");
  toast("Cleared — ready for a new game");
}

document.addEventListener("focusout", () => {
  if (S.isAdmin && S.view === "admin")
    setTimeout(() => { if (!adminEditing()) renderAdminPanel(); }, 150);
});
