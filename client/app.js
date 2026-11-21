import { AudioMeters } from "./audio.js";
import { renderQr } from "./qr.js";
import { PeerLink } from "./rtc.js";

const ROOM_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PROBE = new URLSearchParams(location.search).get("probe") === "1";
const BACKOFF_MS = [500, 1000, 2000, 5000];
const MAX_FAILED_CONNECTS = 3;
const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const MAX_MESSAGES = 300;

const els = {
  body: document.body,
  roomCode: document.getElementById("room-code"),
  shareLink: document.getElementById("share-link"),
  copyLink: document.getElementById("copy-link"),
  shareQr: document.getElementById("share-qr"),
  qrCode: document.getElementById("qr-code"),
  status: document.getElementById("status"),
  ptt: document.getElementById("ptt"),
  pttLabel: document.getElementById("ptt-label"),
  pttHint: document.getElementById("ptt-hint"),
  retry: document.getElementById("retry"),
  newRoom: document.getElementById("new-room"),
  localFill: document.querySelector("#local-level .meter-fill"),
  remoteFill: document.querySelector("#remote-level .meter-fill"),
  stats: document.getElementById("stats"),
  remoteAudio: document.getElementById("remote-audio"),
  messages: document.getElementById("messages"),
  chatEmpty: document.getElementById("chat-empty"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  chatSend: document.getElementById("chat-send"),
  chatState: document.getElementById("chat-state"),
  typing: document.getElementById("typing"),
  sound: document.getElementById("sound"),
};

const audio = new AudioMeters();

let uiState = "idle";
let room = resolveRoom();
let peerId = null;
let remotePeerId = null;
let socket = null;
let socketGeneration = 0;
let peer = null;
let peerGeneration = 0;
let signalChain = Promise.resolve();
let earlySignals = [];
let micStream = null;
let micTrack = null;
let started = false;
let fatal = false;
let talking = false;
let retryTimer = 0;
let retryStep = 0;
let failedConnects = 0;
let errorMessage = "";
let recovery = null;
let flashText = null;
let flashTimer = 0;
let statsTimer = 0;
let meterRaf = 0;
let iceConfigPromise = null;
let messages = [];
let messagesPinned = true;
let peerTyping = false;
let peerTypingTimer = 0;
let localTyping = false;
let localTypingTimer = 0;
let lastTypingSentAt = 0;

const TYPING_IDLE_MS = 2000;
const PEER_TYPING_TTL_MS = 3000;

function init() {
  updateRoomUI();
  wireEvents();
  watchViewport();
  watchMessageLog();
  iceConfigPromise = loadIceServers();
  syncUI();

  window.__walkie = {
    state() {
      return {
        uiState,
        connectionState: peer ? peer.connectionState : null,
        room,
        peerId,
        talking,
        probe: PROBE,
        micSettings: micTrack ? micTrack.getSettings() : null,
        chatEnabled: chatReady(),
        messageCount: messages.length,
        peerTyping,
      };
    },
    async stats() {
      const empty = {
        rttMs: null,
        jitterMs: null,
        packetsLost: null,
        bytesReceived: null,
        bitrateKbps: null,
        jitterBufferMs: null,
        jitterBufferDelayMs: null,
        localLevel: null,
        remoteLevel: null,
      };
      if (!peer || uiState !== "live") return empty;
      try {
        const values = await peer.stats();
        const levels = readLevels();
        return {
          rttMs: values.rttMs ?? null,
          jitterMs: values.jitterMs ?? null,
          packetsLost: values.packetsLost ?? null,
          bytesReceived: values.bytesReceived ?? null,
          bitrateKbps: values.bitrateKbps ?? null,
          jitterBufferMs: values.jitterBufferMs ?? null,
          jitterBufferDelayMs: values.jitterBufferDelayMs ?? null,
          localLevel: levels.local,
          remoteLevel: levels.remote,
        };
      } catch {
        return empty;
      }
    },
    toggle() {
      toggleTalking();
    },
  };

  onStart();
}

function wireEvents() {
  els.copyLink.addEventListener("click", copyLink);
  els.retry.addEventListener("click", retryConnection);
  els.newRoom.addEventListener("click", startNewRoom);

  els.ptt.addEventListener("click", () => toggleTalking());
  els.ptt.addEventListener("contextmenu", (event) => event.preventDefault());
  els.chatForm.addEventListener("submit", onChatSubmit);
  els.chatInput.addEventListener("input", onChatInput);
  els.chatInput.addEventListener("blur", () => setLocalTyping(false));
  els.sound.addEventListener("click", enableSound);
  els.messages.addEventListener("scroll", () => {
    messagesPinned = nearMessagesBottom();
  });

  window.addEventListener("keydown", onKeyDown);
  document.addEventListener("pointerdown", unlockOnGesture, { capture: true, passive: true });
  window.addEventListener("keydown", unlockOnGesture, { capture: true });
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) shutdown();
  });
}

