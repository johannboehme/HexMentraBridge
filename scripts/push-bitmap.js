#!/usr/bin/env bun
/**
 * Generate a bitmap with text and push it to G1 glasses.
 * 
 * Usage:
 *   bun scripts/push-bitmap.js "Your text here" [duration_ms]
 * 
 * The G1 display is monochrome, 526x100 content area (padded to 576x135 by SDK).
 * White text on black background. Max ~40 chars per line, ~4 lines.
 * Font is rendered via jimp — basic bitmap font.
 */

const { Jimp } = require('jimp');
const http = require('http');
const path = require('path');

const PUSH_PORT = 3001;
const WIDTH = 526;
const HEIGHT = 100;

// Simple 5x7 pixel font for uppercase + lowercase + digits + basic punctuation
const FONT = {
  'A': ['01110','10001','10001','11111','10001','10001','10001'],
  'B': ['11110','10001','10001','11110','10001','10001','11110'],
  'C': ['01110','10001','10000','10000','10000','10001','01110'],
  'D': ['11110','10001','10001','10001','10001','10001','11110'],
  'E': ['11111','10000','10000','11110','10000','10000','11111'],
  'F': ['11111','10000','10000','11110','10000','10000','10000'],
  'G': ['01110','10001','10000','10111','10001','10001','01110'],
  'H': ['10001','10001','10001','11111','10001','10001','10001'],
  'I': ['01110','00100','00100','00100','00100','00100','01110'],
  'J': ['00111','00010','00010','00010','00010','10010','01100'],
  'K': ['10001','10010','10100','11000','10100','10010','10001'],
  'L': ['10000','10000','10000','10000','10000','10000','11111'],
  'M': ['10001','11011','10101','10101','10001','10001','10001'],
  'N': ['10001','10001','11001','10101','10011','10001','10001'],
  'O': ['01110','10001','10001','10001','10001','10001','01110'],
  'P': ['11110','10001','10001','11110','10000','10000','10000'],
  'Q': ['01110','10001','10001','10001','10101','10010','01101'],
  'R': ['11110','10001','10001','11110','10100','10010','10001'],
  'S': ['01110','10001','10000','01110','00001','10001','01110'],
  'T': ['11111','00100','00100','00100','00100','00100','00100'],
  'U': ['10001','10001','10001','10001','10001','10001','01110'],
  'V': ['10001','10001','10001','10001','01010','01010','00100'],
  'W': ['10001','10001','10001','10101','10101','10101','01010'],
  'X': ['10001','10001','01010','00100','01010','10001','10001'],
  'Y': ['10001','10001','01010','00100','00100','00100','00100'],
  'Z': ['11111','00001','00010','00100','01000','10000','11111'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['01110','10001','00001','00110','00001','10001','01110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['01110','10001','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','10001','01110'],
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  '.': ['00000','00000','00000','00000','00000','00000','00100'],
  ',': ['00000','00000','00000','00000','00000','00100','01000'],
  '!': ['00100','00100','00100','00100','00100','00000','00100'],
  '?': ['01110','10001','00001','00110','00100','00000','00100'],
  ':': ['00000','00100','00000','00000','00000','00100','00000'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  '/': ['00001','00010','00010','00100','01000','01000','10000'],
  '(': ['00010','00100','01000','01000','01000','00100','00010'],
  ')': ['01000','00100','00010','00010','00010','00100','01000'],
  '@': ['01110','10001','10111','10101','10110','10000','01110'],
  // Lowercase mapped to uppercase
};

// Map lowercase to uppercase
for (let c = 97; c <= 122; c++) {
  FONT[String.fromCharCode(c)] = FONT[String.fromCharCode(c - 32)];
}

function drawChar(img, char, startX, startY, scale = 2) {
  const pattern = FONT[char] || FONT['?'];
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (pattern[row][col] === '1') {
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = startX + col * scale + sx;
            const py = startY + row * scale + sy;
            if (px >= 0 && px < WIDTH && py >= 0 && py < HEIGHT) {
              img.setPixelColor(0xFFFFFFFF, px, py);
            }
          }
        }
      }
    }
  }
}

function renderText(img, text, scale = 2) {
  const charW = 5 * scale + scale; // char width + spacing
  const lineH = 7 * scale + scale * 2; // char height + line spacing
  const maxCharsPerLine = Math.floor(WIDTH / charW);
  
  // Word wrap
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  
  for (const word of words) {
    const test = currentLine ? currentLine + ' ' + word : word;
    if (test.length > maxCharsPerLine) {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = test;
    }
  }
  if (currentLine) lines.push(currentLine);
  
  // Center vertically
  const totalH = lines.length * lineH;
  const startY = Math.max(4, Math.floor((HEIGHT - totalH) / 2));
  
  for (let l = 0; l < lines.length && l < 4; l++) {
    const line = lines[l];
    // Center horizontally
    const lineWidth = line.length * charW;
    const startX = Math.max(4, Math.floor((WIDTH - lineWidth) / 2));
    
    for (let c = 0; c < line.length; c++) {
      drawChar(img, line[c], startX + c * charW, startY + l * lineH, scale);
    }
  }
}

async function main() {
  const text = process.argv[2] || 'Hello from Hex!';
  const duration = parseInt(process.argv[3] || '10000');
  
  const img = new Jimp({ width: WIDTH, height: HEIGHT, color: 0x000000FF });
  renderText(img, text);
  
  const buf = await img.getBuffer('image/bmp');
  const b64 = buf.toString('base64');
  
  const payload = JSON.stringify({ bitmap: b64, duration });
  
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PUSH_PORT, path: '/push-bitmap',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { console.log(data); resolve(); });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

main().catch(console.error);
