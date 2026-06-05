// ============================================================
//  LuckyCondo LINE Bot  —  Webhook + Ollama (Qwen3 14B)
//  มีความจำบทสนทนา + Quick Reply + ต้อนรับเพื่อนใหม่
// ============================================================
require('dotenv').config({ override: true }); // ให้ค่าใน .env ชนะ env เดิมของระบบเสมอ

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

// ---------- Config ----------
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:14b';
const PORT = process.env.PORT || 3000;

// เลือกผู้ให้บริการ AI: 'ollama' (ในเครื่อง) | 'claude' (คลาวด์) | 'gemini' (คลาวด์ ฟรี)
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// สร้าง Claude client เฉพาะเมื่อเลือกใช้ claude
let anthropic = null;
if (LLM_PROVIDER === 'claude') {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// จำนวนข้อความย้อนหลัง (user+bot) ที่เก็บต่อ 1 คน
const MAX_HISTORY = 10;
// ลบความจำของ user ที่เงียบหายเกินกี่ชั่วโมง
const HISTORY_TTL_HOURS = 6;

// ---------- ความจำบทสนทนา (เก็บใน memory + บันทึกลงไฟล์) ----------
// โครงสร้าง: { userId: { messages: [{role, content}], updatedAt: Date } }
const conversations = new Map();
const DB_FILE = path.join(__dirname, 'conversations.json');
let dirty = false; // มีข้อมูลเปลี่ยนที่ยังไม่ได้บันทึกไหม

// โหลดความจำจากไฟล์ตอนเริ่มบอท
function loadConversations() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      for (const [userId, conv] of Object.entries(data)) {
        conversations.set(userId, conv);
      }
      console.log(`   โหลดความจำเดิม ${conversations.size} คนจากไฟล์`);
    }
  } catch (err) {
    console.error('โหลดความจำไม่สำเร็จ (เริ่มใหม่):', err.message);
  }
}

// บันทึกความจำลงไฟล์ (เรียกเมื่อมีการเปลี่ยนแปลง)
function saveConversations() {
  if (!dirty) return;
  try {
    const obj = Object.fromEntries(conversations);
    fs.writeFileSync(DB_FILE, JSON.stringify(obj), 'utf8');
    dirty = false;
  } catch (err) {
    console.error('บันทึกความจำไม่สำเร็จ:', err.message);
  }
}

function getHistory(userId) {
  const conv = conversations.get(userId);
  if (!conv) return [];
  return conv.messages;
}

function pushHistory(userId, role, content) {
  let conv = conversations.get(userId);
  if (!conv) {
    conv = { messages: [], updatedAt: Date.now() };
    conversations.set(userId, conv);
  }
  conv.messages.push({ role, content });
  // เก็บแค่ N ข้อความล่าสุด
  if (conv.messages.length > MAX_HISTORY) {
    conv.messages = conv.messages.slice(-MAX_HISTORY);
  }
  conv.updatedAt = Date.now();
  dirty = true;
}

// เคลียร์ความจำเก่าทุก 1 ชั่วโมง (กัน memory โตไม่หยุด)
setInterval(() => {
  const cutoff = Date.now() - HISTORY_TTL_HOURS * 3600 * 1000;
  for (const [userId, conv] of conversations) {
    if (conv.updatedAt < cutoff) {
      conversations.delete(userId);
      dirty = true;
    }
  }
}, 3600 * 1000);

// บันทึกลงไฟล์อัตโนมัติทุก 20 วินาที (ถ้ามีการเปลี่ยนแปลง)
setInterval(saveConversations, 20 * 1000);

// บันทึกตอนปิดบอท (Ctrl+C)
process.on('SIGINT', () => { saveConversations(); saveGroups(); saveReminders(); process.exit(0); });
process.on('SIGTERM', () => { saveConversations(); saveGroups(); saveReminders(); process.exit(0); });

// ---------- รายชื่อกลุ่มที่บอทอยู่ (เก็บลงไฟล์) ----------
const GROUPS_FILE = path.join(__dirname, 'groups.json');
const groups = new Set();

function loadGroups() {
  try {
    if (fs.existsSync(GROUPS_FILE)) {
      JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')).forEach((g) => groups.add(g));
      console.log(`   โหลดรายชื่อกลุ่ม ${groups.size} กลุ่มจากไฟล์`);
    }
  } catch (err) {
    console.error('โหลดรายชื่อกลุ่มไม่สำเร็จ:', err.message);
  }
}