function unlockOnGesture() {
  audio.unlock();
  if (els.remoteAudio.srcObject && els.remoteAudio.paused) playRemote();
}

function watchViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;

  let frame = 0;

  const apply = () => {
    frame = 0;
    const height = Math.round(viewport.height);
    if (!height) return;

    const layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
    const zoomed = viewport.scale > 1.01;
    const keyboardOpen = !zoomed && height < layoutHeight - 120;

    document.documentElement.style.setProperty("--app-height", height + "px");

    if (keyboardOpen) {
      document.documentElement.dataset.keyboard = "open";
    } else {
      delete document.documentElement.dataset.keyboard;
    }

    // iOS pans the page to keep the focused field above the keyboard. The
    // shell is already sized to the visible area, so put the page back at 0.
    if (keyboardOpen && window.scrollY) window.scrollTo(0, 0);
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(apply);
  };

  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  apply();
}

function watchMessageLog() {
  if (typeof ResizeObserver !== "function") return;

  let height = els.messages.clientHeight;
  const observer = new ResizeObserver(() => {
    const next = els.messages.clientHeight;
    if (next === height) return;
    height = next;
    // The log shrinks when the keyboard opens. If the reader was at the
    // bottom, keep the latest message in view instead of leaving it behind
    // the composer.
    if (messagesPinned) scrollMessagesToBottom();
  });
  observer.observe(els.messages);
}

function nearMessagesBottom(slack = 60) {
  return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < slack;
}

function scrollMessagesToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function resolveRoom() {
  const requested = new URLSearchParams(location.search).get("room");
  if (requested && ROOM_RE.test(requested)) return requested;
  const generated = generateRoomCode();
  history.replaceState(null, "", "/?room=" + generated);
  return generated;
}

function generateRoomCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
  return code.slice(0, 4) + "-" + code.slice(4);
}

function shareUrl() {
  return location.origin + "/?room=" + room;
}

function updateRoomUI() {
  const link = shareUrl();
  els.roomCode.textContent = room;
  els.shareLink.textContent = link;
  els.shareLink.title = link;

  try {
    renderQr(els.qrCode, link);
    els.shareQr.hidden = false;
  } catch {
    els.shareQr.hidden = true;
  }
}

function setState(next, message) {
  if (next !== "live" && talking) {
    talking = false;
    applyMicState();
  }
  uiState = next;
  if (next === "error") {
    errorMessage = message || errorMessage || "Something went wrong. Try again.";
  } else {
    errorMessage = "";
    recovery = null;
  }
  clearFlash();
  syncUI();
}

