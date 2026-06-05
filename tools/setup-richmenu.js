// ลงทะเบียน Rich Menu สำหรับงานดูแลผู้เช่า แล้วตั้งเป็นเมนูเริ่มต้นของทุกคน
// รัน: node tools/setup-richmenu.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
const fs = require('fs');
const axios = require('axios');

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const IMG = path.join(__dirname, 'richmenu.png');
const H = { Authorization: `Bearer ${TOKEN}` };

const menu = {
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

(async () => {
  if (!TOKEN) throw new Error('ไม่พบ LINE_CHANNEL_ACCESS_TOKEN ใน .env');
  if (!fs.existsSync(IMG)) throw new Error('ไม่พบไฟล์รูป richmenu.png (รัน make-richmenu-image.ps1 ก่อน)');

  // 1) ลบเมนูเดิมทั้งหมด (กันซ้ำ)
  const list = await axios.get('https://api.line.me/v2/bot/richmenu/list', { headers: H });
  for (const rm of list.data.richmenus || []) {
    await axios.delete(`https://api.line.me/v2/bot/richmenu/${rm.richMenuId}`, { headers: H });
    console.log('ลบเมนูเดิม:', rm.richMenuId);
  }

  // 2) สร้างเมนูใหม่
  const cr = await axios.post('https://api.line.me/v2/bot/richmenu', menu, {
    headers: { ...H, 'Content-Type': 'application/json' },
  });
  const id = cr.data.richMenuId;
  console.log('สร้างเมนู:', id);

  // 3) อัปโหลดรูป
  const img = fs.readFileSync(IMG);
  await axios.post(`https://api-data.line.me/v2/bot/richmenu/${id}/content`, img, {
    headers: { ...H, 'Content-Type': 'image/png' },
    maxBodyLength: Infinity,
  });
  console.log('อัปโหลดรูปแล้ว');

  // 4) ตั้งเป็นเมนูเริ่มต้นของผู้ใช้ทุกคน
  await axios.post(`https://api.line.me/v2/bot/user/all/richmenu/${id}`, null, { headers: H });
  console.log('✅ ตั้งเป็นเมนูเริ่มต้นเรียบร้อย:', id);
})().catch((e) => {
  console.error('❌ ERROR', e.response?.status, JSON.stringify(e.response?.data) || e.message);
  process.exit(1);
});
