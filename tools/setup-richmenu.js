// ลงทะเบียน Rich Menu 2 ชุด:
//  - เมนูผู้เช่า  → ตั้งเป็น default ของทุกคน
//  - เมนูแอดมิน → ผูกเฉพาะ User ID ใน ADMIN_IDS
// รัน: node tools/setup-richmenu.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
const fs = require('fs');
const axios = require('axios');

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const H = { Authorization: `Bearer ${TOKEN}` };

const tenantMenu = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: 'LuckyCondo Tenant Menu',
  chatBarText: 'เมนูผู้เช่า',
  areas: [
    { bounds: { x: 0,    y: 0,   width: 833, height: 843 }, action: { type: 'message', text: 'ดูข้อมูลห้อง' } },
    { bounds: { x: 833,  y: 0,   width: 833, height: 843 }, action: { type: 'message', text: 'แจ้งซ่อม' } },
    { bounds: { x: 1666, y: 0,   width: 834, height: 843 }, action: { type: 'message', text: 'แจ้งชำระแล้ว' } },
    { bounds: { x: 0,    y: 843, width: 833, height: 843 }, action: { type: 'message', text: 'ดูสถานะชำระ' } },
    { bounds: { x: 833,  y: 843, width: 833, height: 843 }, action: { type: 'message', text: 'ดูการแจ้งซ่อม' } },
    { bounds: { x: 1666, y: 843, width: 834, height: 843 }, action: { type: 'message', text: 'ขอช่องทางติดต่อเจ้าหน้าที่' } },
  ],
};

const adminMenu = {
  size: { width: 2500, height: 1686 },
  selected: false,
  name: 'LuckyCondo Admin Menu',
  chatBarText: 'เมนูแอดมิน',
  areas: [
    { bounds: { x: 0,    y: 0,   width: 833, height: 843 }, action: { type: 'message', text: 'คำสั่งแอดมิน' } },
    { bounds: { x: 833,  y: 0,   width: 833, height: 843 }, action: { type: 'message', text: 'สรุปเดือนนี้' } },
    { bounds: { x: 1666, y: 0,   width: 834, height: 843 }, action: { type: 'message', text: 'ห้องทั้งหมด' } },
    { bounds: { x: 0,    y: 843, width: 833, height: 843 }, action: { type: 'message', text: 'ค้างชำระ' } },
    { bounds: { x: 833,  y: 843, width: 833, height: 843 }, action: { type: 'message', text: 'ซ่อมค้าง' } },
    { bounds: { x: 1666, y: 843, width: 834, height: 843 }, action: { type: 'message', text: 'สัญญาใกล้หมด' } },
  ],
};

async function createMenu(menu, imgFile) {
  const imgPath = path.join(__dirname, imgFile);
  if (!fs.existsSync(imgPath)) throw new Error(`ไม่พบไฟล์รูป ${imgFile} (รัน make-richmenu-image.ps1 ก่อน)`);
  const cr = await axios.post('https://api.line.me/v2/bot/richmenu', menu, {
    headers: { ...H, 'Content-Type': 'application/json' },
  });
  const id = cr.data.richMenuId;
  await axios.post(`https://api-data.line.me/v2/bot/richmenu/${id}/content`, fs.readFileSync(imgPath), {
    headers: { ...H, 'Content-Type': 'image/png' }, maxBodyLength: Infinity,
  });
  console.log(`สร้างเมนู "${menu.name}":`, id);
  return id;
}

(async () => {
  if (!TOKEN) throw new Error('ไม่พบ LINE_CHANNEL_ACCESS_TOKEN ใน .env');

  // 1) ลบเมนูเดิมทั้งหมด
  const list = await axios.get('https://api.line.me/v2/bot/richmenu/list', { headers: H });
  for (const rm of list.data.richmenus || []) {
    await axios.delete(`https://api.line.me/v2/bot/richmenu/${rm.richMenuId}`, { headers: H });
    console.log('ลบเมนูเดิม:', rm.richMenuId);
  }

  // 2) สร้างเมนูผู้เช่า + แอดมิน
  const tenantId = await createMenu(tenantMenu, 'richmenu.png');
  const adminId = await createMenu(adminMenu, 'richmenu-admin.png');

  // 3) ตั้งเมนูผู้เช่าเป็น default ของทุกคน
  await axios.post(`https://api.line.me/v2/bot/user/all/richmenu/${tenantId}`, null, { headers: H });
  console.log('✅ ตั้งเมนูผู้เช่าเป็น default แล้ว');

  // 4) ผูกเมนูแอดมินกับ ADMIN_IDS (override default เฉพาะคน)
  for (const uid of ADMIN_IDS) {
    try {
      await axios.post(`https://api.line.me/v2/bot/user/${uid}/richmenu/${adminId}`, null, { headers: H });
      console.log('   ผูกเมนูแอดมินให้:', uid);
    } catch (e) {
      console.error('   ผูกเมนูแอดมินไม่สำเร็จ:', uid, e.response?.status, JSON.stringify(e.response?.data) || e.message);
    }
  }
  console.log(`✅ เสร็จสิ้น (แอดมิน ${ADMIN_IDS.length} คน)`);
})().catch((e) => {
  console.error('❌ ERROR', e.response?.status, JSON.stringify(e.response?.data) || e.message);
  process.exit(1);
});
