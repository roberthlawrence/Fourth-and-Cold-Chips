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

const app  = initializeApp(CFG.firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// Admin tiers — POWER_ADMIN_EMAILS / PAYMENT_ADMIN_EMAILS in firebase-config.js
// (falls back to the old ADMIN_EMAILS list as power admins)
const POWER = (CFG.POWER_ADMIN_EMAILS || CFG.ADMIN_EMAILS || []).map(e=>e.toLowerCase());
const PAY   = (CFG.PAYMENT_ADMIN_EMAILS || []).map(e=>e.toLowerCase());

// Same collectors as the squares board
const VENMO = [
  { label: "Pay Marcus", handle: "marcus-dawes"  },
  { label: "Pay Dan",    handle: "dan-huskerson" },
  { label: "Pay Randyn", handle: "randyn-tenery" }
];

// ---------- state ----------
const S = {
  uid: null, email: null, isPower: false, isPay: false, isAdmin: false,
  game: null, bag: null, me: null, liveDraw: null,
  players: {}, chips: {}, prizes: {}, alerts: {},
  ready: { game:false, bag:false, chips:false, prizes:false, players:false },
  view: "chips", adminDirty: false, oddsOpen: false,
  unsubAlerts: null, wheelKey: null, wheelDismissed: null
};

// ---------- helpers ----------
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = n => "$" + (Math.round(n * 100) / 100).toLocaleString();
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
  const note = encodeURIComponent(S.game?.title || "4th & Cold Chip Draw");
  return `<div class="venmoBtns">` + VENMO.map(v =>
    `<a class="btn primary mini" target="_blank" rel="noopener"
      href="https://venmo.com/${v.handle}?txn=pay&amount=${amount.toFixed(2)}&note=${note}">${v.label}</a>`
  ).join("") + `</div>`;
}

// derived
const chipsArr  = () => Object.entries(S.chips).map(([id,c]) => ({id, ...c}));
const prizesArr = () => Object.entries(S.prizes).map(([id,p]) => ({id, ...p}))
  .sort((a,b) => (a.order??0) - (b.order??0));