function saveGroups() {
  try {
    fs.writeFileSync(GROUPS_FILE, JSON.stringify([...groups]), 'utf8');
  } catch (err) {
    console.error('บันทึกรายชื่อกลุ่มไม่สำเร็จ:', err.message);
  }
}

function rememberGroup(groupId) {
  if (groupId && !groups.has(groupId)) {
    groups.add(groupId);
    saveGroups();
    console.log(`   ➕ จำกลุ่มใหม่: ${groupId} (รวม ${groups.size} กลุ่ม)`);
  }
}

// ---------- ตั้งค่าการเตือนค่าเช่า (ต่อกลุ่ม/แชท เก็บลงไฟล์) ----------
const REMINDERS_FILE = path.join(__dirname, 'reminders.json');
const reminderConfigs = new Map(); // chatId -> { enabled, dueDay, advanceDays, hour, minute, message }

function loadReminders() {
  try {
    if (fs.existsSync(REMINDERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
      for (const [id, cfg] of Object.entries(data)) reminderConfigs.set(id, cfg);
      console.log(`   โหลดการตั้งค่าเตือน ${reminderConfigs.size} แชทจากไฟล์`);
    }
  } catch (err) {
    console.error('โหลดการตั้งค่าเตือนไม่สำเร็จ:', err.message);
  }
}

function saveReminders() {
  try {
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify(Object.fromEntries(reminderConfigs)), 'utf8');
  } catch (err) {
    console.error('บันทึกการตั้งค่าเตือนไม่สำเร็จ:', err.message);
  }
}

// ดึง config ของแชท (ถ้ายังไม่ตั้งเอง ใช้ค่าตั้งต้นจาก info.js)
function getReminderConfig(chatId) {
  if (reminderConfigs.has(chatId)) return reminderConfigs.get(chatId);
  return { ...RENT_REMINDER, advanceDays: [...RENT_REMINDER.advanceDays] };
}

function setReminderConfig(chatId, cfg) {
  reminderConfigs.set(chatId, cfg);
  saveReminders();
}

// ประกอบข้อความเตือน (เติมหัวข้อ ล่วงหน้า/ครบกำหนด + จำนวนเงิน ให้อัตโนมัติ)
function buildReminderText(cfg, daysBefore) {
  const head = daysBefore === 0
    ? `🔔 วันนี้ครบกำหนดชำระค่าเช่า (วันที่ ${cfg.dueDay} ของเดือน)`
    : `⏰ แจ้งเตือนล่วงหน้า: อีก ${daysBefore} วันจะครบกำหนดชำระค่าเช่า (วันที่ ${cfg.dueDay})`;
  const amountLine = cfg.amount ? `\n💰 ยอดชำระ: ${cfg.amount.toLocaleString('th-TH')} บาท` : '';
  return `${head}${amountLine}\n\n${cfg.message}`;
}

// สรุปการตั้งค่าเตือนเป็นข้อความ (ใช้ทั้งคำสั่ง "ดูการตั้งค่า" และการยืนยันหลังตั้งค่า)
function formatReminderConfig(c) {
  const hh = String(c.hour).padStart(2, '0');
  const mm = String(c.minute).padStart(2, '0');
  const adv = c.advanceDays.length ? c.advanceDays.join(', ') + ' วัน' : 'ไม่มี (เฉพาะวันครบกำหนด)';
  const amt = c.amount ? `${c.amount.toLocaleString('th-TH')} บาท` : 'ยังไม่ระบุ';
  return `⚙️ การตั้งค่าเตือนค่าเช่าของแชทนี้
- สถานะ: ${c.enabled ? 'เปิด ✅' : 'ปิด ⛔'}
- วันครบกำหนด: วันที่ ${c.dueDay} ของเดือน
- ยอดค่าเช่า: ${amt}
- เตือนล่วงหน้า: ${adv}
- เวลาเตือน: ${hh}:${mm} น.`;
}

// คำนวณรอบเตือนของเดือนที่ระบุ -> [{ date, daysBefore }]
function occurrencesForMonth(cfg, year, month) {
  const due = new Date(year, month, cfg.dueDay, cfg.hour, cfg.minute, 0, 0);
  const list = [{ date: due, daysBefore: 0 }];
  for (const a of cfg.advanceDays) {
    const d = new Date(due);
    d.setDate(d.getDate() - a);
    list.push({ date: d, daysBefore: a });
  }
  return list;
}

