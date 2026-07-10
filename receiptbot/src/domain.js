// ════════════════════════════════════════════════════════════════
// domain.js — logic ล้วน ไม่มี I/O (พอร์ตตรงจาก ReceiptBot.gs)
// classify / group bills / build card / html / util
// ════════════════════════════════════════════════════════════════
import { CFG, CAT_TABLE } from './config.js';

// ── util ──
export function num(x) {
  const n = parseFloat(String(x).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}
export function money(x) {
  return x == null ? '-' : Number(x).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function extract(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(x => (x && x.text) || x).join('');
  if (v.text) return v.text;
  if (v.value) return extract(v.value);
  return '';
}

// ── classifier ──
export function classify(text) {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return null;
  let best = null, score = 0;
  CAT_TABLE.forEach(row => {
    let s = 0;
    row.k.split(',').forEach(kw => { kw = kw.trim().toLowerCase(); if (kw && t.indexOf(kw) >= 0) s++; });
    if (t.indexOf(row.n.toLowerCase()) >= 0) s += 2;
    if (s > score) { score = s; best = row; }
  });
  return score > 0 ? { name: best.n, code: best.c } : null;
}
export function codeOf(name) { const r = CAT_TABLE.find(x => x.n === name); return r ? r.c : ''; }

export function guessCategory(vendor) {
  const v = (vendor || '').toLowerCase();
  if (/ปตท|pt|bangchak|shell|esso|caltex|น้ำมัน|ปั๊ม/.test(v)) return 'ค่าน้ำมัน';
  if (/grab|taxi|bts|mrt|วิน|แท็กซี่|เดินทาง/.test(v))          return 'ค่าเดินทาง (บริหาร)';
  if (/โรงแรม|hotel|resort|ที่พัก/.test(v))                     return 'ค่าที่พัก';
  if (/ร้านอาหาร|cafe|coffee|กาแฟ|อาหาร|ภัตตาคาร/.test(v))      return 'ค่าอาหาร (บริหาร)';
  return '';
}

// ── จัดกลุ่มรูป → บิล ──
export function groupBills(items) {
  const receipts = items.filter(x => x.role === 'RECEIPT' && x.amount != null);
  let anchor =
    receipts.filter(x => x.tax_id).sort((a, b) => (b.amount || 0) - (a.amount || 0))[0] ||
    receipts.slice().sort((a, b) => (b.amount || 0) - (a.amount || 0))[0] ||
    items.find(x => x.amount != null) || items[0];
  const slip = items.find(x => (x.role === 'PAYSLIP' || x.role === 'PROOF') && x.amount != null)
            || items.find(x => x !== anchor && x.amount != null);
  const payAmt = slip ? slip.amount : null;
  const mismatch = anchor.amount != null && payAmt != null &&
                   Math.abs(anchor.amount - payAmt) > CFG.AMOUNT_TOLERANCE;
  return [{
    anchor, members: items, amount: anchor.amount, pay_amount: payAmt, mismatch,
    warn: anchor.amount == null ? 'ไม่พบยอดในใบเสร็จ'
        : (mismatch ? 'ยอดใบเสร็จ ≠ ยอดจ่าย — เช็กก่อนยืนยัน' : '')
  }];
}

export function buildBills(arr) {
  const bills = groupBills(arr);
  bills.forEach(b => {
    b.ai_detail = b.anchor.ai_detail || '';
    b.pay_type  = b.anchor.pay_type || '';
    let hit = classify([b.anchor.vendor, b.ai_detail, b.anchor.invoice_no].join(' '));
    if (!hit) { const g = guessCategory(b.anchor.vendor); if (g) hit = { name: g, code: codeOf(g) }; }
    b.category = hit ? hit.name : '';
    b.cat_code = hit ? hit.code : '';
  });
  return bills;
}

// ── ลิงก์ปุ่ม (open_url → GET กลับมา Worker) ──
export function actUrl(workerUrl, act, openId, tok, extra) {
  let u = workerUrl + '?act=' + act + '&u=' + encodeURIComponent(openId) + '&k=' + tok;
  if (extra) Object.keys(extra).forEach(k => { u += '&' + k + '=' + encodeURIComponent(extra[k]); });
  return u;
}

// ── การ์ด — opts = { tok, workerUrl } ──
export function buildCard(openId, bills, mode, refs, opts) {
  const url = (act) => actUrl(opts.workerUrl, act, openId, opts.tok);
  const el = []; let total = 0;
  bills.forEach((b, i) => {
    total += (b.amount || 0);
    const cat = b.category || '— (ยังไม่ระบุหมวด)';
    const warn = b.warn ? `\n⚠️ ${b.warn}` : '';
    const ref = (refs && refs[i]) ? `  ·  ${refs[i]}` : '';
    const pay = b.pay_type ? ` · จ่าย:${b.pay_type}` : '';
    el.push({ tag: 'div', text: { tag: 'lark_md', content:
      `**${bills.length > 1 ? (i + 1) + '. ' : ''}${cat}**${ref}\n` +
      `${b.ai_detail || b.anchor.vendor || '-'}\n` +
      `ยอด **${money(b.amount)}** บ.${pay} · ${b.members.length} รูป` + warn } });
  });
  el.push({ tag: 'hr' });

  if (mode === 'done') {
    const list = (refs && refs.length)
      ? refs.map((r, i) => `${r} · ${money(bills[i] && bills[i].amount)} บ.`).join('\n')
      : 'บันทึกเรียบร้อย';
    el.push({ tag: 'div', text: { tag: 'lark_md', content: '✅ **บันทึกเข้าระบบแล้ว — รอตั้งเบิก**\n' + list } });
    return { config: { wide_screen_mode: true },
      header: { template: 'green', title: { tag: 'plain_text', content: '✅ บันทึกแล้ว' } }, elements: el };
  }

  if (mode === 'saving') {
    el.push({ tag: 'div', text: { tag: 'lark_md', content: '⏳ **กำลังบันทึก...** (อัปโหลดรูป + สร้างรายการ ~10 วิ)' } });
    return { config: { wide_screen_mode: true },
      header: { template: 'turquoise', title: { tag: 'plain_text', content: '⏳ กำลังบันทึก' } }, elements: el };
  }

  if (mode === 'edit' && bills.length === 1) {
    el.push({ tag: 'div', text: { tag: 'lark_md', content:
      '**✏️ พิมพ์แก้ในแชทได้เลย:**\n' +
      '• `ค่า กาแฟลูกค้า` — แก้ชื่อรายการ\n' +
      '• `ยอด 520` — แก้จำนวนเงิน\n\n(หมวดแก้ในเว็บทีหลัง)' } });
    el.push({ tag: 'action', actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '✅ ยืนยัน' }, type: 'primary', url: url('confirm') },
      { tag: 'button', text: { tag: 'plain_text', content: '🗑️ ทิ้ง' },  type: 'danger',  url: url('discard') } ] });
    return { config: { wide_screen_mode: true },
      header: { template: 'orange', title: { tag: 'plain_text', content: '✏️ แก้ไขบิล' } }, elements: el };
  }

  el.push({ tag: 'div', text: { tag: 'lark_md', content: `รวม **${money(total)}** บ.` } });
  if (bills.length > 1) {
    el.push({ tag: 'div', text: { tag: 'lark_md', content: `⚠️ **แยกให้ ${bills.length} บิล — เช็กว่าถูก** ถ้าผิดกด 🗑️ แล้วส่งทีละบิล` } });
    el.push({ tag: 'action', actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '✅ ยืนยันทั้งหมด' }, type: 'primary', url: url('confirm') },
      { tag: 'button', text: { tag: 'plain_text', content: '🗑️ ทิ้ง' },         type: 'danger',  url: url('discard') } ] });
  } else {
    el.push({ tag: 'action', actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '✅ ยืนยัน' }, type: 'primary', url: url('confirm') },
      { tag: 'button', text: { tag: 'plain_text', content: '✏️ แก้ไข' },                  url: url('editform') },
      { tag: 'button', text: { tag: 'plain_text', content: '🗑️ ทิ้ง' },   type: 'danger',  url: url('discard') } ] });
  }
  el.push({ tag: 'note', elements: [{ tag: 'lark_md', content:
    'กด ✏️ แก้ไข เพื่อแก้ชื่อรายการ/ยอด · หมวดให้แอดมินแก้ในเว็บทีหลัง' }] });
  return { config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '📋 ตรวจก่อนยืนยัน' } }, elements: el };
}