function syncUI() {
  els.body.dataset.state = uiState;
  els.status.dataset.state = uiState;
  renderText();

  const live = uiState === "live";
  const canTalk = live && Boolean(micTrack);
  els.ptt.disabled = !canTalk;
  els.ptt.classList.toggle("is-open", live && talking);
  els.ptt.setAttribute("aria-pressed", talking ? "true" : "false");
  els.ptt.setAttribute("aria-label", pttAriaLabel(canTalk));
  els.pttLabel.textContent = pttLabel();

  els.retry.hidden = !(
    uiState === "error" &&
    (recovery === "mic" || recovery === "retry")
  );
  els.newRoom.hidden = !(uiState === "error" && recovery === "new-room");
  els.stats.hidden = !live;

  syncChat();

  if (live) {
    startStats();
    startMeters();
  } else {
    stopStats();
    stopMeters();
  }
}

function renderText() {
  els.status.textContent = flashText ?? statusText();
  els.pttHint.textContent = hintText();
}

function statusText() {
  switch (uiState) {
    case "requesting-mic":
      return "Waiting for microphone permission.";
    case "waiting":
      return "Waiting for the other person. Send them the link.";
    case "connecting":
      return remotePeerId ? "Connecting the audio..." : "Joining the room...";
    case "live":
      return liveStatusText();
    case "reconnecting":
      return "Connection lost. Reconnecting...";
    case "error":
      return errorMessage || "Something went wrong. Try again.";
    default:
      return "Ready when you are.";
  }
}

function liveStatusText() {
  if (talking) return "Mic is open. Click again to close it.";
  return "Connected. Say hi or press Talk.";
}

function hintText() {
  if (uiState === "live" && !els.sound.hidden) return "Tap the sound button to hear them.";
  if (uiState === "live") {
    if (talking) return "The mic stays open until you click again.";
    return "Click Talk or press Space. Chat anytime.";
  }
  if (uiState === "waiting") return "Chat and Talk unlock when they join.";
  if (uiState === "connecting") return "Setting up the audio. Chat works now.";
  if (uiState === "reconnecting") return "Your mic and messages stay ready.";
  if (uiState === "requesting-mic") return "Choose Allow in the browser prompt.";
  if (uiState === "error") {
    if (recovery === "mic") return "Allow the microphone in your browser, then try again.";
    if (recovery === "retry") return "Check your connection, then try again.";
    if (recovery === "new-room") return "Start a new room and send the fresh link.";
    return "";
  }
  return "Allow the microphone in the browser prompt.";
}

function pttLabel() {
  if (uiState === "live" && talking) return "Talking";
  return "Talk";
}

function pttAriaLabel(canTalk) {
  if (!canTalk) return "Talk (available when you are connected)";
  return talking ? "Close the microphone" : "Open the microphone";
}

function flash(text) {
  flashText = text;
  renderText();
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashTimer = 0;
    flashText = null;
    renderText();
  }, 1800);
}

function clearFlash() {
  flashText = null;
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = 0;
  }
}

function applyMicState() {
  if (!micTrack) return;
  micTrack.enabled = talking;
}

function toggleTalking() {
  if (uiState !== "live" || !micTrack) return false;
  talking = !talking;
  applyMicState();
  syncUI();
  return true;
}

function chatReady() {
  return Boolean(
    started &&
      !fatal &&
      remotePeerId &&
      socket &&
      socket.readyState === WebSocket.OPEN,
  );
}

function syncChat() {
  const ready = chatReady();
  if (!ready) {
    setLocalTyping(false);
    setPeerTyping(false);
  }
  els.chatInput.disabled = !ready;
  els.chatSend.disabled = !ready;
  els.chatForm.dataset.ready = ready ? "true" : "false";
  els.chatInput.placeholder = chatPlaceholder();
  els.chatState.textContent = chatStateText();
  els.chatState.dataset.state = chatStateValue();
  if (els.chatEmpty) els.chatEmpty.textContent = chatEmptyText();
}

function setLocalTyping(active) {
  if (!active) {
    if (localTypingTimer) {
      clearTimeout(localTypingTimer);
      localTypingTimer = 0;
    }
    if (!localTyping) return;
    localTyping = false;
    lastTypingSentAt = 0;
    sendTyping(false);
    return;
  }

  const now = Date.now();
  if (!localTyping) {
    localTyping = true;
    lastTypingSentAt = now;
    sendTyping(true);
    return;
  }
  if (now - lastTypingSentAt >= 1500) {
    lastTypingSentAt = now;
    sendTyping(true);
  }
}

