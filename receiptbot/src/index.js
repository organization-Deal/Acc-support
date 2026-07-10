// ════════════════════════════════════════════════════════════════
// index.js — Worker entry + SessionDO
//
//  • Worker fetch  = รับ webhook (event/card) + ปุ่ม GET
//  • SessionDO     = 1 instance ต่อ 1 openId → request เข้าคิวเรียงกันเอง
//                    (แทน LockService.waitLock ของ Apps Script)
//  • งานหนักหลังกดยืนยัน = ctx.waitUntil (แทน trigger flushJobs — ไม่มีดีเลย์)
// ════════════════════════════════════════════════════════════════
import { DurableObject } from 'cloudflare:workers';
import { CFG } from './config.js';
import {
  claudeOCR, downloadImage, reply, sendInteractive, patchMessage, patchSimple,
  saveBills, findEmployee, weeklySummary,
} from './lark.js';
import { buildBills, buildCard, htmlPage, editFormHtml, num, money } from './domain.js';

const RX_CONFIRM = /^(ยืนยัน|ยืนยน|บันทึก|save|confirm|y|yes|ok|โอเค|ใช่|ตกลง|1|👍|✅|✔️|🆗)$/i;
const RX_DISCARD = /^(ทิ้ง|ยกเลิก|cancel|no|ไม่|x|❌|🗑️|0)$/i;
const RX_EDIT    = /^(แก้|แก้ไข|edit|e|✏️|2)$/i;

// ── helpers: response ──
const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
const html = (s) => new Response(s, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const doStub = (env, openId) => env.SESSION.get(env.SESSION.idFromName(openId));

// ════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET')  return handleGet(request, env);
    if (request.method === 'POST') return handlePost(request, env, ctx);
    return json({ ok: true, bot: 'ReceiptBot', version: 'CF_WORKER_v1' });
  },
};

// ── ปุ่มในการ์ด (open_url → GET) ──
async function handleGet(request, env) {
  const url = new URL(request.url);
  const p = Object.fromEntries(url.searchParams);
  const act = p.act || '';
  if (!act) return json({ ok: true, bot: 'ReceiptBot', version: 'CF_WORKER_v1', note: 'ส่งบิลในแชท Lark' });
  const openId = p.u || '';
  if (!openId) return html(htmlPage('⚠️ ลิงก์ใช้ไม่ได้', 'ลิงก์ไม่ถูกต้อง'));
  const out = await doStub(env, openId).handleButton(act, openId, p.k || '', p.name ?? null, p.amount ?? null);
  return html(out);
}

async function handlePost(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: true }); }

  if (body.type === 'url_verification') return json({ challenge: body.challenge });

  // card action callback (path สำรอง — ปุ่มหลักใช้ open_url)
  if (body.action || (body.event && body.event.action)) {
    const act = body.action || body.event.action || {};
    const value = act.value || {};
    const openId = value.open_id;
    if (!openId) return json({ ok: true });
    const res = await doStub(env, openId).cardAction(openId, value, act);
    if (res.flush) ctx.waitUntil(doStub(env, openId).flush());
    return json(res.toast || { ok: true });
  }

  const h = body.header || {};
  if (h.event_type === 'im.message.receive_v1') {
    const evtId = h.event_id;
    if (evtId) {
      if (await env.KV.get('evt_' + evtId)) return json({ ok: true });
      await env.KV.put('evt_' + evtId, '1', { expirationTtl: 600 });
    }
    ctx.waitUntil(handleMessage(body.event, env));   // ตอบ 200 ทันที งานหนักทำเบื้องหลัง
  }
  return json({ ok: true });
}

