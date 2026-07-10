# ReceiptBot — Cloudflare Worker + Durable Object

พอร์ตมาจาก `ReceiptBot.gs` (Google Apps Script) → Cloudflare Workers
Logic เหมือนเดิมเป๊ะ เปลี่ยนแค่ layer I/O ให้เร็วขึ้น

## ทำไมเร็วขึ้น
| ของช้าใน Apps Script | ของใหม่ใน Worker |
|---|---|
| `PropertiesService` (state) | Durable Object storage + KV |
| `LockService.waitLock(25s)` | Durable Object = serialize ต่อ user อัตโนมัติ |
| trigger `flushJobs` (ดีเลย์) | `ctx.waitUntil()` = ทำทันทีหลังตอบ 200 |
| cold start GAS | Worker cold start ~0ms |

## โครงไฟล์
```
wrangler.toml     ← config + KV + DO binding
src/config.js     ← CFG + 54 หมวด (CAT_TABLE)
src/domain.js     ← logic ล้วน: classify, group bills, การ์ด, html
src/lark.js       ← I/O: Lark API, Claude OCR, Bitable
src/index.js      ← Worker entry + SessionDO (Durable Object)
```

## Setup (ครั้งแรก)

### 1. ติดตั้ง + login
```bash
npm install
npx wrangler login
```

### 2. สร้าง KV แล้วเอา id ใส่ wrangler.toml
```bash
npx wrangler kv namespace create STATE
```
เอา `id` ที่ได้ ไปแทน `REPLACE_WITH_KV_ID` ใน `wrangler.toml`

### 3. ใส่ secret
```bash
npx wrangler secret put CLAUDE_KEY        # sk-ant-...
npx wrangler secret put LARK_APP_SECRET
```
> ✅ **ฟรีได้** — โค้ดนี้ใช้ Durable Object แบบ SQLite (`new_sqlite_classes`) ซึ่งอยู่ใน
> Workers **Free plan** แล้ว ไม่ต้องจ่าย $5
> (โควตา/ราคาเปลี่ยนได้ เช็คหน้า pricing ล่าสุดก่อน deploy)

### 4. deploy ครั้งแรก
```bash
npx wrangler deploy
```
จะได้ URL เช่น `https://receiptbot.xxx.workers.dev`
→ เอา URL นี้ไปแก้ `WORKER_URL` ใน `wrangler.toml` แล้ว **deploy ซ้ำอีกที**
(WORKER_URL ใช้ทำลิงก์ปุ่มในการ์ด ต้องตรง ไม่งั้นปุ่มพัง)

### 5. ตั้งค่าฝั่ง Lark (Developer Console)
- **Event Subscription** → Request URL = `https://receiptbot.xxx.workers.dev`
  (โค้ด handle `url_verification` ให้แล้ว กด verify ผ่านเลย)
  Subscribe event: `im.message.receive_v1`
- **Permissions**: `im:message`, `im:message:send_as_bot`, `im:resource`,
  `bitable:app`, `drive:drive`
- เพิ่ม app เป็น collaborator (**Can edit**) ใน Lark Base
- ปุ่มการ์ดใช้ open_url อยู่แล้ว ไม่ต้องตั้ง card callback URL แยก

### 6. ต่อ GitHub auto-deploy
- push repo ขึ้น GitHub
- Cloudflare Dashboard → Workers → เลือก worker → **Settings → Builds → Connect**
- เลือก repo → ทุก push = deploy อัตโนมัติ
- ตั้ง secret ซ้ำใน dashboard (Settings → Variables and Secrets) เพราะ build ฝั่ง CF ไม่เห็น secret จาก CLI

## เทสต์ว่าติด
- เปิด `https://receiptbot.xxx.workers.dev` → ต้องเห็น `"version":"CF_WORKER_v1"`
- ดู log สด: `npx wrangler tail`
- ส่งรูปบิลในแชทบอท → การ์ดต้องเด้งภายในไม่กี่วิ

## หมายเหตุ
- พนักงานยังต้องพิมพ์ `id` เอา open_id ไปใส่คอลัมน์ `Lark open_id` ในตารางพนักงาน (เหมือนเดิม)
- ต่อกับ autoBatch v5.0 เหมือนเดิม: ยิงเข้าตารางด้วยสถานะ `ยังไม่ได้จัดทำเอกสาร`
- ตัวนี้รันบน Free plan ได้ (SQLite DO) — ถ้าไม่อยากพึ่ง DO เลย มีเวอร์ชัน KV-only
  ให้ได้ แต่เสี่ยง double-card ตอนส่งรูปพร้อมกันเป๊ะๆ (ปกติไม่ต้องใช้)