function sendTyping(active) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify({ t: "typing", active }));
  } catch {}
}

function onChatInput() {
  if (!chatReady()) return;
  if (els.chatInput.value.trim().length === 0) {
    setLocalTyping(false);
    return;
  }

  setLocalTyping(true);
  localTypingTimer = setTimeout(() => {
    localTypingTimer = 0;
    setLocalTyping(false);
  }, TYPING_IDLE_MS);
}

function setPeerTyping(active) {
  if (peerTypingTimer) {
    clearTimeout(peerTypingTimer);
    peerTypingTimer = 0;
  }
  peerTyping = Boolean(active);
  els.typing.hidden = !peerTyping;
  els.chatState.hidden = peerTyping;

  if (peerTyping) {
    if (els.chatEmpty) els.chatEmpty.hidden = true;
    peerTypingTimer = setTimeout(() => setPeerTyping(false), PEER_TYPING_TTL_MS);
  } else if (messages.length === 0 && els.chatEmpty) {
    els.chatEmpty.hidden = false;
  }
}

function chatPlaceholder() {
  if (chatReady()) return "Message...";
  switch (uiState) {
    case "waiting":
      return "Waiting for the other person...";
    case "reconnecting":
      return "Reconnecting...";
    case "error":
      return "Chat is unavailable.";
    case "requesting-mic":
      return "Starting the microphone...";
    case "connecting":
      return "Joining the room...";
    default:
      return "Start talking to chat.";
  }
}

function chatEmptyText() {
  if (uiState === "live") return "No messages yet. Say hi.";
  if (uiState === "connecting") return "Chat works while the audio connects.";
  if (uiState === "waiting") return "Say hi when they join. Messages stay in this tab.";
  if (uiState === "reconnecting") return "Reconnecting. Your messages will stay here.";
  if (uiState === "error") return "Messages are unavailable right now.";
  return "Messages stay in this tab.";
}

function chatStateText() {
  if (chatReady()) return uiState === "live" ? "Online" : "Connected";
  if (uiState === "reconnecting") return "Reconnecting";
  if (uiState === "error") return "Offline";
  if (uiState === "requesting-mic" || uiState === "connecting") return "Connecting";
  if (uiState === "waiting") return "Waiting for them";
  return "Not started";
}

function chatStateValue() {
  if (chatReady()) return uiState === "live" ? "live" : "connecting";
  if (uiState === "reconnecting" || uiState === "requesting-mic" || uiState === "connecting") {
    return "connecting";
  }
  if (uiState === "error") return "error";
  return "idle";
}

function onChatSubmit(event) {
  event.preventDefault();
  setLocalTyping(false);
  if (!chatReady()) return;

  const text = els.chatInput.value.trim();
  if (!text) return;

  setLocalTyping(false);

  try {
    socket.send(JSON.stringify({ t: "chat", text }));
  } catch {
    appendMessage({ system: true, text: "That message did not send. Try again.", at: Date.now() });
    return;
  }

  els.chatInput.value = "";
  appendMessage({ from: "self", text, at: Date.now() });
  els.chatInput.focus();
}

