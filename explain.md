# LAN Meet Architecture and Detailed Working

This document explains the current implementation in `webrtc-lan/` and how the app behaves like a Google Meet style LAN audio + text conference.

## 1. System Overview

The system has two major runtime parts:

1. **Signaling + static file server (Python / aiohttp)**
   - File: `webrtc-lan/server/server.py`
   - Serves frontend files and relays signaling messages.

2. **Browser client (HTML/CSS/JavaScript)**
   - Files:
     - `webrtc-lan/client/index.html`
     - `webrtc-lan/client/style.css`
     - `webrtc-lan/client/app.js`
   - Handles UI, media capture, WebSocket signaling, WebRTC peer connections, and chat data channels.

Important: The server is only for signaling/control plane. Audio and chat payloads flow peer-to-peer after connection setup.

---

## 2. Directory Structure

```text
webrtc-lan/
  client/
    index.html      # UI shell and DOM structure
    style.css       # Meet-like layout and responsive participant grid
    app.js          # signaling + WebRTC + chat + UI state logic
  server/
    server.py       # aiohttp signaling/static server
    requirements.txt
```

---

## 3. High-Level Flow

```text
Browser A/B/C load page
    -> HTTP GET /, /style.css, /app.js (served by aiohttp)
    -> Each browser opens WS /ws
    -> Server assigns peer IDs (P1, P2, ...)
    -> Server sends current peer list to each new join
    -> Clients auto-create WebRTC offers/answers per peer pair
    -> ICE candidates exchanged via WS
    -> Once connected:
         Audio track is P2P
         Text chat DataChannel is P2P
    -> Join/leave events update grid + notifications
```

---

## 4. Server Architecture (`server.py`)

### 4.1 Responsibilities

- Start HTTP server on `0.0.0.0:3000`.
- Serve files from `../client`.
- Maintain connected sockets in memory:
  - `clients: dict[str, WebSocketResponse]`
- Generate peer IDs (`P1`, `P2`, ...).
- Relay signaling messages (`offer`, `answer`, `ice-candidate`) to target peer.
- Broadcast lifecycle events:
  - `peer-joined`
  - `peer-left`

### 4.2 Main Components

- `build_app()`
  - Routes:
    - `GET /ws` -> `ws_handler`
    - `GET /` and `GET /{path}` -> `static_handler`

- `static_handler(request)`
  - Resolves requested file under `CLIENT_DIR`
  - Enforces path safety (prevents traversal outside `CLIENT_DIR`)
  - Returns file bytes with MIME type

- `ws_handler(request)`
  - Opens WebSocket
  - Assigns peer ID and stores socket
  - Sends `welcome` with existing peers
  - Broadcasts `peer-joined` to others
  - Receives signaling payloads and relays to target
  - On disconnect: removes peer and broadcasts `peer-left`

### 4.3 Signaling Message Contract

Server accepts and relays:

- `offer` -> `{ type: "offer", to, sdp, from }`
- `answer` -> `{ type: "answer", to, sdp, from }`
- `ice-candidate` -> `{ type: "ice-candidate", to, candidate, from }`

Server-originated events:

- `welcome` -> `{ type: "welcome", id, peers[] }`
- `peer-joined` -> `{ type: "peer-joined", id }`
- `peer-left` -> `{ type: "peer-left", id }`

---

## 5. Client Architecture (`app.js`)

### 5.1 State Model

Core state objects:

- `myId` -> this client’s server-assigned ID (`P#`)
- `localStream` -> microphone MediaStream
- `ws` -> signaling WebSocket
- `peerConns: Map<peerId, RTCPeerConnection>`
- `dataChannels: Map<peerId, RTCDataChannel>`
- `participantCards: Map<peerId, HTMLElement>`

### 5.2 Boot Sequence

At startup:

1. `initMicrophone()`
   - Requests mic permission
   - Starts mic level meter if granted
   - Shows warning panel if denied

2. `connectSignaling()`
   - Connects `ws://<host>:3000/ws`
   - Handles open/message/close/error
   - Auto-reconnects after disconnect (3 seconds)

### 5.3 Auto-Connect Strategy (Meet-like behavior)

When `welcome` arrives:

- Client stores `myId`
- Creates local participant card
- Adds cards for existing peers
- Calls `maybeStartCall(peerId)` for each peer

When `peer-joined` arrives:

- Add participant card
- Show system message + toast
- Attempt auto-call

To avoid duplicate simultaneous offers, `maybeStartCall` uses ID ordering:

- Lower-number peer (e.g., `P1`) initiates call to higher-number peer (`P2`, `P3`, ...)
- Higher-number peer waits and answers

This creates deterministic offer ownership in a mesh.

### 5.4 Peer Connection Lifecycle

`createPeerConnection(peerId)`:

- Creates `RTCPeerConnection` with `RTC_CONFIG = { iceServers: [] }`
- Adds local audio track(s) if mic available
- `onicecandidate` sends candidates via signaling WS
- `ontrack` attaches remote stream to hidden autoplay `<audio>`
- `onconnectionstatechange` updates participant state and call count

Caller flow (`startCall`):

