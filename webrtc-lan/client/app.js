"use strict";

const statusBadge = document.getElementById("statusBadge");
const statusText = document.getElementById("statusText");
const myIdEl = document.getElementById("myId");
const participantCountEl = document.getElementById("participantCount");
const participantsGrid = document.getElementById("participantsGrid");
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const muteBtn = document.getElementById("muteBtn");
const volumeBar = document.getElementById("volumeBar");
const callCountEl = document.getElementById("callCount");
const audioElements = document.getElementById("audioElements");
const micError = document.getElementById("micError");
const toastStack = document.getElementById("toastStack");

let myId = null;
let localStream = null;
let ws = null;

const peerConns = new Map();
const dataChannels = new Map();
const participantCards = new Map();

const RTC_CONFIG = { iceServers: [] };

async function initMicrophone() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    muteBtn.disabled = false;
    initVolumeMeter(localStream);
  } catch (err) {
    console.error("[mic] Access denied:", err);
    micError.classList.remove("hidden");
  }
}

function initVolumeMeter(stream) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);
  function tick() {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((s, v) => s + v, 0) / data.length;
    volumeBar.style.width = `${Math.min(100, (avg / 128) * 100)}%`;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

muteBtn.addEventListener("click", () => {
  if (!localStream) return;
  const tracks = localStream.getAudioTracks();
  const willMute = tracks[0].enabled;
  tracks.forEach(t => { t.enabled = !willMute; });

  if (willMute) {
    muteBtn.textContent = "Unmute";
    muteBtn.classList.add("muted");
  } else {
    muteBtn.textContent = "Mute";
    muteBtn.classList.remove("muted");
  }
});

function connectSignaling() {
  const host = window.location.hostname;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${host}:3000/ws`;

  ws = new WebSocket(url);

  ws.addEventListener("open", () => setStatus(true));
  ws.addEventListener("message", e => {
    let msg;
    try { msg = JSON.parse(e.data); }
    catch { return; }
    handleSignal(msg);
  });

  ws.addEventListener("close", () => {
    setStatus(false);
    setTimeout(connectSignaling, 3000);
  });

  ws.addEventListener("error", err => console.error("[ws]", err));
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

async function handleSignal(msg) {
  const { type, id, peers, from } = msg;

  switch (type) {
    case "welcome":
      myId = id;
      myIdEl.textContent = `Your ID: ${myId}`;
      ensureParticipantCard(myId, true);
      appendSystemMessage("You joined the meeting.");

      peers.forEach(peerId => {
        ensureParticipantCard(peerId, false);
        maybeStartCall(peerId);
      });
      break;

    case "peer-joined":
      ensureParticipantCard(id, false);
      appendSystemMessage(`${id} joined.`);
      showToast(`${id} joined the meeting`);
      maybeStartCall(id);
      break;

    case "peer-left":
      removeParticipantCard(id);
      closePeerConnection(id);
      appendSystemMessage(`${id} left.`);
      showToast(`${id} left the meeting`);
      break;

    case "offer":
      await handleOffer(from, msg.sdp);
      break;

    case "answer":
      await handleAnswer(from, msg.sdp);
      break;

    case "ice-candidate":
      await handleIceCandidate(from, msg.candidate);
      break;

    default:
      break;
  }
}

function peerNumber(peerId) {
  const n = Number.parseInt(String(peerId).replace(/^P/, ""), 10);
  return Number.isNaN(n) ? 0 : n;
}

function maybeStartCall(peerId) {
  if (!myId || peerConns.has(peerId)) return;
  if (peerNumber(myId) > peerNumber(peerId)) return;
  startCall(peerId).catch(err => console.error("[call]", err));
}

function ensureParticipantCard(peerId, isSelf) {
  if (participantCards.has(peerId)) return participantCards.get(peerId);

  const card = document.createElement("article");
  card.className = `participant-card${isSelf ? " participant-card--self" : ""}`;
  card.dataset.peerId = peerId;

  const initials = peerId.slice(0, 2).toUpperCase();
  card.innerHTML = `
    <div class="participant-avatar">${escHtml(initials)}</div>
    <div>
      <div class="participant-name">${escHtml(peerId)}${isSelf ? " (You)" : ""}</div>
      <div class="participant-state" data-state>Connecting...</div>
    </div>
  `;

  participantsGrid.appendChild(card);
  participantCards.set(peerId, card);
  setParticipantState(peerId, isSelf ? "Ready" : "Waiting to connect");
  updateParticipantCount();
  return card;
}

function setParticipantState(peerId, text) {
  const card = participantCards.get(peerId);
  if (!card) return;
  const stateEl = card.querySelector("[data-state]");
  if (stateEl) stateEl.textContent = text;
}

function markParticipantConnected(peerId, connected) {
  const card = participantCards.get(peerId);
  if (!card) return;
  card.classList.toggle("participant-card--connected", connected);
  setParticipantState(peerId, connected ? "Connected" : "Reconnecting...");
}

function removeParticipantCard(peerId) {
  const card = participantCards.get(peerId);
  if (card) card.remove();
  participantCards.delete(peerId);
  updateParticipantCount();
}

function updateParticipantCount() {
  participantCountEl.textContent = String(participantCards.size || 1);
}

function createPeerConnection(peerId) {
  if (peerConns.has(peerId)) return peerConns.get(peerId);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConns.set(peerId, pc);

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.ontrack = e => {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.srcObject = e.streams[0];
    audio.dataset.peerId = peerId;
    audioElements.appendChild(audio);
  };

  pc.onicecandidate = e => {
    if (e.candidate) {
      wsSend({ type: "ice-candidate", to: peerId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === "connected") markParticipantConnected(peerId, true);
    if (state === "failed" || state === "disconnected" || state === "closed") {
      markParticipantConnected(peerId, false);
      if (state === "failed" || state === "closed") closePeerConnection(peerId);
    }
    updateCallCount();
  };

  return pc;
}

function closePeerConnection(peerId) {
  const pc = peerConns.get(peerId);
  if (pc) {
    pc.close();
    peerConns.delete(peerId);
  }

  dataChannels.delete(peerId);

  [...audioElements.querySelectorAll(`audio[data-peer-id="${peerId}"]`)].forEach(el => el.remove());
  updateCallCount();
}

function updateCallCount() {
  const active = [...peerConns.values()].filter(pc => pc.connectionState === "connected").length;
  callCountEl.textContent = String(active);
}

async function startCall(peerId) {
  const pc = createPeerConnection(peerId);
  const dc = pc.createDataChannel("chat");
  setupDataChannel(dc, peerId);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type: "offer", to: peerId, sdp: pc.localDescription });
}

async function handleOffer(fromId, sdp) {
  const pc = createPeerConnection(fromId);

  pc.ondatachannel = e => setupDataChannel(e.channel, fromId);

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsSend({ type: "answer", to: fromId, sdp: pc.localDescription });
}

async function handleAnswer(fromId, sdp) {
  const pc = peerConns.get(fromId);
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function handleIceCandidate(fromId, candidate) {
  const pc = peerConns.get(fromId);
  if (!pc) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error("[ice]", err);
  }
}

function setupDataChannel(dc, peerId) {
  dataChannels.set(peerId, dc);

  dc.onclose = () => dataChannels.delete(peerId);
  dc.onerror = err => console.error("[dc]", err);

  dc.onmessage = e => {
    let data;
    try { data = JSON.parse(e.data); }
    catch { return; }
    appendMessage(data.sender, data.text, data.time, "remote");
  };
}

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  const time = nowHHMM();
  const payload = JSON.stringify({ sender: myId || "You", text, time });

  let sentToAny = false;
  for (const dc of dataChannels.values()) {
    if (dc.readyState === "open") {
      dc.send(payload);
      sentToAny = true;
    }
  }

  if (sentToAny || dataChannels.size === 0) {
    appendMessage(myId || "You", text, time, "self");
  }

  chatInput.value = "";
}

sendBtn.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", e => {
  if (e.key === "Enter") sendMessage();
});

function appendSystemMessage(text) {
  appendMessage("System", text, nowHHMM(), "system");
}

function appendMessage(sender, text, time, type) {
  const div = document.createElement("div");
  div.className = `msg msg--${type}`;

  if (type === "system") {
    div.textContent = `[${time}] ${text}`;
  } else {
    div.innerHTML = `
      <div class="msg__meta">${escHtml(sender)} · ${escHtml(time)}</div>
      <div>${escHtml(text)}</div>
    `;
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showToast(text) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text;
  toastStack.appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
}

function setStatus(connected) {
  if (connected) {
    statusBadge.className = "badge badge--connected";
    statusText.textContent = "Connected";
  } else {
    statusBadge.className = "badge badge--disconnected";
    statusText.textContent = "Disconnected";
  }
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

(async () => {
  await initMicrophone();
  connectSignaling();
})();