function appendMessage({ from, text, at, system = false }) {
  if (typeof text !== "string" || text.length === 0) return;

  const time = Number.isFinite(at) ? at : Date.now();
  const previous = messages[messages.length - 1];
  const grouped =
    !system &&
    Boolean(previous) &&
    !previous.system &&
    previous.from === from &&
    time - previous.at < 120_000;

  messages.push({ from, text, at: time, system });
  if (messages.length > MAX_MESSAGES) messages.shift();

  if (els.chatEmpty) els.chatEmpty.hidden = true;

  const nearBottom = nearMessagesBottom();

  const node = document.createElement("div");
  node.className = "message " + (system ? "message--system" : "message--" + from);
  if (!system) {
    node.dataset.from = from;
    if (grouped) node.dataset.grouped = "true";
  }

  const body = document.createElement("p");
  body.className = "message-text";
  body.textContent = text;
  node.appendChild(body);

  if (!system) {
    const meta = document.createElement("time");
    meta.className = "message-meta";
    meta.dateTime = new Date(time).toISOString();
    meta.textContent = formatMessageTime(time);
    node.appendChild(meta);
  }

  els.messages.appendChild(node);
  trimMessageNodes();

  if (nearBottom || from === "self" || system) {
    messagesPinned = true;
    scrollMessagesToBottom();
  } else {
    messagesPinned = false;
  }
}

function trimMessageNodes() {
  const nodes = els.messages.querySelectorAll(".message");
  for (let i = 0; i < nodes.length - MAX_MESSAGES; i += 1) nodes[i].remove();
}

function formatMessageTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function clearMessages() {
  messages = [];
  messagesPinned = true;
  for (const node of els.messages.querySelectorAll(".message")) node.remove();
  if (els.chatEmpty) els.chatEmpty.hidden = false;
  els.messages.scrollTop = 0;
  setPeerTyping(false);
}

function isControl(target) {
  if (!(target instanceof Element)) return null;
  return target.closest("button, a, input, select, textarea, [contenteditable='true']");
}

function onKeyDown(event) {
  if (event.code !== "Space" || event.repeat) return;
  if (isControl(event.target)) return;
  if (toggleTalking()) event.preventDefault();
}

async function onStart() {
  if (started || uiState === "requesting-mic") return;

  setState("requesting-mic");
  audio.unlock();

  if (!navigator.mediaDevices?.getUserMedia) {
    failMicrophone(
      "The browser blocked the microphone. Open this page over HTTPS or on localhost, then try again.",
    );
    return;
  }

  try {
    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: !PROBE,
          noiseSuppression: !PROBE,
          autoGainControl: !PROBE,
          channelCount: 1,
        },
        video: false,
      });
    }
  } catch (error) {
    failMicrophone(microphoneMessage(error));
    return;
  }

  const track = micStream.getAudioTracks()[0] || null;
  if (!track) {
    failMicrophone("No microphone was available. Connect one and try again.");
    return;
  }

  if (micTrack && micTrack !== track) micTrack.removeEventListener("ended", onTrackEnded);
  micTrack = track;
  micTrack.addEventListener("ended", onTrackEnded, { once: true });
  started = true;
  fatal = false;
  failedConnects = 0;
  retryStep = 0;
  talking = false;
  applyMicState();
  audio.attachLocal(micStream);

  setState("connecting");
  connectSocket();
}

function microphoneMessage(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Microphone permission was denied. Allow it in the browser and try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone was found. Connect one and try again.";
    case "NotReadableError":
    case "TrackStartError":
      return "The microphone is busy in another app. Close it and try again.";
    case "OverconstrainedError":
      return "This microphone does not support the audio settings needed. Try another one.";
    case "SecurityError":
      return "The browser blocked the microphone. Open this page over HTTPS or on localhost, then try again.";
    default:
      return "The microphone did not start. Check it in your system settings and try again.";
  }
}

function failMicrophone(message) {
  if (micTrack) micTrack.removeEventListener("ended", onTrackEnded);
  if (micStream) {
    for (const track of micStream.getTracks()) {
      try {
        track.stop();
      } catch {}
    }
  }
  micStream = null;
  micTrack = null;
  started = false;
  fatal = false;
  talking = false;
  closeSocketQuietly();
  teardownPeer();
  peerId = null;
  remotePeerId = null;
  recovery = "mic";
  setState("error", message);
}

function onTrackEnded() {
  failMicrophone("The microphone stopped. Check it and try again.");
}

function socketUrl() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return scheme + "//" + location.host + "/ws";
}

