// Voice-reactive orb: a shaded WebGL sphere of flowing warm color (white / orange / coral / gold),
// driven by analysers on the mic stream and on Claude's voice.
const orb = (() => {
  const VERT = `
    attribute vec2 p;
    void main() { gl_Position = vec4(p, 0.0, 1.0); }
  `;

  const FRAG = `
    precision highp float;
    uniform vec2 uRes;
    uniform float uTime, uFlow, uLevel, uLow, uHigh, uActive, uSpeak;

    // 3D simplex noise (Ashima Arts / Stefan Gustavson, MIT).
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
    float snoise(vec3 v) {
      const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      i = mod289(i);
      vec4 p = permute(permute(permute(
                i.z + vec4(0.0, i1.z, i2.z, 1.0))
              + i.y + vec4(0.0, i1.y, i2.y, 1.0))
              + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0) * 2.0 + 1.0;
      vec4 s1 = floor(b1) * 2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
    }

    float fbm(vec3 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) { v += a * snoise(p); p = p * 2.02 + vec3(3.1, 1.7, 5.3); a *= 0.5; }
      return v;
    }

    // Ember -> orange -> amber -> white-hot ramp.
    vec3 ramp(float x) {
      x = clamp(x, 0.0, 1.0);
      vec3 c = mix(vec3(0.42, 0.04, 0.06), vec3(0.95, 0.24, 0.06), smoothstep(0.0, 0.35, x));
      c = mix(c, vec3(1.0, 0.55, 0.12), smoothstep(0.3, 0.6, x));
      c = mix(c, vec3(1.0, 0.8, 0.45), smoothstep(0.55, 0.8, x));
      return mix(c, vec3(1.0, 0.97, 0.93), smoothstep(0.78, 1.0, x));
    }

    void main() {
      float scale = min(uRes.x, uRes.y);
      vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / scale;
      float energy = clamp(uLevel * 1.2 + uSpeak * 0.25, 0.0, 1.0);
      float t = uTime;

      // Living silhouette: the edge breathes when idle and ripples with the voice.
      float ang = atan(uv.y, uv.x);
      vec2 ring = vec2(cos(ang), sin(ang));
      float edgeN = snoise(vec3(ring * 1.2, t * 0.35)) * 0.7 + snoise(vec3(ring * 2.4, t * 0.5 + 4.0)) * 0.3 * energy;
      float R = 0.56 * mix(0.9, 1.0, uActive) * (1.0 + 0.015 * sin(t * 0.9) + uLevel * 0.05);
      R *= 1.0 + edgeN * (0.012 + energy * 0.03);

      vec2 p = uv / R;
      float r = length(p);
      float aa = 2.5 / (R * scale);

      vec3 col = vec3(0.0);
      float body = 1.0 - smoothstep(1.0 - aa, 1.0, r);

      if (r < 1.0) {
        float z = sqrt(1.0 - r * r);
        vec3 nrm = vec3(p, z);

        // Slow liquid flow on the sphere, domain-warped and stirred by the voice.
        // uFlow is integrated on the CPU, so speeding up never jumps the pattern.
        vec3 q = nrm * 0.95 + vec3(0.0, uFlow * 0.6, uFlow);
        vec3 warp = vec3(snoise(q * 0.8 + vec3(0.0, 0.0, t * 0.1)),
                         snoise(q * 0.8 + vec3(5.2, 1.3, -t * 0.08)),
                         snoise(q * 0.8 + vec3(9.1, 4.7, t * 0.12)));
        q += warp * (0.5 + uLow * 0.5);
        float f = fbm(q) * 0.5 + 0.5;                  // ~0..1
        float f2 = snoise(q * 1.7 + warp + t * 0.2) * 0.5 + 0.5;

        // Heat: brighter toward the core and with loudness.
        float heat = f * 0.85 + pow(z, 1.5) * 0.5 - 0.12 + energy * 0.1;
        col = ramp(heat);

        // A cool magenta-rose undertone in the deepest pockets gives it depth.
        col = mix(col, vec3(0.75, 0.12, 0.35), smoothstep(0.5, 0.05, heat) * 0.6);

        // Thin luminous veins that sharpen with high frequencies.
        float vein = pow(1.0 - abs(f2 * 2.0 - 1.0), 7.0);
        col += vec3(1.0, 0.9, 0.8) * vein * (0.15 + uHigh * 0.2) * z;

        // Glassy highlight + soft emissive core.
        vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
        float spec = pow(max(dot(reflect(-L, nrm), vec3(0.0, 0.0, 1.0)), 0.0), 40.0);
        col += vec3(1.0) * spec * 0.35;
        col += vec3(1.0, 0.9, 0.78) * pow(z, 6.0) * (0.08 + energy * 0.3);

        // Fresnel rim: hot orange melting into white at the edge.
        float fr = 1.0 - z;
        col = mix(col, vec3(1.0, 0.45, 0.15), pow(fr, 2.2) * 0.55);
        col += vec3(1.0, 0.9, 0.8) * pow(fr, 6.0) * (0.45 + energy * 0.35);

        // Idle: calmer and dimmer; listening: full color.
        float luma = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(vec3(luma) * vec3(1.0, 0.8, 0.7), col, 0.6 + 0.4 * uActive);
        col *= 0.55 + 0.45 * uActive;
      }

      // Outer glow + voice ripples.
      float d = max(r - 1.0, 0.0) * R;
      vec3 haloCol = mix(vec3(1.0, 0.38, 0.12), vec3(1.0, 0.25, 0.35), 0.5 + 0.5 * sin(ang * 2.0 + t * 0.4));
      haloCol = mix(haloCol, vec3(1.0, 0.85, 0.7), energy * 0.3);
      float glow = exp(-d * (9.0 - energy * 2.5)) * (0.12 + uActive * 0.16 + energy * 0.35);
      float ripples = (0.5 + 0.5 * sin(d * 50.0 - t * 3.0)) * exp(-d * 10.0) * uLevel * 0.18;
      // Fade out well before the canvas edge so the glow never shows a box.
      float edgeFade = smoothstep(1.0, 0.7, max(abs(uv.x), abs(uv.y)));
      float halo = (glow + ripples) * (1.0 - body) * edgeFade;
      vec3 outer = haloCol * halo;

      // Saturation-preserving highlight roll-off: overbright values bloom toward white instead of clipping.
      float peak = max(col.r, max(col.g, col.b));
      col = mix(col / max(peak, 1.0), vec3(1.0), clamp(peak - 1.0, 0.0, 1.0) * 0.6);
      // Premultiplied alpha.
      gl_FragColor = vec4(col * body + outer, clamp(body + halo, 0.0, 1.0));
    }
  `;

  let canvas, gl, u, raf = 0;
  let mic = null, out = null; // { analyser, time, freq }
  let level = 0, low = 0, high = 0, speak = 0, active = 0, target = 0, flow = 0, last = performance.now();
  const t0 = performance.now();

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function tap(analyser) {
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    return { analyser, time: new Float32Array(512), freq: new Uint8Array(256) };
  }

  // Returns [rms, low band, high band] for an analyser at sampleRate sr.
  function measure(a, sr) {
    a.analyser.getFloatTimeDomainData(a.time);
    let sum = 0;
    for (let i = 0; i < a.time.length; i++) sum += a.time[i] * a.time[i];
    a.analyser.getByteFrequencyData(a.freq);
    const bin = sr / 512;
    const band = (lo, hi) => {
      let s = 0, n = 0;
      for (let i = Math.max(1, Math.round(lo / bin)); i <= Math.min(255, Math.round(hi / bin)); i++, n++) s += a.freq[i];
      return n ? s / (n * 255) : 0;
    };
    return [Math.sqrt(sum / a.time.length), band(90, 500), band(1800, 6000)];
  }

  // Gentle attack, slow release: it swells with speech rather than flickering per syllable.
  const follow = (cur, to, up = 0.1, down = 0.025) => cur + (to - cur) * (to > cur ? up : down);

  function sample() {
    let [rms, lo, hi] = mic ? measure(mic, mic.analyser.context.sampleRate) : [0, 0, 0];
    level = follow(level, Math.min(1, rms * 4.5));
    low = follow(low, Math.min(1, lo * 1.2));
    high = follow(high, Math.min(1, hi * 2.5));
    const [orms] = out ? measure(out, out.analyser.context.sampleRate) : [0];
    speak = follow(speak, Math.min(1, orms * 4), 0.08, 0.025);
    active = follow(active, target, 0.06, 0.04);
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    sample();
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    flow += dt * (0.12 + Math.min(1, level * 1.2 + speak * 0.25) * 0.22);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uTime, (performance.now() - t0) / 1000);
    gl.uniform1f(u.uFlow, flow);
    gl.uniform1f(u.uLevel, level);
    gl.uniform1f(u.uLow, low);
    gl.uniform1f(u.uHigh, high);
    gl.uniform1f(u.uActive, active);
    gl.uniform1f(u.uSpeak, speak);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  return {
    init(el) {
      canvas = el;
      gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
      if (!gl) return;
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      u = Object.fromEntries(['uRes', 'uTime', 'uFlow', 'uLevel', 'uLow', 'uHigh', 'uActive', 'uSpeak'].map((n) => [n, gl.getUniformLocation(prog, n)]));
      if (!raf) frame();
    },
    // Mic: the AudioContext and its MediaStreamSource.
    setMic(ctx, source) {
      const a = ctx.createAnalyser();
      source.connect(a);
      mic = tap(a);
      target = 1;
    },
    clearMic() { mic = null; target = 0; },
    // Claude's voice: an AnalyserNode the playback sources are connected to.
    setOutput(analyser) { out = tap(analyser); },
  };
})();
