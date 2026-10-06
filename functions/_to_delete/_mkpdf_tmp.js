const rows = [
 ['38378','4593','MOLLE 2 MED W/FRAME OCP M',4,60.00,240.00,'Price gap $10.00','PACK OCP MEDIUM FRAMED · #1 · $70 · 8 on hand'],
 ['27054','—','MOLLE 2 W/FRAME RUCKSACK OCP L',3,70.00,210.00,'No SKU on their line','—'],
 ['11569','—','GORTEX PARKA USE 3COL XL  (PR-451-D3-SR)',4,30.00,120.00,'Their code only','—'],
 ['9693','2630','TAC USMC ASSAULT GOOD COY  (EA30)',12,8.75,105.00,'Price gap $3.00 · coyote vs USMC','POUCH ASSAULT W/ZIPPER USMC #1 · #1 · $5.75 · 248 on hand'],
 ['44092','2987','AF ARCTIC NYLON NEW S',5,20.00,100.00,'Wrong item · SKU reused','MITTEN FUR W/LINER CAMO SMALL · NEW · $12.75 · 177 on hand'],
 ['6464','—','ECW FLEECE USED COYT S  (DI40)',6,12.75,76.50,'Their code only','—'],
 ['2876','—','US USED PISTOL OD L  (ED30 2464/3764)',15,4.75,71.25,'Their code only','—'],
 ['10796','3542','GEN 3 THERM TOP SAND L  (DD40)',5,12.00,60.00,'Price gap $0.75','GRID FROG TOP TAN USMC LG · #1 · $12.75 · 81 on hand'],
 ['5817','4128','GEN 3 SILK ECW PANT NEW COYT XL',5,8.75,43.75,'Wrong item · $71 apart','JACKET WIND OCP GEN III XSS · $80 · 0 on hand'],
 ['18303','3732','MOLLE BANDOLEER OCP NEW  (EH20)',4,6.50,26.00,'Wrong item · half price','BANDOLEER MULTICAM · NEW · $12.75 · 20 on hand'],
 ['43247','2987','N4B ARCTIC FUR NEW CAMO S',1,18.75,18.75,'Wrong item · same SKU as 44092','MITTEN FUR W/LINER CAMO SMALL · NEW · $12.75 · 177 on hand'],
 ['2670','—','US VELCRO USED CAMO 7.5  (EG10 HVLCRWC)',4,4.00,16.00,'Their code only','—'],
 ['2558','2075','US VELCRO NEW CAMO 7.5',2,6.75,13.50,'Wrong item','HELMET LINER 7 1/4 WOODLAND · NEW · $8.75 · 0 on hand'],
];
const units = rows.reduce((s,r)=>s+r[3],0);
const value = rows.reduce((s,r)=>s+r[5],0);
const tr = rows.map(r=>`<tr>
<td class="c b">${r[0]}</td><td class="c b">${r[1]}</td>
<td>${r[2]}</td>
<td class="c">${r[3]}</td><td class="r">$${r[4].toFixed(2)}</td><td class="r b">$${r[5].toFixed(2)}</td>
<td class="issue">${r[6]}</td><td class="cat">${r[7]}</td>
<td class="fill"></td></tr>`).join('');
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>AA6647 unmatched lines</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Arial,sans-serif;color:#333;font-size:9.5px;padding:14px 16px}
.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1976d2;padding-bottom:8px;margin-bottom:10px}
.doc-title{font-size:19px;font-weight:300;color:#1976d2;letter-spacing:1px}
.doc-sub{font-size:12px;font-weight:700;color:#000;margin-top:1px}
.co{text-align:right;font-size:9px;color:#555}
.co strong{font-size:12px;color:#333;display:block}
.meta{display:flex;gap:22px;margin-bottom:9px;font-size:9.5px}
.meta div{background:#f8f9fa;border-left:3px solid #1976d2;padding:6px 9px}
.meta b{color:#888;font-size:8px;text-transform:uppercase;letter-spacing:.8px;display:block;margin-bottom:1px}
table{width:100%;border-collapse:collapse}
th{background:#1976d2;color:#fff;padding:5px 6px;text-align:left;font-size:8px;text-transform:uppercase;letter-spacing:.3px}
td{padding:5px 6px;border-bottom:1px solid #e0e0e0;vertical-align:top}
.c{text-align:center}.r{text-align:right}.b{font-weight:700}
.issue{color:#b26a00;font-size:9px}
.cat{color:#555;font-size:9px}
.fill{border-left:1px solid #ccc;background:#fffdf5;min-width:88px}
tfoot td{border-top:2px solid #1976d2;font-weight:700;padding-top:7px;background:#f8f9fa}
.note{margin-top:10px;background:#fffde7;border-left:3px solid #ffc107;padding:8px 10px;font-size:9px}
.foot{margin-top:12px;padding-top:7px;border-top:1px solid #e0e0e0;text-align:center;font-size:8.5px;color:#888}
@page{size:Letter landscape;margin:.3in}
</style></head><body>
<div class="header"><div><div class="doc-title">UNMATCHED LINES</div><div class="doc-sub">Army Barracks PO AAS000932026</div></div>
<div class="co"><strong>AA Surplus Sales</strong>2153 Pond Road<br>Ronkonkoma, NY 11779<br>716-496-2451</div></div>
<div class="meta">
<div><b>Their PO</b>AAS000932026 · 3 Sep 2026 · Assoc. EMILY</div>
<div><b>Our draft</b>AA6647 — 42 of 55 lines built</div>
<div><b>Not built</b>13 lines · ${units} units · $${value.toFixed(2)}</div>
<div><b>Terms</b>NET 0 days · no backorders or substitutions</div></div>
<table><thead><tr>
<th style="width:44px">Item#</th><th style="width:38px">Their SKU</th><th>Their description</th>
<th style="width:26px" class="c">Qty</th><th style="width:44px" class="r">Cost</th><th style="width:52px" class="r">Line total</th>
<th style="width:110px">Why it is out</th><th style="width:190px">What that SKU is in our catalogue</th>
<th style="width:88px">Correct SKU</th></tr></thead>
<tbody>${tr}</tbody>
<tfoot><tr><td colspan="3">13 lines</td><td class="c">${units}</td><td></td><td class="r">$${value.toFixed(2)}</td><td colspan="3"></td></tr></tfoot></table>
<div class="note"><b>Note.</b> The four rows with no SKU carry only Army Barracks' own codes and need someone who can read their numbering. 3542 and 4593 look like the same goods with prices that have drifted — $300 of the $${value.toFixed(2)} — and could be added straight away. 2987 is used by them for two different products.</div>
<div class="foot">Generated 3 September 2026 · balance of PO AAS000932026 not yet on draft AA6647</div>
</body></html>`;
(async()=>{
  const {htmlToPdf}=require('/sessions/rcw-01qsssopzvcng16d8zxkjjxg/mnt/AA Inventory System/AA-Sales/functions/pdf.js');
  const chromium=require('@sparticuz/chromium'); const puppeteer=require('puppeteer-core');
  const b=await puppeteer.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});
  const p=await b.newPage();
  await p.setContent(html,{waitUntil:'load'});
  const buf=await p.pdf({landscape:true,format:'Letter',printBackground:true,margin:{top:'0.3in',right:'0.3in',bottom:'0.3in',left:'0.3in'}});
  require('fs').writeFileSync('/sessions/rcw-01qsssopzvcng16d8zxkjjxg/mnt/AA Inventory System/AA6647-unmatched-lines.pdf',Buffer.from(buf));
  console.log('PDF bytes:',buf.length);
  await b.close(); process.exit(0);
})().catch(e=>{console.log('FAILED:',e.message);process.exit(1);});
