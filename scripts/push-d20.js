#!/usr/bin/env bun
/**
 * Generate a monochrome D20 die bitmap and push to G1 glasses.
 * 526x100 content area, white on black.
 */

const { Jimp } = require('jimp');
const http = require('http');

const WIDTH = 526;
const HEIGHT = 100;
const PUSH_PORT = 3001;

async function main() {
  const duration = parseInt(process.argv[2]) || 15000;
  
  // Create black image
  const image = new Jimp({ width: WIDTH, height: HEIGHT, color: 0x000000FF });
  
  // D20 is an icosahedron - draw a simplified front-facing view
  // Center of the die
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const r = 44; // radius
  
  // Draw a D20 shape: outer pentagon-like shape with triangular facets
  // Top vertex
  const top = { x: cx, y: cy - r };
  // Bottom vertex  
  const bot = { x: cx, y: cy + r };
  // Left vertices
  const tl = { x: cx - r * 0.95, y: cy - r * 0.35 };
  const bl = { x: cx - r * 0.58, y: cy + r * 0.8 };
  // Right vertices
  const tr = { x: cx + r * 0.95, y: cy - r * 0.35 };
  const br = { x: cx + r * 0.58, y: cy + r * 0.8 };
  // Inner vertices for 3D effect
  const il = { x: cx - r * 0.35, y: cy + r * 0.15 };
  const ir = { x: cx + r * 0.35, y: cy + r * 0.15 };
  const it = { x: cx, y: cy - r * 0.3 };
  
  const white = 0xFFFFFFFF;
  
  // Draw outer edges
  drawLine(image, top.x, top.y, tl.x, tl.y, white);
  drawLine(image, top.x, top.y, tr.x, tr.y, white);
  drawLine(image, tl.x, tl.y, bl.x, bl.y, white);
  drawLine(image, tr.x, tr.y, br.x, br.y, white);
  drawLine(image, bl.x, bl.y, bot.x, bot.y, white);
  drawLine(image, br.x, br.y, bot.x, bot.y, white);
  
  // Draw inner triangle edges (the visible front face)
  drawLine(image, it.x, it.y, il.x, il.y, white);
  drawLine(image, it.x, it.y, ir.x, ir.y, white);
  drawLine(image, il.x, il.y, ir.x, ir.y, white);
  
  // Connect inner to outer
  drawLine(image, top.x, top.y, it.x, it.y, white);
  drawLine(image, tl.x, tl.y, it.x, it.y, white);
  drawLine(image, tr.x, tr.y, it.x, it.y, white);
  drawLine(image, tl.x, tl.y, il.x, il.y, white);
  drawLine(image, bl.x, bl.y, il.x, il.y, white);
  drawLine(image, tr.x, tr.y, ir.x, ir.y, white);
  drawLine(image, br.x, br.y, ir.x, ir.y, white);
  drawLine(image, il.x, il.y, bot.x, bot.y, white);
  drawLine(image, ir.x, ir.y, bot.x, bot.y, white);
  
  // Draw "20" in the center triangle
  const numX = Math.round(cx - 10);
  const numY = Math.round(cy - 6);
  drawChar(image, '2', numX, numY, white, 2);
  drawChar(image, '0', numX + 12, numY, white, 2);
  
  // Convert to BMP buffer
  const bmpBuffer = await image.getBuffer('image/bmp');
  const base64 = bmpBuffer.toString('base64');
  
  // Push to glasses
  const postData = JSON.stringify({ bitmap: base64, duration });
  const req = http.request({
    hostname: '127.0.0.1',
    port: PUSH_PORT,
    path: '/push-bitmap',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
  }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => console.log(data));
  });
  req.on('error', e => console.error('Push failed:', e.message));
  req.write(postData);
  req.end();
}

// Bresenham line drawing
function drawLine(image, x0, y0, x1, y1, color) {
  x0 = Math.round(x0); y0 = Math.round(y0);
  x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    if (x0 >= 0 && x0 < WIDTH && y0 >= 0 && y0 < HEIGHT) {
      image.setPixelColor(color, x0, y0);
      // Make lines thicker (2px)
      if (x0 + 1 < WIDTH) image.setPixelColor(color, x0 + 1, y0);
      if (y0 + 1 < HEIGHT) image.setPixelColor(color, x0, y0 + 1);
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

// Simple 5x7 font characters for digits
const FONT = {
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
};

function drawChar(image, ch, startX, startY, color, scale = 1) {
  const glyph = FONT[ch];
  if (!glyph) return;
  for (let row = 0; row < glyph.length; row++) {
    for (let col = 0; col < glyph[row].length; col++) {
      if (glyph[row][col] === '1') {
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = startX + col * scale + sx;
            const py = startY + row * scale + sy;
            if (px >= 0 && px < WIDTH && py >= 0 && py < HEIGHT) {
              image.setPixelColor(color, px, py);
            }
          }
        }
      }
    }
  }
}

main().catch(console.error);
