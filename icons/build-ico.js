'use strict';
// Assembles logo-{256,128,64,48,32,16}.png into usage-panel.ico (PNG-compressed entries).
const fs = require('fs');
const path = require('path');
const sizes = [256, 128, 64, 48, 32, 16];
const dir = __dirname;
const pngs = sizes.map((s) => ({ s, buf: fs.readFileSync(path.join(dir, 'logo-' + s + '.png')) }));

const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(count, 4);

const entries = [];
let offset = 6 + 16 * count;
for (const { s, buf } of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(s === 256 ? 0 : s, 0); // width (0 = 256)
  e.writeUInt8(s === 256 ? 0 : s, 1); // height
  e.writeUInt8(0, 2);  // palette
  e.writeUInt8(0, 3);  // reserved
  e.writeUInt16LE(1, 4);  // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(buf.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += buf.length;
  entries.push(e);
}
const out = Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
fs.writeFileSync(path.join(dir, '..', 'usage-panel.ico'), out);
console.log('usage-panel.ico written: ' + out.length + ' bytes, ' + count + ' sizes');
