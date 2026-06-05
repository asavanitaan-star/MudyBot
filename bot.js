// ============================================================
//  LuckyCondo LINE Bot  —  Webhook + AI (Gemini / Ollama)
//  ความจำบทสนทนา + Quick Reply + ต้อนรับเพื่อนใหม่
//  + ระบบแอดมิน + ลงทะเบียนผู้เช่า + แจ้งซ่อม + ชำระเงิน + Broadcast
// ============================================================
require('dotenv').config({ override: true });

const express = require('express');
const line = require('@line/bot-sdk');
const { MessagingApiClient } = line.messagingApi;
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  SYSTEM_PROMPT, WELCOME_MESSAGE, QUICK_REPLY,
  GROUP_INTRO_MESSAGE, RENT_REMINDER, COMMAND_HELP, GROUP_TRIGGER,
} = require('./info');

// ─── Config ────────────────────────────────────────────────
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const OLLAMA_URL    = process.env.OLLAMA_URL    || 'http://localhost:11434';
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL  || 'qwen3:14b';
const PORT          = process.env.PORT          || 3000;
const LLM_PROVIDER  = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
const GEMINI_MODEL  = process.env.GEMINI_MODEL  || 'gemini-2.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_HISTORY   = 10;
const HISTORY_TTL_HOURS = 6;

// ─── Admin ─────────────────────────────────────────────────
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
function isAdmin(userId) { return ADMIN_IDS.includes(userId); }

// ─── Conversation Memory ───────────────────────────────────
const conversations = new Map();
const DB_FILE = path.join(__dirname, 'conversations.json');
let dirty = false;

function loadConversations() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) conversations.set(k, v);
      console.log(`   โหลดความจำเดิม ${conversations.size} คนจากไฟล์`);
    }
  } catch (e) { console.error('โหลดความจำไม่สำเร็จ:', e.message); }
}
function saveConversations() {
  if (!dirty) return;
  try { fs.writeFileSync(DB_FILE, JSON.stringify(Object.fromEntries(conversations)), 'utf8'); dirty = false; }
  catch (e) { console.error('บันทึกความจำไม่สำเร็จ:', e.message); }
}
function getHistory(userId) { return conversations.get(userId)?.messages || []; }
function pushHistory(userId, role, content) {
  let conv = conversations.get(userId);
  if (!conv) { conv = { messages: [], updatedAt: Date.now() }; conversations.set(userId, conv); }
  conv.messages.push({ role, content });
  if (conv.messages.length > MAX_HISTORY) conv.messages = conv.messages.slice(-MAX_HISTORY);
  conv.updatedAt = Date.now();
  dirty = true;
}
setInterval(() => {
  const cutoff = Date.now() - HISTORY_TTL_HOURS * 3600000;
  for (const [k, v] of conversations) if (v.updatedAt < cutoff) { conversations.delete(k); dirty = true; }
}, 3600000);
setInterval(saveConversations, 20000);

// ─── Groups ────────────────────────────────────────────────
const GROUPS_FILE = path.join(__dirname, 'groups.json');
const groups = new Set();
function loadGroups() {
  try {
    if (fs.existsSync(GROUPS_FILE)) {
      JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')).forEach(g => groups.add(g));
      console.log(`   โหลดรายชื่อกลุ่ม ${groups.size} กลุ่มจากไฟล์`);
    }
  } catch (e) { console.error('โหลดกลุ่มไม่สำเร็จ:', e.message); }
}
function saveGroups() {
  try { fs.writeFileSync(GROUPS_FILE, JSON.stringify([...groups]), 'utf8'); }
  catch (e) { console.error('บันทึกกลุ่มไม่สำเร็จ:', e.message); }
}
function rememberGroup(groupId) {
  if (groupId && !groups.has(groupId)) {
    groups.add(groupId); saveGroups();
    console.log(`   ➕ จำกลุ่มใหม่: ${groupId} (รวม ${groups.size} กลุ่ม)`);
  }
}

// ─── Rent Reminder ─────────────────────────────────────────
const REMINDERS_FILE = path.join(__dirname, 'reminders.json');
const reminderConfigs = new Map();
function loadReminders() {
  try {
    if (fs.existsSync(REMINDERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
      for (const [id, cfg] of Object.entries(data)) reminderConfigs.set(id, cfg);
      console.log(`   โหลดการตั้งค่าเตือน ${reminderConfigs.size} แชทจากไฟล์`);
    }
  } catch (e) { console.error('โหลดการตั้งค่าเตือนไม่สำเร็จ:', e.message); }
}
function saveReminders() {
  try { fs.writeFileSync(REMINDERS_FILE, JSON.stringify(Object.fromEntries(reminderConfigs)), 'utf8'); }
  catch (e) { console.error('บันทึกการตั้งค่าเตือนไม่สำเร็จ:', e.message); }
}
function getReminderConfig(chatId) {
  if (reminderConfigs.has(chatId)) return reminderConfigs.get(chatId);
  return { ...RENT_REMINDER, advanceDays: [...RENT_REMINDER.advanceDays] };
}
function setReminderConfig(chatId, cfg) { reminderConfigs.set(chatId, cfg); saveReminders(); }
function buildReminderText(cfg, daysBefore) {
  const head = daysBefore === 0
    ? `🔔 วันนี้ครบกำหนดชำระค่าเช่า (วันที่ ${cfg.dueDay} ของเดือน)`
    : `⏰ แจ้งเตือนล่วงหน้า: อีก ${daysBefore} วันจะครบกำหนดชำระค่าเช่า (วันที่ ${cfg.dueDay})`;
  const amountLine = cfg.amount ? `\n💰 ยอดชำระ: ${cfg.amount.toLocaleString('th-TH')} บาท` : '';
  return `${head}${amountLine}\n\n${cfg.message}`;
}
function formatReminderConfig(c) {
  const hh = String(c.hour).padStart(2, '0'), mm = String(c.minute).padStart(2, '0');
  const adv = c.advanceDays.length ? c.advanceDays.join(', ') + ' วัน' : 'ไม่มี';
  const amt = c.amount ? `${c.amount.toLocaleString('th-TH')} บาท` : 'ยังไม่ระบุ';
  return `⚙️ การตั้งค่าเตือนค่าเช่าของแชทนี้\n- สถานะ: ${c.enabled ? 'เปิด ✅' : 'ปิด ⛔'}\n- วันครบกำหนด: วันที่ ${c.dueDay}\n- ยอดค่าเช่า: ${amt}\n- เตือนล่วงหน้า: ${adv}\n- เวลาเตือน: ${hh}:${mm} น.`;
}
function occurrencesForMonth(cfg, year, month) {
  const due = new Date(year, month, cfg.dueDay, cfg.hour, cfg.minute, 0, 0);
  const list = [{ date: due, daysBefore: 0 }];
  for (const a of cfg.advanceDays) {
    const d = new Date(due); d.setDate(d.getDate() - a); list.push({ date: d, daysBefore: a });
  }
  return list;
}
const sameMinute = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate() && a.getHours() === b.getHours() && a.getMinutes() === b.getMinutes();
const firedKeys = new Set();
async function pushReminder(chatId, cfg, daysBefore) {
  try {
    await client.pushMessage({ to: chatId, messages: [{ type: 'text', text: buildReminderText(cfg, daysBefore) }] });
    console.log(`   💸 เตือนค่าเช่า -> ${chatId}`);
  } catch (e) { console.error(`ส่งเตือนไป ${chatId} ไม่สำเร็จ:`, e.message); }
}
setInterval(() => {
  const now = new Date();
  const targets = new Set([...groups, ...reminderConfigs.keys()]);
  for (const chatId of targets) {
    const cfg = getReminderConfig(chatId);
    if (!cfg.enabled) continue;
    const occ = [
      ...occurrencesForMonth(cfg, now.getFullYear(), now.getMonth()),
      ...occurrencesForMonth(cfg, now.getFullYear(), now.getMonth() + 1),
    ];
    for (const o of occ) {
      if (!sameMinute(now, o.date)) continue;
      const key = `${chatId}|${o.date.getTime()}`;
      if (firedKeys.has(key)) continue;
      firedKeys.add(key); pushReminder(chatId, cfg, o.daysBefore);
    }
  }
  const old = Date.now() - 2 * 86400000;
  for (const k of firedKeys) if (Number(k.split('|')[1]) < old) firedKeys.delete(k);
}, 60000);

// ─── Tenant Registry ───────────────────────────────────────
const TENANTS_FILE = path.join(__dirname, 'tenants.json');
const tenants = new Map(); // userId -> { room, name, registeredAt }

function loadTenants() {
  try {
    if (fs.existsSync(TENANTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TENANTS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) tenants.set(k, v);
      console.log(`   โหลดข้อมูลผู้เช่า ${tenants.size} รายจากไฟล์`);
    }
  } catch (e) { console.error('โหลดข้อมูลผู้เช่าไม่สำเร็จ:', e.message); }
}
function saveTenants() {
  try { fs.writeFileSync(TENANTS_FILE, JSON.stringify(Object.fromEntries(tenants)), 'utf8'); }
  catch (e) { console.error('บันทึกข้อมูลผู้เช่าไม่สำเร็จ:', e.message); }
}
function getRoomByUser(userId) { return tenants.get(userId)?.room || null; }
function getUserByRoom(room) {
  for (const [uid, t] of tenants) if (t.room === room.toUpperCase()) return { userId: uid, ...t };
  return null;
}
function formatTenantList() {
  if (tenants.size === 0) return 'ยังไม่มีผู้เช่าลงทะเบียนค่ะ';
  const rows = [...tenants.values()]
    .sort((a, b) => a.room.localeCompare(b.room, 'th'))
    .map(t => `  • ห้อง ${t.room} — ${t.name}`)
    .join('\n');
  return `👥 รายชื่อผู้เช่า (${tenants.size} ราย)\n${rows}`;
}

// ─── Date helpers (รับวันที่แบบไทย dd/mm/yyyy, ปี พ.ศ./ค.ศ.) ──
function parseThaiDate(str) {
  const m = String(str).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!m) return null;
  let d = +m[1], mo = +m[2], y = +m[3];
  if (y < 100) y += 2000;
  if (y > 2400) y -= 543; // พ.ศ. -> ค.ศ.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function formatThaiDate(iso) {
  if (!iso) return '-';
  const [y, mo, d] = iso.split('-').map(Number);
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return `${d} ${months[mo - 1]} ${y + 543}`;
}
function daysUntil(iso) {
  if (!iso) return null;
  const end = new Date(iso + 'T00:00:00+07:00');
  const now = new Date(Date.now() + 7 * 3600000);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((end - today) / 86400000);
}