1. Create PC
2. Create DataChannel `chat`
3. Create offer + set local description
4. Send `offer` via WS relay

Callee flow (`handleOffer`):

1. Create/get PC
2. Attach `ondatachannel`
3. Set remote description
4. Create/set local answer
5. Send `answer`

Answer flow (`handleAnswer`):

- Set remote description on existing PC

ICE flow (`handleIceCandidate`):

- Add candidate to corresponding PC

Cleanup (`closePeerConnection`):

- Close/delete PC
- Remove data channel mapping
- Remove related remote audio elements
- Refresh call count

---

## 6. Audio Path

### 6.1 Capture

- `navigator.mediaDevices.getUserMedia({ audio: true, video: false })`
- Local audio track added to each peer connection

### 6.2 Playback

- Remote track arrives in `pc.ontrack`
- Client creates hidden `<audio autoplay>` with `srcObject = remoteStream`

### 6.3 Mute

- Mute button toggles `track.enabled` for local mic track
- UI text/class switch between `Mute` and `Unmute`

### 6.4 Mic Meter

- Uses `AudioContext + AnalyserNode`
- Frequency bins averaged and mapped to volume bar width

---

## 7. Text Chat Path (P2P DataChannel)

### 7.1 Transport

- One RTC DataChannel per peer connection (`chat`)
- No chat payload goes through server after setup

### 7.2 Send

- User message converted to JSON:
  - `{ sender, text, time }`
- Broadcasted to all open data channels (group-style replication)
- Also appended locally as self message

### 7.3 Receive

- `dc.onmessage` parses JSON
- Appends remote message to chat panel

### 7.4 System Notifications

Join/leave messages are injected as system chat entries and toasts:

- `appendSystemMessage("<peer> joined/left")`
- `showToast("<peer> joined/left the meeting")`

---

## 8. Meet-Style UI and Grid Behavior

### 8.1 Layout

- Top bar: identity, connection status, participant count, active call count
- Main area:
  - Left: participant stage/grid
  - Right: controls + chat sidebar

### 8.2 Dynamic Participant Grid

CSS grid in `style.css`:

- `grid-template-columns: repeat(auto-fit, minmax(220px, 1fr))`
- `grid-auto-rows: minmax(150px, 1fr)`

Effect:

- Cards reflow automatically as participant count changes
- No manual column calculation needed in JavaScript

### 8.3 Participant Card State

Each card tracks:

- identity (peer ID)
- role (`(You)` for local)
- connectivity status text:
  - `Ready`
  - `Waiting to connect`
  - `Connected`
  - `Reconnecting...`

`participant-card--connected` style is toggled based on WebRTC connection state.

---

## 9. Network Topology and Scalability

This is a **full mesh** topology:

- For `n` participants, each participant may maintain up to `n-1` peer connections.
- Total connections in room: `n*(n-1)/2`.

Benefits:

- No media server needed
- Low setup complexity for LAN/small groups

Tradeoffs:

- CPU and bandwidth increase quickly as `n` grows
- Better suited to small groups than large meetings

---

## 10. Failure and Recovery Behavior

- WS disconnect -> client status becomes disconnected and reconnect timer starts.
- Peer disconnect -> server emits `peer-left`; client cleans UI + connections.
- Missing target peer for relay -> server logs warning, drops message.
- Mic denial -> app still runs; chat remains available and calls can proceed without local audio.

---

## 11. Security and Trust Boundaries

### 11.1 Trust Boundary

- Browser <-> signaling server (WebSocket)
- Browser <-> peer browser (WebRTC audio/data)

### 11.2 Current Security Posture

- No authentication or room-level authorization.
- Any LAN client reaching server can join same peer pool.
- Signaling is plain WS over HTTP in LAN mode.

### 11.3 Recommended Hardening

1. Add room model and join tokens.
2. Add identity/auth before allowing signaling.
3. Move to HTTPS/WSS for better browser compatibility and transport security.
4. Add rate limits and basic abuse controls on signaling endpoint.

---

## 12. Known Limitations and Notes

1. `RTC_CONFIG` has no STUN/TURN; designed for same-LAN usage.
2. Mesh architecture is not optimal for large conferences.
3. Server in-memory state means no persistence across restarts.
4. Existing `server.py` docstring still mentions manual “Call” action, while client is now auto-call.

---

## 13. Quick Operational Checklist

1. Install deps:
   - `pip3 install -r webrtc-lan/server/requirements.txt --break-system-packages`
2. Start server:
   - `python3 webrtc-lan/server/server.py`
3. Get LAN IPv4:
   - `hostname -I`
4. Open on all devices (same Wi-Fi/LAN):
   - `http://<LAN-IP>:3000`
5. Allow microphone in browser.
6. Verify participant tiles, notifications, audio, and group chat.

---

## 14. Data-Flow Summary (Control Plane vs Media Plane)

### Control Plane (Server-assisted)

- Join/disconnect awareness
- SDP exchange (`offer`/`answer`)
- ICE candidate relay

### Media/Data Plane (P2P)

- Audio stream over WebRTC tracks
- Chat payload over RTCDataChannel

This separation is the key architectural principle of the app.
