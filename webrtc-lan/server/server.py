#!/usr/bin/env python3
"""
WebRTC LAN Signaling Server  (Python / aiohttp)

HOW TO RUN:
  1. cd server && pip install -r requirements.txt && python server.py
  2. Find your local IP:
       Linux/Mac : hostname -I
       Windows   : ipconfig
  3. On every device connected to the same Wi-Fi open:
       http://<your-ip>:3000
  4. Click "Call" next to any peer to start audio + chat.

Architecture:
  - HTTP  GET /          → serves client/index.html
  - HTTP  GET /<file>    → serves any file from ../client/
  - WS    /ws            → signaling channel (offer/answer/ice-candidate relay)
"""

import asyncio
import json
import logging
import mimetypes
import os
from datetime import datetime, timezone
from pathlib import Path

from aiohttp import web

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

PORT = 3000
CLIENT_DIR = Path(__file__).resolve().parent.parent / "client"

# ── Peer state ────────────────────────────────────────────────────────────────

# peerId (str) → aiohttp WebSocketResponse
clients: dict[str, web.WebSocketResponse] = {}
_next_id = 1


def _new_id() -> str:
    global _next_id
    pid = f"P{_next_id}"
    _next_id += 1
    return pid


async def _send(ws: web.WebSocketResponse, obj: dict) -> None:
    """Send a JSON message to one client, ignoring closed sockets."""
    if not ws.closed:
        await ws.send_str(json.dumps(obj))


async def _broadcast(obj: dict, exclude_id: str | None = None) -> None:
    """Broadcast a JSON message to all connected clients except exclude_id."""
    for pid, client_ws in list(clients.items()):
        if pid != exclude_id:
            await _send(client_ws, obj)


# ── WebSocket handler ─────────────────────────────────────────────────────────

async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    peer_id = _new_id()
    clients[peer_id] = ws
    log.info("CONNECT  %s  (total: %d)", peer_id, len(clients))

    # Welcome: tell the new peer their ID + list of already-present peers
    existing = [pid for pid in clients if pid != peer_id]
    await _send(ws, {"type": "welcome", "id": peer_id, "peers": existing})

    # Notify everyone else that a new peer joined
    await _broadcast({"type": "peer-joined", "id": peer_id}, exclude_id=peer_id)

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    log.warning("Invalid JSON from %s – ignoring", peer_id)
                    continue

                mtype = data.get("type", "")
                to    = data.get("to")
                log.info("MSG  %s → %s  [%s]", peer_id, to or "broadcast", mtype)

                if mtype in ("offer", "answer", "ice-candidate"):
                    if not to:
                        log.warning('No "to" field on %s – dropping', mtype)
                        continue
                    target_ws = clients.get(to)
                    if not target_ws:
                        log.warning("Target %s not found – dropping", to)
                        continue
                    await _send(target_ws, {**data, "from": peer_id})

                else:
                    log.warning('Unknown message type "%s" from %s', mtype, peer_id)

            elif msg.type in (web.WSMsgType.ERROR, web.WSMsgType.CLOSE):
                break

    finally:
        clients.pop(peer_id, None)
        log.info("DISCONNECT  %s  (total: %d)", peer_id, len(clients))
        await _broadcast({"type": "peer-left", "id": peer_id})

    return ws


# ── Static file handler ───────────────────────────────────────────────────────

async def static_handler(request: web.Request) -> web.Response:
    rel = request.match_info.get("path", "") or "index.html"
    if not rel:
        rel = "index.html"
    file_path = (CLIENT_DIR / rel).resolve()

    # Security: stay inside CLIENT_DIR
    if not str(file_path).startswith(str(CLIENT_DIR)):
        raise web.HTTPForbidden()

    if not file_path.exists() or not file_path.is_file():
        raise web.HTTPNotFound()

    content_type, _ = mimetypes.guess_type(str(file_path))
    content_type = content_type or "application/octet-stream"

    return web.Response(
        body=file_path.read_bytes(),
        content_type=content_type,
    )


# ── App setup ─────────────────────────────────────────────────────────────────

def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/",          static_handler)
    app.router.add_get("/{path:.+}", static_handler)
    return app


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info("Starting LAN WebRTC signaling server on port %d", PORT)
    log.info("Serving client files from: %s", CLIENT_DIR)
    web.run_app(build_app(), host="0.0.0.0", port=PORT, access_log=log)