// ─── Unit Profile (1 กลุ่ม = 1 ยูนิต/สัญญา) ─────────────────
const UNITS_FILE = path.join(__dirname, 'units.json');
const units = new Map(); // groupId -> { project, room, tenantName, tenantPhone, tenantUserId, ownerName, ownerPhone, rent, deposit, contractStart, contractEnd, bankAccount }

function loadUnits() {
  try {
    if (fs.existsSync(UNITS_FILE)) {
      const data = JSON.parse(fs.readFileSync(UNITS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) units.set(k, v);
      console.log(`   โหลดข้อมูลยูนิต ${units.size} ห้องจากไฟล์`);
    }
  } catch (e) { console.error('โหลดข้อมูลยูนิตไม่สำเร็จ:', e.message); }
}
function saveUnits() {
  try { fs.writeFileSync(UNITS_FILE, JSON.stringify(Object.fromEntries(units)), 'utf8'); }
  catch (e) { console.error('บันทึกข้อมูลยูนิตไม่สำเร็จ:', e.message); }
}
function getUnit(groupId) { return units.get(groupId) || null; }
function updateUnit(groupId, patch) {
  const u = units.get(groupId) || { createdAt: Date.now() };
  Object.assign(u, patch, { updatedAt: Date.now() });
  units.set(groupId, u); saveUnits();
  return u;
}
function formatUnit(groupId) {
  const u = units.get(groupId);
  if (!u) return '🏠 ยังไม่ได้ตั้งข้อมูลห้องของกลุ่มนี้ค่ะ\nแอดมินพิมพ์ "ตั้งข้อมูลห้อง" เพื่อเริ่มตั้งค่าได้เลย';
  const L = ['🏠 ข้อมูลห้อง'];
  const head = [u.project, u.room].filter(Boolean).join(' ');
  if (head) L.push(`- ห้อง: ${head}`);
  if (u.tenantName) L.push(`- ผู้เช่า: ${u.tenantName}${u.tenantPhone ? ' (' + u.tenantPhone + ')' : ''}`);
  if (u.ownerName) L.push(`- เจ้าของห้อง: ${u.ownerName}${u.ownerPhone ? ' (' + u.ownerPhone + ')' : ''}`);
  if (u.rent) L.push(`- ค่าเช่า: ${u.rent.toLocaleString('th-TH')} บาท/เดือน`);
  if (u.deposit) L.push(`- เงินประกัน: ${u.deposit.toLocaleString('th-TH')} บาท`);
  if (u.contractStart || u.contractEnd) {
    L.push(`- สัญญา: ${formatThaiDate(u.contractStart)} ถึง ${formatThaiDate(u.contractEnd)}`);
    const left = daysUntil(u.contractEnd);
    if (left !== null) L.push(left >= 0 ? `  (เหลืออีก ${left} วัน)` : `  (หมดอายุแล้ว ${Math.abs(left)} วัน)`);
  }
  if (u.bankAccount) L.push(`- บัญชีรับโอน: ${u.bankAccount}`);
  if (L.length === 1) return '🏠 ยังไม่ได้ตั้งข้อมูลห้องของกลุ่มนี้ค่ะ\nแอดมินพิมพ์ "ตั้งข้อมูลห้อง" เพื่อเริ่มตั้งค่าได้เลย';
  return L.join('\n');
}

// ─── Unit bulk setup (ใส่ข้อมูลทั้งหมดทีเดียว) ──────────────
const UNIT_FIELDS = [
  { key: 'project',     labels: ['โครงการ', 'อาคาร'] },
  { key: 'room',        labels: ['เลขที่ห้อง', 'เลขห้อง', 'ห้อง'] },
  { key: 'tenantName',  labels: ['ชื่อผู้เช่า', 'ผู้เช่า'] },
  { key: 'tenantPhone', labels: ['เบอร์ผู้เช่า', 'โทรผู้เช่า'] },
  { key: 'ownerName',   labels: ['ชื่อเจ้าของ', 'เจ้าของ'] },
  { key: 'ownerPhone',  labels: ['เบอร์เจ้าของ', 'โทรเจ้าของ'] },
  { key: 'rent',        labels: ['ค่าเช่า'], type: 'int' },
  { key: 'deposit',     labels: ['เงินประกัน', 'ประกัน'], type: 'int' },
  { key: 'contract',    labels: ['สัญญา'], type: 'daterange' },
  { key: 'bankAccount', labels: ['เลขบัญชี', 'บัญชี'] },
];
const UNIT_TEMPLATE = `ตั้งข้อมูลห้อง
โครงการ:
ห้อง:
ผู้เช่า:
เบอร์ผู้เช่า:
เจ้าของ:
เบอร์เจ้าของ:
ค่าเช่า:
ประกัน:
สัญญา:  -
บัญชี: `;
function unitTemplateMessage(groupId) {
  return `📝 ตั้งข้อมูลห้อง — ก๊อปข้อความด้านล่างไปแก้ แล้วส่งกลับมาทั้งก้อนได้เลยค่ะ\n(ช่องไหนไม่มีข้อมูล เว้นว่างหรือลบบรรทัดทิ้งได้ / สัญญาใส่ "เริ่ม - หมด")\n\n${UNIT_TEMPLATE}\n\n— — —\nข้อมูลปัจจุบัน:\n${formatUnit(groupId)}`;
}
function parseUnitBulk(body) {
  const flat = [];
  for (const f of UNIT_FIELDS) for (const lb of f.labels) flat.push({ lb, f });
  flat.sort((a, b) => b.lb.length - a.lb.length); // จับ label ที่ยาว/เจาะจงก่อน
  const data = {}, errors = [];
  for (let line of body.split('\n')) {
    line = line.trim();
    const idx = line.search(/[:：]/);
    if (idx < 0) continue;
    const label = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!value || value === '-') continue;
    const hit = flat.find(x => label.includes(x.lb));
    if (!hit) continue;
    const f = hit.f;
    if (f.type === 'int') {
      const n = parseInt(value.replace(/[,\s]/g, ''), 10);
      if (!n || n <= 0) { errors.push(`• ${label}: ต้องเป็นตัวเลข`); continue; }
      data[f.key] = n;
    } else if (f.type === 'daterange') {
      const parts = value.split(/\s*(?:-|–|—|ถึง|to)\s*/i).filter(Boolean);
      const s = parseThaiDate(parts[0] || ''), e = parseThaiDate(parts[1] || '');
      if (!s || !e) { errors.push('• สัญญา: รูปแบบวันที่ไม่ถูกต้อง (เช่น 1/1/2569 - 31/12/2569)'); continue; }
      data.contractStart = s; data.contractEnd = e;
    } else {
      data[f.key] = f.key === 'room' ? value.toUpperCase() : value;
    }
  }
  return { data, errors };
}