const myChips   = () => chipsArr().filter(c => c.owner === S.uid);
const owedBy    = uid => chipsArr().filter(c=>c.owner===uid).reduce((s,c)=>s+c.value,0);
const balanceOf = uid => owedBy(uid) - (S.players[uid]?.paid || 0);
const drawnCount   = v   => chipsArr().filter(c=>c.value===v).length;
const bucketCount  = pid => chipsArr().filter(c=>c.bucket===pid).length;
const myBucketCount= pid => myChips().filter(c=>c.bucket===pid).length;
const anyUnpaid = () => Object.keys(S.players).some(u => balanceOf(u) > 0.005);
const bucketEntries = pid => chipsArr().filter(c => c.bucket === pid)
  .sort((a,b) => a.id < b.id ? -1 : 1);   // deterministic order on every device
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
          ${chipHTML(g.value,"mini")}
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
  S.isPower = !!S.email && POWER.includes(S.email);
  S.isPay   = !!S.email && PAY.includes(S.email);
  S.isAdmin = S.isPower || S.isPay;
  if (S.email && !S.isAdmin) toast(`${S.email} isn't on the admin list.`);
  startListeners();
});
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
    S.me = S.players[S.uid] || null;
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
  if (!S.me){
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
  const name = $("#join-name").value.trim();
  const e1 = $("#join-email").value.trim().toLowerCase();
  const e2 = $("#join-email2").value.trim().toLowerCase();
  const err = $("#join-err");
  err.classList.add("hidden");
  if (!name || !e1){ err.textContent = "Name and email are required."; err.classList.remove("hidden"); return; }
  if (e1 !== e2){ err.textContent = "Emails don't match."; err.classList.remove("hidden"); return; }
  try{
    await setDoc(doc(db,"players",S.uid), {
      name, email: e1, paid: 0, notices: [], createdAt: serverTimestamp()
    });
    audit("join", `${name} <${e1}>`);
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
  maybeShow();
  if (!S.me) return;
  $("#brandSeason").textContent = (S.game?.title || "CHIP DRAW").toUpperCase();
  renderBalancePill(); renderBanners();
  renderChipsTab(); renderPrizesTab();
  if (S.view === "admin"){
    if (S.isAdmin) renderAdminPanel(); else setView("chips");
  }
}

function renderBalancePill(){
  const bal = balanceOf(S.uid);
  const p = $("#balance-pill");
  p.textContent = bal > 0.005 ? `Owe ${money(bal)}` : "Paid up";
  p.classList.toggle("owe", bal > 0.005);
}

function renderBanners(){
  const B = [];
  const state = S.game?.state;
  const myWins = prizesArr().filter(p => p.winnerChipId && S.chips[p.winnerChipId]?.owner === S.uid);
  if (myWins.length)
    B.push(`<div class="banner win"><div class="grow">🏆 <b>You won:</b> ${myWins.map(p=>esc(p.name)).join(", ")}. See the Prizes tab.</div></div>`);
  (S.me?.notices || []).forEach(n => {
    B.push(`<div class="banner info"><div class="grow">${esc(n.msg)}</div>
      <button class="x" data-dismiss="${esc(n.id)}">×</button></div>`);
  });
  const bal = balanceOf(S.uid);
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
        .map(u => `${esc(S.players[u].name)} (${money(balanceOf(u))})`).join(", ");
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
    await updateDoc(doc(db,"players",S.uid), { notices }).catch(x=>toast(x.message));
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
  const owed = owedBy(S.uid), paid = S.me?.paid || 0;
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
    const k = c.value + "|" + (c.bucket||"");
    groups[k] = groups[k] || { value:c.value, bucket:c.bucket||null, n:0 };
    groups[k].n++;
  });
  const rows = Object.values(groups).sort((a,b)=>a.value-b.value).map(g => {
    const where = g.bucket ? (S.prizes[g.bucket]?.name || "Removed prize") : "Not placed";
    return `<div class="place-row">
      <div class="stack-item">${chipHTML(g.value,"mini")}<span class="stack-count">×${g.n}</span></div>
      <div class="grow small">${esc(where)}</div>
      ${state==="open" ? `<button class="btn mini" data-move="${g.value}|${g.bucket||""}">Move</button>` : ""}
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
      <p class="muted small" style="margin-top:10px">Every chip = one entry on whatever prize you place it. The dollar value is what you pay — it doesn't change your odds.</p>
    </div>`;
  $("#btn-draw")?.addEventListener("click", openDraw);
  el.querySelector(".bagodds")?.addEventListener("toggle",
    e => { S.oddsOpen = e.target.open; });
  el.querySelectorAll("[data-move]").forEach(b => b.addEventListener("click", () => {
    const [v, bucket] = b.dataset.move.split("|");
    openMoveSheet(Number(v), bucket || null);
  }));
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
  try{
    const value = await drawChipTx();
    await new Promise(r => setTimeout(r, 900));
    bagEl.classList.add("hidden");
    const st = chipStyle(value);
    chipEl.className = `chip big ${st.dark?"dark":""} reveal`;
    chipEl.style.setProperty("--c", st.c);
    chipEl.querySelector("span").textContent = "$" + value;
    chipEl.classList.remove("hidden");
    txt.innerHTML = `You pulled a <b>${money(value)}</b> chip!`;
    info.innerHTML = bagInfoHTML(false);
    audit("draw", `${S.me.name} drew $${value}`);
  }catch(ex){
    txt.textContent = ex.message === "empty" ? "The bag is empty!" : ("Draw failed: " + ex.message);
  }
  actions.classList.remove("hidden");
}
async function drawChipTx(){
  if (S.game?.state !== "open") throw new Error("Draws are closed.");
  const cap = S.game?.unpaidCap || 0;
  if (cap > 0 && balanceOf(S.uid) >= cap)
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
    drawnValue = groups[gi].value;
    tx.update(bagRef, { groups });
    tx.set(chipRef, {
      owner: S.uid, ownerName: S.me.name, ownerEmail: S.me.email,
      value: drawnValue, bucket: null, drawnAt: serverTimestamp()
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
      const won = !!p.winnerChipId;
      const winChip = won ? S.chips[p.winnerChipId] : null;
      return `<div class="prize ${won?"won":""}">
        ${p.img ? `<img src="${p.img}" alt="${esc(p.name)}">` : ""}
        <div class="pad">
          <h3 style="margin:0">${esc(p.name)}</h3>
          ${p.desc ? `<p class="muted small" style="margin-top:4px">${esc(p.desc)}</p>` : ""}
          <div class="counts"><span><b class="num">${total}</b> chip${total===1?"":"s"} in</span>
            <span>yours: <b class="num">${mine}</b></span></div>
          ${won ? `<div class="winline">🏆 Winner: ${esc(winChip?.ownerName || p.winnerName || "?")}</div>` : ""}
          ${state==="open" ? `<div class="btnrow">
              <button class="btn mini primary" data-add="${p.id}" ${unallocated?"":"disabled"}>Add chips</button>
              ${mine ? `<button class="btn mini" data-pull="${p.id}">Move mine out</button>` : ""}
            </div>` : ""}
        </div></div>`;
    }).join("")}`;
  el.querySelectorAll("[data-add]").forEach(b => b.addEventListener("click", () => openPlaceSheet(b.dataset.add)));
  el.querySelectorAll("[data-pull]").forEach(b => b.addEventListener("click", () => openPullSheet(b.dataset.pull)));
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
function stepperRow(label, max, key){
  return `<div class="place-row"><div class="grow small">${label}</div>
    <div class="stepper" data-key="${key}" data-max="${max}">
      <button type="button" class="dec">−</button><span class="val num">0</span>
      <button type="button" class="inc">+</button></div></div>`;
}
function wireSteppers(){
  $$("#place-content .stepper").forEach(st => {
    const val = st.querySelector(".val"), max = Number(st.dataset.max);
    st.querySelector(".inc").addEventListener("click", () => {
      val.textContent = Math.min(max, Number(val.textContent)+1); });
    st.querySelector(".dec").addEventListener("click", () => {
      val.textContent = Math.max(0, Number(val.textContent)-1); });
  });
}
function stepperVals(){
  const out = {};
  $$("#place-content .stepper").forEach(st => out[st.dataset.key] = Number(st.querySelector(".val").textContent));
  return out;
}
function openPlaceSheet(pid){
  const p = S.prizes[pid]; if (!p) return;
  const free = myChips().filter(c => !c.bucket);
  const byVal = {};
  free.forEach(c => byVal[c.value] = (byVal[c.value]||0)+1);
  const rows = Object.keys(byVal).map(Number).sort((a,b)=>a-b)
    .map(v => stepperRow(`$${v} chips (you have ${byVal[v]} unplaced)`, byVal[v], "v"+v)).join("");
  openSheet(`Add chips → ${p.name}`, rows || "<p class='muted'>No unplaced chips.</p>", async () => {
    const want = stepperVals();
    const batch = writeBatch(db); let n = 0;
    for (const [k,count] of Object.entries(want)){
      const v = Number(k.slice(1));
      free.filter(c=>c.value===v).slice(0,count).forEach(c => {
        batch.update(doc(db,"chips",c.id), { bucket: pid, movedAt: serverTimestamp() }); n++;
      });
    }
    if (!n) return;
    await batch.commit();
    toast(`${n} chip${n>1?"s":""} placed on ${p.name}`);
  });
  wireSteppers();
}
function openPullSheet(pid){
  const p = S.prizes[pid]; if (!p) return;
  const mine = myChips().filter(c => c.bucket === pid);
  const byVal = {};
  mine.forEach(c => byVal[c.value] = (byVal[c.value]||0)+1);
  const rows = Object.keys(byVal).map(Number).sort((a,b)=>a-b)
    .map(v => stepperRow(`$${v} chips (${byVal[v]} here)`, byVal[v], "v"+v)).join("");
  openSheet(`Move out of ${p.name}`, rows, async () => {
    const want = stepperVals();
    const batch = writeBatch(db); let n = 0;
    for (const [k,count] of Object.entries(want)){
      const v = Number(k.slice(1));
      mine.filter(c=>c.value===v).slice(0,count).forEach(c => {
        batch.update(doc(db,"chips",c.id), { bucket: null, movedAt: serverTimestamp() }); n++;
      });
    }
    if (!n) return;
    await batch.commit();
    toast(`${n} chip${n>1?"s":""} moved back to your stack`);
  });
  wireSteppers();
}
function openMoveSheet(value, fromBucket){
  const mine = myChips().filter(c => c.value===value && (c.bucket||null)===(fromBucket||null));
  const opts = [`<option value="">— Not placed —</option>`]
    .concat(prizesArr().map(p => `<option value="${p.id}" ${p.id===fromBucket?"disabled":""}>${esc(p.name)}</option>`)).join("");
  const from = fromBucket ? (S.prizes[fromBucket]?.name || "removed prize") : "your unplaced stack";
  openSheet(`Move $${value} chips`, `
    <p class="small muted">From ${esc(from)} — you have ${mine.length} there.</p>
    ${stepperRow("How many to move", mine.length, "n")}
    <label>Move to<select id="move-dest">${opts}</select></label>`,
    async () => {
      const n = stepperVals().n || 0;
      const dest = $("#move-dest").value || null;
      if (!n) return;
      const batch = writeBatch(db);
      mine.slice(0,n).forEach(c => batch.update(doc(db,"chips",c.id),
        { bucket: dest, movedAt: serverTimestamp() }));
      await batch.commit();
      toast(`${n} chip${n>1?"s":""} moved`);
    });
  wireSteppers();
}

// ============================================================
// LIVE DRAW WHEEL
// ============================================================
let wheelRAF = null;
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
function ownerHue(uid){
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
  return h % 360;
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
  $("#wheel-prize").textContent = ld.prizeName || "";
  $("#wheel-winner").classList.add("hidden");
  $("#wheel-winner").textContent = "";
  const entries = bucketEntries(ld.prizeId);
  const N = entries.length;
  const winIdx = entries.findIndex(c => c.id === ld.winnerChipId);
  const cv = $("#wheel"), ctx = cv.getContext("2d");
  const D = ld.durationMs || 10000;
  $("#wheel-status").textContent = `${N} chip${N===1?"":"s"} in — spinning…`;
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
      ctx.fillStyle = `hsl(${ownerHue(c.owner)},52%,${c.owner===S.uid?46:60}%)`;
      ctx.fill();
      if (c.owner === S.uid){
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
  const p = S.prizes[pid]; if (!p || p.winnerChipId) return;
  const entries = bucketEntries(pid);
  if (!entries.length){ toast("No chips in that bucket."); return; }
  const win = entries[cryptoRandInt(entries.length)];
  const D = 10000;
  await setDoc(doc(db,"config","liveDraw"), {
    prizeId: pid, prizeName: p.name,
    winnerChipId: win.id, winnerName: win.ownerName,
    startedAtMs: Date.now(), durationMs: D, status: "spinning"
  });
  audit("live-draw", `${p.name} — wheel started (${entries.length} entries)`);
  setTimeout(() => finalizeLive({ prizeId: pid, winnerChipId: win.id,
    winnerName: win.ownerName, winnerEmail: win.ownerEmail, winnerValue: win.value }), D + 600);
}
async function finalizeLive(ld){
  try{
    const p = S.prizes[ld.prizeId];
    if (p && !p.winnerChipId){
      const chip = S.chips[ld.winnerChipId] || {};
      await updateDoc(doc(db,"prizes",ld.prizeId), {
        winnerChipId: ld.winnerChipId,
        winnerName: ld.winnerName || chip.ownerName || "?",
        winnerEmail: ld.winnerEmail || chip.ownerEmail || "",
        winnerValue: ld.winnerValue ?? chip.value ?? 0,
        drawnAt: serverTimestamp()
      });
      audit("winner", `${p.name} → ${ld.winnerName || chip.ownerName} (live wheel)`);
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
  const allDrawn = ps.length && ps.every(p=>p.winnerChipId);

  const drawingSection = `
    <h2>Drawings</h2>
    ${state!=="locked" && state!=="complete"
      ? `<p class="muted small">Lock buckets first — drawings run after the lock.</p>`
      : ps.map(p=>`<div class="card">
          <div class="row spread"><b>${esc(p.name)}</b>
            <span class="muted small num">${bucketCount(p.id)} chips</span></div>
          ${p.winnerChipId
            ? `<p class="small" style="color:var(--orange-deep);font-weight:700;margin-top:6px">🏆 ${esc(p.winnerName||S.chips[p.winnerChipId]?.ownerName||"?")}</p>`
            : `<div class="row gap">
                <button class="btn mini gold" data-livedraw="${p.id}">🎡 Live wheel draw</button>
                <button class="btn mini" data-drawwin="${p.id}">Quick draw (no wheel)</button>
              </div>`}
        </div>`).join("")}
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
          <td><input type="number" step="0.01" min="0" class="pay-in num" data-u="${u}" value="${pl.paid||0}"></td>
          <td class="num ${bal>0.005?"owefig":"okfig"}">${money(bal)}</td>
          <td><button class="btn mini" data-paidfull="${u}">Paid ✓</button></td>
        </tr>`;}).join("")}</tbody></table>
      <button class="btn mini" style="margin-top:10px" data-act="savepays">Save payment edits</button>
      <button class="btn mini" data-act="csv">Download CSV</button>
    </div>`;

  const footer = `
    <p class="muted small" style="margin:8px 0 4px">Signed in as ${esc(S.email)}
      (${S.isPower ? "power admin" : "payment admin"}) ·
      <button class="btn mini ghost" data-act="signout">Sign out</button></p>
    <p class="muted small" style="margin:0 0 30px">If you're playing too, draw your chips while signed in with Google so they stay tied to this account.</p>`;

  if (!S.isPower){
    // payment admins: drawings + payments only
    el.innerHTML = `<h2>Game state: <span style="color:var(--orange)">${state.toUpperCase()}</span></h2>`
      + drawingSection + paymentsSection + footer;
    wireAdmin(el);
    return;
  }

  el.innerHTML = `
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
      <label>Unplaced chips when locking
        <select id="set-rule">
          <option value="warn" ${g.unassignedRule==="warn"?"selected":""}>Warn me and block the lock</option>
          ${ps.map(p=>`<option value="${p.id}" ${g.unassignedRule===p.id?"selected":""}>Auto-move to: ${esc(p.name)}</option>`).join("")}
        </select></label>
      <p class="muted small" style="margin-top:-6px;margin-bottom:10px">This decides what happens to chips nobody placed when you hit Lock: either the lock is blocked so you can chase people down, or the chips auto-move into the prize you pick here. Add prizes and they'll show up as options.</p>
      <button class="btn block" data-act="savesettings">Save settings</button>
    </div>

    <h2>The bag</h2>
    <div class="card" id="bag-builder">
      <p class="muted small" style="margin-bottom:10px">One row per denomination. You can add chips mid-game; you can't cut a denomination below what's already been drawn.</p>
      ${groups.map((x,i)=>{
        const d = drawnCount(x.value);
        return `<div class="bb-row" data-i="${i}">
          <input type="number" class="bb-val num" min="1" step="1" value="${x.value}" placeholder="$" ${d? "disabled":""}>
          <span class="muted">×</span>
          <input type="number" class="bb-count num" min="${d}" step="1" value="${x.total}" placeholder="#">
          <span class="muted small num">${d} drawn</span>
          <button class="btn mini danger bb-del" ${d? "disabled":""}>✕</button>
        </div>`;}).join("")}
      <button class="btn mini" id="bb-add">+ Add denomination</button>
      <div class="bb-total row spread"><span>Pool</span>
        <b class="num">${totChips} chips · ${money(totVal)}</b></div>
      <button class="btn primary block" style="margin-top:10px" data-act="savebag">Save bag</button>
    </div>

    <h2>Prizes (${ps.length}/30)</h2>
    ${ps.map(p=>`<div class="card">
      <div class="row spread"><b>${esc(p.name)}</b>
        <span class="muted small num">${bucketCount(p.id)} chips</span></div>
      ${p.winnerChipId ? `<p class="small" style="color:var(--orange-deep);font-weight:700;margin-top:6px">🏆 ${esc(p.winnerName||"?")}</p>` : ""}
      ${state!=="complete" && !p.winnerChipId ? `<button class="btn mini danger" style="margin-top:8px" data-delprize="${p.id}">Remove prize</button>` : ""}
    </div>`).join("")}
    ${ps.length < 30 ? `
    <div class="card">
      <h3>Add a prize</h3>
      <label>Name<input id="np-name" maxlength="60"></label>
      <label>Description<textarea id="np-desc" rows="2" maxlength="240"></textarea></label>
      <label>Image (optional)<input id="np-img" type="file" accept="image/*"></label>
      <button class="btn block" data-act="addprize">Add prize</button>
    </div>` : ""}

    ${drawingSection}
    ${paymentsSection}

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
      <button class="btn danger block" data-act="cleargame">🧹 Clear game for a new run (auto-archives first)</button>
    </div>
    ${footer}
  `;
  wireAdmin(el);
}
function wireAdmin(el){
  el.querySelectorAll("input,select,textarea").forEach(i =>
    i.addEventListener("input", () => { S.adminDirty = true; }));
  el.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", async () => {
    try{ await adminAct(b.dataset.act); }
    catch(e){ toast((e.code === "permission-denied"
      ? "Permission denied — is your email in the firestore.rules list? "
      : "") + (e.code || e.message)); }
    S.adminDirty = false; renderAdminPanel(true);
  }));
  el.querySelectorAll("[data-delprize]").forEach(b => b.addEventListener("click", () => removePrize(b.dataset.delprize)));
  el.querySelectorAll("[data-drawwin]").forEach(b => b.addEventListener("click",
    () => drawWinner(b.dataset.drawwin).catch(e=>toast(e.code||e.message))));
  el.querySelectorAll("[data-livedraw]").forEach(b => b.addEventListener("click",
    () => startLiveDraw(b.dataset.livedraw).catch(e=>toast(e.code||e.message))));
  el.querySelectorAll("[data-paidfull]").forEach(b => b.addEventListener("click", async () => {
    const u = b.dataset.paidfull;
    try{
      await updateDoc(doc(db,"players",u), { paid: owedBy(u) });
      audit("payment", `${S.players[u].name} marked paid in full (${money(owedBy(u))})`);
      toast("Marked paid");
    }catch(e){ toast(e.code || e.message); }
  }));
  $("#bb-add")?.addEventListener("click", () => {
    S.adminDirty = true;
    const holder = $("#bag-builder");
    const row = document.createElement("div");
    row.className = "bb-row";
    row.innerHTML = `<input type="number" class="bb-val num" min="1" step="1" placeholder="$">
      <span class="muted">×</span>
      <input type="number" class="bb-count num" min="0" step="1" placeholder="#">
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
    await updateDoc(gRef, {
      title: $("#set-title").value.trim() || "Chip Draw Raffle",
      unpaidCap: Number($("#set-cap").value) || 0,
      unassignedRule: $("#set-rule").value
    });
    toast("Settings saved"); audit("settings","updated");
  }
  if (act === "savebag"){
    const rows = $$("#bag-builder .bb-row");
    const groups = []; const seen = new Set();
    for (const r of rows){
      const value = Number(r.querySelector(".bb-val").value);
      const total = Number(r.querySelector(".bb-count").value);
      if (!value || value < 1 || total < 0 || !Number.isFinite(total)) continue;
      if (seen.has(value)){ toast(`Duplicate $${value} rows — combine them.`); return; }
      seen.add(value);
      const drawn = drawnCount(value);
      if (total < drawn){ toast(`$${value}: can't set below ${drawn} already drawn.`); return; }
      groups.push({ value, total, remaining: total - drawn });
    }
    for (const v of new Set(chipsArr().map(c=>c.value))){
      if (!seen.has(v)){ toast(`$${v} chips have been drawn — that row can't be removed.`); return; }
    }
    await setDoc(doc(db,"config","bag"), { groups });
    toast("Bag saved"); audit("bag", groups.map(g=>`${g.total}x$${g.value}`).join(", "));
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
  if (act === "complete"){ await updateDoc(gRef, { state:"complete" }); audit("state","complete"); }
  if (act === "addprize") await addPrize();
  if (act === "savepays"){
    const batch = writeBatch(db);
    $$(".pay-in").forEach(inp => {
      const v = Number(inp.value) || 0;
      if (v !== (S.players[inp.dataset.u]?.paid || 0))
        batch.update(doc(db,"players",inp.dataset.u), { paid: v });
    });
    await batch.commit(); toast("Payments saved"); audit("payment","bulk edit");
  }
  if (act === "csv") downloadCSV();
  if (act === "signout"){ await signOut(auth); location.reload(); }
  if (act === "loadaudit") await loadAudit();
  if (act === "backup") downloadBackup();
  if (act === "cloudarchive") await cloudArchive();
  if (act === "listarchives") await listArchives();
  if (act === "restore") await restoreFromFile();
  if (act === "cleargame") await clearGame();
}