function connectSocket() {
  if (!started || fatal) return;
  clearRetryTimer();
  closeSocketQuietly();

  const generation = socketGeneration;
  let ws;
  try {
    ws = new WebSocket(socketUrl());
  } catch {
    registerFailedConnect();
    return;
  }
  socket = ws;

  let joined = false;
  let joinTimer = 0;
  const clearJoinTimer = () => {
    if (joinTimer) {
      clearTimeout(joinTimer);
      joinTimer = 0;
    }
  };

  ws.onopen = () => {
    if (generation !== socketGeneration) return;
    try {
      ws.send(JSON.stringify({ t: "join", room }));
    } catch {
      return;
    }
    joinTimer = setTimeout(() => {
      if (generation === socketGeneration) {
        try {
          ws.close();
        } catch {}
      }
    }, 8000);
  };

  ws.onmessage = (event) => {
    if (generation !== socketGeneration) return;
    handleServerMessage(event.data, () => {
      joined = true;
      clearJoinTimer();
    });
  };

  ws.onclose = (event) => {
    clearJoinTimer();
    if (generation !== socketGeneration) return;
    if (socket === ws) socket = null;
    handleSocketClose(event, joined);
  };

  ws.onerror = () => {};
}

function closeSocketQuietly() {
  socketGeneration += 1;
  const current = socket;
  socket = null;
  if (current) {
    try {
      current.close();
    } catch {}
  }
}

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = 0;
  }
}

function registerFailedConnect() {
  failedConnects += 1;
  if (failedConnects >= MAX_FAILED_CONNECTS) {
    showRetryError();
    return;
  }
  scheduleReconnect();
}

function handleSocketClose(event, joined) {
  teardownPeer();
  remotePeerId = null;
  if (fatal || !started) return;

  if (event.code === 4001) {
    fatal = true;
    recovery = "new-room";
    setState("error", "This room already has two people.");
    return;
  }
  if (event.code === 4002) {
    fatal = true;
    recovery = "new-room";
    setState("error", "That room code is not valid. Start a fresh room.");
    return;
  }
  if (event.code === 4003) {
    fatal = true;
    recovery = "retry";
    setState("error", "The server rejected the connection. Try again.");
    return;
  }

  if (joined) {
    failedConnects = 0;
    retryStep = 0;
    scheduleReconnect();
    return;
  }

  failedConnects += 1;
  if (failedConnects >= MAX_FAILED_CONNECTS) {
    showRetryError();
    return;
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (!started || fatal) return;
  teardownPeer();
  setState("reconnecting");
  if (retryTimer) return;
  const delay = BACKOFF_MS[Math.min(retryStep, BACKOFF_MS.length - 1)];
  retryStep += 1;
  retryTimer = setTimeout(() => {
    retryTimer = 0;
    connectSocket();
  }, delay);
}

function showRetryError() {
  clearRetryTimer();
  teardownPeer();
  recovery = "retry";
  setState("error", "Cannot reach the server. Check your connection, then try again.");
}

function retryConnection() {
  if (!started || !micTrack) {
    onStart();
    return;
  }
  fatal = false;
  recovery = null;
  failedConnects = 0;
  retryStep = 0;
  setState("reconnecting");
  connectSocket();
}

function startNewRoom() {
  closeSocketQuietly();
  teardownPeer();
  remotePeerId = null;
  fatal = false;
  failedConnects = 0;
  retryStep = 0;
  recovery = null;
  room = generateRoomCode();
  history.replaceState(null, "", "/?room=" + room);
  updateRoomUI();
  clearMessages();
  if (started && micTrack) {
    setState("connecting");
    connectSocket();
  } else {
    setState("idle");
  }
}

function handleServerMessage(raw, markJoined) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || typeof message !== "object") return;

  switch (message.t) {
    case "joined":
      markJoined();
      peerId = typeof message.peerId === "string" ? message.peerId : null;
      failedConnects = 0;
      retryStep = 0;
      if (Number(message.peerCount) > 1) setState("connecting");
      else setState("waiting");
      break;

    case "peer-join":
      teardownPeer();
      remotePeerId = typeof message.peerId === "string" ? message.peerId : null;
      appendMessage({ system: true, text: "They joined.", at: Date.now() });
      setState("connecting");
      if (message.initiator === true) beginOffer();
      break;

    case "signal":
      enqueueSignal(message);
      break;

    case "chat":
      if (typeof message.text !== "string" || message.text.length === 0) break;
      if (message.from && remotePeerId && message.from !== remotePeerId) break;
      setPeerTyping(false);
      appendMessage({ from: "peer", text: message.text, at: Number(message.at) });
      break;

    case "typing":
      if (message.from && remotePeerId && message.from !== remotePeerId) break;
      setPeerTyping(message.active === true);
      break;

    case "peer-leave":
      if (message.peerId && remotePeerId && message.peerId !== remotePeerId) break;
      if (remotePeerId) {
        appendMessage({ system: true, text: "They left.", at: Date.now() });
      }
      remotePeerId = null;
      teardownPeer();
      setState("waiting");
      break;

    case "error":
      handleServerError(message);
      break;
  }
}