// ─── Rooms (ค่าเช่ารายห้อง) ─────────────────────────────────
const ROOMS_FILE = path.join(__dirname, 'rooms.json');
const rooms = new Map(); // room -> { rent }

function loadRooms() {
  try {
    if (fs.existsSync(ROOMS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) rooms.set(k, v);
      console.log(`   โหลดข้อมูลห้อง ${rooms.size} ห้องจากไฟล์`);
    }
  } catch (e) { console.error('โหลดข้อมูลห้องไม่สำเร็จ:', e.message); }
}
function saveRooms() {
  try { fs.writeFileSync(ROOMS_FILE, JSON.stringify(Object.fromEntries(rooms)), 'utf8'); }
  catch (e) { console.error('บันทึกข้อมูลห้องไม่สำเร็จ:', e.message); }
}
function getRoomRent(room) { return rooms.get(room.toUpperCase())?.rent || 0; }
function setRoomRent(room, rent) {
  const r = room.toUpperCase();
  const cfg = rooms.get(r) || {};
  cfg.rent = rent; rooms.set(r, cfg); saveRooms();
}
function allRoomNumbers() {
  return [...new Set([...[...tenants.values()].map(t => t.room), ...rooms.keys()])].sort();
}
function formatRoomList() {
  if (rooms.size === 0) return 'ยังไม่ได้ตั้งค่าเช่าห้องใดเลยค่ะ\nพิมพ์ "ตั้งค่าเช่า ห้อง 301 12000" เพื่อเริ่มค่ะ';
  const rows = [...rooms.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'th'))
    .map(([room, c]) => {
      const tenant = getUserByRoom(room);
      const who = tenant ? ` — ${tenant.name}` : '';
      return `  • ห้อง ${room}: ${c.rent ? c.rent.toLocaleString('th-TH') + ' บาท' : 'ยังไม่ระบุ'}${who}`;
    }).join('\n');
  return `🏠 ค่าเช่ารายห้อง (${rooms.size} ห้อง)\n${rows}`;
}

// ─── Repairs ───────────────────────────────────────────────
const REPAIRS_FILE = path.join(__dirname, 'repairs.json');
let repairs = [];
let repairIdCounter = 1;

function loadRepairs() {
  try {
    if (fs.existsSync(REPAIRS_FILE)) {
      const data = JSON.parse(fs.readFileSync(REPAIRS_FILE, 'utf8'));
      repairs = data.repairs || [];
      repairIdCounter = data.nextId || (repairs.length ? Math.max(...repairs.map(r => r.id)) + 1 : 1);
      console.log(`   โหลดข้อมูลแจ้งซ่อม ${repairs.length} รายการจากไฟล์`);
    }
  } catch (e) { console.error('โหลดข้อมูลแจ้งซ่อมไม่สำเร็จ:', e.message); }
}
function saveRepairs() {
  try { fs.writeFileSync(REPAIRS_FILE, JSON.stringify({ repairs, nextId: repairIdCounter }), 'utf8'); }
  catch (e) { console.error('บันทึกข้อมูลแจ้งซ่อมไม่สำเร็จ:', e.message); }
}
const REPAIR_STATUS = {
  pending: 'รอดำเนินการ ⏳',
  inprogress: 'กำลังดำเนินการ 🔧',
  done: 'เสร็จแล้ว ✅',
  cancel: 'ยกเลิก ❌',
};
function addRepair(userId, room, description, chatId) {
  const repair = { id: repairIdCounter++, userId, room, description, status: 'pending', chatId, createdAt: Date.now(), updatedAt: Date.now() };
  repairs.push(repair); saveRepairs(); return repair;
}
function getRepairsByRoom(room) {
  return repairs.filter(r => r.room === room.toUpperCase() && r.status !== 'cancel');
}
function formatRepairList(list, title) {
  if (!list.length) return `${title}\nไม่มีรายการค่ะ`;
  return `${title}\n` + list.map(r => {
    const d = new Date(r.createdAt + 7 * 3600000);
    const date = `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear() + 543}`;
    return `#${r.id} ห้อง ${r.room} — ${r.description}\n   สถานะ: ${REPAIR_STATUS[r.status] || r.status} (${date})`;
  }).join('\n\n');
}

// ─── Payments ──────────────────────────────────────────────
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');
const payments = new Map(); // "YYYY-MM" -> { room: { paid, paidAt, note, confirmedBy } }

