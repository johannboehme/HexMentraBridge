const { Jimp } = require('jimp');
const http = require('http');

const WIDTH = 526;
const HEIGHT = 100;

async function generateFrame(frameIndex, totalFrames) {
  const img = new Jimp({ width: WIDTH, height: HEIGHT, color: 0x000000FF });

  const setP = (x, y) => {
    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT)
      img.setPixelColor(0xFFFFFFFF, x, y);
  };

  const rect = (x1, y1, w, h) => {
    for (let y = y1; y < y1 + h; y++)
      for (let x = x1; x < x1 + w; x++) setP(x, y);
  };

  const circle = (cx, cy, r) => {
    for (let a = 0; a < 360; a += 0.5) {
      const x = Math.round(cx + r * Math.cos(a * Math.PI / 180));
      const y = Math.round(cy + r * Math.sin(a * Math.PI / 180));
      setP(x, y);
    }
  };

  const cx = 263;
  const cy = 50;

  // Head
  circle(cx, cy, 35);
  circle(cx, cy, 34);

  // Antenna with bounce
  const bounce = Math.sin((frameIndex / totalFrames) * Math.PI * 2) * 5;
  rect(cx - 1, cy - 38 + bounce, 3, 6);
  circle(cx, cy - 42 + bounce, 4);
  circle(cx, cy - 42 + bounce, 3);

  // Eyes — blink animation
  const blinkFrame = frameIndex % 8;
  if (blinkFrame === 0 || blinkFrame === 1) {
    // Closed eyes (blinking)
    rect(cx - 18, cy - 5, 12, 2);
    rect(cx + 6, cy - 5, 12, 2);
  } else {
    // Open eyes
    rect(cx - 16, cy - 10, 8, 8);
    rect(cx + 8, cy - 10, 8, 8);
    // Pupils move
    const pupilOffset = Math.round(Math.sin((frameIndex / totalFrames) * Math.PI * 4) * 3);
    rect(cx - 14 + pupilOffset, cy - 8, 4, 4);
    rect(cx + 10 + pupilOffset, cy - 8, 4, 4);
  }

  // Smile
  for (let a = 200; a <= 340; a += 0.5) {
    const x = Math.round(cx + 16 * Math.cos(a * Math.PI / 180));
    const y = Math.round(cy + 10 + 14 * Math.sin(a * Math.PI / 180));
    setP(x, y);
  }

  // "HEX" text bouncing on the right
  const textY = 20 + Math.round(Math.sin((frameIndex / totalFrames) * Math.PI * 2) * 10);

  // H
  rect(cx + 60, textY, 3, 20);
  rect(cx + 72, textY, 3, 20);
  rect(cx + 60, textY + 9, 15, 3);

  // E
  rect(cx + 80, textY, 3, 20);
  rect(cx + 80, textY, 12, 3);
  rect(cx + 80, textY + 9, 10, 3);
  rect(cx + 80, textY + 17, 12, 3);

  // X
  for (let i = 0; i < 20; i++) {
    const x1 = cx + 97 + Math.round(i * 0.6);
    const x2 = cx + 109 - Math.round(i * 0.6);
    setP(x1, textY + i); setP(x1 + 1, textY + i);
    setP(x2, textY + i); setP(x2 + 1, textY + i);
  }

  const buf = await img.getBuffer('image/bmp');
  return buf.toString('base64');
}

async function main() {
  const totalFrames = 16;
  const frames = [];

  console.log(`Generating ${totalFrames} frames...`);
  for (let i = 0; i < totalFrames; i++) {
    frames.push(await generateFrame(i, totalFrames));
    process.stdout.write('.');
  }
  console.log(' done!');

  const intervalMs = parseInt(process.argv[2] || '300');
  const duration = parseInt(process.argv[3] || '10000');

  const payload = JSON.stringify({
    frames,
    intervalMs,
    repeat: true,
    duration,
  });

  console.log(`Pushing ${frames.length} frames, ${intervalMs}ms interval, ${duration}ms duration...`);

  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 3001, path: '/push-animation',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { console.log(data); resolve(); });
    });
    req.write(payload);
    req.end();
  });
}

main().catch(console.error);
