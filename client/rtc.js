const FALLBACK_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const MAX_BITRATE = 32_000;

/**
 * One audio transceiver, one microphone track, trickle ICE.
 * The server's initiator flag decides which side offers, so there is no glare.
 */
export class PeerLink {
  constructor({
    iceServers,
    track,
    stream,
    role,
    onSignal,
    onRemoteStream,
    onStateChange,
    onFailed,
  }) {
    this.role = role;
    this.track = track;
    this.stream = stream;
    this.onSignal = onSignal;
    this.onRemoteStream = onRemoteStream;
    this.onStateChange = onStateChange;
    this.onFailed = onFailed;

    this.pc = new RTCPeerConnection({
      iceServers: iceServers && iceServers.length ? iceServers : FALLBACK_ICE_SERVERS,
      bundlePolicy: "max-bundle",
    });

    this.transceiver = null;
    this.pendingCandidates = [];
    this.remoteSet = false;
    this.closed = false;
    this.failedReported = false;
    this.sampleAt = 0;
    this.sampleBytes = 0;
    this.kbps = 0;

    if (track && "contentHint" in track) track.contentHint = "speech";

    this.pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate =
        typeof event.candidate.toJSON === "function" ? event.candidate.toJSON() : event.candidate;
      this.onSignal?.({ kind: "candidate", candidate });
    };