const sameMinute = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate() && a.getHours() === b.getHours() &&
  a.getMinutes() === b.getMinutes();

const firedKeys = new Set(); // กันยิงซ้ำ: `${chatId}|${date.getTime()}`

async function pushReminder(chatId, cfg, daysBefore) {
  try {
    await client.pushMessage({
      to: chatId,
      messages: [{ type: 'text', text: buildReminderText(cfg, daysBefore) }],
    });
    console.log(`   💸 เตือนค่าเช่า (${daysBefore === 0 ? 'ครบกำหนด' : 'ล่วงหน้า ' + daysBefore + ' วัน'}) -> ${chatId}`);
  } catch (err) {
    console.error(`ส่งเตือนไป ${chatId} ไม่สำเร็จ:`, err.message);
  }
}

// เช็กทุก 1 นาที
setInterval(() => {
  const now = new Date();
  // เป้าหมาย = ทุกกลุ่มที่บอทอยู่ + ทุกแชทที่ตั้งค่าเตือนไว้
  const targets = new Set([...groups, ...reminderConfigs.keys()]);
  for (const chatId of targets) {
    const cfg = getReminderConfig(chatId);
    if (!cfg.enabled) continue;
    // เช็กรอบของเดือนนี้และเดือนหน้า (เผื่อเตือนล่วงหน้าข้ามเดือน)
    const occ = [
      ...occurrencesForMonth(cfg, now.getFullYear(), now.getMonth()),
      ...occurrencesForMonth(cfg, now.getFullYear(), now.getMonth() + 1),
    ];
    for (const o of occ) {
      if (!sameMinute(now, o.date)) continue;
      const key = `${chatId}|${o.date.getTime()}`;
      if (firedKeys.has(key)) continue;
      firedKeys.add(key);
      pushReminder(chatId, cfg, o.daysBefore);
    }
  }
  // ล้าง key เก่าเกิน 2 วัน
  const old = Date.now() - 2 * 86400 * 1000;
  for (const k of firedKeys) {
    if (Number(k.split('|')[1]) < old) firedKeys.delete(k);
  }
}, 60 * 1000);

// ---------- ตัวแปลคำสั่งตั้งค่าเตือน (คืน string ที่จะตอบ, หรือ null ถ้าไม่ใช่คำสั่ง) ----------
function handleReminderCommand(text, chatId) {
  const t = text.trim();

  // ช่วยเหลือ
  if (/^(คำสั่ง|ช่วยเหลือ|help|วิธีใช้)$/i.test(t)) return COMMAND_HELP;

  // ดูการตั้งค่า
  if (/^ดู.*(ตั้งค่า)?.*เตือน/.test(t)) {
    return formatReminderConfig(getReminderConfig(chatId)) + '\n\nพิมพ์ "ลัคกี้ คำสั่ง" เพื่อดูวิธีแก้ไขค่ะ';
  }

  // เตือนเดี๋ยวนี้ / ทดสอบ
  if (/^(เตือนเดี๋ยวนี้|ทดสอบ.*เตือน|เตือนตอนนี้)/.test(t)) {
    return buildReminderText(getReminderConfig(chatId), 0);
  }

  // เปิด/ปิด
  if (/^เปิด.*เตือน/.test(t)) {
    const c = getReminderConfig(chatId); c.enabled = true; setReminderConfig(chatId, c);
    return '✅ เปิดการเตือนค่าเช่าของกลุ่มนี้แล้วค่ะ';
  }
  if (/^ปิด.*เตือน/.test(t)) {
    const c = getReminderConfig(chatId); c.enabled = false; setReminderConfig(chatId, c);
    return '⛔ ปิดการเตือนค่าเช่าของกลุ่มนี้แล้วค่ะ';
  }

  // ตั้งวันครบกำหนด N
  let m = t.match(/^ตั้ง.*ครบกำหนด\s*(\d{1,2})/);
  if (m) {
    const d = parseInt(m[1], 10);
    if (d < 1 || d > 28) return 'กรุณาระบุวันที่ระหว่าง 1-28 นะคะ (เลี่ยงวันที่ 29-31 เพราะบางเดือนไม่มี)';
    const c = getReminderConfig(chatId); c.dueDay = d; setReminderConfig(chatId, c);
    return `✅ ตั้งวันครบกำหนดชำระเป็นวันที่ ${d} ของเดือนแล้วค่ะ`;
  }

  // ตั้งเตือนล่วงหน้า X,Y วัน
  m = t.match(/^ตั้งเตือนล่วงหน้า\s*([\d,\s]+?)\s*วัน?/);
  if (m) {
    const days = m[1].split(/[,\s]+/).map((x) => parseInt(x, 10))
      .filter((x) => Number.isInteger(x) && x > 0 && x <= 27);
    const uniq = [...new Set(days)].sort((a, b) => b - a);
    const c = getReminderConfig(chatId); c.advanceDays = uniq; setReminderConfig(chatId, c);
    return uniq.length
      ? `✅ ตั้งเตือนล่วงหน้า ${uniq.join(', ')} วันก่อนครบกำหนดแล้วค่ะ`
      : '✅ ยกเลิกการเตือนล่วงหน้าแล้วค่ะ (เตือนเฉพาะวันครบกำหนด)';
  }

  // ตั้งเวลาเตือน HH:MM
  m = t.match(/^ตั้งเวลา.*?(\d{1,2})[:.](\d{2})/);
  if (m) {
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (hh > 23 || mm > 59) return 'รูปแบบเวลาไม่ถูกต้องค่ะ ลองใหม่ เช่น "ตั้งเวลาเตือน 09:00"';
    const c = getReminderConfig(chatId); c.hour = hh; c.minute = mm; setReminderConfig(chatId, c);
    return `✅ ตั้งเวลาเตือนเป็น ${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')} น. แล้วค่ะ`;
  }

  return null; // ไม่ใช่คำสั่ง
}