function handleServerError(message) {
  fatal = true;
  teardownPeer();
  if (message.code === "room-full") {
    recovery = "new-room";
    setState("error", "This room already has two people.");
  } else if (message.code === "bad-room") {
    recovery = "new-room";
    setState("error", "That room code is not valid. Start a fresh room.");
  } else {
    recovery = "retry";
    setState("error", "The server rejected the connection. Try again.");
  }
}

function enqueueSignal(message) {
  const generation = socketGeneration;
  signalChain = signalChain
    .then(() => {
      if (generation !== socketGeneration) return;
      return processSignal(message);
    })
    .catch(() => {
      if (generation === socketGeneration && started && !fatal) recoverPeer();
    });
}

async function processSignal(message) {
  if (!started || fatal || !remotePeerId) return;
  if (message.from && message.from !== remotePeerId) return;
  const data = message.data;
  if (!data || typeof data !== "object") return;

  if (!peer) {
    if (data.kind === "candidate") {
      earlySignals.push(data);
      if (earlySignals.length > 32) earlySignals.shift();
      return;
    }
    if (data.kind === "description" && data.description?.type === "offer") {
      const link = await createPeerLink("responder");
      if (!link) return;
      const queued = earlySignals;
      earlySignals = [];
      for (const candidate of queued) await link.handleSignal(candidate);
      await link.handleSignal(data);
      return;
    }
    return;
  }

  await peer.handleSignal(data);
}

async function beginOffer() {
  const link = await createPeerLink("initiator");
  if (!link) return;
  try {
    await link.start();
  } catch {
    if (peer === link) {
      teardownPeer();
      recoverPeer();
    }
  }
}

async function createPeerLink(role) {
  if (!micTrack || !micStream) return null;
  const generation = peerGeneration + 1;
  peerGeneration = generation;
  const iceServers = await iceConfigPromise;
  if (generation !== peerGeneration || !started || fatal) return null;
  if (!socket || socket.readyState !== WebSocket.OPEN || !remotePeerId) return null;

  const link = new PeerLink({
    iceServers,
    track: micTrack,
    stream: micStream,
    role,
    onSignal: (data) => sendSignal(data),
    onRemoteStream: (stream) => attachRemoteStream(stream),
    onStateChange: (state) => {
      if (peer === link && state === "connected") setState("live");
    },
    onFailed: () => {
      if (peer === link) recoverPeer();
    },
  });
  peer = link;
  syncUI();
  return link;
}

function sendSignal(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify({ t: "signal", data }));
  } catch {}
}

function attachRemoteStream(stream) {
  els.remoteAudio.srcObject = stream;
  audio.attachRemote(stream);
  playRemote();
}