// ── OCR อยู่ตรงนี้ (ขนานกันได้) → ค่อยส่งผลเข้า DO (serialize) ──
async function handleMessage(event, env) {
  const msg = event.message;
  const openId = (event.sender && event.sender.sender_id && event.sender.sender_id.open_id) || '';
  if (!openId || !msg) return;

  if (msg.message_type === 'text') {
    const t = (JSON.parse(msg.content).text || '').trim();
    await doStub(env, openId).handleText(t, openId);
    return;
  }
  if (msg.message_type !== 'image') return;

  const content = JSON.parse(msg.content);
  let ocr;
  try {
    const bytes = await downloadImage(env, msg.message_id, content.image_key);
    ocr = await claudeOCR(env, bytes);
  } catch (err) {
    await reply(env, openId, '⚠️ อ่านรูปนี้ไม่ได้: ' + err.message);
    return;
  }
  await doStub(env, openId).processImage(openId, msg.message_id, content.image_key, ocr);
}

// ════════════════════════════════════════════════════════════════
// SessionDO — state + serialize ต่อ openId
// storage key เดียว: 'session' = { openId, stage[], grouped[], cardmsg, tok, tosave[] }
// ════════════════════════════════════════════════════════════════
export class SessionDO extends DurableObject {
  async #load()  { return (await this.ctx.storage.get('session')) || {}; }
  async #save(s) { await this.ctx.storage.put('session', s); }
  #tok(s)  { if (!s.tok) s.tok = crypto.randomUUID().replace(/-/g, '').substring(0, 12); return s.tok; }
  #opts(s) { return { tok: this.#tok(s), workerUrl: this.env.WORKER_URL }; }

  // ── รับผล OCR ของรูป 1 ใบ ──
  async processImage(openId, messageId, imageKey, ocr) {
    const s = await this.#load();
    s.openId = openId;
    s.stage = s.stage || [];
    s.stage.push({
      message_id: messageId, image_key: imageKey,
      role: ocr.role, vendor: ocr.vendor, date: ocr.date, amount: ocr.amount,
      tax_id: ocr.tax_id, invoice_no: ocr.invoice_no,
      pay_type: ocr.pay_type, ai_detail: ocr.ai_detail, confidence: ocr.confidence,
    });
    const bills = buildBills(s.stage);
    s.grouped = bills;
    const opts = this.#opts(s);   // ensure tok
    await this.#save(s);

    if (s.cardmsg) {
      await patchMessage(this.env, s.cardmsg, buildCard(openId, bills, 'view', null, opts));
    } else {
      const mId = await sendInteractive(this.env, openId, buildCard(openId, bills, 'view', null, opts));
      if (mId) { s.cardmsg = mId; await this.#save(s); }
    }
  }

  // ── ข้อความในแชท ──
  async handleText(t, openId) {
    const s = await this.#load();
    s.openId = openId;

    if (t === 'id') { await reply(this.env, openId, 'open_id: ' + openId); return; }

    if (s.grouped && s.grouped.length) {
      const bills = s.grouped;
      if (RX_CONFIRM.test(t)) {
        s.tosave = s.grouped; s.grouped = [];
        const opts = this.#opts(s);
        await this.#save(s);
        if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, bills, 'saving', null, opts));
        await this.flush();
        return;
      }
      if (RX_DISCARD.test(t)) {
        if (s.cardmsg) await patchSimple(this.env, s.cardmsg, 'grey', '🗑️ ทิ้งบิลแล้ว');
        await this.ctx.storage.delete('session');
        await reply(this.env, openId, 'ทิ้งบิลแล้ว — ถ่ายใหม่ส่งได้เลย');
        return;
      }
      if (RX_EDIT.test(t)) {
        await reply(this.env, openId, '✏️ พิมพ์แก้ได้เลย (ไม่ต้องพิมพ์ "แก้" ก่อนก็ได้):\n' +
          '• `ค่า กาแฟลูกค้า` — แก้ชื่อรายการ\n' +
          '• `ยอด 520` — แก้จำนวนเงิน\n\n(หมวดให้แอดมินแก้ในเว็บทีหลัง)\nเสร็จแล้วพิมพ์ `y` ยืนยัน');
        return;
      }
      if (await this.#applyTextEdit(s, t, openId)) return;
    }

    if (/^(รายการ|ยอดสะสม|ค้างเบิก)$/.test(t)) { await weeklySummary(this.env, openId); return; }
    await reply(this.env, openId, '📸 ถ่ายบิลส่งเป็นชุด (สลิป + ใบเสร็จ + รูป)\nการ์ดจะเด้งให้ตรวจทันทีหลังอ่านรูป\nพิมพ์ "รายการ" = ดูยอดที่เบิกแล้วอาทิตย์นี้');
  }

