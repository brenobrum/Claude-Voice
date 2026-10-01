// Continuous 24 kHz playback from a sample queue. One output stream, so no seams between
// network chunks. Waits for a small prebuffer before starting (and after any underrun) so
// network jitter turns into a little latency instead of audible stutter.
const PREBUFFER = 24000 * 0.12; // 120 ms

class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;   // read position in queue[0]
    this.queued = 0;   // samples waiting
    this.playing = false;
    this.peak = 0;
    this.blocks = 0;
    this.underruns = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'push') {
        this.queue.push(data.samples);
        this.queued += data.samples.length;
      } else if (data.type === 'clear') {
        this.queue = [];
        this.offset = 0;
        this.queued = 0;
        this.playing = false;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.playing && this.queued >= PREBUFFER) this.playing = true;
    let i = 0;
    if (this.playing) {
      while (i < out.length && this.queue.length) {
        const head = this.queue[0];
        const n = Math.min(out.length - i, head.length - this.offset);
        out.set(head.subarray(this.offset, this.offset + n), i);
        for (let k = i; k < i + n; k++) { const a = Math.abs(out[k]); if (a > this.peak) this.peak = a; }
        i += n;
        this.offset += n;
        this.queued -= n;
        if (this.offset >= head.length) { this.queue.shift(); this.offset = 0; }
      }
      if (!this.queue.length) { this.playing = false; if (i < out.length) this.underruns++; } // rebuffer before resuming
    }
    out.fill(0, i);
    // Report what is actually audible ~every 50 ms.
    if (++this.blocks >= 9) {
      this.port.postMessage({ peak: this.peak, queued: this.queued, underruns: this.underruns });
      this.peak = 0;
      this.blocks = 0;
    }
    return true;
  }
}

registerProcessor('player-processor', PlayerProcessor);