// ---------- Express App ----------
const app = express();

// Health check
app.get('/', (_req, res) => res.send('LuckyCondo Bot is running ✅'));

// LINE Webhook
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).end();
  }
});

// SDK v11: ใช้ MessagingApiClient (รับ channelAccessToken อย่างเดียว)
const client = new MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// ดึง groupId/roomId จาก event (ถ้าอยู่ในกลุ่ม)
function getGroupId(event) {
  if (event.source?.type === 'group') return event.source.groupId;
  if (event.source?.type === 'room') return event.source.roomId;
  return null;
}

// ---------- Event handler ----------
async function handleEvent(event) {
  const groupId = getGroupId(event);

  // บอทถูกเชิญเข้ากลุ่ม -> ทักทาย + จำกลุ่มไว้
  if (event.type === 'join') {
    rememberGroup(groupId);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: GROUP_INTRO_MESSAGE }],
    });
  }

  // บอทถูกเตะออกจากกลุ่ม -> ลบกลุ่มออก
  if (event.type === 'leave') {
    if (groupId && groups.delete(groupId)) {
      saveGroups();
      console.log(`   ➖ ออกจากกลุ่ม: ${groupId}`);
    }
    return null;
  }

  // ลูกค้าเพิ่มเพื่อน (แชทเดี่ยว) -> ส่งข้อความต้อนรับ
  if (event.type === 'follow') {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: WELCOME_MESSAGE, quickReply: QUICK_REPLY }],
    });
  }

  if (event.type !== 'message') return null;

  // ถ้าอยู่ในกลุ่ม จำกลุ่มไว้เสมอ (เผื่อบอทอยู่ในกลุ่มก่อนเพิ่มฟีเจอร์นี้)
  if (groupId) rememberGroup(groupId);

  // ไม่ใช่ข้อความตัวอักษร
  if (event.message.type !== 'text') {
    // ในกลุ่ม: เงียบ (ไม่สแปม) | แชทเดี่ยว: บอกให้พิมพ์มา
    if (groupId) return null;
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: 'ขอบคุณค่ะ 🙏 น้องลัคกี้รับเฉพาะข้อความตัวอักษรนะคะ รบกวนพิมพ์คำถามมาได้เลย หรือเลือกเมนูด้านล่างค่ะ',
        quickReply: QUICK_REPLY,
      }],
    });
  }

  const userText = event.message.text.trim();
  let promptText = userText;

  // ===== ในกลุ่ม: ทำเฉพาะเมื่อถูกเรียกชื่อ/แท็ก (กันสแปม) =====
  if (groupId) {
    const mentionedBot = event.message.mention?.mentionees?.some((m) => m.isSelf);
    const lower = userText.toLowerCase();
    const calledByName = GROUP_TRIGGER.some((w) => lower.startsWith(w.toLowerCase()));
    if (!mentionedBot && !calledByName) {
      return null; // ไม่ได้เรียก -> เงียบ
    }
    // ตัดคำเรียกออกจากข้อความก่อนประมวลผล
    for (const w of GROUP_TRIGGER) {
      if (lower.startsWith(w.toLowerCase())) {
        promptText = userText.slice(w.length).trim();
        break;
      }
    }
    if (!promptText) promptText = 'สวัสดีค่ะ';
  }

  // คีย์แชท: ใช้ groupId ถ้าในกลุ่ม, ไม่งั้นใช้ userId
  const convKey = groupId || event.source?.userId || 'unknown';

  // ===== ลองตีความเป็นคำสั่งตั้งค่าเตือนก่อน =====
  const cmdReply = handleReminderCommand(promptText, convKey);
  if (cmdReply !== null) {
    console.log(`[${groupId ? 'Group' : 'User'} ${convKey.slice(0, 6)}] (คำสั่ง) ${promptText}`);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: cmdReply }],
    });
  }

  // ===== ไม่ใช่คำสั่ง -> ถาม AI =====
  console.log(`[${groupId ? 'Group' : 'User'} ${convKey.slice(0, 6)}] ${promptText}`);

  let replyText;
  try {
    replyText = await askAI(convKey, promptText);
  } catch (err) {
    console.error('AI error:', err.message);
    replyText = 'ขออภัยค่ะ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง หรือติดต่อเจ้าหน้าที่โดยตรงนะคะ 🙏';
  }

  console.log(`[Bot] ${replyText}`);

  // ในกลุ่มไม่ต้องแนบ Quick Reply (เกะกะ) | แชทเดี่ยวแนบเมนู
  const message = { type: 'text', text: replyText };
  if (!groupId) message.quickReply = QUICK_REPLY;

  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [message],
  });
}

