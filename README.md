# WebRTC LAN P2P Prototype

This project is a peer-to-peer audio and text transmission system designed for offline LAN networks. It uses **WebRTC** for direct communication between devices and an **aiohttp** WebSocket signaling server.

## Features
- **P2P Audio:** Direct low-latency voice transmission.
- **P2P Chat:** Real-time text messaging via WebRTC DataChannels.
- **No Internet Required:** Works entirely on a local network (Wi-Fi/Ethernet).
- **Modern UI:** Responsive dashboard built with Tailwind CSS.

## Setup Instructions

1. **Install Dependencies:**
   ```bash
   cd webrtc-lan/server
   pip3 install -r requirements.txt --break-system-packages
   ```

2. **Start the Signaling Server:**
   ```bash
   python3 webrtc-lan/server/server.py
   ```

3. **Connect Devices:**
   - Note the **LAN Access URL** displayed in the terminal (e.g., `https://192.168.1.10:3000`).
   - Open this URL on two devices on the same network.
   - Enter the same **Room ID** and click **Join**.

## ⚠️ Browser Security (Microphone Access)
Browsers require **HTTPS** or **localhost** for microphone access. To enable HTTPS:

1. Generate SSL certificates:
   ```bash
   python3 webrtc-lan/server/generate_cert.py
   ```
2. Restart the server - it will automatically use HTTPS if certificates exist.
3. Access via `https://<your-ip>:3000`

To use HTTP without HTTPS, you must use Chrome/Edge with the insecure origin flag:
1. Open Chrome/Edge and go to `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. Add your server's IP (e.g., `http://192.168.1.10:3000`).
3. Set it to **Enabled** and relaunch.
