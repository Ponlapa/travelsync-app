// TravelSync front end. Backend: Google Apps Script (gas-src/), money rules: MONEY_RULES.md.
// Every POST carries clientVersion + session token; writes also carry a requestId so a retry after a
// lost answer is never saved twice.
// Backends are an allow-list (never a URL from the address bar — a crafted link could collect PINs).
// ?env=staging talks to the TravelSync-TEST copy for testing.
const BACKENDS = {
  prod: "https://script.google.com/macros/s/AKfycbxTLRWerX27djKJKPK_bcni6DI1KlQyuWMCmgsOys46EwunwJa4Dl2PepLAO3fTkTcu/exec",
  staging: "https://script.google.com/macros/s/AKfycbzvY3b5I-UwdPZZlguq_HE0XQBwbDNzYwNWx1RZY2Ui5KY15THCW9FYN7i9mr3vgi90/exec"
};
const APP_ENV = (typeof location !== 'undefined' && new URLSearchParams(location.search).get('env') === 'staging') ? 'staging' : 'prod';
const WEB_APP_URL = BACKENDS[APP_ENV];
const APP_CLIENT_VERSION = 2;
const SESSION_KEY = "travelsync_session";
const USERS_KEY = "travelsync_users";   // login list from the last visit, shown before Google answers
const TRIP_KEY = "travelsync_trip_";    // + userId_tripId: last trip data, shown while the fresh one loads
const TRIP_STALE_MS = 30000;            // back in the app after this long → reload the open trip

let sessionToken = "";
let currentUser = null;
let currentTripId = null;
let globalTripData = null;
let tripDataFresh = false;     // false while a saved copy is shown and Google has not answered yet
let tripLoadedAt = 0;          // when globalTripData last came from Google
let tripRefresh = null;        // the reload in flight (one at a time)
let cachedUsers = [];
let activeSelectedDayDate = "";
let activeCurrentFinTabIdx = 1;
let t1IsCustomMode = false;

// ---------- helpers ----------
// Every user-entered value goes through escapeHtml before innerHTML.
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Value for an inline handler: onclick="fn(${jsArg(x)})" — survives quotes, newlines and markup.
function jsArg(v) {
  return escapeHtml(JSON.stringify(String(v == null ? '' : v)));
}

// Only http(s) links may become an href (blocks javascript: URLs).
function safeUrl(url) {
  const u = String(url || '').trim();
  return /^https?:\/\//i.test(u) ? escapeHtml(u) : '';
}

function memberLabel(m) {
  return `${escapeHtml(m.icon || '👤')} ${escapeHtml(m.name)}`;
}