// ---------- Tool: ให้ AI เข้าใจภาษาธรรมชาติแล้วตั้งค่าเตือนค่าเช่า ----------
const REMINDER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_rent_reminder',
      description: 'ตั้งค่าหรือแก้ไขการแจ้งเตือนชำระค่าเช่าของห้องแชทนี้ เรียกเมื่อผู้ใช้ต้องการตั้ง/เปิด/ปิด/เปลี่ยนแปลงการเตือนค่าเช่า เช่น "เตือนค่าเช่าทุกวันที่ 5", "ตั้งเตือนล่วงหน้า 3 วัน", "ปิดการเตือน"',
      parameters: {
        type: 'object',
        properties: {
          dueDay: { type: 'integer', description: 'วันครบกำหนดชำระของเดือน (1-28)' },
          hour: { type: 'integer', description: 'เวลาเตือน ชั่วโมงแบบ 24 ชม. (0-23) เช่น แปดโมงเช้า=8, เก้าโมง=9, บ่ายสอง=14' },
          minute: { type: 'integer', description: 'เวลาเตือน นาที (0-59)' },
          advanceDays: { type: 'array', items: { type: 'integer' }, description: 'จำนวนวันที่เตือนล่วงหน้าก่อนครบกำหนด เช่น [3,1] หมายถึงเตือนก่อน 3 วันและ 1 วัน' },
          amount: { type: 'integer', description: 'จำนวนเงินค่าเช่าเป็นบาท (ถ้าผู้ใช้ระบุ)' },
          enabled: { type: 'boolean', description: 'true=เปิดการเตือน, false=ปิดการเตือน' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_rent_reminder',
      description: 'แสดงการตั้งค่าการเตือนค่าเช่าปัจจุบันของห้องแชทนี้ เรียกเมื่อผู้ใช้ถามว่าตั้งค่าเตือนไว้อย่างไร',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ดำเนินการตาม tool ที่โมเดลเรียก -> คืนข้อความยืนยัน (หรือ null ถ้าไม่มี tool ที่รู้จัก)
function applyReminderTools(chatId, toolCalls) {
  for (const call of toolCalls) {
    const fn = call.function?.name;
    let args = call.function?.arguments || {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }

    if (fn === 'show_rent_reminder') {
      return formatReminderConfig(getReminderConfig(chatId));
    }

    if (fn === 'set_rent_reminder') {
      const c = getReminderConfig(chatId);
      const changes = [];
      if (Number.isInteger(args.dueDay) && args.dueDay >= 1 && args.dueDay <= 28) {
        c.dueDay = args.dueDay; changes.push(`วันครบกำหนด = วันที่ ${args.dueDay}`);
      }
      if (Number.isInteger(args.hour) && args.hour >= 0 && args.hour <= 23) {
        c.hour = args.hour;
        if (Number.isInteger(args.minute) && args.minute >= 0 && args.minute <= 59) c.minute = args.minute;
        else c.minute = 0;
        changes.push(`เวลา = ${String(c.hour).padStart(2,'0')}:${String(c.minute).padStart(2,'0')} น.`);
      }
      if (Array.isArray(args.advanceDays)) {
        const adv = [...new Set(args.advanceDays.map((x) => parseInt(x, 10))
          .filter((x) => Number.isInteger(x) && x > 0 && x <= 27))].sort((a, b) => b - a);
        c.advanceDays = adv;
        changes.push(`เตือนล่วงหน้า = ${adv.length ? adv.join(', ') + ' วัน' : 'ไม่มี'}`);
      }
      if (Number.isInteger(args.amount) && args.amount > 0) {
        c.amount = args.amount; changes.push(`ยอดค่าเช่า = ${args.amount.toLocaleString('th-TH')} บาท`);
      }
      if (typeof args.enabled === 'boolean') {
        c.enabled = args.enabled; changes.push(args.enabled ? 'เปิดการเตือน' : 'ปิดการเตือน');
      }
      if (changes.length === 0) return null; // โมเดลเรียกแต่ไม่มีค่าที่ใช้ได้
      c.enabled = c.enabled !== false; // ถ้าตั้งค่าใหม่ ให้ถือว่าเปิด (เว้นแต่สั่งปิดชัดเจน)
      setReminderConfig(chatId, c);
      return `✅ ตั้งค่าเตือนค่าเช่าเรียบร้อยค่ะ (${changes.join(', ')})\n\n${formatReminderConfig(c)}`;
    }
  }
  return null;
}

// ---------- Ollama (Qwen3) ----------
async function askOllama(chatId, userText) {
  const history = getHistory(chatId);
  // แนบ tool ตั้งเตือนเฉพาะเมื่อข้อความเกี่ยวกับการเตือน/ค่าเช่า (กัน tool ลั่นกับคำถามทั่วไป)
  const reminderRelated = /เตือน|ค่าเช่า|ชำระ|จ่ายค่า/.test(userText);

  const payload = {
    model: OLLAMA_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
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

  // ถ้าโมเดลเรียก tool -> ตั้งค่าเตือนจริง แล้วตอบยืนยัน
  if (msg.tool_calls?.length) {
    const confirm = applyReminderTools(chatId, msg.tool_calls);
    if (confirm) {
      pushHistory(chatId, 'user', userText);
      pushHistory(chatId, 'assistant', confirm);
      return confirm;
    }
  }

  let text = (msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  text = text || 'ขออภัยค่ะ ไม่สามารถประมวลผลคำตอบได้ กรุณาลองใหม่นะคะ';

  pushHistory(chatId, 'user', userText);
  pushHistory(chatId, 'assistant', text);
  return text;
}

// ---------- Claude (Anthropic) ----------
// แปลง tool definitions เดิม (รูปแบบ Ollama) ให้เป็นรูปแบบ Claude
const CLAUDE_REMINDER_TOOLS = REMINDER_TOOLS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));

async function askClaude(chatId, userText) {
  const history = getHistory(chatId);
  const reminderRelated = /เตือน|ค่าเช่า|ชำระ|จ่ายค่า/.test(userText);

  const req = {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    // prompt caching: ระบบ prompt คงที่ -> แคชไว้ลดต้นทุน
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [...history, { role: 'user', content: userText }],
  };
  if (reminderRelated) req.tools = CLAUDE_REMINDER_TOOLS;

  const resp = await anthropic.messages.create(req);

  // ถ้า Claude เรียก tool -> ตั้งค่าเตือนจริง แล้วตอบยืนยัน
  const toolUses = resp.content.filter((b) => b.type === 'tool_use');
  if (toolUses.length) {
    const confirm = applyReminderTools(
      chatId,
      toolUses.map((b) => ({ function: { name: b.name, arguments: b.input } }))
    );
    if (confirm) {
      pushHistory(chatId, 'user', userText);
      pushHistory(chatId, 'assistant', confirm);
      return confirm;
    }
  }

  let text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  text = text || 'ขออภัยค่ะ ไม่สามารถประมวลผลคำตอบได้ กรุณาลองใหม่นะคะ';

  pushHistory(chatId, 'user', userText);
  pushHistory(chatId, 'assistant', text);
  return text;
}

// ---------- Gemini (Google) ----------
// แปลง schema เป็นรูปแบบ Gemini (type ต้องเป็นตัวพิมพ์ใหญ่ เช่น OBJECT/STRING/INTEGER)
function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (s && typeof s === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      out[k] = k === 'type' && typeof v === 'string' ? v.toUpperCase() : toGeminiSchema(v);
    }
    return out;
  }
  return s;
}
// สร้าง function declarations สำหรับ Gemini จาก REMINDER_TOOLS
const GEMINI_REMINDER_TOOLS = [{
  function_declarations: REMINDER_TOOLS.map((t) => {
    const decl = { name: t.function.name, description: t.function.description };
    const props = t.function.parameters?.properties || {};
    if (Object.keys(props).length > 0) decl.parameters = toGeminiSchema(t.function.parameters);
    return decl;
  }),
}];

async function askGemini(chatId, userText) {
  const history = getHistory(chatId);
  const reminderRelated = /เตือน|ค่าเช่า|ชำระ|จ่ายค่า/.test(userText);

  // Gemini ใช้ role 'user' กับ 'model' (แปลง assistant -> model)
  const contents = [
    ...history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    { role: 'user', parts: [{ text: userText }] },
  ];

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.7 },
  };
  if (reminderRelated) body.tools = GEMINI_REMINDER_TOOLS;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await axios.post(url, body, { timeout: 120000 });
  const parts = resp.data?.candidates?.[0]?.content?.parts || [];

  // ถ้า Gemini เรียก tool -> ตั้งค่าเตือนจริง แล้วตอบยืนยัน
  const fcs = parts.filter((p) => p.functionCall);
  if (fcs.length) {
    const confirm = applyReminderTools(
      chatId,
      fcs.map((p) => ({ function: { name: p.functionCall.name, arguments: p.functionCall.args || {} } }))
    );
    if (confirm) {
      pushHistory(chatId, 'user', userText);
      pushHistory(chatId, 'assistant', confirm);
      return confirm;
    }
  }

  let text = parts.filter((p) => p.text).map((p) => p.text).join('').trim();
  text = text || 'ขออภัยค่ะ ไม่สามารถประมวลผลคำตอบได้ กรุณาลองใหม่นะคะ';

  pushHistory(chatId, 'user', userText);
  pushHistory(chatId, 'assistant', text);
  return text;
}