function loadPayments() {
  try {
    if (fs.existsSync(PAYMENTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) payments.set(k, v);
      console.log(`   โหลดข้อมูลการชำระเงิน ${payments.size} เดือนจากไฟล์`);
    }
  } catch (e) { console.error('โหลดข้อมูลการชำระเงินไม่สำเร็จ:', e.message); }
}
function savePayments() {
  try { fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(Object.fromEntries(payments)), 'utf8'); }
  catch (e) { console.error('บันทึกข้อมูลการชำระเงินไม่สำเร็จ:', e.message); }
}
function currentMonthKey() {
  const now = new Date(Date.now() + 7 * 3600000);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
function thaiMonthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return `${months[m - 1]} ${y + 543}`;
}
function getPaymentMonth(key) {
  if (!payments.has(key)) payments.set(key, {});
  return payments.get(key);
}
function recordPayment(room, note, confirmedBy = null) {
  const key = currentMonthKey();
  const month = getPaymentMonth(key);
  month[room.toUpperCase()] = { paid: true, paidAt: Date.now(), note: note || '', confirmedBy };
  payments.set(key, month); savePayments();
}
function formatPaymentSummary(key) {
  const month = payments.get(key) || {};
  const label = thaiMonthLabel(key);
  const allRooms = allRoomNumbers();
  if (allRooms.length === 0) return `📊 สรุปการชำระเงิน ${label}\nยังไม่มีห้อง/ผู้เช่าค่ะ`;
  const paid = allRooms.filter(r => month[r]?.paid);
  const unpaid = allRooms.filter(r => !month[r]?.paid);
  const paidRows = paid.map(r => `  ✅ ห้อง ${r}${month[r].confirmedBy ? ' (ยืนยันแล้ว)' : ' (รอยืนยัน)'}`).join('\n');
  const unpaidRows = unpaid.map(r => {
    const rent = getRoomRent(r);
    return `  ❌ ห้อง ${r}${rent ? ' — ' + rent.toLocaleString('th-TH') + ' บาท' : ''}`;
  }).join('\n');
  const outstanding = unpaid.reduce((s, r) => s + getRoomRent(r), 0);
  const outLine = outstanding ? `\n\n💰 ยอดค้างรวม: ${outstanding.toLocaleString('th-TH')} บาท` : '';
  return `📊 สรุปการชำระเงิน ${label}\n\nชำระแล้ว (${paid.length}/${allRooms.length}):\n${paidRows || '  ยังไม่มี'}\n\nยังไม่ชำระ (${unpaid.length}):\n${unpaidRows || '  ไม่มี'}${outLine}`;
}

// ─── Reminder Command Handler ──────────────────────────────
function handleReminderCommand(text, chatId) {
  const t = text.trim();
  if (/^(คำสั่ง|ช่วยเหลือ|help|วิธีใช้)$/i.test(t)) return COMMAND_HELP;
  if (/^ดู.*(ตั้งค่า)?.*เตือน/.test(t)) return formatReminderConfig(getReminderConfig(chatId)) + '\n\nพิมพ์ "ลัคกี้ คำสั่ง" เพื่อดูวิธีแก้ไขค่ะ';
  if (/^(เตือนเดี๋ยวนี้|ทดสอบ.*เตือน|เตือนตอนนี้)/.test(t)) return buildReminderText(getReminderConfig(chatId), 0);
  if (/^เปิด.*เตือน/.test(t)) { const c = getReminderConfig(chatId); c.enabled = true; setReminderConfig(chatId, c); return '✅ เปิดการเตือนค่าเช่าของกลุ่มนี้แล้วค่ะ'; }
  if (/^ปิด.*เตือน/.test(t)) { const c = getReminderConfig(chatId); c.enabled = false; setReminderConfig(chatId, c); return '⛔ ปิดการเตือนค่าเช่าของกลุ่มนี้แล้วค่ะ'; }
  let m = t.match(/^ตั้ง.*ครบกำหนด\s*(\d{1,2})/);
  if (m) {
    const d = parseInt(m[1], 10);
    if (d < 1 || d > 28) return 'กรุณาระบุวันที่ระหว่าง 1-28 นะคะ';
    const c = getReminderConfig(chatId); c.dueDay = d; setReminderConfig(chatId, c);
    return `✅ ตั้งวันครบกำหนดชำระเป็นวันที่ ${d} ของเดือนแล้วค่ะ`;
  }
  m = t.match(/^ตั้งเตือนล่วงหน้า\s*([\d,\s]+?)\s*วัน?/);
  if (m) {
    const days = m[1].split(/[,\s]+/).map(x => parseInt(x, 10)).filter(x => Number.isInteger(x) && x > 0 && x <= 27);
    const uniq = [...new Set(days)].sort((a, b) => b - a);
    const c = getReminderConfig(chatId); c.advanceDays = uniq; setReminderConfig(chatId, c);
    return uniq.length ? `✅ ตั้งเตือนล่วงหน้า ${uniq.join(', ')} วันก่อนครบกำหนดแล้วค่ะ` : '✅ ยกเลิกการเตือนล่วงหน้าแล้วค่ะ';
  }
  m = t.match(/^ตั้งเวลา.*?(\d{1,2})[:.](\d{2})/);
  if (m) {
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (hh > 23 || mm > 59) return 'รูปแบบเวลาไม่ถูกต้องค่ะ เช่น "ตั้งเวลาเตือน 09:00"';
    const c = getReminderConfig(chatId); c.hour = hh; c.minute = mm; setReminderConfig(chatId, c);
    return `✅ ตั้งเวลาเตือนเป็น ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} น. แล้วค่ะ`;
  }
  return null;
}

