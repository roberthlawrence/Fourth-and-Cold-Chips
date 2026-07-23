// ============================================================
// CHIP DRAW — app.js  (vanilla ES modules + Firebase v10)
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously,
  GoogleAuthProvider, signInWithPopup, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, onSnapshot, getDoc, setDoc, updateDoc,
  addDoc, deleteDoc, runTransaction, writeBatch, serverTimestamp,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAILS } from "./firebase-config.js";

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ---------- state ----------
const S = {
  uid: null, email: null, isAdmin: false,
  game: null, bag: null, me: null,
  players: {},          // uid -> player
  chips: {},            // id -> chip
  prizes: {},           // id -> prize
  alerts: {},           // id -> adminAlert
  ready: { game:false, bag:false, chips:false, prizes:false, players:false },
  activeTab: "chips",
  unsubAlerts: null
};

// ---------- helpers ----------
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = n => "$" + (Math.round(n * 100) / 100).toLocaleString();
const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function cryptoRandInt(n){ // uniform 0..n-1
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
  { c:"#D2A24C", dark:false }, { c:"#C25A0B", dark:true }
];
function chipStyle(value){
  const vals = bagValues();
  const i = Math.max(0, vals.indexOf(value)) % CHIP_COLORS.length;
  return CHIP_COLORS[i];
}
function bagValues(){
  return (S.bag?.groups || []).map(g => g.value).sort((a,b)=>a-b);
}
function chipHTML(value, size=""){
  const st = chipStyle(value);
  return `<div class="chip ${size} ${st.dark?"dark":""}" style="--c:${st.c}">
    <span>$${value}</span></div>`;
}

let toastT = null;
function toast(msg){
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastT); toastT = setTimeout(()=>t.classList.add("hidden"), 2600);
}

function confirmDialog(title, html){
  return new Promise(res => {
    $("#confirm-title").textContent = title;
    $("#confirm-text").innerHTML = html;
    const m = $("#modal-confirm"); m.classList.remove("hidden");
    const done = ok => { m.classList.add("hidden"); yes.removeEventListener("click",oy);
      no.removeEventListener("click",on); res(ok); };
    const yes = $("#confirm-yes"), no = $("#confirm-no");
    const oy = () => done(true), on = () => done(false);
    yes.addEventListener("click", oy); no.addEventListener("click", on);
  });
}

function audit(action, detail){
  addDoc(collection(db,"audit"), {
    at: serverTimestamp(),
    who: S.email || S.me?.name || S.uid || "?",
    action, detail: detail || ""
  }).catch(()=>{});
}

// derived
const chipsArr  = () => Object.entries(S.chips).map(([id,c]) => ({id, ...c}));
const prizesArr = () => Object.entries(S.prizes).map(([id,p]) => ({id, ...p}))
  .sort((a,b) => (a.order??0) - (b.order??0));
const myChips   = () => chipsArr().filter(c => c.owner === S.uid);
function owedBy(uid){ return chipsArr().filter(c => c.owner===uid)
  .reduce((s,c)=>s+c.value, 0); }
function balanceOf(uid){ return owedBy(uid) - (S.players[uid]?.paid || 0); }
function drawnCount(value){ return chipsArr().filter(c=>c.value===value).length; }
function bucketCount(pid){ return chipsArr().filter(c=>c.bucket===pid).length; }
function myBucketCount(pid){ return myChips().filter(c=>c.bucket===pid).length; }
function anyUnpaid(){ return Object.keys(S.players).some(u => balanceOf(u) > 0.005); }

// ---------- boot / auth ----------
onAuthStateChanged(auth, async user => {
  if (!user){ signInAnonymously(auth).catch(e => bootError(e)); return; }
  S.uid = user.uid;
  S.email = (user.email || "").toLowerCase() || null;
  S.isAdmin = !!S.email && ADMIN_EMAILS.map(e=>e.toLowerCase()).includes(S.email);
  startListeners();
});
function bootError(e){
  $("#screen-loading").innerHTML =
    `<p class="err">Couldn't connect: ${esc(e.message)}</p>
     <p class="muted small">Check firebase-config.js and that Anonymous auth is enabled.</p>`;
}