async function lockGame(){
  const un = chipsArr().filter(c=>!c.bucket);
  const rule = S.game.unassignedRule;
  if (un.length){
    if (rule === "warn" || !S.prizes[rule]){
      const owners = [...new Set(un.map(c=>c.ownerName))].join(", ");
      await confirmDialog("Can't lock yet",
        `<p class="small">${un.length} chip${un.length>1?"s":""} still unplaced (${esc(owners)}).</p>
         <p class="small muted">Have players place them, or set an auto-move bucket in Settings, then lock again.</p>`, "OK");
      return;
    }
    const batch = writeBatch(db);
    un.forEach(c => batch.update(doc(db,"chips",c.id), { bucket: rule, movedAt: serverTimestamp() }));
    await batch.commit();
    audit("lock", `auto-moved ${un.length} chips to ${S.prizes[rule]?.name}`);
  }
  const flag = anyUnpaid();
  await updateDoc(doc(db,"config","game"), { state:"locked", unpaidAtLock: flag });
  audit("state", "locked" + (flag ? " (unpaid balances outstanding — still valid entries)" : ""));
  toast("Buckets locked");
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
  const p = S.prizes[pid]; if (!p || p.winnerChipId) return;
  const entries = bucketEntries(pid);
  if (!entries.length){ if(!quiet) toast("No chips in that bucket."); return; }
  const win = entries[cryptoRandInt(entries.length)];
  await updateDoc(doc(db,"prizes",pid), {
    winnerChipId: win.id, winnerName: win.ownerName,
    winnerEmail: win.ownerEmail, winnerValue: win.value, drawnAt: serverTimestamp()
  });
  audit("winner", `${p.name} → ${win.ownerName} ($${win.value} chip, ${entries.length} entries, quick draw)`);
  if (!quiet) toast(`🏆 ${win.ownerName} wins ${p.name}!`);
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
  const ok = await confirmDialog("Clear game for a new run?",
    `<p class="small">This archives the current game first (cloud + file download), then wipes chips, prizes, players, and payments, empties the bag, and resets to SETUP.</p>`, "Archive & clear");
  if (!ok) return;
  downloadBackup();
  await cloudArchive().catch(()=>{});
  await wipeCollections();
  await setDoc(doc(db,"config","bag"), { groups: [] });
  await setDoc(doc(db,"config","game"), { title: S.game?.title || "Chip Draw Raffle",
    state:"setup", unassignedRule:"warn", unpaidCap: S.game?.unpaidCap || 0, unpaidAtLock:false });
  audit("clear", "game cleared for new run");
  toast("Cleared — ready for a new game");
}

document.addEventListener("focusout", () => {
  if (S.isAdmin && S.view === "admin")
    setTimeout(() => { if (!adminEditing()) renderAdminPanel(); }, 150);
});