// ─── Admin Command Handler ─────────────────────────────────
async function handleAdminCommand(text, chatId, userId, groupId) {
  const t = text.trim();

  // ทุกคนใช้ได้: ดูไอดีของฉัน
  if (/^ไอดีของฉัน$/.test(t)) {
    return { text: `🆔 LINE User ID ของคุณ:\n${userId}\n\nนำไปใส่ใน ADMIN_IDS ใน .env ค่ะ` };
  }

  if (!isAdmin(userId)) return null;

  // ─── โปรไฟล์ยูนิต (ผูกกับกลุ่ม) ───────────────────────────
  const isUnitCmd = /^(ตั้งข้อม[ูุ]?ลห้อง|ตั้งโครงการ|ตั้งเลขห้อง|ตั้งผู้เช่า|ตั้งเจ้าของ|ตั้งประกัน|ตั้งสัญญา|ตั้งบัญชี)/.test(t)
    || /^ตั้งค่าเช่า\s+[\d,]+\s*$/.test(t);
  if (isUnitCmd && !groupId) {
    return { text: 'คำสั่งตั้งข้อมูลห้องต้องพิมพ์ "ในกลุ่มของห้องนั้น" นะคะ (แต่ละกลุ่ม = 1 ห้อง)' };
  }
  if (/^ตั้งข้อม[ูุ]?ลห้อง(?:\s|$)/.test(t)) {
    const body = t.replace(/^ตั้งข้อม[ูุ]?ลห้อง[ \t]*\r?\n?/, '');
    if (!body.trim()) return { text: unitTemplateMessage(groupId) };
    const { data, errors } = parseUnitBulk(body);
    if (!Object.keys(data).length) {
      return { text: 'อ่านข้อมูลไม่ได้เลยค่ะ ลองใช้รูปแบบนี้นะคะ\n\n' + unitTemplateMessage(groupId) };
    }
    updateUnit(groupId, data);
    let msg = '✅ บันทึกข้อมูลห้องเรียบร้อยค่ะ\n\n' + formatUnit(groupId);
    if (errors.length) msg += '\n\n⚠️ ข้ามบางช่อง:\n' + errors.join('\n');
    return { text: msg };
  }
  let mu = t.match(/^ตั้งโครงการ\s+(.+)/s);
  if (mu) { updateUnit(groupId, { project: mu[1].trim() }); return { text: `✅ ตั้งโครงการ: ${mu[1].trim()}` }; }
  mu = t.match(/^ตั้งเลขห้อง\s+(\S+)/);
  if (mu) { const r = mu[1].trim().toUpperCase(); updateUnit(groupId, { room: r }); return { text: `✅ ตั้งเลขห้อง: ${r}` }; }
  mu = t.match(/^ตั้งผู้เช่า\s+(.+?)(?:\s+(0[\d\-]{8,}))?\s*$/s);
  if (mu) {
    const patch = { tenantName: mu[1].trim() };
    if (mu[2]) patch.tenantPhone = mu[2].trim();
    updateUnit(groupId, patch);
    return { text: `✅ ผู้เช่า: ${patch.tenantName}${patch.tenantPhone ? ' (' + patch.tenantPhone + ')' : ''}` };
  }
  mu = t.match(/^ตั้งเจ้าของ\s+(.+?)(?:\s+(0[\d\-]{8,}))?\s*$/s);
  if (mu) {
    const patch = { ownerName: mu[1].trim() };
    if (mu[2]) patch.ownerPhone = mu[2].trim();
    updateUnit(groupId, patch);
    return { text: `✅ เจ้าของห้อง: ${patch.ownerName}${patch.ownerPhone ? ' (' + patch.ownerPhone + ')' : ''}` };
  }
  mu = t.match(/^ตั้งค่าเช่า\s+([\d,]+)\s*$/);
  if (mu) { const rent = parseInt(mu[1].replace(/,/g, ''), 10); updateUnit(groupId, { rent }); return { text: `✅ ค่าเช่า: ${rent.toLocaleString('th-TH')} บาท/เดือน` }; }
  mu = t.match(/^ตั้งประกัน\s+([\d,]+)/);
  if (mu) { const deposit = parseInt(mu[1].replace(/,/g, ''), 10); updateUnit(groupId, { deposit }); return { text: `✅ เงินประกัน: ${deposit.toLocaleString('th-TH')} บาท` }; }
  mu = t.match(/^ตั้งสัญญา\s+(\S+)\s+(\S+)/);
  if (mu) {
    const s = parseThaiDate(mu[1]), e = parseThaiDate(mu[2]);
    if (!s || !e) return { text: 'รูปแบบวันที่ไม่ถูกต้องค่ะ ใช้ วัน/เดือน/ปี เช่น "ตั้งสัญญา 1/1/2569 31/12/2569"' };
    updateUnit(groupId, { contractStart: s, contractEnd: e });
    return { text: `✅ สัญญา: ${formatThaiDate(s)} ถึง ${formatThaiDate(e)}` };
  }
  mu = t.match(/^ตั้งบัญชี\s+(.+)/s);
  if (mu) { updateUnit(groupId, { bankAccount: mu[1].trim() }); return { text: `✅ บัญชีรับโอน:\n${mu[1].trim()}` }; }

  // ─ ดูผู้เช่า
  if (/^ดูผู้เช่า/.test(t)) return { text: formatTenantList() };

  // ─ เพิ่มผู้เช่า ห้อง 301 ชื่อ สมชาย
  let m = t.match(/^เพิ่มผู้เช่า\s+ห้อง\s*(\S+)\s+ชื่อ\s+(.+)/);
  if (m) {
    const room = m[1].toUpperCase(), name = m[2].trim();
    const existing = getUserByRoom(room);
    if (existing) tenants.delete(existing.userId);
    tenants.set(`__room_${room}`, { room, name, registeredAt: Date.now() });
    saveTenants();
    return { text: `✅ เพิ่มผู้เช่าห้อง ${room} ชื่อ ${name} แล้วค่ะ\n(ให้ผู้เช่าพิมพ์ "ลัคกี้ ลงทะเบียน ห้อง ${room}" ในกลุ่ม เพื่อรับแจ้งเตือนส่วนตัวด้วยนะคะ)` };
  }

  // ─ ลบผู้เช่า ห้อง 301
  m = t.match(/^ลบผู้เช่า\s+ห้อง\s*(\S+)/);
  if (m) {
    const room = m[1].toUpperCase();
    const existing = getUserByRoom(room);
    if (!existing) return { text: `ไม่พบผู้เช่าห้อง ${room} ค่ะ` };
    tenants.delete(existing.userId); saveTenants();
    return { text: `✅ ลบข้อมูลผู้เช่าห้อง ${room} แล้วค่ะ` };
  }

  // ─ ดูแจ้งซ่อม ห้อง 301
  m = t.match(/^ดูแจ้งซ่อม\s+ห้อง\s*(\S+)/);
  if (m) {
    const list = getRepairsByRoom(m[1]);
    return { text: formatRepairList(list, `🔧 รายการแจ้งซ่อม ห้อง ${m[1].toUpperCase()}`) };
  }
  // ─ ดูแจ้งซ่อม (ทั้งหมดที่ค้างอยู่)
  if (/^ดูแจ้งซ่อม/.test(t)) {
    const pending = repairs.filter(r => r.status !== 'done' && r.status !== 'cancel');
    return { text: formatRepairList(pending, '🔧 รายการแจ้งซ่อมที่ยังค้างอยู่') };
  }

  // ─ อัปเดตซ่อม #3 เสร็จแล้ว
  m = t.match(/^อัปเดตซ่อม\s+#?(\d+)\s+(.+)/);
  if (m) {
    const id = parseInt(m[1], 10);
    const repair = repairs.find(r => r.id === id);
    if (!repair) return { text: `ไม่พบรายการแจ้งซ่อม #${id} ค่ะ` };
    const kw = m[2].trim();
    const statusMap = { 'เสร็จแล้ว': 'done', 'กำลังดำเนินการ': 'inprogress', 'รับเรื่อง': 'pending', 'ยกเลิก': 'cancel' };
    const newStatus = Object.entries(statusMap).find(([k]) => kw.includes(k))?.[1];
    if (!newStatus) return { text: 'ระบุสถานะไม่ถูกต้องค่ะ ใช้: เสร็จแล้ว / กำลังดำเนินการ / ยกเลิก' };
    repair.status = newStatus; repair.updatedAt = Date.now(); saveRepairs();
    if (repair.userId && !repair.userId.startsWith('__room_')) {
      try {
        await client.pushMessage({
          to: repair.userId,
          messages: [{ type: 'text', text: `🔔 อัปเดตการแจ้งซ่อม #${id}\nห้อง ${repair.room}: ${repair.description}\nสถานะ: ${REPAIR_STATUS[newStatus]}` }],
        });
      } catch {}
    }
    return { text: `✅ อัปเดตรายการ #${id} เป็น "${REPAIR_STATUS[newStatus]}" แล้วค่ะ` };
  }

  // ─ ดูยอดชำระ / ดูยอดชำระ เดือน 6
  if (/^ดูยอดชำระ/.test(t)) {
    let key = currentMonthKey();
    const mMonth = t.match(/เดือน\s*(\d{1,2})/);
    if (mMonth) {
      const now = new Date(Date.now() + 7 * 3600000);
      key = `${now.getUTCFullYear()}-${String(parseInt(mMonth[1], 10)).padStart(2, '0')}`;
    }
    return { text: formatPaymentSummary(key) };
  }

  // ─ ยืนยันชำระ 301
  m = t.match(/^ยืนยันชำระ\s+(\S+)/);
  if (m) {
    const room = m[1].toUpperCase();
    const key = currentMonthKey();
    const month = getPaymentMonth(key);
    if (!month[room]?.paid) return { text: `ห้อง ${room} ยังไม่ได้แจ้งชำระนะคะ` };
    month[room].confirmedBy = userId; month[room].confirmedAt = Date.now();
    payments.set(key, month); savePayments();
    const tenant = getUserByRoom(room);
    if (tenant && !tenant.userId.startsWith('__room_')) {
      try {
        await client.pushMessage({
          to: tenant.userId,
          messages: [{ type: 'text', text: `✅ ยืนยันการชำระค่าเช่าห้อง ${room} เดือน ${thaiMonthLabel(key)} เรียบร้อยแล้วค่ะ ขอบคุณนะคะ 🙏` }],
        });
      } catch {}
    }
    return { text: `✅ ยืนยันการชำระห้อง ${room} แล้วค่ะ` };
  }

  // ─ ประกาศ [ข้อความ]
  m = t.match(/^ประกาศ\s+(.+)/s);
  if (m) {
    const msg = m[1].trim();
    let count = 0;
    for (const gid of groups) {
      try { await client.pushMessage({ to: gid, messages: [{ type: 'text', text: `📢 ประกาศจากแอดมิน\n\n${msg}` }] }); count++; }
      catch {}
    }
    return { text: `✅ ส่งประกาศไปแล้ว ${count} กลุ่มค่ะ` };
  }

  // ─ ตั้งค่าเช่า ห้อง 301 12000
  m = t.match(/^ตั้งค่าเช่า\s+(?:ห้อง\s*)?(\S+)\s+([\d,]+)/);
  if (m) {
    const room = m[1].toUpperCase();
    const rent = parseInt(m[2].replace(/,/g, ''), 10);
    if (!rent || rent <= 0) return { text: 'กรุณาระบุค่าเช่าเป็นตัวเลขนะคะ เช่น "ตั้งค่าเช่า ห้อง 301 12000"' };
    setRoomRent(room, rent);
    return { text: `✅ ตั้งค่าเช่าห้อง ${room} = ${rent.toLocaleString('th-TH')} บาท/เดือน แล้วค่ะ` };
  }

  // ─ ดูค่าเช่า
  if (/^ดูค่าเช่า/.test(t)) return { text: formatRoomList() };

  // ─ คำสั่งแอดมิน
  if (/^(คำสั่งแอดมิน|admin)$/i.test(t)) {
    return { text: `📋 คำสั่งแอดมิน\n\n🏠 ข้อมูลห้อง (พิมพ์ในกลุ่มของห้องนั้น):\n• ตั้งข้อมูลห้อง  (ดูวิธีตั้งทั้งหมด)\n• ดูข้อมูลห้อง\n\n👥 ผู้เช่า:\n• ดูผู้เช่า\n• เพิ่มผู้เช่า ห้อง 301 ชื่อ สมชาย\n• ลบผู้เช่า ห้อง 301\n\n🔧 แจ้งซ่อม:\n• ดูแจ้งซ่อม\n• ดูแจ้งซ่อม ห้อง 301\n• อัปเดตซ่อม #3 เสร็จแล้ว\n• อัปเดตซ่อม #3 กำลังดำเนินการ\n• อัปเดตซ่อม #3 ยกเลิก\n\n💰 การชำระ:\n• ดูยอดชำระ\n• ดูยอดชำระ เดือน 6\n• ยืนยันชำระ 301\n\n📢 ประกาศ:\n• ประกาศ [ข้อความ]` };
  }

  return null;
}

// ─── Tenant Command Handler ────────────────────────────────
function handleTenantCommand(text, chatId, userId) {
  const t = text.trim();

  // ดูข้อมูลห้อง (ทุกคนในกลุ่มใช้ได้)
  if (/^ดูข้อม[ูุ]?ลห้อง/.test(t)) {
    if (String(chatId).startsWith('U')) return 'ดูข้อมูลห้องได้ในกลุ่มของห้องนั้นนะคะ';
    return formatUnit(chatId);
  }

  // ลงทะเบียน ห้อง 301 ชื่อ สมชาย
  let m = t.match(/^ลงทะเบียน\s+ห้อง\s*(\S+)(?:\s+ชื่อ\s+(.+))?/);
  if (m) {
    const room = m[1].toUpperCase();
    const name = (m[2] || '').trim() || 'ผู้เช่า';
    const oldByUser = tenants.get(userId);
    if (oldByUser) tenants.delete(userId);
    const oldByRoom = getUserByRoom(room);
    if (oldByRoom && oldByRoom.userId.startsWith('__room_')) tenants.delete(oldByRoom.userId);
    tenants.set(userId, { room, name, registeredAt: Date.now() });
    saveTenants();
    return `✅ ลงทะเบียนห้อง ${room} ชื่อ ${name} เรียบร้อยแล้วค่ะ\nสามารถใช้คำสั่งต่อไปนี้ได้เลย:\n• แจ้งซ่อม [รายละเอียด]\n• แจ้งชำระแล้ว\n• ดูการแจ้งซ่อม\n• ข้อมูลของฉัน`;
  }

  // ข้อมูลของฉัน
  if (/^ข้อมูลของฉัน/.test(t)) {
    const me = tenants.get(userId);
    if (!me) return 'คุณยังไม่ได้ลงทะเบียนค่ะ พิมพ์ "ลงทะเบียน ห้อง [เลขห้อง] ชื่อ [ชื่อ]" เพื่อลงทะเบียน';
    const key = currentMonthKey();
    const month = payments.get(key) || {};
    const p = month[me.room];
    const payStatus = !p?.paid ? '❌ ยังไม่ชำระ' : p.confirmedBy ? '✅ ชำระและยืนยันแล้ว' : '🕐 แจ้งชำระแล้ว รอยืนยัน';
    const rent = getRoomRent(me.room);
    const rentLine = rent ? `\n- ค่าเช่า: ${rent.toLocaleString('th-TH')} บาท/เดือน` : '';
    return `👤 ข้อมูลของคุณ\n- ชื่อ: ${me.name}\n- ห้อง: ${me.room}${rentLine}\n- สถานะชำระเดือนนี้: ${payStatus}`;
  }

  // แจ้งซ่อม (ไม่มีรายละเอียด) → แนะนำวิธีพิมพ์
  if (/^แจ้งซ่อม$/.test(t)) {
    return 'แจ้งซ่อมได้เลยค่ะ 🛠️ พิมพ์รายละเอียดต่อท้าย เช่น\n"แจ้งซ่อม แอร์ไม่เย็น" หรือ "แจ้งซ่อม ก๊อกน้ำในห้องน้ำรั่ว"';
  }

  // แจ้งซ่อม [รายละเอียด]
  m = t.match(/^แจ้งซ่อม\s+(.+)/s);
  if (m) {
    const room = getRoomByUser(userId);
    if (!room) return 'กรุณาลงทะเบียนก่อนนะคะ พิมพ์ "ลงทะเบียน ห้อง [เลขห้อง] ชื่อ [ชื่อ]"';
    const repair = addRepair(userId, room, m[1].trim(), chatId);
    return `✅ รับเรื่องแจ้งซ่อม #${repair.id} แล้วค่ะ\nห้อง ${room}: ${repair.description}\nทีมงานจะดำเนินการโดยเร็วนะคะ 🙏`;
  }

  // ดูการแจ้งซ่อม
  if (/^ดูการแจ้งซ่อม/.test(t)) {
    const room = getRoomByUser(userId);
    if (!room) return 'กรุณาลงทะเบียนก่อนนะคะ';
    const list = getRepairsByRoom(room);
    return formatRepairList(list, `🔧 รายการแจ้งซ่อมห้อง ${room}`);
  }

  // แจ้งชำระแล้ว [หมายเหตุ]
  m = t.match(/^แจ้งชำระ(?:แล้ว)?(?:\s+(.+))?/s);
  if (m) {
    const room = getRoomByUser(userId);
    if (!room) return 'กรุณาลงทะเบียนก่อนนะคะ';
    recordPayment(room, (m[1] || '').trim());
    return `✅ รับทราบการแจ้งชำระห้อง ${room} เดือน ${thaiMonthLabel(currentMonthKey())} แล้วค่ะ\nรอเจ้าหน้าที่ยืนยันนะคะ 🙏`;
  }

  // ดูสถานะชำระ
  if (/^ดูสถานะชำระ/.test(t)) {
    const room = getRoomByUser(userId);
    if (!room) return 'กรุณาลงทะเบียนก่อนนะคะ';
    const key = currentMonthKey();
    const month = payments.get(key) || {};
    const p = month[room];
    if (!p?.paid) return `❌ ห้อง ${room} ยังไม่ได้แจ้งชำระค่าเช่าเดือน ${thaiMonthLabel(key)} ค่ะ`;
    return `💰 ห้อง ${room} เดือน ${thaiMonthLabel(key)}\nสถานะ: ${p.confirmedBy ? '✅ ยืนยันแล้ว' : '🕐 รอการยืนยันจากเจ้าหน้าที่'}`;
  }

  return null;
}

// ─── AI Tools (Reminder via Function Calling) ─────────────
const REMINDER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_rent_reminder',
      description: 'ตั้งค่าหรือแก้ไขการแจ้งเตือนชำระค่าเช่าของห้องแชทนี้ เรียกเมื่อผู้ใช้ต้องการตั้ง/เปิด/ปิด/เปลี่ยนแปลงการเตือนค่าเช่า',
      parameters: {
        type: 'object',
        properties: {
          dueDay:      { type: 'integer', description: 'วันครบกำหนดชำระของเดือน (1-28)' },
          hour:        { type: 'integer', description: 'เวลาเตือน ชั่วโมงแบบ 24 ชม. (0-23)' },
          minute:      { type: 'integer', description: 'เวลาเตือน นาที (0-59)' },
          advanceDays: { type: 'array', items: { type: 'integer' }, description: 'จำนวนวันที่เตือนล่วงหน้า เช่น [3,1]' },
          amount:      { type: 'integer', description: 'จำนวนเงินค่าเช่าเป็นบาท' },
          enabled:     { type: 'boolean', description: 'true=เปิด, false=ปิด' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_rent_reminder',
      description: 'แสดงการตั้งค่าการเตือนค่าเช่าปัจจุบันของห้องแชทนี้',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function applyReminderTools(chatId, toolCalls) {
  for (const call of toolCalls) {
    const fn = call.function?.name;
    let args = call.function?.arguments || {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (fn === 'show_rent_reminder') return formatReminderConfig(getReminderConfig(chatId));
    if (fn === 'set_rent_reminder') {
      const c = getReminderConfig(chatId);
      const changes = [];
      if (Number.isInteger(args.dueDay) && args.dueDay >= 1 && args.dueDay <= 28) { c.dueDay = args.dueDay; changes.push(`วันครบกำหนด = วันที่ ${args.dueDay}`); }
      if (Number.isInteger(args.hour) && args.hour >= 0 && args.hour <= 23) {
        c.hour = args.hour;
        c.minute = (Number.isInteger(args.minute) && args.minute >= 0 && args.minute <= 59) ? args.minute : 0;
        changes.push(`เวลา = ${String(c.hour).padStart(2,'0')}:${String(c.minute).padStart(2,'0')} น.`);
      }
      if (Array.isArray(args.advanceDays)) {
        const adv = [...new Set(args.advanceDays.map(x => parseInt(x,10)).filter(x => Number.isInteger(x) && x > 0 && x <= 27))].sort((a,b) => b-a);
        c.advanceDays = adv; changes.push(`เตือนล่วงหน้า = ${adv.length ? adv.join(', ')+' วัน' : 'ไม่มี'}`);
      }
      if (Number.isInteger(args.amount) && args.amount > 0) { c.amount = args.amount; changes.push(`ยอดค่าเช่า = ${args.amount.toLocaleString('th-TH')} บาท`); }
      if (typeof args.enabled === 'boolean') { c.enabled = args.enabled; changes.push(args.enabled ? 'เปิดการเตือน' : 'ปิดการเตือน'); }
      if (changes.length === 0) return null;
      c.enabled = c.enabled !== false;
      setReminderConfig(chatId, c);
      return `✅ ตั้งค่าเตือนค่าเช่าเรียบร้อยค่ะ (${changes.join(', ')})\n\n${formatReminderConfig(c)}`;
    }
  }
  return null;
}

// ─── Date/Time Helper ──────────────────────────────────────
function getCurrentDatetimePrompt() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  const days = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const dayName = days[now.getUTCDay()];
  const pad = n => String(n).padStart(2, '0');
  return `\n\n[ข้อมูลระบบ] วันเวลาปัจจุบัน (เวลาไทย): วัน${dayName}ที่ ${now.getUTCDate()}/${now.getUTCMonth() + 1}/${now.getUTCFullYear() + 543} เวลา ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} น.`;
}

// ─── Ollama ────────────────────────────────────────────────
async function askOllama(chatId, userText) {
  const history = getHistory(chatId);
  const reminderRelated = /เตือน|ค่าเช่า|ชำระ|จ่ายค่า/.test(userText);
  const payload = {
    model: OLLAMA_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + getCurrentDatetimePrompt() },
      ...history,
      { role: 'user', content: userText },
    ],
    stream: false,
    think: false,
    options: { temperature: 0.7, num_ctx: 8192 },
  };
  if (reminderRelated) payload.tools = REMINDER_TOOLS;
  const response = await axios.post(`${OLLAMA_URL}/api/chat`, payload, { timeout: 120000 });
  const msg = response.data?.message || {};
  if (msg.tool_calls?.length) {
    const confirm = applyReminderTools(chatId, msg.tool_calls);
    if (confirm) { pushHistory(chatId, 'user', userText); pushHistory(chatId, 'assistant', confirm); return confirm; }
  }
  let text = (msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  text = text || 'ขออภัยค่ะ ไม่สามารถประมวลผลคำตอบได้ กรุณาลองใหม่นะคะ';
  pushHistory(chatId, 'user', userText); pushHistory(chatId, 'assistant', text);
  return text;
}

// ─── Gemini ────────────────────────────────────────────────
function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (s && typeof s === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(s)) out[k] = k === 'type' && typeof v === 'string' ? v.toUpperCase() : toGeminiSchema(v);
    return out;
  }
  return s;
}
const GEMINI_REMINDER_TOOLS = [{
  function_declarations: REMINDER_TOOLS.map(t => {
    const decl = { name: t.function.name, description: t.function.description };
    const props = t.function.parameters?.properties || {};
    if (Object.keys(props).length > 0) decl.parameters = toGeminiSchema(t.function.parameters);
    return decl;
  }),
}];

async function askGemini(chatId, userText) {
  const history = getHistory(chatId);
  const reminderRelated = /เตือน|ค่าเช่า|ชำระ|จ่ายค่า/.test(userText);
  const contents = [
    ...history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    { role: 'user', parts: [{ text: userText }] },
  ];
  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT + getCurrentDatetimePrompt() }] },
    contents,
    generationConfig: { temperature: 0.7 },
  };
  if (reminderRelated) body.tools = GEMINI_REMINDER_TOOLS;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await axios.post(url, body, { timeout: 120000 });
  const parts = resp.data?.candidates?.[0]?.content?.parts || [];
  const fcs = parts.filter(p => p.functionCall);
  if (fcs.length) {
    const confirm = applyReminderTools(chatId, fcs.map(p => ({ function: { name: p.functionCall.name, arguments: p.functionCall.args || {} } })));
    if (confirm) { pushHistory(chatId, 'user', userText); pushHistory(chatId, 'assistant', confirm); return confirm; }
  }
  let text = parts.filter(p => p.text).map(p => p.text).join('').trim();
  text = text || 'ขออภัยค่ะ ไม่สามารถประมวลผลคำตอบได้ กรุณาลองใหม่นะคะ';
  pushHistory(chatId, 'user', userText); pushHistory(chatId, 'assistant', text);
  return text;
}

