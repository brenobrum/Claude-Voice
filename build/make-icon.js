// Renders the orb shader (src/orb.js) into the app icon: build/icon.png (1024²) and build/icon.icns.
// Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const orbSrc = fs.readFileSync(path.join(__dirname, '../src/orb.js'), 'utf8');
const grab = (name) => orbSrc.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`))[1];

// Runs in the page: draw one frame of the orb, then frame it in a macOS-style rounded square.
const render = (vert, frag) => {
  const S = 1024;
  const gl3 = document.createElement('canvas');
  gl3.width = gl3.height = 1100;
  const gl = gl3.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true });
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vert));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const set = (n, ...v) => gl[`uniform${v.length}f`](gl.getUniformLocation(prog, n), ...v);
  gl.viewport(0, 0, gl3.width, gl3.height);
  set('uRes', gl3.width, gl3.height);
  // A fixed, nicely composed moment: listening, mid-sentence.
  set('uTime', 7.3); set('uFlow', 2.4); set('uLevel', 0.35); set('uLow', 0.3);
  set('uHigh', 0.35); set('uActive', 1); set('uSpeak', 0);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  // Apple icon grid: 824² body centred in 1024², corner radius ~185.
  const x = 100, w = 824, r = 185;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 28; g.shadowOffsetY = 12;
  g.beginPath(); g.roundRect(x, x, w, w, r);
  const bg = g.createRadialGradient(512, 470, 40, 512, 512, 560);
  bg.addColorStop(0, '#2a1a12'); bg.addColorStop(0.55, '#140e0b'); bg.addColorStop(1, '#080606');
  g.fillStyle = bg; g.fill();
  g.restore();
  g.save();
  g.beginPath(); g.roundRect(x, x, w, w, r); g.clip();
  g.drawImage(gl3, (S - gl3.width) / 2, (S - gl3.height) / 2);
  g.restore();
  return c.toDataURL('image/png');
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const url = await win.webContents.executeJavaScript(`(${render})(${JSON.stringify(grab('VERT'))}, ${JSON.stringify(grab('FRAG'))})`);
  const png = path.join(__dirname, 'icon.png');
  fs.writeFileSync(png, Buffer.from(url.split(',')[1], 'base64'));

  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-')) + '/icon.iconset';
  fs.mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      execFileSync('sips', ['-z', String(px), String(px), png, '--out', path.join(set, name)], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(__dirname, 'icon.icns')]);
  console.log('wrote build/icon.png and build/icon.icns');
  app.quit();
});