  async #applyTextEdit(s, text, openId) {
    if (!s.grouped || !s.grouped.length) return false;
    const b = s.grouped[0]; let done = ''; let m;
    if ((m = text.match(/^ยอด\s*([\d,\.]+)/)))                                  { b.amount = num(m[1]); done += 'ยอด '; }
    if ((m = text.match(/^(?:ชื่อ|รายการ|รายละเอียด|ค่า)\s*(.+)/)))            { b.ai_detail = m[1].trim(); done += 'ชื่อรายการ '; }
    if (!done) return false;
    const opts = this.#opts(s);
    await this.#save(s);
    if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, s.grouped, 'view', null, opts));
    await reply(this.env, openId, `✏️ แก้ ${done.trim()} แล้ว — พิมพ์ \`y\` เพื่อยืนยัน`);
    return true;
  }

  // ── งานหนัก: อัปโหลดรูป + เขียน record + แจ้งผล (เรียกจาก confirm) ──
  async flush() {
    const s = await this.#load();
    const bills = s.tosave || [];
    if (!bills.length) return;
    const openId = s.openId;
    s.tosave = [];
    await this.#save(s);

    const emp = await findEmployee(this.env, openId);
    if (!emp) {
      await reply(this.env, openId, '⚠️ ยังไม่ได้ลงทะเบียนพนักงาน\nพิมพ์ "id" เอา open_id ไปใส่คอลัมน์ "Lark open_id" ในตารางพนักงานก่อน แล้วส่งบิลใหม่');
      return;
    }
    const refs = await saveBills(this.env, emp, bills);
    const opts = this.#opts(s);
    if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, bills, 'done', refs, opts));

    // ล้าง session (จบรอบ)
    await this.ctx.storage.delete('session');
    await reply(this.env, openId, '✅ บันทึกแล้ว:\n' +
      bills.map((b, i) => `${refs[i]} · ${b.category || '-'} · ${money(b.amount)} บ.`).join('\n') +
      '\n\nพิมพ์ "รายการ" ดูยอดสะสมอาทิตย์นี้');
  }

  // ── ปุ่ม open_url (GET) ──
  async handleButton(act, openId, k, name, amount) {
    const s = await this.#load();
    s.openId = openId;
    const bills = s.grouped || [];

    // ตรวจ session token
    if (act !== 'confirm' && act !== 'discard' && act !== 'editform' && act !== 'editmenu' && act !== 'saveedit')
      return htmlPage('⚠️ ลิงก์ใช้ไม่ได้', 'act ไม่รู้จัก');
    if (!s.tok || s.tok !== k)
      return htmlPage('⚠️ ลิงก์ใช้ไม่ได้', 'บิลนี้จัดการไปแล้ว หรือลิงก์หมดอายุ\nถ่ายบิลใหม่ส่งในแชทได้เลย');

    // ── ยืนยัน → เซฟเข้า Lark เลย (หน้าเว็บรอได้ ไม่มี limit 3 วิ) ──
    if (act === 'confirm') {
      if (!bills.length) return htmlPage('บันทึกไปแล้ว', 'บิลนี้ถูกบันทึก/ยกเลิกไปแล้ว');
      const emp = await findEmployee(this.env, openId);
      if (!emp) {
        await reply(this.env, openId, '⚠️ ยังไม่ได้ลงทะเบียนพนักงาน\nพิมพ์ "id" เอา open_id ไปใส่คอลัมน์ "Lark open_id" ในตารางพนักงานก่อน');
        return htmlPage('ยังไม่ลงทะเบียน', 'พิมพ์ "id" ในแชท แล้วเอา open_id ไปใส่ตารางพนักงานก่อน');
      }
      const opts = this.#opts(s);
      if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, bills, 'saving', null, opts));
      const refs = await saveBills(this.env, emp, bills);
      if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, bills, 'done', refs, opts));
      await this.ctx.storage.delete('session');
      const sum = bills.reduce((a, b) => a + (b.amount || 0), 0);
      await reply(this.env, openId, '✅ บันทึกแล้ว:\n' +
        bills.map((b, i) => `${refs[i]} · ${b.category || '-'} · ${money(b.amount)} บ.`).join('\n') +
        '\n\nพิมพ์ "รายการ" ดูยอดสะสมอาทิตย์นี้');
      return htmlPage('✅ บันทึกเข้าระบบแล้ว',
        bills.map((b, i) => refs[i] + ' · ' + money(b.amount) + ' บ.').join('\n') +
        '\n━━━━━━━━━\nรวม ' + money(sum) + ' บาท\nสถานะ: รอตั้งเบิก');
    }

    if (act === 'discard') {
      if (s.cardmsg) await patchSimple(this.env, s.cardmsg, 'grey', '🗑️ ทิ้งบิลแล้ว');
      await this.ctx.storage.delete('session');
      await reply(this.env, openId, '🗑️ ทิ้งบิลแล้ว — ถ่ายใหม่ส่งได้เลย');
      return htmlPage('🗑️ ทิ้งแล้ว', 'ถ่ายบิลใหม่ส่งในแชทได้เลย');
    }

    if (act === 'editform' || act === 'editmenu') {
      if (!bills.length) return htmlPage('บิลนี้จบแล้ว', 'ถ่ายบิลใหม่ส่งในแชทได้เลย');
      return editFormHtml(openId, s.tok, bills[0], this.env.WORKER_URL);
    }

    if (act === 'saveedit') {
      if (bills[0]) {
        if (name != null && name !== '') bills[0].ai_detail = String(name).trim();
        const amt = num(amount);
        if (amt != null) bills[0].amount = amt;
        const opts = this.#opts(s);
        await this.#save(s);
        if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, bills, 'view', null, opts));
      }
      return htmlPage('✅ แก้ไขเรียบร้อย',
        'ชื่อรายการ: ' + (name || '-') + '\nยอดเงิน: ' + money(num(amount)) + ' บาท\n\n👉 กลับไปแชท แล้วกด ✅ ยืนยัน เพื่อบันทึกเข้าระบบ');
    }

    return htmlPage('⚠️', 'ไม่มี handler');
  }

  // ── card action callback (path สำรอง) ──
  async cardAction(openId, value, act) {
    const s = await this.#load();
    s.openId = openId;
    const bills = s.grouped || [];
    const opts = this.#opts(s);

    if (value.action === 'discard') {
      if (s.cardmsg) await patchSimple(this.env, s.cardmsg, 'grey', '🗑️ ทิ้งบิลแล้ว');
      await this.ctx.storage.delete('session');
      return { toast: { toast: { type: 'success', content: 'ทิ้งบิลแล้ว' } } };
    }
    if (value.action === 'edit') {
      if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, bills, 'edit', null, opts));
      await this.#save(s);
      return { toast: { toast: { type: 'success', content: 'เปิดโหมดแก้ไข ✏️' } } };
    }
    if (value.action === 'confirm') {
      if (!bills.length) return { toast: { toast: { type: 'success', content: 'บิลนี้บันทึกไปแล้ว' } } };
      s.tosave = bills; s.grouped = [];
      await this.#save(s);
      if (s.cardmsg) await patchMessage(this.env, s.cardmsg, buildCard(openId, bills, 'saving', null, opts));
      return { toast: { toast: { type: 'success', content: '⏳ กำลังบันทึก...' } }, flush: true };
    }
    return { toast: { ok: true } };
  }
}