function money(n) {
  return `฿${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Same rule as splitEqually() in gas-src/Finance.js: whole satang, leftover satang to preferIdx first, then list order.
function splitEquallyCents(total, count, preferIdx) {
  const cents = Math.round(total * 100), base = Math.floor(cents / count), extra = cents - base * count;
  const order = [...Array(count).keys()];
  if (preferIdx >= 0 && preferIdx < count) { order.splice(preferIdx, 1); order.unshift(preferIdx); }
  const amounts = Array(count).fill(base);
  for (let k = 0; k < extra; k++) amounts[order[k]]++;
  return amounts.map((c) => c / 100);
}

// Show/Hide button of a bill or deposit row.
function toggleDetails(btn, colId) {
  const col = document.getElementById(colId);
  const isHidden = col.classList.contains('hidden');
  col.classList.toggle('hidden');
  btn.innerText = isHidden ? 'Hide 🔼' : 'Show 🔽';
}

function formatDateRange(start, end) {
  if (!start && !end) return 'ยังไม่ระบุวันที่';
  return start === end ? start : `${start || '?'} ถึง ${end || '?'}`;
}

function confirmDanger(title, text, confirmText) {
  return Swal.fire({
    title: escapeHtml(title), text: text, icon: 'warning', showCancelButton: true,
    confirmButtonText: confirmText || 'ใช่, ลบทันที!', cancelButtonText: 'ยกเลิก',
    customClass: { confirmButton: 'btn bg-red-500 text-white font-black px-4 mx-1 border-0', cancelButton: 'btn bg-slate-400 text-white font-black px-4 mx-1 border-0' },
    buttonsStyling: false
  }).then((r) => r.isConfirmed);
}

function showLoading(title) {
  Swal.fire({ title: title, allowOutsideClick: false, didOpen: () => { Swal.showLoading(); } });
}

// ---------- API ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newRequestId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(16) + '-' + Math.random().toString(16).slice(2);
}

// A real answer is a JSON object with a boolean `success` that echoes our requestId.
// Google sometimes answers a POST with an error page or someone else's answer; those are retried.
function isGenuineAnswer(res, requestId) {
  return !!res && typeof res === 'object' && typeof res.success === 'boolean' && res.echo === (requestId || '');
}

async function postOnce(body) {
  const res = await fetch(WEB_APP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  return res.json();
}

// Thrown when no genuine answer arrived. For a write it is unknown whether it was saved.
class UncertainResult extends Error {}

async function api(action, payload = {}, { write = false } = {}) {
  const requestId = write ? newRequestId() : '';
  const body = { ...payload, action, clientVersion: APP_CLIENT_VERSION, token: sessionToken, requestId };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt);
    let res;
    try { res = await postOnce(body); } catch (e) { continue; }
    if (!isGenuineAnswer(res, requestId)) continue;
    if (res.code === 'BUSY') continue;           // nothing was written; same requestId is safe to resend
    if (res.code === 'AUTH') { onSessionExpired(res.error); throw new UncertainResult('auth'); }
    if (res.code === 'UPDATE_REQUIRED') { Swal.fire({ title: 'มีเวอร์ชันใหม่', text: res.error, icon: 'info' }); throw new UncertainResult('update'); }
    return res;
  }
  if (write) {
    await Swal.fire({ title: 'ไม่แน่ใจว่าบันทึกสำเร็จ', text: 'สัญญาณไม่ดีหรือระบบไม่ตอบ ระบบจะโหลดข้อมูลล่าสุดให้ดูก่อน กรุณาตรวจสอบว่ารายการขึ้นแล้วหรือยัง ก่อนกดบันทึกซ้ำ', icon: 'warning' });
    if (currentTripId) reloadTripDashboard(); else if (currentUser) renderTripsList();
  } else {
    Swal.fire({ title: 'เชื่อมต่อไม่ได้', text: 'กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่', icon: 'error' });
  }
  throw new UncertainResult('no answer');
}

// Server said no (validation / permission): show its message as text. Returns true on success.
function reportSaveResult(res) {
  if (res && res.success) return true;
  Swal.fire({ title: 'บันทึกไม่สำเร็จ', text: (res && res.error) || 'ไม่สามารถบันทึกข้อมูลได้', icon: 'error' });
  return false;
}

// Promise chains end here so an UncertainResult (already reported to the user) is not an uncaught error.
function quiet(err) {
  if (!(err instanceof UncertainResult)) console.error(err);
}

// Every write goes through here: "กำลังบันทึก..." covers the screen until the answer (and the reload in
// `after`) is in. Google can take 30 s+; without the cover people tap save again, which is a new request
// and a second bill. A failure / uncertain answer replaces the cover with its own alert.
// A saved copy of the trip is on screen: wait for the fresh one, so nobody saves from old numbers.
// Returns true (and tells the user) when a save must wait.
function holdWhileTripUpdating() {
  if (!currentTripId || tripDataFresh) return false;
  refreshTrip().catch(quiet);
  Swal.fire({ title: 'กำลังอัปเดตข้อมูล', text: 'รอสักครู่ให้ข้อมูลล่าสุดขึ้นก่อน แล้วกดบันทึกอีกครั้ง', icon: 'info' });
  return true;
}

function runWrite(action, payload, after) {
  if (holdWhileTripUpdating()) return Promise.resolve();
  showLoading('กำลังบันทึก...');
  return api(action, payload, { write: true }).then((res) => {
    if (!reportSaveResult(res)) return;
    return Promise.resolve(after && after(res)).then(() => { if (Swal.isLoading()) Swal.close(); });
  }).catch(quiet);
}

// ---------- phone storage ----------
// localStorage survives closing a home-screen app (sessionStorage does not on iOS). Blocked storage
// (private mode) throws: the app then works from memory only.
function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* memory only */ }
}

function storageRemove(key) {
  try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
}

function storageRemovePrefix(prefix) {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    keys.filter((k) => k && k.startsWith(prefix)).forEach(storageRemove);
  } catch (e) { /* ignore */ }
}

// ---------- session ----------
// The server keeps a session 6 h after its last use; an older saved token gets AUTH → back to login.
function saveSession(token, user) {
  sessionToken = token;
  currentUser = user;
  storageSet(SESSION_KEY, { token, user });
}

function loadSavedSession() {
  const saved = storageGet(SESSION_KEY);
  return saved && saved.token && saved.user ? saved : null;
}

function clearSession() {
  sessionToken = '';
  currentUser = null;
  storageRemove(SESSION_KEY);
}

function onSessionExpired(message) {
  clearSession();
  globalTripData = null;
  currentTripId = null;
  switchToView('view-login');
  Swal.fire({ title: 'กรุณาเข้าสู่ระบบใหม่', text: message || 'หมดเวลาการใช้งาน', icon: 'info' });
}

window.addEventListener('DOMContentLoaded', function () {
  if (APP_ENV === 'staging') document.title = '[TEST] ' + document.title;
  const saved = loadSavedSession();
  if (saved) {
    saveSession(saved.token, saved.user);
    switchToView('view-trips');
    renderTripsList();
  }
  loadInitialUserData();
});

// Fills the login dropdown; a name the user already picked stays picked.
function renderUserSelect(users) {
  cachedUsers = users;
  const select = document.getElementById('login-user-select');
  const picked = select.value;
  select.innerHTML = `<option value="" disabled selected>เลือกโปรไฟล์ผู้ใช้ของตนเอง</option>` +
    users.map((u) => `<option value="${escapeHtml(u.id)}">${memberLabel(u)}</option>`).join('');
  if (picked && users.some((u) => u.id === picked)) select.value = picked;
}

// Shows the list from the last visit at once, then refreshes it (that call also wakes the Google script).
function loadInitialUserData() {
  const saved = storageGet(USERS_KEY);
  if (Array.isArray(saved) && saved.length) {
    renderUserSelect(saved);
    if (!currentUser) switchToView('view-login');
  }
  fetch(`${WEB_APP_URL}?action=getAllUsers`)
    .then((r) => r.json())
    .then((usersList) => {
      if (!Array.isArray(usersList)) throw new Error('not a user list');
      storageSet(USERS_KEY, usersList);
      renderUserSelect(usersList);
      if (!currentUser) switchToView('view-login');
    })
    .catch(() => {
      if (!currentUser) switchToView('view-login');
      if (!cachedUsers.length) Swal.fire({ title: 'โหลดรายชื่อไม่ได้', text: 'กรุณาตรวจสอบอินเทอร์เน็ตแล้วเปิดแอปใหม่', icon: 'error' });
    });
}

// ---------- login / register / phone / forgot PIN ----------
function handleUserLoginSubmit() {
  const uId = document.getElementById('login-user-select').value;
  const pin = document.getElementById('login-user-pin').value.trim();
  if (!uId || !pin) return Swal.fire('แจ้งเตือน', 'กรุณาเลือกชื่อและระบุ PIN ให้ครบถ้วน', 'warning');
  showLoading('กำลังตรวจสอบสิทธิ์...');
  api('verifyUserPin', { uId, pin }, { write: true }).then((res) => {
    Swal.close();
    if (!reportSaveResult(res)) return;
    document.getElementById('login-user-pin').value = '';
    afterLogin(res);
  }).catch(quiet);
}

function afterLogin(res) {
  saveSession(res.token, res.user);
  switchToView('view-trips');
  renderTripsList();
  if (res.needsPhone) openBottomSheet('modal-need-phone');
}

// Typing digits fills in the dashes: 0812345678 -> 081-234-5678
function formatPhoneInput(el) {
  const d = el.value.replace(/\D/g, '').slice(0, 10);
  el.value = d.length > 6 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d;
}

const PHONE_RE = /^\d{3}-\d{3}-\d{4}$/;
const PIN_RE = /^\d{4,6}$/;

function handleRegisterUserSubmit() {
  const name = document.getElementById('reg-user-name').value.trim();
  const icon = document.getElementById('reg-user-icon').value.trim();
  const pin = document.getElementById('reg-user-pin').value.trim();
  const phone = document.getElementById('reg-user-phone').value.trim();
  if (!name || !icon) return Swal.fire('แจ้งเตือน', 'กรุณาใส่ชื่อและไอคอน', 'warning');
  if (!PIN_RE.test(pin)) return Swal.fire('แจ้งเตือน', 'PIN ต้องเป็นตัวเลข 4-6 หลัก', 'warning');
  if (!PHONE_RE.test(phone)) return Swal.fire('แจ้งเตือน', 'เบอร์โทรต้องเป็นรูปแบบ XXX-XXX-XXXX', 'warning');
  const btn = document.getElementById('reg-submit-btn');
  btn.disabled = true;
  api('addNewUser', { name, icon, pin, phone }, { write: true }).then((res) => {
    btn.disabled = false;
    if (!reportSaveResult(res)) return;
    closeBottomSheet('modal-register-user');
    cachedUsers.push(res.user);
    afterLogin(res);
  }).catch((e) => { btn.disabled = false; quiet(e); });
}

function submitNeedPhone() {
  const phone = document.getElementById('need-phone-input').value.trim();
  if (!PHONE_RE.test(phone)) return Swal.fire('แจ้งเตือน', 'เบอร์โทรต้องเป็นรูปแบบ XXX-XXX-XXXX', 'warning');
  runWrite('setMyPhone', { phone }, () => closeBottomSheet('modal-need-phone'));
}

function openForgotPin() {
  const uId = document.getElementById('login-user-select').value;
  if (!uId) return Swal.fire('แจ้งเตือน', 'กรุณาเลือกชื่อของคุณก่อน', 'warning');
  const u = cachedUsers.find((x) => x.id === uId);
  document.getElementById('forgot-user-label').innerText = u ? `${u.icon || '👤'} ${u.name}` : uId;
  ['forgot-phone', 'forgot-new-pin', 'forgot-new-pin2'].forEach((id) => { document.getElementById(id).value = ''; });
  openBottomSheet('modal-forgot-pin');
}

function submitForgotPin() {
  const uId = document.getElementById('login-user-select').value;
  const phone = document.getElementById('forgot-phone').value.trim();
  const newPin = document.getElementById('forgot-new-pin').value.trim();
  if (!PHONE_RE.test(phone)) return Swal.fire('แจ้งเตือน', 'เบอร์โทรต้องเป็นรูปแบบ XXX-XXX-XXXX', 'warning');
  if (!PIN_RE.test(newPin)) return Swal.fire('แจ้งเตือน', 'PIN ใหม่ต้องเป็นตัวเลข 4-6 หลัก', 'warning');
  if (newPin !== document.getElementById('forgot-new-pin2').value.trim()) return Swal.fire('แจ้งเตือน', 'PIN ใหม่ทั้งสองช่องไม่ตรงกัน', 'warning');
  runWrite('resetPinByPhone', { uId, phone, newPin }, () => {
    closeBottomSheet('modal-forgot-pin');
    Swal.fire('ตั้ง PIN ใหม่แล้ว', 'เข้าสู่ระบบด้วย PIN ใหม่ได้เลย', 'success');
  });
}

function backToLogin() {
  storageRemovePrefix(TRIP_KEY);       // log out = nothing of the trips stays on the phone
  clearSession();
  globalTripData = null;
  currentTripId = null;
  switchToView('view-login');
}

// ---------- trips ----------
function renderTripsList() {
  if (!currentUser) return;
  document.getElementById('current-user-badge').innerText = `${currentUser.icon || '👤'} ${currentUser.name}`;
  return api('getAllTrips').then((res) => {
    if (!reportSaveResult(res)) return;
    const container = document.getElementById('trips-list-container');
    const trips = res.trips || [];
    if (!trips.length) {
      container.innerHTML = `<div class="text-center py-8 text-xs text-slate-400 font-bold bg-white/60 rounded-2xl border border-dashed border-slate-300">ยังไม่มีทริป กด + เพื่อสร้างทริปแรก</div>`;
      return;
    }
    // my trips first, then open trips, then past trips
    const rank = (t) => (t.myStatus ? 0 : 1) + (t.isPast ? 2 : 0);
    container.innerHTML = trips.slice().sort((a, b) => rank(a) - rank(b) || String(b.startDate).localeCompare(String(a.startDate))).map(tripCardHtml).join('');
  }).catch(quiet);
}

function tripCardHtml(t) {
  const badges = {
    Host: '<span class="badge badge-primary text-[9px] font-black text-white">Host</span>',
    Approved: '<span class="badge badge-success text-[9px] font-black text-white">สมาชิก</span>',
    Pending: '<span class="badge badge-warning text-[9px] font-black">รออนุมัติ</span>'
  };
  let action;
  if (t.myStatus === 'Host' || t.myStatus === 'Approved') {
    action = `<button onclick="enterTripDashboard(${jsArg(t.id)})" class="btn btn-sm btn-primary text-white text-xs font-black rounded-xl px-4 h-8 min-h-0">เข้าสู่ทริป ➔</button>`;
  } else if (t.myStatus === 'Pending') {
    action = `<span class="text-[11px] text-amber-600 font-black">⏳ รอ Host อนุมัติ</span>`;
  } else if (!t.isPast) {
    action = `<button onclick="joinTrip(${jsArg(t.id)}, ${jsArg(t.title)})" class="btn btn-sm btn-secondary text-white text-xs font-black rounded-xl px-4 h-8 min-h-0">Join Trip 🙋</button>`;
  } else {
    action = `<span class="text-[11px] text-slate-400 font-bold">ทริปจบแล้ว</span>`;
  }
  return `
    <div class="card bg-white border border-slate-200 rounded-2xl p-4 shadow-2xs ${t.isPast ? 'opacity-70' : ''}">
      <div class="flex justify-between items-start gap-2">
        <div class="min-w-0 flex-1">
          <h4 class="font-black text-slate-800 text-base">🗺️ ${escapeHtml(t.title)}</h4>
          <p class="text-xs text-slate-400 font-bold truncate mt-0.5">${escapeHtml(t.desc || 'ไม่มีคำอธิบาย')}</p>
          <p class="text-[11px] text-slate-500 font-bold mt-1">📅 ${escapeHtml(formatDateRange(t.startDate, t.endDate))}${t.isPast ? ' · จบแล้ว' : ''}</p>
        </div>
        ${badges[t.myStatus] || ''}
      </div>
      <div class="flex justify-between items-center border-t border-slate-100 pt-3 mt-3">
        <span class="text-[10px] text-slate-400 font-black">Host: ${escapeHtml(t.hostName || '-')} · ${Number(t.memberCount) || 0} คน</span>
        ${action}
      </div>
    </div>`;
}

function joinTrip(tripId, title) {
  Swal.fire({
    title: 'ขอเข้าร่วมทริป?', text: `ส่งคำขอเข้าร่วม "${title}" ให้ Host อนุมัติ`, icon: 'question', showCancelButton: true,
    confirmButtonText: 'ส่งคำขอ', cancelButtonText: 'ยกเลิก'
  }).then((r) => {
    if (!r.isConfirmed) return;
    runWrite('requestJoinTrip', { tripId }, () => { Swal.fire('ส่งคำขอแล้ว', 'รอ Host อนุมัติ', 'success'); renderTripsList(); });
  });
}

function handleCreateTrip() {
  const title = document.getElementById('trip-title').value.trim();
  const desc = document.getElementById('trip-desc').value.trim();
  const startDate = document.getElementById('trip-start').value;
  const endDate = document.getElementById('trip-end').value;
  if (!title) return Swal.fire('แจ้งเตือน', 'กรุณาระบุชื่อทริป', 'warning');
  if (!startDate || !endDate || endDate < startDate) return Swal.fire('แจ้งเตือน', 'กรุณาระบุวันเริ่มและวันจบ (วันจบต้องไม่ก่อนวันเริ่ม)', 'warning');
  runWrite('createTrip', { title, desc, startDate, endDate }, () => {
    closeBottomSheet('modal-add-trip');
    return renderTripsList();
  });
}

// ---------- dashboard ----------
function isHost() {
  return !!(globalTripData && globalTripData.me && globalTripData.me.role === 'Host');
}

function tripKey(tripId) {
  return `${TRIP_KEY}${currentUser ? currentUser.id : ''}_${tripId}`;
}

// Saved copy on the phone → shown at once and refreshed ("กำลังอัปเดต" line). First visit → progress popup.
function enterTripDashboard(tripId) {
  currentTripId = tripId;
  tripDataFresh = false;
  const saved = storageGet(tripKey(tripId));
  if (saved && saved.success) {
    globalTripData = saved;
    renderFullDashboardUI();
    switchToView('view-dashboard');
    switchMainTab('iti');
    refreshTrip().catch(quiet);
    return;
  }
  const progress = showTripProgress();
  api('getTripFinancialData', { tripId }).then((data) => {
    progress.stop();
    if (tripId !== currentTripId) return;
    if (!reportSaveResult(data)) { currentTripId = null; return; }
    Swal.close();
    applyTripData(data);
    switchToView('view-dashboard');
    switchMainTab('iti');
  }).catch((e) => {
    progress.stop();
    if (tripId === currentTripId) currentTripId = null;   // never entered: the trip list must not stay "in a trip"
    quiet(e);
  });
}

function applyTripData(data) {
  globalTripData = data;
  tripDataFresh = true;
  tripLoadedAt = Date.now();
  storageSet(tripKey(currentTripId), data);
  renderFullDashboardUI();
}

// Reloads the open trip (itinerary + money); a second call while one runs gets the same promise.
function refreshTrip() {
  if (tripRefresh) return tripRefresh;
  const tripId = currentTripId;
  if (!tripId) return Promise.resolve();
  setTripUpdating(true);
  tripRefresh = api('getTripFinancialData', { tripId }).then((data) => {
    if (tripId !== currentTripId) return;
    if (data && data.success) return applyTripData(data);
    storageRemove(tripKey(tripId));     // e.g. removed from the trip
    reportSaveResult(data);
    backToTrips();
  }).finally(() => {
    tripRefresh = null;
    if (tripId === currentTripId) setTripUpdating(false);
  });
  return tripRefresh;
}

// After a save: same reload, errors already shown by api().
function reloadTripDashboard() {
  return refreshTrip().catch(quiet);
}

// Back in the app (phone unlocked / switched back) with old trip data on screen → reload it.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !currentTripId || !globalTripData) return;
  if (Date.now() - tripLoadedAt > TRIP_STALE_MS) refreshTrip().catch(quiet);
});

// A1: popup with an estimated percentage — Google gives no real progress, so it creeps towards 90 %
// (about 57 % at 8 s, 86 % at 24 s) and the popup closes when the answer is in.
function showTripProgress() {
  const t0 = Date.now();
  Swal.fire({
    title: 'กำลังโหลดข้อมูลทริป...', showConfirmButton: false, allowOutsideClick: false,
    html: `<div class="trip-progress"><div id="trip-progress-bar" class="trip-progress-fill" style="width:3%"></div></div>
      <div id="trip-progress-pct" class="trip-progress-pct">3%</div>
      <div class="trip-progress-note">ครั้งแรกอาจใช้เวลา 10-30 วินาที</div>`
  });
  const timer = setInterval(() => {
    const box = Swal.getHtmlContainer();
    const bar = box && box.querySelector('#trip-progress-bar');
    if (!bar) return clearInterval(timer);            // popup replaced (error, other message)
    const pct = Math.max(3, Math.round(90 * (1 - Math.exp(-(Date.now() - t0) / 10000))));
    bar.style.width = pct + '%';
    box.querySelector('#trip-progress-pct').innerText = pct + '%';
  }, 250);
  return { stop: () => clearInterval(timer) };
}

// B1: running line under the trip title + "กำลังอัปเดต..." in place of the dates.
let tripUpdating = false;
function setTripUpdating(on) {
  tripUpdating = on;
  document.getElementById('dash-updating-line').classList.toggle('hidden', !on);
  renderTripDatesLine();
}

function renderTripDatesLine() {
  const el = document.getElementById('dash-trip-dates');
  const trip = (globalTripData && globalTripData.trip) || {};
  el.innerText = tripUpdating ? '🔄 กำลังอัปเดตข้อมูลล่าสุด...' : `📅 ${formatDateRange(trip.startDate, trip.endDate)}`;
  el.classList.toggle('dash-updating-text', tripUpdating);
}

function renderFullDashboardUI() {
  if (!globalTripData) return;
  const data = globalTripData;
  const trip = data.trip || {};
  document.getElementById('dash-trip-title').innerText = trip.title || 'ทริป';
  renderTripDatesLine();
  document.getElementById('dash-edit-dates-btn').classList.toggle('hidden', !isHost());
  document.getElementById('add-member-btn').classList.toggle('hidden', !isHost());

  const membersContainer = document.getElementById('trip-members-list-container');
  membersContainer.innerHTML = (data.members || []).map((m) => `
    <div class="badge badge-outline gap-1 text-[11px] font-bold p-2 bg-slate-50 border-slate-200">
      <span>${memberLabel(m)}</span>
      ${m.role === 'Host' ? `<span class="text-[9px] text-primary font-black ml-1">(Host)</span>`
        : isHost() ? `<button onclick="removeTripMember(${jsArg(m.id)}, ${jsArg(m.name)})" class="text-rose-500 hover:text-rose-700 ml-1 font-black">×</button>` : ''}
    </div>`).join('');

  const hostBox = document.getElementById('host-approval-box');
  const pending = isHost() ? (data.pendingMembers || []) : [];
  hostBox.classList.toggle('hidden', !pending.length);
  document.getElementById('pending-members-list').innerHTML = pending.map((pm) =>
    `<div class="flex items-center justify-between bg-white p-2 rounded-xl border border-amber-200 text-xs"><span class="font-bold">${memberLabel(pm)}</span><div class="flex gap-1"><button onclick="handleMemberAction(${jsArg(pm.id)}, 'reject')" class="btn btn-2xs btn-error text-white font-bold">ปฏิเสธ</button><button onclick="handleMemberAction(${jsArg(pm.id)}, 'accept')" class="btn btn-2xs btn-success text-white font-bold">อนุมัติ ✅</button></div></div>`).join('');

  const tabsBar = document.getElementById('itinerary-day-tabs-bar');
  const uniqueDates = [...new Set((data.itinerary || []).map((item) => item.date).filter(Boolean))].sort();
  if (uniqueDates.length) {
    if (!uniqueDates.includes(activeSelectedDayDate)) activeSelectedDayDate = uniqueDates[0];
    tabsBar.innerHTML = uniqueDates.map((dStr) => {
      const cls = activeSelectedDayDate === dStr
        ? 'btn btn-sm btn-primary text-white font-black rounded-xl text-xs px-3 shrink-0 whitespace-nowrap'
        : 'btn btn-sm bg-slate-100 border border-slate-200 font-bold rounded-xl text-slate-600 text-xs px-3 shrink-0 whitespace-nowrap';
      return `<button type="button" onclick="changeActiveDayTab(${jsArg(dStr)})" class="${cls}">${escapeHtml(dStr)}</button>`;
    }).join('');
  } else {
    tabsBar.innerHTML = `<span class="text-[11px] text-slate-400 font-bold">ยังไม่มีแผนกิจกรรม</span>`;
  }
  renderItineraryTimeline();
  reCalculateAndRenderFinancialViews();
}

function openEditTripDates() {
  const trip = (globalTripData && globalTripData.trip) || {};
  document.getElementById('edit-trip-start').value = trip.startDate || '';
  document.getElementById('edit-trip-end').value = trip.endDate || '';
  openBottomSheet('modal-edit-trip-dates');
}

function submitEditTripDates() {
  const startDate = document.getElementById('edit-trip-start').value;
  const endDate = document.getElementById('edit-trip-end').value;
  if (!startDate || !endDate || endDate < startDate) return Swal.fire('แจ้งเตือน', 'วันจบต้องไม่ก่อนวันเริ่ม', 'warning');
  closeBottomSheet('modal-edit-trip-dates');
  runWrite('updateTripDates', { tripId: currentTripId, startDate, endDate }, reloadTripDashboard);
}

// ---------- members ----------
function openAddMemberModal() {
  const select = document.getElementById('add-member-user-select');
  const inTrip = new Set((globalTripData.members || []).map((m) => m.id));
  select.innerHTML = `<option value="" disabled selected>เลือกสมาชิก</option>` +
    cachedUsers.filter((u) => !inTrip.has(u.id)).map((u) => `<option value="${escapeHtml(u.id)}">${memberLabel(u)}</option>`).join('');
  openBottomSheet('modal-add-member');
}

function submitAddTripMember() {
  const userId = document.getElementById('add-member-user-select').value;
  if (!userId) return Swal.fire('แจ้งเตือน', 'กรุณาเลือกชื่อสมาชิก', 'warning');
  closeBottomSheet('modal-add-member');
  runWrite('addMemberToTrip', { tripId: currentTripId, userId }, reloadTripDashboard);
}

function removeTripMember(userId, userName) {
  confirmDanger(`ยืนยันลบ ${userName}?`, 'สมาชิกคนนี้จะถูกถอดออกจากทริป (ลบได้เฉพาะคนที่ยังไม่มีชื่อในบิล มัดจำ หรือการโอน)', 'ใช่, ลบออก!').then((ok) => {
    if (!ok) return;
    runWrite('removeTripMember', { tripId: currentTripId, userId }, reloadTripDashboard);
  });
}

function handleMemberAction(targetUserId, type) {
  runWrite('handleMemberAction', { tripId: currentTripId, targetUserId, type }, reloadTripDashboard);
}

// ---------- itinerary ----------
function renderItineraryTimeline() {
  const itiContainer = document.getElementById('itinerary-timeline');
  const filtered = ((globalTripData && globalTripData.itinerary) || []).filter((item) => item.date === activeSelectedDayDate);
  if (!filtered.length) {
    itiContainer.innerHTML = `<div class="text-slate-400 text-xs py-8 font-bold text-center bg-slate-50 border border-dashed rounded-xl">ไม่มีกิจกรรมในวันนี้</div>`;
    return;
  }
  itiContainer.innerHTML = filtered.sort((a, b) => (a.time || '').localeCompare(b.time || '')).map((item) => {
    const href = safeUrl(item.mapUrl);
    const map = href ? `<a href="${href}" target="_blank" rel="noopener" class="btn btn-sm btn-circle text-white shadow-md flex items-center justify-center w-7 h-7" style="background-color:#0284c7 !important; border:0;"><i class="fa-solid fa-location-dot text-xs"></i></a>` : '';
    return `
      <div class="relative mb-3" id="iti-row-${escapeHtml(item.id)}">
        <span class="absolute -left-[21px] top-1.5 bg-primary w-2 h-2 rounded-full"></span>
        <div class="text-xs font-black text-white px-2.5 py-0.5 rounded-md inline-block mb-1 shadow-3xs" style="background-color: #FF3483 !important;">⏰ เวลา ${escapeHtml(item.time)} น.</div>
        <div class="bg-slate-50 border-2 border-slate-200 p-3 rounded-2xl flex justify-between items-center shadow-3xs relative">
          <div class="min-w-0 flex-1 pr-2">
            <div class="font-black text-base text-slate-800 truncate">${escapeHtml(item.activity)}</div>
            <div class="text-xs text-slate-400 font-bold truncate mt-0.5"><i class="fa-solid fa-map-pin mr-1 text-slate-300"></i>${escapeHtml(item.location || 'ไม่ได้ระบุสถานที่')}</div>
          </div>
          <div class="shrink-0 flex items-center gap-1.5">
            ${map}
            <button onclick="openEditItineraryModal(${[item.id, item.date, item.time, item.activity, item.location, item.mapUrl].map(jsArg).join(', ')})" class="btn btn-sm btn-circle btn-ghost text-slate-400 hover:text-amber-600 hover:bg-amber-50 w-7 h-7 min-h-0 flex items-center justify-center" title="แก้ไข"><i class="fa-solid fa-pen-to-square text-xs"></i></button>
            ${item.id ? `<button onclick="deleteItineraryItem(${jsArg(item.id)})" class="btn btn-sm btn-circle btn-ghost text-slate-400 hover:text-rose-600 hover:bg-rose-50 w-7 h-7 min-h-0 flex items-center justify-center" title="ลบแผน"><i class="fa-solid fa-trash-can text-xs"></i></button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

function setItiForm(mode, values) {
  const v = values || {};
  document.getElementById('iti-edit-id').value = v.id || '';
  document.getElementById('iti-mode').value = mode;
  document.getElementById('iti-old-date').value = v.date || '';
  document.getElementById('iti-old-time').value = v.time || '';
  document.getElementById('iti-date').value = v.date || activeSelectedDayDate || '';
  document.getElementById('iti-time').value = v.time || '12:00';
  document.getElementById('iti-act').value = v.activity || '';
  document.getElementById('iti-loc').value = v.location || '';
  document.getElementById('iti-map').value = v.mapUrl || '';
  document.getElementById('iti-modal-title').innerText = mode === 'edit' ? '✏️ แก้ไขแผนการเดินทาง' : '📌 เพิ่มกิจกรรมลงบนแผนการเดินทาง';
  document.getElementById('iti-submit-btn').innerText = mode === 'edit' ? 'บันทึกการแก้ไข 💾' : 'บันทึกลงปฏิทินทริป ⏰';
  openBottomSheet('modal-add-itinerary');
}

function openAddItineraryModal() {
  setItiForm('add');
}

function openEditItineraryModal(id, date, time, activity, location, mapUrl) {
  setItiForm('edit', { id, date, time, activity, location, mapUrl });
}

function handleRegisterItinerary() {
  const isEdit = document.getElementById('iti-mode').value === 'edit';
  const payload = {
    tripId: currentTripId,
    id: document.getElementById('iti-edit-id').value,
    oldDate: document.getElementById('iti-old-date').value,
    oldTime: document.getElementById('iti-old-time').value,
    date: document.getElementById('iti-date').value,
    time: document.getElementById('iti-time').value,
    activity: document.getElementById('iti-act').value.trim(),
    location: document.getElementById('iti-loc').value.trim(),
    mapUrl: document.getElementById('iti-map').value.trim()
  };
  if (!payload.date || !payload.time || !payload.activity) return Swal.fire('แจ้งเตือน', 'กรุณากรอกวันที่ เวลา และชื่อกิจกรรม', 'warning');
  runWrite(isEdit ? 'updateItinerary' : 'addItinerary', payload, () => {
    closeBottomSheet('modal-add-itinerary');
    activeSelectedDayDate = payload.date;
    return reloadTripDashboard();
  });
}

function deleteItineraryItem(itemId) {
  confirmDanger('ยืนยันลบแผนกิจกรรมนี้?', 'รายการกิจกรรมนี้จะถูกลบทิ้งจากแผนการเดินทาง').then((ok) => {
    if (!ok) return;
    runWrite('deleteItinerary', { tripId: currentTripId, id: itemId }, reloadTripDashboard);
  });
}

function changeActiveDayTab(dStr) {
  activeSelectedDayDate = dStr;
  renderFullDashboardUI();
}

// ---------- money: render ----------
function reCalculateAndRenderFinancialViews() {
  if (!globalTripData) return;
  document.getElementById('cost-total-display').innerText = `${money(globalTripData.totalTripExpense)} บาท`;
  renderTab1();
  renderTab2();
  renderTab3();
  renderTab4();
}

function memberById(id) {
  return ((globalTripData && globalTripData.members) || []).find((m) => m.id === id);
}

// Escaped HTML label for a member id (falls back to the name the server sent).
function nameHtml(id, fallbackName) {
  const m = memberById(id);
  return m ? memberLabel(m) : escapeHtml(fallbackName || id || 'สมาชิก');
}

function renderTab1() {
  const box = document.getElementById('tab1-list-container');
  const bills = globalTripData.tab1Expenses || [];
  if (!bills.length) {
    box.innerHTML = `<div class="text-center py-6 text-xs text-slate-400 font-bold bg-slate-50 rounded-xl border border-dashed">ยังไม่มีบิล</div>`;
    return;
  }
  const me = currentUser.id;
  box.innerHTML = bills.map((h) => {
    const canDelete = isHost() || h.payerId === me || h.createdBy === me;
    const splitsHtml = (h.splits || []).map((s) =>
      `<div class="text-[11px] text-slate-600 font-bold pl-4 border-l-2 border-slate-200">${nameHtml(s.id, s.name)} ➔ ส่วนที่ต้องจ่าย: ${money(s.share)}</div>`).join('');
    return `
      <div id="tab1-row-${escapeHtml(h.billId)}" class="w-full mb-2 bg-slate-50 border border-slate-200 rounded-xl overflow-hidden relative">
        <div class="p-3 flex justify-between items-start">
          <div class="min-w-0 flex-1 pr-2">
            <span class="font-black text-slate-800 text-sm block truncate">${escapeHtml(h.note)}</span>
            <span class="text-[10px] text-slate-400 font-bold mt-0.5 block">${escapeHtml(h.category)} • คนจ่าย: ${nameHtml(h.payerId, h.payerName)}</span>
            <div class="font-black text-slate-700 mt-1 text-sm">ยอดบิล: ${money(h.totalAmount)}</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            ${attachBtnHtml('bill', h.billId, h.note)}
            <button type="button" onclick="toggleDetails(this, ${jsArg('tab1-col-' + h.billId)})" class="btn btn-xs bg-slate-200 border-0 hover:bg-slate-300 text-slate-700 font-bold rounded-lg text-[10px] px-2 min-h-0 h-6">Show 🔽</button>
            ${canDelete ? `<button type="button" onclick="deleteTab1Bill(${jsArg(h.billId)})" class="btn btn-xs btn-circle btn-error text-white border-0 bg-red-500 w-6 h-6 min-h-0 flex items-center justify-center"><i class="fa-solid fa-trash-can text-[10px]"></i></button>` : ''}
          </div>
        </div>
        <div id="tab1-col-${escapeHtml(h.billId)}" class="hidden bg-white border-t border-slate-100 p-3 space-y-1.5">${splitsHtml}</div>
      </div>`;
  }).join('');
}

function renderTab2() {
  const box = document.getElementById('tab2-list-container');
  const deposits = globalTripData.tab2Deposits || [];
  if (!deposits.length) {
    box.innerHTML = `<div class="text-center py-6 text-xs text-slate-400 font-bold bg-slate-50 rounded-xl border border-dashed">ยังไม่มีโครงการมัดจำ</div>`;
    return;
  }
  const me = currentUser.id;
  box.innerHTML = deposits.map((h) => {
    const canDelete = isHost() || h.createdBy === me;
    const detailsHtml = (h.details || []).map((d) =>
      `<div class="text-[11px] text-slate-600 font-bold pl-4 border-l-2 border-slate-200">${nameHtml(d.id, d.name)} ${d.isTarget ? '🎯 ร่วมหาร' : ''} ➔ มัดจำ: ${money(d.deposit)}</div>`).join('');
    let status;
    if (!h.counted) {
      status = `<button id="btn-final-t2-${escapeHtml(h.depId)}" onclick="openFinalPaymentManager(${jsArg(h.depId)}, ${jsArg(h.note)}, ${Number(h.fullCost) || 0}, ${Number(h.totalDeposit) || 0})" class="btn btn-xs btn-primary font-bold h-6 min-h-0 text-[10px] px-2 rounded-lg">บันทึกจ่ายวันจริง 🏨</button>`;
    } else if (h.finalPayerId) {
      status = `<span class="badge badge-success text-white text-[9px] font-black p-1.5 h-5">${escapeHtml(h.finalPayerName)} จ่ายวันจริงแล้ว · นับในสรุปการโอน</span>`;
    } else {
      status = `<span class="badge badge-success text-white text-[9px] font-black p-1.5 h-5">มัดจำครบแล้ว · นับในสรุปการโอน</span>`;
    }
    return `
      <div id="tab2-row-${escapeHtml(h.depId)}" class="w-full mb-2 bg-slate-50 border border-slate-200 rounded-xl overflow-hidden relative">
        <div class="p-3 flex justify-between items-start">
          <div class="min-w-0 flex-1 pr-2">
            <span class="font-black text-slate-800 text-sm block truncate">${escapeHtml(h.note)}</span>
            <span class="text-[10px] text-slate-400 font-bold block mt-0.5">ราคาเต็ม: ${money(h.fullCost)} · มัดจำแล้ว: ${money(h.totalDeposit)}</span>
            <span class="text-[10px] font-bold text-slate-500 block mt-1">จ่ายวันจริง: <b class="text-slate-700">${money(h.remaining)}</b></span>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            ${attachBtnHtml('deposit', h.depId, h.note)}
            <button type="button" onclick="toggleDetails(this, ${jsArg('tab2-col-' + h.depId)})" class="btn btn-xs bg-slate-200 border-0 hover:bg-slate-300 text-slate-700 font-bold rounded-lg text-[10px] px-2 min-h-0 h-6">Show 🔽</button>
            ${canDelete ? `<button type="button" onclick="deleteTab2Bill(${jsArg(h.depId)})" class="btn btn-xs btn-circle btn-error text-white border-0 bg-red-500 w-6 h-6 min-h-0 flex items-center justify-center"><i class="fa-solid fa-trash-can text-[10px]"></i></button>` : ''}
          </div>
        </div>
        <div class="px-3 pb-3 flex justify-end">${status}</div>
        <div id="tab2-col-${escapeHtml(h.depId)}" class="hidden bg-white border-t border-slate-100 p-3 space-y-1.5">${detailsHtml}</div>
      </div>`;
  }).join('');
}

function renderTab3() {
  const box = document.getElementById('tab3-list-container');
  const data = globalTripData;
  const me = currentUser.id;
  const instructions = ((data.tab3Settlements || [])[0] || {}).instructions || [];
  let html = '';
  if (data.settled) {
    html += `<div class="p-3 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-black text-center">✅ เคลียร์เงินกันครบแล้ว ไม่มีใครค้างใคร</div>`;
  } else if (!instructions.length) {
    html += `<div class="text-center py-6 text-xs text-slate-400 font-bold bg-slate-50 rounded-xl border border-dashed">ยังไม่มีค่าใช้จ่ายที่ต้องโอน</div>`;
  }
  if (data.awaitingDeposits) {
    html += `<div class="text-[10px] text-amber-700 font-bold bg-amber-50 border border-amber-200 rounded-xl p-2">⏳ มีมัดจำ ${data.awaitingDeposits} โครงการที่ยังไม่บันทึกจ่ายวันจริง — ยังไม่นับในยอดนี้</div>`;
  }
  html += instructions.map((ins) => {
    let action = '';
    if (ins.fromId === me) {
      action = `<button onclick="openTransferModal(${jsArg(ins.toId)}, ${Number(ins.amount) || 0})" class="btn btn-xs btn-success text-white font-black rounded-lg h-7 min-h-0">โอนแล้ว ✅</button>`;
    } else if (ins.toId === me) {
      action = `<span class="badge badge-info text-white text-[9px] font-black">รอรับเงิน</span>`;
    }
    const highlight = ins.fromId === me || ins.toId === me ? 'border-primary bg-primary/5' : 'border-slate-200 bg-white';
    return `
      <div class="flex justify-between items-center gap-2 p-3 rounded-2xl border ${highlight} text-xs font-bold">
        <div class="min-w-0">
          <div class="text-slate-700">${nameHtml(ins.fromId, ins.fromName)} ➔ ${nameHtml(ins.toId, ins.toName)}</div>
          <div class="text-rose-600 font-black text-sm mt-0.5">${money(ins.amount)}</div>
        </div>
        ${action}
      </div>`;
  }).join('');

  const history = data.transfers || [];
  if (history.length) {
    html += `<div class="text-[11px] font-black text-slate-500 mt-3">🧾 ประวัติการโอนที่บันทึกแล้ว</div>`;
    html += history.slice().reverse().map((t) => {
      const canDelete = isHost() || t.fromId === me || t.toId === me;
      return `
        <div class="flex justify-between items-center gap-2 px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-[11px] font-bold">
          <span class="text-slate-600">${nameHtml(t.fromId, t.fromName)} ➔ ${nameHtml(t.toId, t.toName)} · <b>${money(t.amount)}</b></span>
          <span class="flex items-center gap-2 shrink-0">
            ${attachBtnHtml('transfer', t.transferId, `โอน ${t.fromName} ➔ ${t.toName} ${money(t.amount)}`)}
            ${canDelete ? `<button onclick="deleteTransfer(${jsArg(t.transferId)})" class="text-rose-500 font-black" title="ยกเลิกรายการโอน">✕</button>` : ''}
          </span>
        </div>`;
    }).join('');
  }
  box.innerHTML = html;
}

function renderTab4() {
  const box = document.getElementById('tab4-list-container');
  const reports = globalTripData.tab4Report || [];
  box.innerHTML = reports.map((r) => {
    const net = Number(r.net) || 0;
    const netText = Math.abs(net) < 0.01 ? '<span class="text-emerald-600">เคลียร์แล้ว</span>'
      : net > 0 ? `<span class="text-emerald-600">ได้คืนอีก ${money(net)}</span>` : `<span class="text-rose-600">ต้องจ่ายอีก ${money(-net)}</span>`;
    return `
      <div class="p-3.5 mb-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold space-y-1">
        <div class="text-slate-800 font-black">${nameHtml(r.id, r.name)}</div>
        <div class="flex justify-between"><span class="text-slate-500">ส่วนของฉัน (ค่าใช้จ่ายรวม)</span><span class="text-primary font-black">${money(r.share)}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">ฉันจ่ายออกไป</span><span>${money(r.paidOut)}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">ยอดสุทธิ (หลังหักการโอน)</span>${netText}</div>
      </div>`;
  }).join('') || `<div class="text-center py-6 text-xs text-slate-400 font-bold bg-slate-50 rounded-xl border border-dashed">ไม่พบข้อมูล</div>`;
}

// ---------- money: bills ----------
function switchFinTab(tabIdx) {
  activeCurrentFinTabIdx = tabIdx;
  for (let i = 1; i <= 4; i++) {
    const btn = document.getElementById(`tab-btn-${i}`);
    const content = document.getElementById(`fin-content-${i}`);
    if (i === tabIdx) {
      btn.className = 'tab flex-1 text-[11px] font-black rounded-xl px-1 truncate bg-primary text-white shadow-md shadow-cyan-500/30 border-2 border-primary transition-all scale-105 z-10';
      btn.style = '';
      content.classList.remove('hidden');
    } else {
      btn.className = 'tab flex-1 text-[11px] font-bold rounded-xl px-1 truncate bg-white text-slate-400 border border-slate-200 transition-all opacity-70';
      btn.style = 'background-color:#ffffff !important; color:#94a3b8 !important;';
      content.classList.add('hidden');
    }
  }
}

function openAddBillModal() {
  const members = globalTripData.members || [];
  document.getElementById('t1-payer-select').innerHTML = members.map((m) =>
    `<option value="${escapeHtml(m.id)}" ${m.id === currentUser.id ? 'selected' : ''}>${memberLabel(m)}</option>`).join('');
  document.getElementById('t1-members-checkbox-zone').innerHTML = members.map((m) => `
    <div class="flex items-center justify-between p-2 bg-white border border-slate-200 rounded-xl gap-2">
      <label class="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer min-w-0 flex-1 truncate">
        <input type="checkbox" name="chk-t1-user" value="${escapeHtml(m.id)}" checked onchange="refreshT1Amounts()" class="checkbox checkbox-primary checkbox-sm rounded-md">
        <span class="truncate">${memberLabel(m)}</span>
      </label>
      <div class="flex items-center gap-1 shrink-0 w-28">
        <input type="number" id="input-t1-amt-${escapeHtml(m.id)}" value="0" min="0" oninput="recalculateT1CustomAmounts()" class="input input-bordered input-xs w-full text-right font-bold text-slate-800 bg-slate-50" ${t1IsCustomMode ? '' : 'readonly'}>
        <span class="text-[10px] text-slate-400 font-bold">บ.</span>
      </div>
    </div>`).join('');
  refreshT1Amounts();
  openBottomSheet('modal-add-tab1');
}

function refreshT1Amounts() {
  if (t1IsCustomMode) recalculateT1CustomAmounts(); else calculateT1EqualSplit();
}

function toggleT1SplitMode() {
  t1IsCustomMode = document.getElementById('t1-custom-split-toggle').checked;
  document.querySelectorAll("input[id^='input-t1-amt-']").forEach((inp) => {
    if (t1IsCustomMode) inp.removeAttribute('readonly'); else inp.setAttribute('readonly', 'readonly');
  });
  document.getElementById('t1-balance-alert').classList.toggle('hidden', !t1IsCustomMode);
  refreshT1Amounts();
}

function calculateT1EqualSplit() {
  const totalAmt = parseFloat(document.getElementById('t1-amount').value) || 0;
  const checked = Array.from(document.querySelectorAll("input[name='chk-t1-user']:checked")).map((c) => c.value);
  document.querySelectorAll("input[id^='input-t1-amt-']").forEach((inp) => { inp.value = '0'; });
  if (!checked.length) return;
  const shares = splitEquallyCents(totalAmt, checked.length, checked.indexOf(document.getElementById('t1-payer-select').value));
  checked.forEach((id, i) => { document.getElementById(`input-t1-amt-${id}`).value = shares[i].toFixed(2); });
}

function recalculateT1CustomAmounts() {
  if (!t1IsCustomMode) return;
  const totalAmt = parseFloat(document.getElementById('t1-amount').value) || 0;
  const sumUsed = Array.from(document.querySelectorAll("input[name='chk-t1-user']:checked"))
    .reduce((acc, c) => acc + (parseFloat(document.getElementById(`input-t1-amt-${c.value}`).value) || 0), 0);
  const remaining = Math.round((totalAmt - sumUsed) * 100) / 100;
  document.getElementById('t1-lbl-total').innerText = totalAmt.toLocaleString();
  document.getElementById('t1-lbl-used').innerText = sumUsed.toLocaleString();
  const statusLbl = document.getElementById('t1-lbl-status');
  const alertBox = document.getElementById('t1-balance-alert');
  if (Math.abs(remaining) < 0.01) {
    statusLbl.innerText = 'ยอดเงินถูกต้องครบถ้วน ✅';
    alertBox.className = 'p-2.5 my-1.5 rounded-xl text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200';
  } else if (remaining > 0) {
    statusLbl.innerText = `ขาดอีก ${remaining.toLocaleString()} บาท`;
    alertBox.className = 'p-2.5 my-1.5 rounded-xl text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200';
  } else {
    statusLbl.innerText = `เกินอยู่ ${Math.abs(remaining).toLocaleString()} บาท`;
    alertBox.className = 'p-2.5 my-1.5 rounded-xl text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200';
  }
}

function submitTab1Expense() {
  const amt = parseFloat(document.getElementById('t1-amount').value);
  const note = document.getElementById('t1-note').value.trim();
  const category = document.getElementById('t1-cat').value;
  const payerId = document.getElementById('t1-payer-select').value;
  const checked = Array.from(document.querySelectorAll("input[name='chk-t1-user']:checked")).map((c) => c.value);
  if (!(amt > 0)) return Swal.fire('แจ้งเตือน', 'กรุณาระบุยอดเงินมากกว่า 0', 'warning');
  if (!note) return Swal.fire('แจ้งเตือน', 'กรุณาระบุชื่อรายการบิล', 'warning');
  if (!checked.length) return Swal.fire('แจ้งเตือน', 'กรุณาเลือกคนร่วมหารอย่างน้อย 1 คน', 'warning');

  // Equal mode sends ids only (server splits to the satang); custom mode sends each person's amount.
  let splits = checked;
  if (t1IsCustomMode) {
    splits = checked.map((id) => ({ id, amount: parseFloat(document.getElementById(`input-t1-amt-${id}`).value) || 0 }));
    const sum = splits.reduce((acc, s) => acc + s.amount, 0);
    if (Math.round(sum * 100) !== Math.round(amt * 100)) {
      return Swal.fire('ยอดไม่ตรง', `ยอดรายคนรวม ${sum.toLocaleString()} บาท ไม่เท่ากับยอดบิล ${amt.toLocaleString()} บาท`, 'warning');
    }
  }
  closeBottomSheet('modal-add-tab1');
  runWrite('addExpenseNew', { tripId: currentTripId, note, category, totalAmount: amt, payerId, splits }, () => {
    document.getElementById('t1-amount').value = '';
    document.getElementById('t1-note').value = '';
    return reloadTripDashboard();
  });
}

function deleteTab1Bill(billId) {
  confirmDanger('ยืนยันลบบิลนี้?', 'ยอดในสรุปการโอนจะถูกคำนวณใหม่ ถ้ามีคนโอนตามยอดเดิมไปแล้ว อาจต้องโอนคืนกัน').then((ok) => {
    if (!ok) return;
    runWrite('deleteExpenseNew', { billId }, reloadTripDashboard);
  });
}

// ---------- money: deposits ----------
function buildTab2DynamicMembersForm() {
  document.getElementById('t2-deposit-members-injector').innerHTML = (globalTripData.members || []).map((m) =>
    `<div class="flex items-center justify-between p-2.5 bg-white border border-slate-200 rounded-xl gap-2"><label class="flex items-center gap-2 text-xs font-black text-slate-700 min-w-0 flex-1 cursor-pointer truncate"><input type="checkbox" name="chk-t2-user" value="${escapeHtml(m.id)}" checked class="checkbox checkbox-secondary checkbox-sm rounded-md"><span class="truncate">${memberLabel(m)}</span></label><div class="flex items-center gap-1 shrink-0 w-36"><span class="text-[10px] text-slate-400 font-bold">มัดจำ:</span><input type="number" id="input-t2-depamt-${escapeHtml(m.id)}" value="0" min="0" class="input input-bordered input-xs w-full text-right font-bold text-slate-800 bg-white"><span class="text-[10px] text-slate-400 font-bold">บาท</span></div></div>`).join('');
}

function submitTab2DepositMaster() {
  const fullCost = parseFloat(document.getElementById('t2-fullcost').value) || 0;
  const note = document.getElementById('t2-note').value.trim();
  const category = document.getElementById('t2-cat').value;
  const splits = Array.from(document.getElementsByName('chk-t2-user')).map((c) => ({
    userId: c.value, isTarget: c.checked, depositAmount: parseFloat(document.getElementById(`input-t2-depamt-${c.value}`).value) || 0
  }));
  const totalDeposit = splits.reduce((acc, s) => acc + s.depositAmount, 0);
  if (!(fullCost > 0)) return Swal.fire('แจ้งเตือน', 'กรุณาระบุราคาเต็มมากกว่า 0', 'warning');
  if (!note) return Swal.fire('แจ้งเตือน', 'กรุณาระบุชื่อโครงการมัดจำ', 'warning');
  if (!splits.some((s) => s.isTarget)) return Swal.fire('แจ้งเตือน', 'กรุณาเลือกคนร่วมหารอย่างน้อย 1 คน', 'warning');
  if (splits.some((s) => s.depositAmount < 0)) return Swal.fire('แจ้งเตือน', 'เงินมัดจำห้ามติดลบ', 'warning');
  if (Math.round(totalDeposit * 100) > Math.round(fullCost * 100)) {
    return Swal.fire('แจ้งเตือน', `เงินมัดจำรวม ${totalDeposit.toLocaleString()} บาท เกินราคาเต็ม ${fullCost.toLocaleString()} บาท`, 'warning');
  }
  closeBottomSheet('modal-add-tab2-master');
  runWrite('addDepositMaster', { tripId: currentTripId, note, category, fullCost, splits }, reloadTripDashboard);
}

// The final payment is fixed at fullCost - deposits (agreed price); the user only picks who paid it.
function openFinalPaymentManager(depId, note, fullCost, totalDeposit) {
  document.getElementById('t2-final-depid').value = depId;
  const expectedPaid = Math.round((fullCost - totalDeposit) * 100) / 100;
  document.getElementById('t2-final-paid-input').value = expectedPaid.toFixed(2);
  document.getElementById('t2-final-info-label').innerText = `บิล: ${note} | ราคาเต็ม ${money(fullCost)} − มัดจำ ${money(totalDeposit)}`;
  document.getElementById('t2-final-payer-select').innerHTML = (globalTripData.members || []).map((m) =>
    `<option value="${escapeHtml(m.id)}" ${m.id === currentUser.id ? 'selected' : ''}>${memberLabel(m)}</option>`).join('');
  openBottomSheet('modal-add-tab2-final');
}

function submitTab2FinalPayment() {
  const depId = document.getElementById('t2-final-depid').value;
  const finalPayerId = document.getElementById('t2-final-payer-select').value;
  if (!finalPayerId) return Swal.fire('แจ้งเตือน', 'กรุณาเลือกคนที่จ่ายวันจริง', 'warning');
  closeBottomSheet('modal-add-tab2-final');
  runWrite('updateDepositFinalPayment', { depId, finalPayerId }, reloadTripDashboard);
}

function deleteTab2Bill(depId) {
  confirmDanger('ยืนยันลบโครงการมัดจำ?', 'รายการมัดจำทั้งหมดของโครงการนี้จะถูกลบ และยอดในสรุปการโอนจะคำนวณใหม่').then((ok) => {
    if (!ok) return;
    runWrite('deleteDepositFull', { depId }, reloadTripDashboard);
  });
}

// ---------- money: transfers ----------
function openTransferModal(toId, amount) {
  const m = memberById(toId);
  document.getElementById('xfer-to-id').value = toId;
  document.getElementById('xfer-to-label').innerText = m ? `${m.icon || '👤'} ${m.name}` : toId;
  document.getElementById('xfer-amount').value = (Number(amount) || 0).toFixed(2);
  openBottomSheet('modal-transfer');
}

function submitTransfer() {
  const toId = document.getElementById('xfer-to-id').value;
  const amount = parseFloat(document.getElementById('xfer-amount').value);
  if (!(amount > 0)) return Swal.fire('แจ้งเตือน', 'กรุณาระบุยอดที่โอนมากกว่า 0', 'warning');
  closeBottomSheet('modal-transfer');
  runWrite('addTransfer', { tripId: currentTripId, toId, amount }, reloadTripDashboard);
}

function deleteTransfer(transferId) {
  confirmDanger('ยกเลิกรายการโอนนี้?', 'ใช้เมื่อกดผิด หรือเงินยังไม่ถึงจริง — ยอดที่ต้องโอนจะกลับมาเหมือนเดิม', 'ใช่, ยกเลิก').then((ok) => {
    if (!ok) return;
    runWrite('deleteTransfer', { transferId }, reloadTripDashboard);
  });
}

// ---------- navigation ----------
function switchMainTab(tabName) {
  const isIti = tabName === 'iti';
  const on = 'flex flex-col items-center justify-center text-primary font-black transition-all bg-primary/10 border-t-2 border-primary shadow-inner';
  const off = 'flex flex-col items-center justify-center text-slate-400 font-bold transition-all bg-transparent border-0 opacity-60';
  document.getElementById('nav-btn-iti').className = isIti ? on : off;
  document.getElementById('nav-btn-fin').className = isIti ? off : on;
  document.getElementById('sub-view-itinerary').classList.toggle('hidden', !isIti);
  document.getElementById('sub-view-expenses').classList.toggle('hidden', isIti);
  if (!isIti) switchFinTab(activeCurrentFinTabIdx);
}

function openBottomSheet(id) {
  const el = document.getElementById(id); if (!el) return;
  el.classList.remove('hidden');
  setTimeout(() => {
    el.classList.add('opacity-100'); el.classList.remove('opacity-0');
    const body = el.querySelector('div'); if (body) body.classList.remove('translate-y-full');
  }, 10);
}

function closeBottomSheet(id) {
  const el = document.getElementById(id); if (!el) return;
  const body = el.querySelector('div'); if (body) body.classList.add('translate-y-full');
  el.classList.add('opacity-0'); el.classList.remove('opacity-100');
  setTimeout(() => { el.classList.add('hidden'); }, 300);
}

function backToTrips() {
  currentTripId = null;
  globalTripData = null;
  tripDataFresh = false;
  setTripUpdating(false);
  switchToView('view-trips');
  renderTripsList();
}

function switchToView(viewId) {
  ['view-login', 'view-trips', 'view-dashboard'].forEach((id) => { const el = document.getElementById(id); el.classList.add('hidden'); el.style.display = 'none'; });
  const nav = document.getElementById('app-bottom-navbar');
  nav.classList.toggle('hidden', viewId !== 'view-dashboard');
  const target = document.getElementById(viewId); target.classList.remove('hidden'); target.style.display = 'flex';
}

// Members popup (Show / Hide); a click anywhere else closes it.
function toggleMemberMenu(event) {
  if (event) event.stopPropagation();
  document.getElementById('trip-members-section').classList.toggle('show');
}

window.addEventListener('click', function () {
  const section = document.getElementById('trip-members-section');
  if (section && section.classList.contains('show')) section.classList.remove('show');
});

// ---------- photos (attachments) of bills, deposits and transfers ----------
// Photos live in a private Drive folder; the server sends the bytes only to trip members.
// The phone shrinks every photo to a JPEG (long side ATTACH_MAX_SIDE) before sending, one request per photo.
const ATTACH_MAX = 5;
const ATTACH_MAX_SIDE = 1280;
const ATTACH_MAX_BYTES = 2 * 1024 * 1024;
let attachCtx = null;           // { type, refId, title } of the open photo sheet
let attachUploading = false;
const attachImages = {};        // attId → data URL (kept while the app is open)

function attachList(type, refId) {
  return ((globalTripData && globalTripData.attachments) || {})[`${type}:${refId}`] || [];
}

function attachBtnHtml(type, refId, title) {
  const n = attachList(type, refId).length;
  return `<button type="button" onclick="openAttachments(${jsArg(type)}, ${jsArg(refId)}, ${jsArg(title)})" class="btn btn-xs bg-white border border-slate-300 text-slate-700 font-bold rounded-lg text-[10px] px-2 min-h-0 h-6" title="รูปแนบ">📎 ${n || '+'}</button>`;
}

function openAttachments(type, refId, title) {
  attachCtx = { type, refId, title };
  renderAttachSheet();
  openBottomSheet('modal-attachments');
}

function renderAttachSheet() {
  if (!attachCtx) return;
  const list = attachList(attachCtx.type, attachCtx.refId);
  const me = currentUser ? currentUser.id : '';
  document.getElementById('att-title').innerText = `📎 รูปแนบ · ${attachCtx.title || ''}`;
  document.getElementById('att-count').innerText = `${list.length} / ${ATTACH_MAX} รูป · แตะรูปเพื่อดูเต็มจอ`;
  const tiles = list.map((a) => `
    <div class="att-tile" onclick="viewAttachment(${jsArg(a.id)})">
      <img id="att-img-${escapeHtml(a.id)}" class="att-img" alt="">
      ${isHost() || a.createdBy === me ? `<button type="button" class="att-del" onclick="event.stopPropagation(); deleteAttachmentPhoto(${jsArg(a.id)})" title="ลบรูป">🗑</button>` : ''}
      <span class="att-who">${escapeHtml(a.createdByName || '')}</span>
    </div>`);
  if (list.length < ATTACH_MAX && !attachUploading) {
    tiles.push(`<button type="button" class="att-add" onclick="pickAttachmentFiles()"><span>＋</span>เพิ่มรูป</button>`);
  }
  document.getElementById('att-grid').innerHTML = tiles.join('');
  list.forEach((a) => loadAttachImage(a.id));
}

function loadAttachImage(attId) {
  const show = () => { const img = document.getElementById(`att-img-${attId}`); if (img) img.src = attachImages[attId]; };
  if (attachImages[attId]) return show();
  api('getAttachmentImage', { attId }).then((res) => {
    if (!res || !res.success) return;
    attachImages[attId] = `data:image/jpeg;base64,${res.data}`;
    show();
  }).catch(quiet);
}

function viewAttachment(attId) {
  if (!attachImages[attId]) return;          // still loading
  Swal.fire({ imageUrl: attachImages[attId], imageAlt: 'รูปแนบ', showConfirmButton: false, showCloseButton: true, width: '95%', padding: '0.5rem' });
}

function deleteAttachmentPhoto(attId) {
  confirmDanger('ลบรูปนี้?', 'ลบแล้วกู้คืนไม่ได้', 'ลบรูป').then((ok) => {
    if (ok) runWrite('deleteAttachment', { attId }, () => reloadTripDashboard().then(renderAttachSheet));
  });
}

function pickAttachmentFiles() {
  if (holdWhileTripUpdating()) return;
  document.getElementById('att-file').click();
}

function onAttachFilesPicked(input) {
  const files = Array.from(input.files || []);
  input.value = '';                           // picking the same photo again still fires onchange
  if (files.length) uploadAttachmentFiles(files);
}

// Sends the picked photos one by one (only as many as still fit); stops at the first problem and says which photo.
async function uploadAttachmentFiles(files) {
  if (!attachCtx || attachUploading || holdWhileTripUpdating()) return;
  const { type, refId } = attachCtx;
  const room = ATTACH_MAX - attachList(type, refId).length;
  const todo = files.slice(0, Math.max(0, room));
  if (!todo.length) return;
  attachUploading = true;
  renderAttachSheet();
  try {
    for (let i = 0; i < todo.length; i++) {
      setAttachProgress(i, todo.length, files.length > room ? `แนบได้อีก ${room} รูป จะอัป ${room} รูปแรก` : '');
      let data;
      try {
        data = await shrinkToJpegBase64(todo[i]);
      } catch (e) {
        Swal.fire({ title: 'เปิดรูปนี้ไม่ได้', text: `"${todo[i].name}" — กรุณาใช้รูป JPG หรือ PNG`, icon: 'error' });
        break;
      }
      const res = await api('addAttachment', { tripId: currentTripId, refType: type, refId, data }, { write: true });
      if (!reportSaveResult(res)) break;
    }
  } catch (e) {
    quiet(e);                                 // no answer: api() already told the user and reloads
  } finally {
    attachUploading = false;
    setAttachProgress(null);
    await reloadTripDashboard();
    renderAttachSheet();
  }
}

function setAttachProgress(done, total, note) {
  const box = document.getElementById('att-progress');
  box.classList.toggle('hidden', done === null);
  if (done === null) return;
  document.getElementById('att-progress-text').innerText = `กำลังอัปรูป ${done + 1}/${total} ...${note ? ' · ' + note : ''}`;
  document.getElementById('att-progress-bar').style.width = `${Math.max(5, Math.round((done / total) * 100))}%`;
}

// Long side at most `max`, ratio kept, never enlarged.
function fitSize(w, h, max) {
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('cannot decode')); };
    img.src = url;
  });
}

// Photo file → base64 JPEG (no data: prefix) of at most ATTACH_MAX_BYTES; quality steps down if needed.
async function shrinkToJpegBase64(file) {
  const img = await loadImageFile(file);
  const { w, h } = fitSize(img.naturalWidth, img.naturalHeight, ATTACH_MAX_SIDE);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';                     // transparent PNG → white, not black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  for (const q of [0.7, 0.55, 0.4, 0.25]) {
    const b64 = canvas.toDataURL('image/jpeg', q).split(',')[1];
    if (b64.length * 3 / 4 <= ATTACH_MAX_BYTES) return b64;
  }
  throw new Error('still too big');
}