// ---------- Dispatcher: เลือก provider ตาม LLM_PROVIDER ----------
async function askAI(chatId, userText) {
  if (LLM_PROVIDER === 'claude') return askClaude(chatId, userText);
  if (LLM_PROVIDER === 'gemini') return askGemini(chatId, userText);
  return askOllama(chatId, userText);
}

// ---------- Start ----------
loadConversations();
loadGroups();
loadReminders();
app.listen(PORT, () => {
  const r = RENT_REMINDER;
  const hh = String(r.hour).padStart(2, '0');
  const mm = String(r.minute).padStart(2, '0');
  const adv = r.advanceDays.join(',');
  console.log(`🚀 LuckyCondo Bot listening on port ${PORT}`);
  if (LLM_PROVIDER === 'claude') {
    console.log(`   AI: Claude (${CLAUDE_MODEL})`);
  } else if (LLM_PROVIDER === 'gemini') {
    console.log(`   AI: Gemini (${GEMINI_MODEL})`);
  } else {
    console.log(`   AI: Ollama ${OLLAMA_URL}  Model: ${OLLAMA_MODEL}`);
  }
  console.log(`   ความจำ: ${MAX_HISTORY} ข้อความ/คน, ลบอัตโนมัติหลังเงียบ ${HISTORY_TTL_HOURS} ชม. (บันทึกลงไฟล์)`);
  console.log(`   เตือนค่าเช่า (ค่าตั้งต้น): ครบกำหนดวันที่ ${r.dueDay}, ล่วงหน้า ${adv} วัน, เวลา ${hh}:${mm} น. (${groups.size} กลุ่ม)`);
});