function playRemote() {
  els.sound.hidden = true;
  const played = els.remoteAudio.play();
  if (played && typeof played.then === "function") {
    played
      .then(() => {
        els.sound.hidden = true;
        renderText();
      })
      .catch(() => {
        if (els.remoteAudio.srcObject) {
          els.sound.hidden = false;
          renderText();
        }
      });
  }
}

function enableSound() {
  audio.unlock();
  playRemote();
}

function teardownPeer() {
  peerGeneration += 1;
  earlySignals = [];
  setLocalTyping(false);
  setPeerTyping(false);
  if (peer) {
    peer.close();
    peer = null;
  }
  els.remoteAudio.srcObject = null;
  els.sound.hidden = true;
  audio.detachRemote();
  audio.reset();
  stopStats();
  stopMeters();
}

function recoverPeer() {
  if (!started || fatal) return;
  const current = socket;
  if (current && current.readyState <= WebSocket.OPEN) {
    try {
      current.close();
    } catch {}
  } else {
    scheduleReconnect();
  }
}

function readLevels() {
  const levels = audio.sample();
  if (!micTrack?.enabled) levels.local = 0;
  return levels;
}

function startMeters() {
  if (meterRaf) return;
  const loop = () => {
    const levels = readLevels();
    els.localFill.style.transform = "scaleX(" + levels.local.toFixed(3) + ")";
    els.remoteFill.style.transform = "scaleX(" + levels.remote.toFixed(3) + ")";
    meterRaf = requestAnimationFrame(loop);
  };
  meterRaf = requestAnimationFrame(loop);
}

function stopMeters() {
  if (meterRaf) cancelAnimationFrame(meterRaf);
  meterRaf = 0;
  els.localFill.style.transform = "scaleX(0)";
  els.remoteFill.style.transform = "scaleX(0)";
}

function startStats() {
  if (statsTimer) return;
  const tick = async () => {
    if (uiState !== "live" || !peer) return;
    const link = peer;
    try {
      const values = await link.stats();
      if (uiState === "live" && peer === link) renderStats(values);
    } catch {}
  };
  tick();
  statsTimer = setInterval(tick, 1000);
}

function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = 0;
}

function renderStats(values) {
  const parts = [];
  if (values.rttMs != null) parts.push("RTT " + values.rttMs.toFixed(1) + " ms");
  if (values.bitrateKbps != null && values.bitrateKbps > 0) {
    parts.push(Math.round(values.bitrateKbps) + " kbps");
  }
  if (values.jitterMs != null) parts.push("jitter " + values.jitterMs.toFixed(1) + " ms");
  if (values.packetsLost != null) parts.push("lost " + values.packetsLost);
  els.stats.textContent = parts.length ? parts.join(" · ") : "Measuring...";
}

async function copyLink() {
  const link = shareUrl();
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link);
    } else {
      legacyCopy(link);
    }
    flash("Link copied.");
  } catch {
    try {
      legacyCopy(link);
      flash("Link copied.");
    } catch {
      flash("Could not copy the link. Select it and copy it yourself.");
    }
  }
}

function legacyCopy(text) {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.className = "copy-field";
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  els.copyLink.focus();
  if (!copied) throw new Error("copy failed");
}

async function loadIceServers() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch("/api/config", {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return DEFAULT_ICE_SERVERS;
    const config = await response.json();
    if (Array.isArray(config?.iceServers) && config.iceServers.length > 0) {
      return config.iceServers;
    }
  } catch {
    return DEFAULT_ICE_SERVERS;
  } finally {
    clearTimeout(timer);
  }
  return DEFAULT_ICE_SERVERS;
}

function shutdown() {
  closeSocketQuietly();
  teardownPeer();
  if (micTrack) micTrack.removeEventListener("ended", onTrackEnded);
  if (micStream) {
    for (const track of micStream.getTracks()) {
      try {
        track.stop();
      } catch {}
    }
  }
  micStream = null;
  micTrack = null;
  started = false;
  audio.close();
}

init();