// ── หน้าเว็บตอบกลับหลังกดปุ่ม ──
export function htmlPage(title, msg) {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#fff;font-family:-apple-system,Roboto,Sarabun,sans-serif">'
    + '<div style="text-align:center;padding:32px 24px;max-width:340px">'
    + '<div style="font-size:48px;line-height:1;margin-bottom:12px">' + (title.split(' ')[0] || '✅') + '</div>'
    + '<div style="font-size:22px;font-weight:700;color:#1f2329;margin-bottom:10px">' + title + '</div>'
    + '<div style="font-size:15px;color:#646a73;line-height:1.6;white-space:pre-line">' + msg + '</div>'
    + '<div style="font-size:13px;color:#8f959e;margin-top:20px">ปิดหน้านี้แล้วกลับไปแชทได้เลย</div>'
    + '</div></body></html>';
}

export function editFormHtml(openId, tok, bill, workerUrl) {
  const name = String((bill && (bill.ai_detail || (bill.anchor && bill.anchor.vendor))) || '').replace(/"/g, '&quot;');
  const amount = (bill && bill.amount != null) ? bill.amount : '';
  const wrap = 'font-family:-apple-system,Roboto,Sarabun,sans-serif;';
  const lb = 'display:block;font-size:14px;color:#646a73;margin:16px 2px 6px;';
  const inp = 'width:100%;box-sizing:border-box;padding:14px;font-size:17px;border:1px solid #d0d3d6;border-radius:11px;background:#fff;color:#1f2329;outline:none;';
  const btn = 'display:block;width:100%;box-sizing:border-box;margin-top:24px;padding:16px;font-size:17px;font-weight:700;color:#fff;background:#3370ff;border:none;border-radius:12px;';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<base target="_top">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:20px 16px;background:#fff;' + wrap + 'color:#1f2329">'
    + '<div style="font-size:20px;font-weight:700;margin:2px 2px 4px">✏️ แก้ไขบิล</div>'
    + '<div style="font-size:13px;color:#8f959e;margin:0 2px 8px">แก้เฉพาะช่องที่ต้องการ แล้วกดบันทึก</div>'
    + '<form method="get" target="_top" action="' + workerUrl + '">'
    + '<input type="hidden" name="act" value="saveedit">'
    + '<input type="hidden" name="u" value="' + openId + '">'
    + '<input type="hidden" name="k" value="' + tok + '">'
    + '<label style="' + lb + '">ชื่อรายการ</label>'
    + '<input name="name" style="' + inp + '" value="' + name + '" placeholder="เช่น ค่ากาแฟรับรองลูกค้า">'
    + '<label style="' + lb + '">ยอดเงิน (บาท)</label>'
    + '<input name="amount" type="text" inputmode="decimal" style="' + inp + '" value="' + amount + '" placeholder="0.00">'
    + '<button type="submit" style="' + btn + '">💾 บันทึกการแก้ไข</button>'
    + '<div style="font-size:13px;color:#8f959e;margin-top:10px;text-align:center">บันทึกแล้วกลับไปแชท กด ✅ ยืนยัน</div>'
    + '</form></body></html>';
}
