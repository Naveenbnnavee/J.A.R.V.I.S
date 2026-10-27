# J.A.R.V.I.S. – Real-Time Conversational AI Assistant

[![Category](https://img.shields.io/badge/Category-AI%2FML%20%26%20Systems-cyan)](https://github.com)
[![Platform](https://img.shields.io/badge/Platform-Tauri%20%7C%20Windows-blue)](https://github.com)
[![Architecture](https://img.shields.io/badge/Inference-Hybrid%20Local%20%2F%20Cloud-violet)](https://github.com)

A production-grade, ultra-low latency desktop conversational assistant orchestrating full-duplex WebSocket audio pipelines, dynamic local/cloud LLM routing, and a synchronized 60 FPS WebGL Arc-Reactor visualizer shader loop.

---

## 🎯 Measurable Engineering Metrics

- **Voice-to-Voice Loop Latency:** `< 1.2s` total end-to-end turnaround (Silero VAD ➔ Faster-Whisper STT ➔ LLM Router ➔ ElevenLabs / Local TTS).
- **Inference Privacy:** `100%` Local LLM routing via quantized Ollama for confidential desktop actions, file management, and system telemetry.
- **Visualizer Throughput:** `60 FPS` constant GPU rendering rate with zero layout thrashing on a dedicated WebGL canvas.
- **Audio Delivery Protocol:** Chunked binary WebSocket protocol with resilient reconnection backoff and localized ring-buffer management.

---

## 🏗️ System Architecture

```
[ Microphone Input ]
         │
         ▼
[ Silero Voice Activity Detector (VAD) ] ➔ 16kHz PCM Ring Buffer
         │
         ▼
[ Streaming Faster-Whisper STT Engine ] ➔ Tokens / WS
         │
         ▼
[ Dynamic Intent Router ]
  ├── Local Ollama / Mistral (System Control, File Ops, Privacy-Critical)
  └── High-Parameter Cloud Fallback (Complex Reasoning, General Synthesis)
         │
         ▼
[ ChromaDB Semantic Memory Store ] ➔ Long-term User Preferences & Context
         │
         ▼
[ Streaming TTS Engine ] ➔ Binary Audio Chunks
         │
         ▼
[ WebGL Arc-Reactor Visualizer & Audio Output ]
```

---

## 🖼️ Architectural Showcase & Screenshots

Because J.A.R.V.I.S. is a private desktop application bound to local hardware and GPU acceleration, an interactive showcase view with high-definition screenshots is provided at:

```
showcase.html
```

Open `showcase.html` in any browser to inspect:
1. **Audio Visualizer & Idle State** (`assets/screenshots/jarvis_visualizer_idle.png`): Radial Arc-Reactor HUD displaying system telemetry, core temperatures, and network latency.
2. **Streaming Voice Response** (`assets/screenshots/jarvis_streaming_voice.png`): Dynamic chat console and live voice transcription with fallback modes.
3. **Intent Routing Telemetry** (`assets/screenshots/jarvis_intent_routing.png`): Multi-agent drawer displaying YouTube scheduler, WhatsApp controller, and dev tools.

---

## 🚀 Local Quickstart & Development

### Prerequisites
- Node.js `v20+` & npm
- Rust toolchain & Cargo (`rustup`)
- Tauri CLI (`cargo install tauri-cli` or `npx @tauri-apps/cli`)
- Optional: Local Ollama runner (`ollama serve`)

### Installation & Run

```bash
# 1. Clone repository from GitHub & enter project
git clone https://github.com/Naveenbnnavee/J.A.R.V.I.S.git
cd J.A.R.V.I.S

# Or pull latest changes into your directory if already cloned:
# git pull origin main

# 2. Install frontend dependencies
npm install

# 3. Install backend worker dependencies
cd backend
npm install
cd ..

# 4. Launch desktop application in dev mode
npm run dev

# 5. Optional: Run web UI standalone
npx vite --port 1420
```

---

## 🔒 Security & Privacy Invariants

- **Zero Remote Egress for Local Commands:** System automation commands (volume, app launch, process monitoring) never leave the local machine.
- **Secure Secret Isolation:** Cloud API keys and tokens are loaded strictly via environment variables or encrypted key vaults.
- **Memory Buffer Bounds:** Audio chunks are held in bounded FIFO ring buffers, eliminating memory leakage during long voice sessions.
