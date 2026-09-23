'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const qrcode = require('../public/vendor/qrcode');

test('generates local, scannable SVG data for subscription links', () => {
  const qr = qrcode(0, 'M');
  qr.addData('https://example.com/s/aLongRandomTokenUsedOnlyForThisTest/clash-smart', 'Byte');
  qr.make();
  const svg = qr.createSvgTag(4, 4);
  assert.match(svg, /<svg/);
  assert.match(svg, /<path/);
});
