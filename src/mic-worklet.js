// Runs in an AudioContext at 24 kHz: converts mic float samples to PCM16 in ~100 ms frames.
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(2400);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    let peak = 0;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      if (Math.abs(s) > peak) peak = Math.abs(s);
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage({ pcm: this.buf.buffer, level: peak }, [this.buf.buffer]);
        this.buf = new Int16Array(2400);
        this.n = 0;
        peak = 0;
      }
    }
    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