async function askAI(chatId, userText) {
  if (LLM_PROVIDER === 'gemini') return askGemini(chatId, userText);
  return askOllama(chatId, userText);
}

// ─── Express ───────────────────────────────────────────────
const app = express();
app.get('/', (_req, res) => res.send('LuckyCondo Bot is running ✅'));
app.post('/webhook', line.middleware(config), async (req, res) => {
  try { await Promise.all(req.body.events.map(handleEvent)); res.status(200).end(); }
  catch (err) { console.error('Webhook error:', err); res.status(500).end(); }
});

const client = new MessagingApiClient({ channelAccessToken: config.channelAccessToken });

function getGroupId(event) {
  if (event.source?.type === 'group') return event.source.groupId;
  if (event.source?.type === 'room') return event.source.roomId;
  return null;
}

// ─── Event Handler ─────────────────────────────────────────
async function handleEvent(event) {
  const groupId = getGroupId(event);
  const userId = event.source?.userId;

  if (event.type === 'join') {
    rememberGroup(groupId);
    return client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: GROUP_INTRO_MESSAGE }] });
  }
  if (event.type === 'leave') {
    if (groupId && groups.delete(groupId)) { saveGroups(); console.log(`   ➖ ออกจากกลุ่ม: ${groupId}`); }
    return null;
  }
  if (event.type === 'follow') {
    return client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: WELCOME_MESSAGE, quickReply: QUICK_REPLY }] });
  }
  if (event.type !== 'message') return null;
  if (groupId) rememberGroup(groupId);

  // ─ non-text: รูปจากผู้เช่าที่ลงทะเบียนแล้ว = สลิป
  if (event.message.type !== 'text') {
    if (groupId) {
      if (event.message.type === 'image' && userId) {
        const room = getRoomByUser(userId);
        if (room) {
          recordPayment(room, '(ส่งรูปสลิป)');
          return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `🧾 รับสลิปของห้อง ${room} แล้วค่ะ รอเจ้าหน้าที่ยืนยันนะคะ 🙏` }],
          });
        }
      }
      return null;
    }
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: 'ขอบคุณค่ะ 🙏 น้องลัคกี้รับเฉพาะข้อความตัวอักษรนะคะ รบกวนพิมพ์คำถามมาได้เลยค่ะ', quickReply: QUICK_REPLY }],
    });
  }

  const userText = event.message.text.trim();
  let promptText = userText;
  const convKey = groupId || userId || 'unknown';

  // ─ ในกลุ่ม: ต้องเรียกชื่อก่อน
  if (groupId) {
    const mentionedBot = event.message.mention?.mentionees?.some(m => m.isSelf);
    const lower = userText.toLowerCase();
    const calledByName = GROUP_TRIGGER.some(w => lower.startsWith(w.toLowerCase()));
    if (!mentionedBot && !calledByName) return null;
    for (const w of GROUP_TRIGGER) {
      if (lower.startsWith(w.toLowerCase())) { promptText = userText.slice(w.length).trim(); break; }
    }
    if (!promptText) promptText = 'สวัสดีค่ะ';
  } else {
    // แชตเดี่ยว: ไม่ต้องเรียกชื่อ แต่ถ้าเผลอใส่ "ลัคกี้" นำหน้า ก็ตัดออกให้ คำสั่งจะได้ตรง
    const lower = userText.toLowerCase();
    for (const w of GROUP_TRIGGER) {
      if (lower.startsWith(w.toLowerCase())) { promptText = userText.slice(w.length).trim() || userText; break; }
    }
  }

  console.log(`[${groupId ? 'Group' : 'User'} ${convKey.slice(0, 6)}] ${promptText}`);

  const reply = async (text) => {
    const msg = { type: 'text', text };
    if (!groupId) msg.quickReply = QUICK_REPLY;
    return client.replyMessage({ replyToken: event.replyToken, messages: [msg] });
  };

  // 1. Reminder commands
  const reminderReply = handleReminderCommand(promptText, convKey);
  if (reminderReply !== null) return reply(reminderReply);

  // 2. Admin commands
  const adminResult = await handleAdminCommand(promptText, convKey, userId, groupId);
  if (adminResult !== null) return reply(adminResult.text);

  // 3. Tenant commands
  const tenantReply = handleTenantCommand(promptText, convKey, userId);
  if (tenantReply !== null) return reply(tenantReply);

  // 4. AI
  let replyText;
  try { replyText = await askAI(convKey, promptText); }
  catch (err) { console.error('AI error:', err.message); replyText = 'ขออภัยค่ะ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งนะคะ 🙏'; }
  console.log(`[Bot] ${replyText}`);
  return reply(replyText);
}