    this.pc.ontrack = (event) => {
      if (event.track.kind !== "audio") return;
      const stream = event.streams[0] || new MediaStream([event.track]);
      this.onRemoteStream?.(stream);
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      this.onStateChange?.(state);
      if (state === "connected") {
        this.tuneReceiver();
        this.applyBitrate();
      } else if (state === "failed") {
        this.#reportFailed();
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === "failed") this.#reportFailed();
    };
  }

  get connectionState() {
    return this.pc.connectionState;
  }

  #reportFailed() {
    if (this.closed || this.failedReported) return;
    this.failedReported = true;
    this.onFailed?.();
  }

  #sendDescription() {
    const description = this.pc.localDescription;
    if (!description) return;
    this.onSignal?.({
      kind: "description",
      description: { type: description.type, sdp: description.sdp },
    });
  }

  #newTransceiver() {
    return this.pc.addTransceiver(this.track, {
      direction: "sendrecv",
      streams: this.stream ? [this.stream] : [],
    });
  }

  #audioTransceiver() {
    return (
      this.pc.getTransceivers().find((item) => item.receiver?.track?.kind === "audio") || null
    );
  }

  async start() {
    if (this.closed || this.role !== "initiator") return;
    this.transceiver = this.#newTransceiver();
    this.tuneReceiver();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.#sendDescription();
    await this.applyBitrate();
  }

  async accept(description) {
    if (this.closed || this.role !== "responder") return;
    await this.pc.setRemoteDescription(description);
    this.remoteSet = true;
    await this.#flushCandidates();

    const offered = this.#audioTransceiver();
    if (offered) {
      this.transceiver = offered;
      offered.direction = "sendrecv";
      if (this.track && offered.sender.track !== this.track) {
        await offered.sender.replaceTrack(this.track);
      }
    } else if (this.track) {
      this.transceiver = this.#newTransceiver();
    }

    this.tuneReceiver();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.#sendDescription();
    await this.applyBitrate();
  }

  async handleSignal(data) {
    if (this.closed || !data || typeof data !== "object") return;

    if (data.kind === "candidate") {
      await this.#addCandidate(data.candidate);
      return;
    }
    if (data.kind !== "description") return;

    const description = data.description;
    if (!description || typeof description.sdp !== "string" || this.remoteSet) return;

    if (description.type === "offer" && this.role === "responder") {
      await this.accept(description);
    } else if (description.type === "answer" && this.role === "initiator") {
      await this.pc.setRemoteDescription(description);
      this.remoteSet = true;
      await this.#flushCandidates();
      this.tuneReceiver();
      await this.applyBitrate();
    }
  }

  async #addCandidate(candidate) {
    if (!candidate || typeof candidate.candidate !== "string" || candidate.candidate.length === 0) {
      return;
    }
    if (!this.remoteSet) {
      if (this.pendingCandidates.length < 128) this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {}
  }

  async #flushCandidates() {
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {}
    }
  }

  tuneReceiver() {
    const receiver = this.transceiver?.receiver;
    if (!receiver) return;
    if ("jitterBufferTarget" in receiver) {
      try {
        receiver.jitterBufferTarget = 0;
      } catch {}
    }
  }

  async applyBitrate() {
    const sender = this.transceiver?.sender;
    if (!sender) return;
    try {
      const parameters = sender.getParameters();
      if (!Array.isArray(parameters.encodings) || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }
      for (const encoding of parameters.encodings) encoding.maxBitrate = MAX_BITRATE;
      await sender.setParameters(parameters);
    } catch {}
  }

  #bitrate(bytesReceived) {
    if (typeof bytesReceived !== "number") return null;
    const now = performance.now();
    if (this.sampleAt === 0) {
      this.sampleAt = now;
      this.sampleBytes = bytesReceived;
      this.kbps = 0;
      return 0;
    }
    const elapsed = now - this.sampleAt;
    if (elapsed >= 1000) {
      this.kbps = Math.max(0, ((bytesReceived - this.sampleBytes) * 8) / elapsed);
      this.sampleAt = now;
      this.sampleBytes = bytesReceived;
    }
    return this.kbps;
  }

  async stats() {
    const empty = {
      rttMs: null,
      jitterMs: null,
      packetsLost: null,
      bytesReceived: null,
      bitrateKbps: null,
      jitterBufferMs: null,
      jitterBufferDelayMs: null,
    };
    if (this.closed || !this.pc || this.pc.signalingState === "closed") return empty;

    let report;
    try {
      report = await this.pc.getStats();
    } catch {
      return empty;
    }

    let inbound = null;
    let selectedPairId = null;
    report.forEach((stat) => {
      if (stat.type === "transport" && stat.selectedCandidatePairId) {
        selectedPairId = stat.selectedCandidatePairId;
      }
      if (stat.type === "inbound-rtp" && (stat.kind === "audio" || stat.mediaType === "audio")) {
        if (!inbound || (stat.bytesReceived ?? 0) > (inbound.bytesReceived ?? 0)) inbound = stat;
      }
    });

    let pair = selectedPairId ? report.get(selectedPairId) : null;
    if (!pair) {
      report.forEach((stat) => {
        if (pair) return;
        if (stat.type === "candidate-pair" && stat.state === "succeeded" && (stat.nominated || stat.selected)) {
          pair = stat;
        }
      });
    }
    if (!pair) {
      report.forEach((stat) => {
        if (pair) return;
        if (
          stat.type === "candidate-pair" &&
          stat.state === "succeeded" &&
          (stat.bytesSent ?? 0) + (stat.bytesReceived ?? 0) > 0
        ) {
          pair = stat;
        }
      });
    }

    const rttMs =
      pair && typeof pair.currentRoundTripTime === "number" && pair.currentRoundTripTime >= 0
        ? pair.currentRoundTripTime * 1000
        : null;
    const jitterMs = inbound && typeof inbound.jitter === "number" ? inbound.jitter * 1000 : null;
    const packetsLost =
      inbound && typeof inbound.packetsLost === "number" ? inbound.packetsLost : null;
    const bytesReceived =
      inbound && typeof inbound.bytesReceived === "number" ? inbound.bytesReceived : null;

    let jitterBufferMs = null;
    try {
      const target = this.transceiver?.receiver?.jitterBufferTarget;
      if (typeof target === "number") jitterBufferMs = target * 1000;
    } catch {}

    const jitterBufferDelayMs =
      inbound && typeof inbound.jitterBufferDelay === "number" && inbound.jitterBufferEmittedCount > 0
        ? (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000
        : null;

    return {
      rttMs,
      jitterMs,
      packetsLost,
      bytesReceived,
      bitrateKbps: this.#bitrate(bytesReceived),
      jitterBufferMs,
      jitterBufferDelayMs,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pendingCandidates = [];
    this.transceiver = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    try {
      this.pc.close();
    } catch {}
  }
}