let started = false;
function startListeners(){
  if (started){ maybeShow(); return; }
  started = true;
  onSnapshot(doc(db,"config","game"), async snap => {
    if (!snap.exists()){
      if (S.isAdmin){
        await setDoc(doc(db,"config","game"), { title:"Chip Draw Raffle",
          state:"setup", unassignedRule:"warn", unpaidCap:0, venmo:"",
          unpaidAtLock:false });
        return;
      }
      S.game = null;
    } else S.game = snap.data();
    S.ready.game = true; renderAll();
  }, e => bootError(e));
  onSnapshot(doc(db,"config","bag"), snap => {
    S.bag = snap.exists() ? snap.data() : { groups: [] };
    S.ready.bag = true; renderAll();
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
  if (!S.isAdmin) { S.alerts = {}; return; }
  S.unsubAlerts = onSnapshot(collection(db,"adminAlerts"), qs => {
    S.alerts = {}; qs.forEach(d => S.alerts[d.id] = d.data());
    renderAll();
  });
}

function allReady(){ return Object.values(S.ready).every(Boolean); }
function maybeShow(){
  if (!allReady()) return;
  $("#screen-loading").classList.add("hidden");
  if (!S.me){
    $("#screen-join").classList.remove("hidden");
    $("#app").classList.add("hidden");
    $("#join-title").textContent = S.game?.title || "Chip Draw";
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

// ---------- tabs ----------
$$("#tabbar button").forEach(b => b.addEventListener("click", () => {
  S.activeTab = b.dataset.tab;
  $$("#tabbar button").forEach(x => x.classList.toggle("active", x===b));
  $$(".tab").forEach(t => t.classList.add("hidden"));
  $("#tab-" + S.activeTab).classList.remove("hidden");
  renderAll();
}));

// ---------- render ----------
function renderAll(){
  if (!allReady()) return;
  maybeShow();
  if (!S.me) return;
  $("#app-title").textContent = S.game?.title || "Chip Draw";
  renderBalancePill(); renderBanners();
  renderChipsTab(); renderPrizesTab(); renderBagTab();
  $("#tabbtn-admin").classList.toggle("hidden", !S.isAdmin);
  if (S.isAdmin) renderAdminTab();
}

function renderBalancePill(){
  const bal = balanceOf(S.uid);
  const p = $("#balance-pill");
  p.textContent = bal > 0.005 ? `Owe ${money(bal)}` : "Paid up";
  p.classList.toggle("owe", bal > 0.005);
}

function venmoLink(amount){
  const h = S.game?.venmo;
  if (!h) return null;
  return `https://venmo.com/${encodeURIComponent(h)}?txn=pay&amount=${amount.toFixed(2)}&note=${encodeURIComponent((S.game?.title||"Chip Draw"))}`;
}

function renderBanners(){
  const B = [];
  const state = S.game?.state;
  // winners (mine)
  const myWins = prizesArr().filter(p => p.winnerChipId && S.chips[p.winnerChipId]?.owner === S.uid);
  if (myWins.length)
    B.push(`<div class="banner win"><div class="grow">🏆 <b>You won:</b> ${myWins.map(p=>esc(p.name)).join(", ")}. See the Prizes tab.</div></div>`);
  // player notices
  (S.me?.notices || []).forEach(n => {
    B.push(`<div class="banner info"><div class="grow">${esc(n.msg)}</div>
      <button class="x" data-dismiss="${esc(n.id)}">×</button></div>`);
  });
  // balance due (every login while owed)
  const bal = balanceOf(S.uid);
  if (bal > 0.005 && state !== "setup"){
    const v = venmoLink(bal);
    B.push(`<div class="banner warn"><div class="grow">You owe <b>${money(bal)}</b> for your chips.
      ${v ? `<br><a class="btn primary mini" href="${v}" target="_blank" rel="noopener">Pay with Venmo</a>` : ""}</div></div>`);
  }
  // unallocated reminder
  const un = myChips().filter(c => !c.bucket).length;
  if (un > 0 && state === "open"){
    B.push(`<div class="banner info"><div class="grow">You have <b>${un}</b> chip${un>1?"s":""} not placed on a prize yet. Head to the Prizes tab.</div></div>`);
  }
  // admin banners
  if (S.isAdmin){
    if ((state === "locked" || state === "complete") && anyUnpaid()){
      const list = Object.keys(S.players).filter(u => balanceOf(u) > 0.005)
        .map(u => `${esc(S.players[u].name)} (${money(balanceOf(u))})`).join(", ");
      B.push(`<div class="banner alert"><div class="grow"><b>Admin — unpaid balances after lock:</b> ${list}</div></div>`);
    }
    if (S.game?.unpaidAtLock && (state === "locked" || state === "complete")){
      B.push(`<div class="banner warn"><div class="grow"><b>Admin:</b> game was locked with unpaid chips still counted as valid entries (per settings).</div></div>`);
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
    await updateDoc(doc(db,"players",S.uid), { notices });
  }
  if (d.copy){ try{ await navigator.clipboard.writeText(d.copy); toast("Emails copied"); }catch{ toast("Copy failed"); } }
  if (d.resolve){ await updateDoc(doc(db,"adminAlerts",d.resolve), { resolved:true }); }
});

// ---------- MY CHIPS tab ----------
function renderChipsTab(){
  const el = $("#tab-chips");
  const state = S.game?.state;
  const mine = myChips();
  const owed = owedBy(S.uid), paid = S.me?.paid || 0;
  const remaining = (S.bag?.groups||[]).reduce((s,g)=>s+g.remaining,0);

  const cap = S.game?.unpaidCap || 0;
  const capped = cap > 0 && (owed - paid) >= cap;
  let drawDisabled = "", drawNote = "";
  if (state === "setup"){ drawDisabled="disabled"; drawNote="The game hasn't opened yet."; }
  else if (state !== "open"){ drawDisabled="disabled"; drawNote="Buckets are locked — no more draws."; }
  else if (!remaining){ drawDisabled="disabled"; drawNote="The bag is empty!"; }
  else if (capped){ drawDisabled="disabled"; drawNote=`Pay down your balance to keep drawing (limit ${money(cap)} unpaid).`; }

  // group my chips by value+bucket
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
      <span class="eyebrow">The bag holds ${remaining} chip${remaining===1?"":"s"}</span>
      <button id="btn-draw" class="btn primary block" style="margin-top:12px" ${drawDisabled}>🎒 Draw a chip</button>
      ${drawNote ? `<p class="muted small" style="margin-top:8px">${drawNote}</p>` : ""}
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
      <p class="muted small" style="margin-top:8px">Every chip = one entry in whatever prize you place it on. The dollar value is what you pay — it doesn't change your odds.</p>
    </div>`;
  $("#btn-draw")?.addEventListener("click", () => openDraw());
  el.querySelectorAll("[data-move]").forEach(b => b.addEventListener("click", () => {
    const [v, bucket] = b.dataset.move.split("|");
    openMoveSheet(Number(v), bucket || null);
  }));
}

// ---------- draw ----------
function openDraw(){
  $("#modal-draw").classList.remove("hidden");
  runDraw();
}
async function runDraw(){
  const bagEl = $("#draw-bag"), chipEl = $("#draw-chip"),
        txt = $("#draw-text"), actions = $("#draw-actions");
  actions.classList.add("hidden"); chipEl.classList.add("hidden");
  bagEl.classList.remove("hidden");
  bagEl.classList.remove("shake"); void bagEl.offsetWidth; bagEl.classList.add("shake");
  txt.textContent = "Reaching in…";
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
    audit("draw", `${S.me.name} drew $${value}`);
  }catch(ex){
    txt.textContent = ex.message === "empty" ? "The bag is empty!" : ("Draw failed: " + ex.message);
  }
  actions.classList.remove("hidden");
}
async function drawChipTx(){
  // pre-checks
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
$("#draw-again").addEventListener("click", () => runDraw());
$("#draw-done").addEventListener("click", () => $("#modal-draw").classList.add("hidden"));

// ---------- PRIZES tab ----------
function renderPrizesTab(){
  const el = $("#tab-prizes");
  const state = S.game?.state;
  const ps = prizesArr();
  if (!ps.length){ el.innerHTML = `<p class="muted" style="margin-top:20px">No prizes posted yet.</p>`; return; }
  const unallocated = myChips().filter(c=>!c.bucket).length;
  el.innerHTML = `
    ${state==="open" ? `<p class="muted small" style="margin:10px 0">You have <b>${unallocated}</b> unplaced chip${unallocated===1?"":"s"}. Every chip on a prize is one entry in that drawing — move them around any time until buckets lock.</p>` : ""}
    ${state==="locked" ? `<div class="banner info"><div class="grow">Buckets are <b>locked</b>. Winners will be drawn soon.</div></div>` : ""}
    ${ps.map(p => {
      const total = bucketCount(p.id), mine = myBucketCount(p.id);
      const won = !!p.winnerChipId;
      const winChip = won ? S.chips[p.winnerChipId] : null;
      return `<div class="prize ${won?"won":""}">
        ${p.img ? `<img src="${p.img}" alt="${esc(p.name)}">` : ""}
        <div class="pad">
          <div class="row spread"><h3 style="margin:0">${esc(p.name)}</h3></div>
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

// add unallocated chips to a prize (per denomination)
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
// pull my chips out of a prize back to unallocated
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
// move a group (from My Chips tab) to any destination
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

// ---------- BAG tab ----------
function renderBagTab(){
  const el = $("#tab-bag");
  const groups = [...(S.bag?.groups||[])].sort((a,b)=>a.value-b.value);
  const remaining = groups.reduce((s,g)=>s+g.remaining,0);
  const total = groups.reduce((s,g)=>s+g.total,0);
  el.innerHTML = `
    <h2>What's left in the bag</h2>
    <div class="card">
      ${groups.length ? groups.map(g => `
        <div class="bag-row">
          ${chipHTML(g.value,"mini")}
          <div class="bag-bar"><i style="width:${g.total? (g.remaining/g.total*100):0}%"></i></div>
          <div class="bag-nums num"><b>${g.remaining}</b> / ${g.total}</div>
        </div>`).join("") : `<p class="muted">The bag hasn't been filled yet.</p>`}
      ${groups.length ? `<div class="bb-total row spread"><span>Chips remaining</span><b class="num">${remaining} / ${total}</b></div>` : ""}
    </div>
    <p class="muted small">Every chip is one entry — the dollar amount is only what it costs. Odds of pulling each value shift as the bag empties.</p>
    <div class="divider"></div>
    ${S.email
      ? `<p class="small muted">Signed in as ${esc(S.email)} <button class="btn mini" id="btn-signout">Sign out</button></p>`
      : `<button class="btn mini ghost" id="btn-adminlogin">Admin sign-in</button>`}
  `;
  $("#btn-adminlogin")?.addEventListener("click", adminLogin);
  $("#btn-signout")?.addEventListener("click", async () => { await signOut(auth); location.reload(); });
}
async function adminLogin(){
  try{
    await signInWithPopup(auth, new GoogleAuthProvider());
    location.reload();
  }catch(e){ toast("Sign-in failed: " + e.message); }
}

// ---------- ADMIN tab ----------
function adminEditing(){
  const a = document.activeElement;
  return a && $("#tab-admin")?.contains(a) &&
    ["INPUT","SELECT","TEXTAREA"].includes(a.tagName);
}
function renderAdminTab(force){
  const el = $("#tab-admin");
  if (!force && (adminEditing() || S.adminDirty)) return; // don't clobber unsaved edits
  const g = S.game || {};
  const groups = [...(S.bag?.groups||[])];
  const ps = prizesArr();
  const state = g.state;
  const totChips = groups.reduce((s,x)=>s+x.total,0);
  const totVal = groups.reduce((s,x)=>s+x.total*x.value,0);
  const unallocAll = chipsArr().filter(c=>!c.bucket).length;
  const allDrawn = ps.length && ps.every(p=>p.winnerChipId);

  el.innerHTML = `
    <h2>Game state: <span style="color:var(--orange-hi)">${state.toUpperCase()}</span></h2>
    <div class="card">
      ${state==="setup" ? `<button class="btn primary block" data-act="open">Open the game</button>
        <p class="muted small" style="margin-top:8px">Players can join now, but can't draw until you open.</p>` : ""}
      ${state==="open" ? `<button class="btn primary block" data-act="lock">Lock buckets</button>
        <p class="muted small" style="margin-top:8px">${unallocAll} unplaced chip${unallocAll===1?"":"s"} across all players.
        Rule on lock: <b>${g.unassignedRule==="warn" ? "warn me (blocks lock)" : "auto-move to " + esc(S.prizes[g.unassignedRule]?.name || "?")}</b></p>` : ""}
      ${state==="locked" ? `
        <button class="btn block" data-act="reopen">Reopen (unlock)</button>
        ${allDrawn ? `<button class="btn primary block" style="margin-top:8px" data-act="complete">Mark game complete</button>` : ""}` : ""}
      ${state==="complete" ? `<p class="muted">Game complete. 🏁</p>` : ""}
    </div>

    <h2>Settings</h2>
    <div class="card">
      <label>Game title<input id="set-title" value="${esc(g.title||"")}"></label>
      <label>Venmo handle (no @)<input id="set-venmo" value="${esc(g.venmo||"")}" placeholder="your-venmo"></label>
      <label>Unpaid limit — block draws once a player owes this much ($0 = off)
        <input id="set-cap" type="number" min="0" step="1" value="${g.unpaidCap||0}"></label>
      <label>Unplaced chips when locking
        <select id="set-rule">
          <option value="warn" ${g.unassignedRule==="warn"?"selected":""}>Warn me and block the lock</option>
          ${ps.map(p=>`<option value="${p.id}" ${g.unassignedRule===p.id?"selected":""}>Auto-move to: ${esc(p.name)}</option>`).join("")}
        </select></label>
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
      ${p.winnerChipId ? `<p class="winline small" style="color:var(--gold)">🏆 ${esc(S.chips[p.winnerChipId]?.ownerName||"?")} — $${S.chips[p.winnerChipId]?.value??"?"} chip</p>`
        : (state==="locked" ? `<button class="btn mini primary" style="margin-top:8px" data-drawwin="${p.id}">Draw winner</button>` : "")}
      ${state!=="complete" && !p.winnerChipId ? `<button class="btn mini danger" style="margin-top:8px" data-delprize="${p.id}">Remove prize</button>` : ""}
    </div>`).join("")}
    ${state==="locked" && ps.some(p=>!p.winnerChipId) ? `<button class="btn primary block" data-act="drawall">Draw all remaining winners</button>` : ""}
    ${ps.length < 30 ? `
    <div class="card">
      <h3>Add a prize</h3>
      <label>Name<input id="np-name" maxlength="60"></label>
      <label>Description<textarea id="np-desc" rows="2" maxlength="240"></textarea></label>
      <label>Image (optional)<input id="np-img" type="file" accept="image/*"></label>
      <button class="btn block" data-act="addprize">Add prize</button>
    </div>` : ""}

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
    </div>
    <p class="muted small" style="margin:8px 0 30px">Tip: if you (an admin) are also playing, draw your chips while signed in with Google so your chips stay tied to this account.</p>
  `;

  // wire admin actions
  el.querySelectorAll("input,select,textarea").forEach(i =>
    i.addEventListener("input", () => { S.adminDirty = true; }));
  el.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", async () => {
    await adminAct(b.dataset.act);
    S.adminDirty = false; renderAdminTab(true);
  }));
  el.querySelectorAll("[data-delprize]").forEach(b => b.addEventListener("click", () => removePrize(b.dataset.delprize)));
  el.querySelectorAll("[data-drawwin]").forEach(b => b.addEventListener("click", () => drawWinner(b.dataset.drawwin)));
  el.querySelectorAll("[data-paidfull]").forEach(b => b.addEventListener("click", async () => {
    const u = b.dataset.paidfull;
    await updateDoc(doc(db,"players",u), { paid: owedBy(u) });
    audit("payment", `${S.players[u].name} marked paid in full (${money(owedBy(u))})`);
    toast("Marked paid");
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
      venmo: $("#set-venmo").value.trim(),
      unpaidCap: Number($("#set-cap").value) || 0,
      unassignedRule: $("#set-rule").value
    });
    toast("Settings saved"); audit("settings","updated"); renderAdminTab();
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
    // any denomination with drawn chips must remain
    for (const v of new Set(chipsArr().map(c=>c.value))){
      if (!seen.has(v)){ toast(`$${v} chips have been drawn — that row can't be removed.`); return; }
    }
    await setDoc(doc(db,"config","bag"), { groups });
    toast("Bag saved"); audit("bag", JSON.stringify(groups.map(g=>`${g.total}x$${g.value}`)));
    renderAdminTab();
  }
  if (act === "open"){
    if (!(S.bag?.groups||[]).length){ toast("Fill the bag first."); return; }
    await updateDoc(gRef, { state:"open" }); audit("state","open");
  }
  if (act === "lock") await lockGame();
  if (act === "reopen"){
    const ok = await confirmDialog("Reopen the game?", "Players will be able to draw and move chips again.");
    if (ok){ await updateDoc(gRef, { state:"open" }); audit("state","reopened"); }
  }
  if (act === "complete"){ await updateDoc(gRef, { state:"complete" }); audit("state","complete"); }
  if (act === "addprize") await addPrize();
  if (act === "drawall"){
    for (const p of prizesArr().filter(p=>!p.winnerChipId)) await drawWinner(p.id, true);
    toast("All winners drawn");
  }
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
}

async function lockGame(){
  const un = chipsArr().filter(c=>!c.bucket);
  const rule = S.game.unassignedRule;
  if (un.length){
    if (rule === "warn" || !S.prizes[rule]){
      const owners = [...new Set(un.map(c=>c.ownerName))].join(", ");
      await confirmDialog("Can't lock yet",
        `<p class="small">${un.length} chip${un.length>1?"s":""} still unplaced (${esc(owners)}).</p>
         <p class="small muted">Have players place them, or set an auto-move bucket in Settings, then lock again.</p>`);
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

// prize image → resized base64
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
  try{
    const img = await readImage($("#np-img").files[0]);
    await addDoc(collection(db,"prizes"), {
      name, desc: $("#np-desc").value.trim(), img,
      order: Date.now(), winnerChipId: null, createdAt: serverTimestamp()
    });
    audit("prize", `added: ${name}`); toast("Prize added"); renderAdminTab();
  }catch(e){ toast(e.message); }
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
}

async function drawWinner(pid, quiet){
  const p = S.prizes[pid]; if (!p || p.winnerChipId) return;
  const entries = chipsArr().filter(c => c.bucket === pid);
  if (!entries.length){ if(!quiet) toast("No chips in that bucket."); return; }
  const win = entries[cryptoRandInt(entries.length)];
  await updateDoc(doc(db,"prizes",pid), {
    winnerChipId: win.id, winnerName: win.ownerName,
    winnerEmail: win.ownerEmail, winnerValue: win.value, drawnAt: serverTimestamp()
  });
  audit("winner", `${p.name} → ${win.ownerName} ($${win.value} chip, ${entries.length} entries)`);
  if (!quiet) toast(`🏆 ${win.ownerName} wins ${p.name}!`);
}

function downloadCSV(){
  const rows = [["Player","Email","Chip value","Prize bucket","Owed","Paid","Balance"]];
  chipsArr().forEach(c => rows.push([
    c.ownerName, c.ownerEmail, c.value,
    c.bucket ? (S.prizes[c.bucket]?.name || "removed") : "unplaced",
    "", "", ""
  ]));
  Object.entries(S.players).forEach(([u,pl]) => rows.push([
    pl.name, pl.email, "", "TOTALS", owedBy(u), pl.paid||0, balanceOf(u)
  ]));
  const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g,'""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], {type:"text/csv"}));
  a.download = "chip-draw.csv"; a.click();
}

// re-render admin tab when inputs blur (since we skip renders mid-edit)
document.addEventListener("focusout", () => {
  if (S.isAdmin) setTimeout(() => { if (!adminEditing()) renderAdminTab(); }, 150);
});