// ─── Shutdown ──────────────────────────────────────────────
process.on('SIGINT',  () => { saveConversations(); saveGroups(); saveReminders(); saveTenants(); saveUnits(); saveRooms(); saveRepairs(); savePayments(); process.exit(0); });
process.on('SIGTERM', () => { saveConversations(); saveGroups(); saveReminders(); saveTenants(); saveUnits(); saveRooms(); saveRepairs(); savePayments(); process.exit(0); });

// ─── Start ─────────────────────────────────────────────────
loadConversations(); loadGroups(); loadReminders(); loadTenants(); loadUnits(); loadRooms(); loadRepairs(); loadPayments();
app.listen(PORT, () => {
  const r = RENT_REMINDER;
  const hh = String(r.hour).padStart(2, '0'), mm = String(r.minute).padStart(2, '0');
  console.log(`🚀 LuckyCondo Bot listening on port ${PORT}`);
  console.log(`   AI: ${LLM_PROVIDER === 'gemini' ? `Gemini (${GEMINI_MODEL})` : `Ollama ${OLLAMA_URL} Model: ${OLLAMA_MODEL}`}`);
  console.log(`   Admin IDs: ${ADMIN_IDS.length ? ADMIN_IDS.join(', ') : 'ยังไม่ตั้งค่า — พิมพ์ "ลัคกี้ ไอดีของฉัน" ในแชทเพื่อดู ID'}`);
  console.log(`   ความจำ: ${MAX_HISTORY} ข้อความ/คน, ลบอัตโนมัติหลังเงียบ ${HISTORY_TTL_HOURS} ชม.`);
  console.log(`   เตือนค่าเช่า (ค่าตั้งต้น): ครบกำหนดวันที่ ${r.dueDay}, ล่วงหน้า ${r.advanceDays.join(',')} วัน, เวลา ${hh}:${mm} น. (${groups.size} กลุ่ม)`);
});
