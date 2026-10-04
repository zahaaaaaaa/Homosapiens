/* Formular 230 with the team's NGO already filled in.
 *
 * The page is the official ANAF form (Anexa nr. 2, cod 14.13.04.13) as a 300 dpi image; on top of it go,
 * as real text: the year of the income, the mark at "2. Susținerea unei entități nonprofit", the NGO's
 * fiscal code, name and IBAN, and 3,5 at "Procentul din impozit". The person fills in the rest by hand
 * and signs. No other library: a one-page PDF is small enough to write directly.
 */
import { FONT_META, GLYPHS, FONT_B64 } from './f230-font.mjs';

const PW = 595.28, PH = 841.89;            // A4, in points
const IW = 2480, IH = 3507;                 // the form image
const SX = PW / IW, SY = PH / IH;
// Boxes of the form, in pixels of the image: [left, top, right, bottom], inside the border.
const BOX = {
  year: [[1254, 423, 1324, 497], [1327, 423, 1398, 497], [1401, 423, 1473, 497], [1476, 423, 1546, 497]],
  ngo: [904, 1645, 955, 1696],
  cif: [996, 1810, 1471, 1864],
  name: [738, 1899, 2362, 1956],
  iban: [417, 1991, 1651, 2048],
  pct: [497, 2085, 823, 2142]
};
const INK = '0.078 0.086 0.106';

const enc = new TextEncoder();
const num = (v) => String(Math.round(v * 100) / 100);
const hex4 = (n) => n.toString(16).padStart(4, '0').toUpperCase();
let fontBytes = null;
function font() {
  if (!fontBytes) fontBytes = Uint8Array.from(atob(FONT_B64), (c) => c.charCodeAt(0));
  return fontBytes;
}

// Glyph ids and width (per 1000) of a text; a letter the font lacks falls back to its plain form (ş -> s).
function shape(text) {
  let hex = '', w = 0;
  for (const ch of String(text || '')) {
    let g = GLYPHS[ch];
    if (!g) g = GLYPHS[ch.normalize('NFD')[0]];
    if (!g) continue;
    hex += hex4(g[0]); w += g[1];
  }
  return { hex, w };
}

function rect(b) {
  return { x0: b[0] * SX, x1: b[2] * SX, top: PH - b[1] * SY, bot: PH - b[3] * SY };
}

// Text in a box: left-aligned (or centred), the capital letters centred in height, smaller if it is too long.
function textIn(b, text, size, o = {}) {
  const { hex, w } = shape(text);
  if (!hex) return '';
  const r = rect(b);
  const pad = o.pad === undefined ? 5 : o.pad;
  const room = r.x1 - r.x0 - pad * 2;
  let s = size;
  if (w * s / 1000 > room) s = Math.max(o.min || 5, room * 1000 / w);
  const tw = w * s / 1000;
  const x = o.center ? r.x0 + (r.x1 - r.x0 - tw) / 2 : r.x0 + pad;
  const y = (r.top + r.bot) / 2 - FONT_META.cap * s / 2000;
  // clipped to the box, so nothing can spill over the form
  return `q ${num(r.x0)} ${num(r.bot)} ${num(r.x1 - r.x0)} ${num(r.top - r.bot)} re W n BT /F1 ${num(s)} Tf ${num(x)} ${num(y)} Td <${hex}> Tj ET Q\n`;
}

function cross(b) {
  const r = rect(b), i = (r.x1 - r.x0) * 0.22;
  return `${num(r.x0 + i)} ${num(r.bot + i)} m ${num(r.x1 - i)} ${num(r.top - i)} l ${num(r.x0 + i)} ${num(r.top - i)} m ${num(r.x1 - i)} ${num(r.bot + i)} l S\n`;
}

export const groupIban = (s) => String(s || '').replace(/\s+/g, '').toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');

// The year whose income the form is for: until 25 May it is last year's; after that, this year's
// (sent from January to 25 May of next year).
export function incomeYear(now = new Date()) {
  const y = now.getUTCFullYear();
  const afterDeadline = now.getUTCMonth() > 4 || (now.getUTCMonth() === 4 && now.getUTCDate() > 25);
  return afterDeadline ? y : y - 1;
}

