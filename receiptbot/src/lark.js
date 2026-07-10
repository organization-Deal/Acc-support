// ════════════════════════════════════════════════════════════════
// lark.js — I/O ทั้งหมด: Lark API, Claude OCR, Bitable
// (UrlFetchApp → fetch, CacheService/Properties → KV, base64 → btoa)
// ════════════════════════════════════════════════════════════════
import { CFG } from './config.js';
import { num, money, extract } from './domain.js';

// ── base64 (ArrayBuffer → base64) chunk กัน stack overflow รูปใหญ่ ──
function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── tenant token (cache ใน KV 90 นาที) ──
export async function larkToken(env) {
  const c = await env.KV.get('lark_tok');
  if (c) return c;
  const res = await fetch(CFG.LARK_HOST + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: CFG.LARK_APP_ID, app_secret: env.LARK_APP_SECRET }),
  });
  const j = await res.json();
  const tok = j.tenant_access_token;
  if (tok) await env.KV.put('lark_tok', tok, { expirationTtl: 5400 });
  return tok;
}

async function larkPost(env, path, payload) {
  const res = await fetch(CFG.LARK_HOST + path, {
    method: 'POST', headers: { Authorization: 'Bearer ' + (await larkToken(env)), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const out = await res.json();
  if (out.code && out.code !== 0) console.log('❌ Lark POST ' + path + ' → code ' + out.code + ' : ' + out.msg);
  return out;
}
async function larkPatch(env, path, payload) {
  const res = await fetch(CFG.LARK_HOST + path, {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + (await larkToken(env)), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const out = await res.json();
  if (out.code && out.code !== 0) console.log('❌ Lark PATCH ' + path + ' → code ' + out.code + ' : ' + out.msg);
  return out;
}

// ── message helpers ──
export async function reply(env, openId, text) {
  await larkPost(env, '/open-apis/im/v1/messages?receive_id_type=open_id',
    { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) });
}
export async function sendInteractive(env, openId, card) {
  const r = await larkPost(env, '/open-apis/im/v1/messages?receive_id_type=open_id',
    { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) });
  return (r.data && r.data.message_id) || '';
}
export async function patchMessage(env, messageId, card) {
  if (messageId) await larkPatch(env, `/open-apis/im/v1/messages/${messageId}`, { content: JSON.stringify(card) });
}
export async function patchSimple(env, messageId, template, title) {
  if (messageId) await patchMessage(env, messageId,
    { config: { wide_screen_mode: true }, header: { template, title: { tag: 'plain_text', content: title } }, elements: [] });
}

// ── image download / upload ──
export async function downloadImage(env, messageId, imageKey) {
  const res = await fetch(`${CFG.LARK_HOST}/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
    { headers: { Authorization: 'Bearer ' + (await larkToken(env)) } });
  if (res.status !== 200) throw new Error('download ' + res.status);
  return await res.arrayBuffer();
}
export async function uploadToBitable(env, messageId, imageKey) {
  const buf = await downloadImage(env, messageId, imageKey);
  const form = new FormData();
  form.append('file_name', imageKey + '.jpg');
  form.append('parent_type', 'bitable_image');
  form.append('parent_node', CFG.BASE_TOKEN);
  form.append('size', String(buf.byteLength));
  form.append('file', new Blob([buf], { type: 'image/jpeg' }), imageKey + '.jpg');  // file ต้องอยู่ท้ายสุด
  const res = await fetch(CFG.LARK_HOST + '/open-apis/drive/v1/medias/upload_all',
    { method: 'POST', headers: { Authorization: 'Bearer ' + (await larkToken(env)) }, body: form });
  const j = await res.json();
  if (!j.data || !j.data.file_token) throw new Error('upload: ' + JSON.stringify(j).substring(0, 120));
  return j.data.file_token;
}

// ════════════════════════════════════════════════════════════════
// CLAUDE OCR — บังคับ JSON ด้วย prefill "{"
// ════════════════════════════════════════════════════════════════
export async function claudeOCR(env, arrayBuffer) {
  const key = env.CLAUDE_KEY || env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ยังไม่ได้ใส่ CLAUDE_KEY');
  const pays = CFG.PAY_TYPES.join('|');
  const prompt =
`คุณคือ OCR เอกสารการเงินไทยของบริษัทตู้หยอดเหรียญ ตอบ JSON เท่านั้น ห้ามมีข้อความอื่น:
{"role":"RECEIPT|PAYSLIP|PROOF|OTHER","vendor":"ชื่อร้าน|null","date":"YYYY-MM-DD (พ.ศ.→ค.ศ.)","amount":เลข|null,"tax_id":"13หลัก|null","invoice_no":"เลข|null","pay_type":"${pays}|null","ai_detail":"ประโยคอธิบายค่าใช้จ่ายเชิงทางการ 1 ประโยค","confidence":0-100}
role: RECEIPT=ใบเสร็จ/ใบกำกับ, PAYSLIP=สลิปจ่าย, PROOF=หลักฐานโอน, OTHER=อื่นๆ(รูปอาหาร/สถานที่)
ai_detail: เขียนวัตถุประสงค์ค่าใช้จ่ายให้ดูเป็นทางการ เช่น "ค่าน้ำมันเชื้อเพลิงสำหรับเดินทางบำรุงรักษาตู้"
อ่านไม่ออก=null แต่ confidence ต้องมี`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': CFG.CLAUDE_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CFG.CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: abToBase64(arrayBuffer) } },
          { type: 'text', text: prompt } ] },
        { role: 'assistant', content: '{' },
      ],
    }),
  });

  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); } catch (e) { throw new Error('Claude ตอบไม่ใช่ JSON: ' + raw.substring(0, 120)); }
  if (body.error) throw new Error('Claude: ' + (body.error.message || raw).toString().substring(0, 150));
  if (!body.content) throw new Error('Claude: ' + raw.substring(0, 150));
  let text = body.content.map(c => c.text || '').join('');
  if (text.charAt(0) !== '{') text = '{' + text;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude ไม่ตอบ JSON: ' + text.substring(0, 120));
  const o = JSON.parse(m[0]);
  o.amount = num(o.amount); o.confidence = num(o.confidence);
  return o;
}

// ════════════════════════════════════════════════════════════════
// บันทึกเข้า "คำขอเบิกเงิน"
// ════════════════════════════════════════════════════════════════
export async function saveBills(env, emp, bills) {
  const refs = [];
  for (const b of bills) {
    const att = { payslip: [], receipt: [], tax: [], evidence: [] };
    for (const m of b.members) {
      let tok;
      try { tok = await uploadToBitable(env, m.message_id, m.image_key); } catch (e) { continue; }
      const cell = { file_token: tok };
      if (m.role === 'PAYSLIP') att.payslip.push(cell);
      else if (m.role === 'RECEIPT') (m.tax_id ? att.tax : att.receipt).push(cell);
      else att.evidence.push(cell);
    }

    const f = {};
    f[CFG.F.REQUESTER] = [emp.record_id];
    f[CFG.F.DETAIL]    = b.ai_detail || b.anchor.vendor || b.category || 'ค่าใช้จ่าย';
    if (b.ai_detail) f[CFG.F.AI_DETAIL] = b.ai_detail;
    f[CFG.F.AMOUNT]    = b.amount || 0;
    f[CFG.F.STATUS]    = CFG.STATUS_PENDING;
    if (b.anchor.date) f[CFG.F.DATE] = new Date(b.anchor.date).getTime();
    const code = b.cat_code;
    if (b.category && code) {
      f[CFG.F.CATEGORY]   = b.category;
      f[CFG.F.CAT_CODE_F] = code;
    }
    if (b.pay_type && CFG.PAY_TYPES.indexOf(b.pay_type) >= 0) f[CFG.F.PAY_TYPE] = b.pay_type;
    if (att.payslip.length)  f[CFG.F.ATT_PAYSLIP]  = att.payslip;
    if (att.receipt.length)  f[CFG.F.ATT_RECEIPT]  = att.receipt;
    if (att.tax.length)      f[CFG.F.ATT_TAX]      = att.tax;
    if (att.evidence.length) f[CFG.F.ATT_EVIDENCE] = att.evidence;
    f[CFG.F.NO_RECEIPT] = true;
    if (b.mismatch) f[CFG.F.NOTE] = `⚠️ ยอดใบเสร็จ ${money(b.amount)} ≠ ยอดจ่าย ${money(b.pay_amount)} (OCR ${b.anchor.confidence || 0}%)`;

    const r = await larkPost(env, `/open-apis/bitable/v1/apps/${CFG.BASE_TOKEN}/tables/${CFG.T_EXPENSE}/records`, { fields: f });
    let ref = '(เลขกำลังสร้าง)';
    try { ref = extract(r.data.record.fields[CFG.F.DOC_NO]) || ref; } catch (e) {}
    refs.push(ref);
  }
  return refs;
}

// ── หาพนักงานจาก open_id (list records + กรองฝั่งโค้ด, cache 6 ชม.) ──
export async function findEmployee(env, openId) {
  const hit = await env.KV.get('emp_' + openId);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  const tok = await larkToken(env);
  let pageToken = '';
  for (let guard = 0; guard < 20; guard++) {
    const url = `${CFG.LARK_HOST}/open-apis/bitable/v1/apps/${CFG.BASE_TOKEN}/tables/${CFG.T_EMPLOYEE}/records`
      + `?page_size=500` + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
    const res = await (await fetch(url, { headers: { Authorization: 'Bearer ' + tok } })).json();
    if (res.code !== 0) return null;
    const items = (res.data && res.data.items) || [];
    for (const it of items) {
      let oid = it.fields[CFG.EMP_OPENID];
      if (Array.isArray(oid)) oid = oid.map(x => (x && x.text) || x).join('');
      else if (oid && oid.text) oid = oid.text;
      if (oid === openId) {
        let name = it.fields[CFG.EMP_NAME];
        if (Array.isArray(name)) name = name.map(x => (x && x.text) || x).join('');
        const emp = { record_id: it.record_id, name: name || '' };
        await env.KV.put('emp_' + openId, JSON.stringify(emp), { expirationTtl: 21600 });
        return emp;
      }
    }
    if (!res.data || !res.data.has_more) break;
    pageToken = res.data.page_token;
  }
  return null;
}

// ── ยอดสะสมรอตั้งเบิกอาทิตย์นี้ ──
export async function weeklySummary(env, openId) {
  const emp = await findEmployee(env, openId);
  if (!emp) { await reply(env, openId, 'ยังไม่ได้ลงทะเบียนพนักงาน — พิมพ์ "id" แล้วเอา open_id ไปใส่ตารางพนักงาน'); return; }
  const tok = await larkToken(env);
  let n = 0, total = 0, pageToken = '';
  for (let guard = 0; guard < 20; guard++) {
    const url = `${CFG.LARK_HOST}/open-apis/bitable/v1/apps/${CFG.BASE_TOKEN}/tables/${CFG.T_EXPENSE}/records`
      + `?page_size=500` + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
    const r = await (await fetch(url, { headers: { Authorization: 'Bearer ' + tok } })).json();
    if (r.code !== 0) break;
    const items = (r.data && r.data.items) || [];
    items.forEach(it => {
      if (String(it.fields[CFG.F.STATUS] || '') === 'จัดทำเอกสารแล้ว') return;
      const req = it.fields[CFG.F.REQUESTER];
      let ids = [];
      if (Array.isArray(req)) req.forEach(x => { if (x && x.record_ids) ids = ids.concat(x.record_ids); });
      else if (req && req.record_ids) ids = req.record_ids;
      if (ids.indexOf(emp.record_id) >= 0) { n++; total += Number(it.fields[CFG.F.AMOUNT] || 0); }
    });
    if (!r.data || !r.data.has_more) break;
    pageToken = r.data.page_token;
  }
  await reply(env, openId, n ? `📊 รอตั้งเบิก: **${n} บิล** รวม **${money(total)}** บ.\n(ถึงรอบเบิกจะรวมเป็น PDF ให้)` : 'ยังไม่มีบิลรอตั้งเบิก');
}
