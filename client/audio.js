/**
 * RMS meters for the local microphone and the remote stream.
 * The analysers are sinks only: playback still happens through the audio element.
 */
export class AudioMeters {
  constructor() {
    this.ctx = null;
    this.local = { source: null, analyser: null, buffer: null };
    this.remote = { source: null, analyser: null, buffer: null };
    this.levels = { local: 0, remote: 0 };
  }

  /** Must run inside the Start gesture so the context is allowed to start. */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      try {
        this.ctx = new Ctx({ latencyHint: "interactive" });
      } catch {
        this.ctx = null;
        return;
      }
    }
    if (this.ctx.state === "suspended") {
      const resumed = this.ctx.resume();
      if (resumed && typeof resumed.catch === "function") resumed.catch(() => {});
    }
  }

  attachLocal(stream) {
    const built = this.#build(stream, this.local);
    if (built) this.local = built;
  }

  attachRemote(stream) {
    const built = this.#build(stream, this.remote);
    if (built) this.remote = built;
  }

  #build(stream, previous) {
    if (!this.ctx || !stream || stream.getAudioTracks().length === 0) return null;
    let source;
    try {
      source = this.ctx.createMediaStreamSource(stream);
    } catch {
      return null;
    }
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    if (previous.source) {
      try {
        previous.source.disconnect();
      } catch {}
    }
    return { source, analyser, buffer: new Uint8Array(analyser.fftSize) };
  }

  sample() {
    const local = this.#read(this.local);
    const remote = this.#read(this.remote);
    this.levels.local = this.#smooth(this.levels.local, local);
    this.levels.remote = this.#smooth(this.levels.remote, remote);
    return { ...this.levels };
  }

  #read({ analyser, buffer }) {
    if (!analyser || !buffer) return 0;
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const value = (buffer[i] - 128) / 128;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / buffer.length);
    return Math.min(1, rms * 6);
  }

  #smooth(current, target) {
    const next = current + (target - current) * (target > current ? 0.55 : 0.12);
    return next < 0.001 ? 0 : next;
  }

  detachRemote() {
    if (this.remote.source) {
      try {
        this.remote.source.disconnect();
      } catch {}
    }
    this.remote = { source: null, analyser: null, buffer: null };
    this.levels.remote = 0;
  }

  reset() {
    this.levels.local = 0;
    this.levels.remote = 0;
  }

  close() {
    this.detachRemote();
    if (this.local.source) {
      try {
        this.local.source.disconnect();
      } catch {}
    }
    this.local = { source: null, analyser: null, buffer: null };
    if (this.ctx) {
      const closed = this.ctx.close();
      if (closed && typeof closed.catch === "function") closed.catch(() => {});
    }
    this.ctx = null;
  }
}