function utf16hex(s) {
  let h = 'FEFF';
  for (let i = 0; i < s.length; i++) h += hex4(s.charCodeAt(i));
  return '<' + h + '>';
}

function toUnicode() {
  const pairs = [];
  for (const [ch, g] of Object.entries(GLYPHS)) {
    let u = '';
    for (let i = 0; i < ch.length; i++) u += hex4(ch.charCodeAt(i));
    pairs.push(`<${hex4(g[0])}> <${u}>`);
  }
  let body = '';
  for (let i = 0; i < pairs.length; i += 100) {
    const part = pairs.slice(i, i + 100);
    body += `${part.length} beginbfchar\n${part.join('\n')}\nendbfchar\n`;
  }
  return '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' + body +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
}

/* data: { year, cif, name, iban, pct, title }; jpeg: Uint8Array of the form image (IW x IH, baseline). */
export function formular230(data, jpeg) {
  const year = String(data.year || '').replace(/\D/g, '').slice(0, 4);
  let c = `q ${PW} 0 0 ${PH} 0 0 cm /Im1 Do Q\n${INK} rg ${INK} RG 1.4 w 1 J 1 j\n`;
  year.split('').forEach((d, i) => { c += textIn(BOX.year[i], d, 16, { center: true, pad: 0 }); });
  c += cross(BOX.ngo);
  c += textIn(BOX.cif, String(data.cif || '').replace(/\s+/g, ''), 11.5);
  c += textIn(BOX.name, data.name, 11.5, { min: 5.5 });
  c += textIn(BOX.iban, groupIban(data.iban), 11.5, { min: 7 });
  c += textIn(BOX.pct, data.pct || '3,5', 11.5);
  const F = FONT_META;
  const now = new Date();
  const stamp = 'D:' + now.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  const objs = [
    { d: '<< /Type /Catalog /Pages 2 0 R /Lang (ro-RO) /ViewerPreferences << /DisplayDocTitle true >> >>' },
    { d: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { d: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im1 4 0 R >> /Font << /F1 5 0 R >> /ProcSet [/PDF /Text /ImageC] >> /Contents 6 0 R >>` },
    { d: `<< /Type /XObject /Subtype /Image /Width ${IW} /Height ${IH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length %L >>`, s: jpeg },
    { d: `<< /Type /Font /Subtype /Type0 /BaseFont /${F.name} /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 9 0 R >>` },
    { d: '<< /Length %L >>', s: enc.encode(c) },
    { d: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${F.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /W [0 [${F.widths.join(' ')}]] /CIDToGIDMap /Identity >>` },
    { d: `<< /Type /FontDescriptor /FontName /${F.name} /Flags 32 /FontBBox [${F.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${F.ascent} /Descent ${F.descent} /CapHeight ${F.cap} /StemV 90 /FontFile2 10 0 R >>` },
    { d: '<< /Length %L >>', s: enc.encode(toUnicode()) },
    { d: `<< /Length %L /Length1 ${font().length} >>`, s: font() },
    { d: `<< /Title ${utf16hex(data.title || 'Formular 230')} /Author (Homosapiens #19053) /Creator (homosapiens.ro) /Producer (homosapiens.ro) /CreationDate (${stamp}) >>` }
  ];
  const parts = [];
  let len = 0;
  const push = (u) => { parts.push(u); len += u.length; };
  push(enc.encode('%PDF-1.7\n%âãÏÓ\n'));
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(len);
    if (o.s) {
      push(enc.encode(`${i + 1} 0 obj\n${o.d.replace('%L', String(o.s.length))}\nstream\n`));
      push(o.s);
      push(enc.encode('\nendstream\nendobj\n'));
    } else {
      push(enc.encode(`${i + 1} 0 obj\n${o.d}\nendobj\n`));
    }
  });
  const xref = len;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) x += String(o).padStart(10, '0') + ' 00000 n \n';
  x += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(enc.encode(x));
  const out = new Uint8Array(len);
  let p = 0;
  for (const u of parts) { out.set(u, p); p += u.length; }
  return out;
}
