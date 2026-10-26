import { useState, useCallback, useEffect, useRef } from 'react';
import { ReactorState } from './components/ArcReactor';
import { RadialHUD } from './components/RadialHUD';
import { HudTerminal } from './components/HudTerminal';
import { DeveloperWorkspace } from './components/DeveloperWorkspace';
import { ChatConsole, Message } from './components/ChatConsole';
import { PipelineDrawer } from './components/PipelineDrawer';
import { PinModal } from './components/PinModal';
import { VoiceUI, VoiceExchange } from './components/VoiceUI';
import { useAudioCapture } from './hooks/useAudioCapture';
import { useJarvisWebSocket } from './hooks/useJarvisWebSocket';
import { useAudioPlayback } from './hooks/useAudioPlayback';
import { useWebcam } from './hooks/useWebcam';
import { getJarvisSocket } from './services/socket';
import { Menu, AlertTriangle, Check, X, Camera, MessageSquare, Radio, Ghost, PlaySquare, Activity, Smartphone, Volume2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { enable, isEnabled } from '@tauri-apps/plugin-autostart';

type AppMode = 'voice' | 'chat';

function App() {
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [isPipelineDrawerOpen, setIsPipelineDrawerOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [agentStatus, setAgentStatus] = useState<string>('');
  const [isAwake, setIsAwake] = useState<boolean>(false);
  const [mode, setMode] = useState<AppMode>('voice');
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [isSilent, setIsSilent] = useState(true);
  const [chatMessages, setChatMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'jarvis',
      text: "Silent mode active, Sir. I am at your disposal. Type your query below.",
    }
  ]);
  const [isGhostMode, setIsGhostMode] = useState(false);
  const awakeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeReminder, setActiveReminder] = useState<string | null>(null);
  const [voiceExchanges, setVoiceExchanges] = useState<VoiceExchange[]>([]);
  const pendingJarvisIdRef = useRef<string | null>(null);
  const reminderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleGhostMode = async () => {
    const next = !isGhostMode;
    setIsGhostMode(next);
    try {
      await invoke('toggle_ghost_mode', { ignore: next });
    } catch (e) {
      console.warn('Ghost mode invoke failed (not in Tauri context):', e);
    }
  };

  const addLog = useCallback((msg: string) => {
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    if (msg.includes('[Agent]')) {
      setAgentStatus(msg.replace('[Agent]', '').trim());
    }
    
    // Capture Jarvis spoken response for VoiceUI
    if (msg.startsWith('Jarvis: ')) {
      const text = msg.replace('Jarvis: ', '').trim();
      if (!text) return;
      const id = `jarvis-${Date.now()}`;
      pendingJarvisIdRef.current = id;
      setVoiceExchanges(prev => [...prev, { id, role: 'jarvis', text, streaming: false }]);
    }
    // Capture what the user said for VoiceUI
    if (msg.includes('User: ')) {
      const text = msg.substring(msg.indexOf('User: ') + 6).trim();
      if (text) {
        setVoiceExchanges(prev => [...prev, { id: `user-${Date.now()}`, role: 'user', text }]);
      }
    }
  }, []);

  const onFileWritten = useCallback((file: string) => {
    setFiles(prev => prev.includes(file) ? prev : [...prev, file]);
  }, []);

  const setGhostModeRemote = useCallback(async (state: boolean) => {
    setIsGhostMode(state);
    try {
      await invoke('toggle_ghost_mode', { ignore: state });
    } catch (e) {
      console.warn('Ghost mode invoke failed:', e);
    }
  }, []);

  const { isSpeaking, playbackVolume, queueAudioChunk, stopPlayback, setSpeakingState } = useAudioPlayback();
  
  const playChime = useCallback(() => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(660, audioCtx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.1);
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.05);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
      oscillator.start(audioCtx.currentTime);
      oscillator.stop(audioCtx.currentTime + 0.5);
    } catch (e) {
      console.error("Audio chime failed", e);
    }
  }, []);

  const { sendAudioChunk, pendingAction, approveAction, denyAction, visionPrompt, clearVisionPrompt, wakeWordTimestamp, serverLive, previewUrl, activeEngine, activeNodes, forceLocalTts, toggleLocalTts, authChallenge, hasTelegram, phoneAlert, submitPin, requestTelegramAuth, clearAuthChallenge, sysTelemetry, generatedImage, clearGeneratedImage, youtubePipelineEnabled, toggleYoutubePipeline } = useJarvisWebSocket(
    queueAudioChunk,
    addLog,
    stopPlayback,
    onFileWritten,
    setGhostModeRemote,
    () => setSpeakingState(true),
    () => setSpeakingState(false),
    (msg: string) => {
      setActiveReminder(msg);
      if (reminderTimeoutRef.current) clearTimeout(reminderTimeoutRef.current);
      reminderTimeoutRef.current = setTimeout(() => setActiveReminder(null), 10000);
    },
    playChime
  );

  // Speak Incoming Call
  useEffect(() => {
    if (phoneAlert && phoneAlert.type === 'CALL' && !isSilent) {
      const utterance = new SpeechSynthesisUtterance("Incoming call. " + (phoneAlert.text || ""));
      utterance.rate = 1.1;
      window.speechSynthesis.speak(utterance);
    }
  }, [phoneAlert, isSilent]);

  const { captureFrame, isScanning } = useWebcam();
  const { isRecording, micVolume, startRecording, stopRecording } = useAudioCapture(sendAudioChunk);

  // Global keyboard shortcut: Ctrl+Shift+C to toggle modes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        setMode(prev => prev === 'voice' ? 'chat' : 'voice');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Initialize Services & Autostart
  useEffect(() => {
    const initBackend = async () => {
      try {
        // Autostart
        const autostartEnabled = await isEnabled();
        if (!autostartEnabled) {
          await enable();
          console.log('[Autostart] Enabled on Windows boot.');
        }

        // Request native service supervisor to ensure backend and ChromaDB are alive
        try {
          await invoke('ensure_services_running');
          console.log('[Service Supervisor] Background services initiated.');
        } catch (e) {
          console.warn('[Service Supervisor] Invoke failed:', e);
        }
      } catch (err) {
        console.error('[Initialization Error]', err);
      }
    };

    initBackend();
  }, []);

  // Listen for ghost mode toggles from Rust (e.g. via global shortcut or voice command)
  useEffect(() => {
    const unlisten = listen('ghost_mode_toggled', (event) => {
      setIsGhostMode(event.payload as boolean);
    });
    return () => {
      unlisten.then(f => f());
    };
  }, []);

  // Trigger webcam when backend sends a visionPrompt
  useEffect(() => {
    if (visionPrompt) {
      captureFrame().then(base64 => {
        if (base64) {
          const socket = getJarvisSocket();
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'vision_query', imageBase64: base64, prompt: visionPrompt }));
          }
        }
        clearVisionPrompt();
      });
    }
  }, [visionPrompt, captureFrame, clearVisionPrompt]);

  // Handle Wake Word Activation
  useEffect(() => {
    if (wakeWordTimestamp > 0) {
      setIsAwake(true);
      addLog("Wake word detected! Listening...");
      
      // Attempt to play a subtle chime
      try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(1760, audioCtx.currentTime + 0.1);
        gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + 0.05);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        oscillator.start(audioCtx.currentTime);
        oscillator.stop(audioCtx.currentTime + 0.3);
      } catch (e) {
        console.error("Audio chime failed", e);
      }

      if (awakeTimeoutRef.current) clearTimeout(awakeTimeoutRef.current);
      awakeTimeoutRef.current = setTimeout(() => {
        setIsAwake(false);
        addLog("Going back to sleep...");
      }, 15000); // Stay awake for 15s after wake word
    }
  }, [wakeWordTimestamp, addLog]);

  // Determine overall reactor state
  let reactorState: ReactorState = 'idle';
  let activeVolume = 0;

  // Handle wake state when speaking
  useEffect(() => {
    if (isSpeaking) {
      setIsAwake(true);
      if (awakeTimeoutRef.current) clearTimeout(awakeTimeoutRef.current);
      awakeTimeoutRef.current = setTimeout(() => setIsAwake(false), 15000);
    }
  }, [isSpeaking]);

  if (isSpeaking) {
    reactorState = 'speaking';
    activeVolume = playbackVolume;
  } else if (isRecording && isAwake) {
    reactorState = 'listening';
    activeVolume = micVolume;
  } else if (isRecording && !isAwake) {
    // Background listening mode (Idle)
    reactorState = 'idle';
    activeVolume = micVolume * 0.3; // Very subtle pulsing
  }

  const toggleMic = () => {
    if (isRecording) {
      stopRecording();
      addLog("Microphone deactivated.");
    } else {
      startRecording();
      addLog("Microphone activated. Listening...");
    }
  };

  return (
    <div 
      className={`w-screen h-screen bg-transparent overflow-hidden flex flex-col items-center justify-center relative transition-all duration-300 ${
        activeReminder ? 'animate-pulse border-4 border-cyan-400 shadow-[inset_0_0_80px_rgba(34,211,238,0.8)]' : ''
      }`}
    >
      
      {/* ── Biometric PIN Modal ── */}
      <PinModal
        sessionKey={authChallenge?.sessionKey ?? null}
        score={authChallenge?.score ?? '0'}
        hasTelegram={hasTelegram}
        onSubmit={(pin, sessionKey) => submitPin(pin, sessionKey)}
        onRequestTelegram={(sessionKey) => requestTelegramAuth(sessionKey)}
        onDismiss={() => clearAuthChallenge()}
      />

      {/* Draggable region for Tauri — top strip for window drag */}
      <div data-tauri-drag-region className="absolute top-0 w-full h-16 cursor-move bg-transparent" style={{ zIndex: 200 }} />

      {/* ── Mode Switcher ── */}
      <div style={{
        position: 'absolute', top: 18, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 8, zIndex: 300,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(16px)',
        border: '1px solid rgba(6,182,212,0.2)', borderRadius: 99,
        padding: '4px 6px',
      }}>
        <button
          onClick={() => setMode('voice')}
          title="Voice Mode (Ctrl+Shift+C)"
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '5px 14px',
            borderRadius: 99, border: 'none', cursor: 'pointer', fontFamily: 'monospace',
            fontSize: 11, fontWeight: 700, letterSpacing: 1, transition: 'all 0.25s',
            background: mode === 'voice' ? 'rgba(6,182,212,0.2)' : 'transparent',
            color: mode === 'voice' ? '#22d3ee' : '#4b5563',
            boxShadow: mode === 'voice' ? '0 0 12px rgba(6,182,212,0.3)' : 'none',
          }}
        >
          <Radio size={12} /> VOICE
        </button>
        <button
          onClick={() => setMode('chat')}
          title="Chat Mode (Ctrl+Shift+C)"
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '5px 14px',
            borderRadius: 99, border: 'none', cursor: 'pointer', fontFamily: 'monospace',
            fontSize: 11, fontWeight: 700, letterSpacing: 1, transition: 'all 0.25s',
            background: mode === 'chat' ? 'rgba(99,102,241,0.2)' : 'transparent',
            color: mode === 'chat' ? '#818cf8' : '#4b5563',
            boxShadow: mode === 'chat' ? '0 0 12px rgba(99,102,241,0.3)' : 'none',
          }}
        >
          <MessageSquare size={12} /> CHAT
        </button>
      </div>

      {/* ── VOICE MODE ── */}
      <AnimatePresence mode="wait">
        {mode === 'voice' && (
          <motion.div key="voice" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }}
            data-tauri-drag-region
            style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, cursor: 'move' }}
          >
            {/* Full Radial HUD (background) */}
            <RadialHUD 
              reactorState={reactorState} 
              reactorVolume={activeVolume} 
              activeNodes={activeNodes} 
              memoryUsage={sysTelemetry?.memoryUsage || "12.4 GB"} 
              llmTier={activeEngine} 
              latency={sysTelemetry?.latency || "32ms"}
              coreTemp={sysTelemetry?.coreTemp || "34°C OPTIMAL"}
              isPhoneConnected={!!sysTelemetry?.phoneConnected}
            />

            {/* VoiceUI Overlay (foreground — conversation layer) */}
            <VoiceUI
              isRecording={isRecording}
              isSpeaking={isSpeaking}
              isAwake={isAwake}
              isConnected={serverLive}
              activeEngine={activeEngine}
              exchanges={voiceExchanges}
              onToggleMic={toggleMic}
            />

            {/* Developer Overlay Toggle */}
            <button 
              onClick={() => setOverlayOpen(prev => !prev)}
              className="absolute top-8 left-8 z-[210] px-3 py-1.5 border border-cyan-900 bg-black/60 text-cyan-500 text-xs font-mono rounded hover:bg-cyan-900/40 hover:text-cyan-300 transition-colors cursor-pointer"
            >
              {overlayOpen ? 'HIDE OVERLAY' : 'SHOW OVERLAY'}
            </button>

            {/* Slide-out Developer Overlay */}
            <AnimatePresence>
              {overlayOpen && (
                <motion.div 
                  initial={{ x: '-100%', opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: '-100%', opacity: 0 }}
                  transition={{ type: 'spring', damping: 20, stiffness: 100 }}
                  className="absolute top-0 left-0 h-full w-[450px] bg-black/80 backdrop-blur-md border-r border-cyan-900/50 z-40 pt-20 p-6 flex flex-col gap-6"
                >
                  <DeveloperWorkspace logs={logs} files={files} status={agentStatus} serverLive={serverLive} previewUrl={previewUrl} />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}

        {/* ── CHAT MODE ── */}
        {mode === 'chat' && (
          <motion.div key="chat" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} transition={{ duration: 0.35 }}
            style={{ width: '92%', maxWidth: 680, height: 'calc(100vh - 180px)', marginTop: 52 }}
          >
            <ChatConsole 
              isSilent={isSilent} 
              onSilentToggle={() => setIsSilent(p => !p)} 
              messages={chatMessages}
              setMessages={setChatMessages}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* HUD Terminal */}
      <HudTerminal isOpen={isTerminalOpen} onToggle={() => setIsTerminalOpen(!isTerminalOpen)} logs={logs} activeEngine={activeEngine} sysTelemetry={sysTelemetry} />

      {/* Action Required Overlay */}
      {pendingAction && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-md z-40 flex items-center justify-center p-8">
          <div className="bg-slate-900 border border-amber-500/50 shadow-[0_0_40px_rgba(245,158,11,0.2)] rounded-2xl p-6 w-full max-w-lg">
            <div className="flex items-center gap-3 text-amber-400 mb-4">
              <AlertTriangle size={24} />
              <h2 className="text-xl font-bold font-mono">ACTION REQUIRED</h2>
            </div>
            
            <div className="bg-black/50 p-4 rounded-lg border border-slate-700 mb-6 font-mono text-sm overflow-hidden text-slate-300">
              <div className="text-cyan-400 mb-2 border-b border-slate-700 pb-2">Tool: {pendingAction.tool}</div>
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(pendingAction.args, null, 2)}
              </pre>
            </div>

            <div className="flex gap-4">
              <button 
                onClick={() => denyAction(pendingAction.id)}
                className="flex-1 py-3 rounded-lg border border-red-500/50 text-red-400 hover:bg-red-500/10 flex items-center justify-center gap-2 font-mono transition-colors"
              >
                <X size={18} /> DENY
              </button>
              <button 
                onClick={() => approveAction(pendingAction.id)}
                className="flex-1 py-3 rounded-lg border border-emerald-500/50 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.3)] flex items-center justify-center gap-2 font-mono transition-all"
              >
                <Check size={18} /> APPROVE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Vision Scanning Overlay */}
      {isScanning && (
        <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
          <div className="absolute w-[40vw] h-[40vw] border border-cyan-500/30 rounded-full animate-ping opacity-20" />
          <div className="absolute w-[30vw] h-[30vw] border border-cyan-400/50 rounded-full animate-ping opacity-40 delay-75" />
          <div className="bg-cyan-950/80 border border-cyan-500 text-cyan-300 px-6 py-3 rounded-full flex items-center gap-3 backdrop-blur-md shadow-[0_0_30px_rgba(34,211,238,0.4)]">
            <Camera className="animate-pulse" />
            <span className="font-mono font-bold tracking-widest">SCANNING TARGET...</span>
          </div>
        </div>
      )}

      {/* Reminder HUD Toast */}
      <AnimatePresence>
        {activeReminder && (
          <motion.div
            initial={{ opacity: 0, y: -50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, y: -20 }}
            className="fixed top-8 right-8 z-50 pointer-events-auto"
          >
            <div className="bg-slate-900/90 backdrop-blur-xl border border-cyan-500/50 shadow-[0_0_40px_rgba(34,211,238,0.3)] rounded-2xl p-5 w-80 overflow-hidden relative">
              <div className="absolute top-0 left-0 w-full h-1 bg-cyan-400 animate-pulse" />
              <div className="flex items-start gap-4">
                <div className="p-2 bg-cyan-500/20 rounded-full text-cyan-400 animate-pulse">
                  <AlertTriangle size={24} />
                </div>
                <div className="flex-1">
                  <h3 className="text-cyan-400 font-mono font-bold text-sm mb-1 uppercase tracking-wider">Reminder</h3>
                  <p className="text-slate-200 text-sm">{activeReminder}</p>
                </div>
              </div>
              <div className="flex gap-2 mt-4">
                <button 
                  onClick={() => setActiveReminder(null)} 
                  className="flex-1 py-2 text-xs font-mono rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
                >
                  DISMISS
                </button>
                <button 
                  onClick={() => {
                    setActiveReminder(null);
                    // simple local snooze for 5 mins
                    setTimeout(() => setActiveReminder(activeReminder), 5 * 60 * 1000);
                  }} 
                  className="flex-1 py-2 text-xs font-mono rounded bg-cyan-900/30 hover:bg-cyan-800/50 text-cyan-400 border border-cyan-800/50 transition-colors"
                >
                  SNOOZE
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Phone Alert Toast */}
      <AnimatePresence>
        {phoneAlert && (
          <motion.div
            initial={{ opacity: 0, x: -50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, x: -20 }}
            className="fixed top-8 left-8 z-50 pointer-events-auto"
          >
            <div className="bg-slate-900/90 backdrop-blur-xl border border-green-500/50 shadow-[0_0_40px_rgba(34,197,94,0.3)] rounded-2xl p-5 w-80 overflow-hidden relative">
              <div className="absolute top-0 left-0 w-full h-1 bg-green-400 animate-pulse" />
              <div className="flex items-start gap-4">
                <div className="p-2 bg-green-500/20 rounded-full text-green-400 animate-bounce">
                  <Smartphone size={24} />
                </div>
                <div className="flex-1">
                  <h3 className="text-green-400 font-mono font-bold text-sm mb-1 uppercase tracking-wider">{phoneAlert.type || 'Phone Notification'}</h3>
                  {phoneAlert.package && <p className="text-slate-200 text-sm font-bold">{phoneAlert.package}</p>}
                  {phoneAlert.text && <p className="text-slate-300 text-xs mt-1 truncate">{phoneAlert.text}</p>}
                  {phoneAlert.type === 'CALL' && (
                    <button 
                      onClick={() => {
                        const socket = getJarvisSocket();
                        if (socket) {
                          socket.send(JSON.stringify({
                            type: 'companion_command',
                            commandObj: { command: 'SILENCE_CALL' }
                          }));
                        }
                      }}
                      className="mt-3 bg-red-500/20 text-red-400 border border-red-500/50 rounded px-3 py-1 text-xs font-bold hover:bg-red-500/40 transition-colors uppercase tracking-wider w-full"
                    >
                      Mute Phone
                    </button>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Generated Image Overlay — floats bottom-right, works in both voice and chat mode */}
      <AnimatePresence>
        {generatedImage && (
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            style={{ position: 'fixed', bottom: 110, right: 24, zIndex: 50, maxWidth: 340, width: '90vw' }}
          >
            <div style={{
              background: 'rgba(6,12,30,0.95)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(6,182,212,0.5)',
              boxShadow: '0 0 50px rgba(6,182,212,0.3)',
              borderRadius: 20,
              overflow: 'hidden',
            }}>
              <div style={{ padding: '10px 14px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#22d3ee', fontFamily: 'monospace', fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase' }}>🖼 Generated Image</span>
                <button
                  onClick={clearGeneratedImage}
                  style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '0 2px' }}
                >×</button>
              </div>
              <img
                src={generatedImage.url}
                alt={generatedImage.prompt}
                style={{ width: '100%', display: 'block', maxHeight: 280, objectFit: 'cover' }}
              />
              <div style={{ padding: '8px 14px 12px' }}>
                <p style={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: 11, margin: 0, fontStyle: 'italic' }}>"{generatedImage.prompt}"</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toggle Terminal + Ghost Mode + YouTube Pipeline Buttons */}
      <div style={{ position: 'fixed', bottom: 24, right: 24, display: 'flex', gap: 10, zIndex: 50 }}>
        <button
          onClick={() => setIsPipelineDrawerOpen(!isPipelineDrawerOpen)}
          title="YouTube Pipeline Drawer"
          style={{
            padding: 14, borderRadius: '50%',
            background: 'rgba(6,182,212,0.1)',
            border: '1px solid rgba(6,182,212,0.4)',
            color: '#22d3ee',
            cursor: 'pointer',
            backdropFilter: 'blur(8px)',
            transition: 'all 0.3s',
          }}
        >
          <Activity size={18} />
        </button>
        <button
          onClick={() => toggleYoutubePipeline(!youtubePipelineEnabled)}
          title={youtubePipelineEnabled ? 'YouTube Pipeline ENABLED (Autonomous)' : 'YouTube Pipeline DISABLED'}
          style={{
            padding: 14, borderRadius: '50%',
            background: youtubePipelineEnabled ? 'rgba(239,68,68,0.3)' : 'rgba(0,0,0,0.3)',
            border: `1px solid ${youtubePipelineEnabled ? 'rgba(239,68,68,0.7)' : 'rgba(239,68,68,0.3)'}`,
            color: youtubePipelineEnabled ? '#fca5a5' : '#7f1d1d',
            cursor: 'pointer',
            backdropFilter: 'blur(8px)',
            transition: 'all 0.3s',
            boxShadow: youtubePipelineEnabled ? '0 0 20px rgba(239,68,68,0.4)' : 'none',
          }}
        >
          <PlaySquare size={18} />
        </button>
        <button
          onClick={() => toggleLocalTts(!forceLocalTts)}
          title={forceLocalTts ? 'Voice Engine: LOCAL PIPER TTS' : 'Voice Engine: CLOUD GEMINI TTS'}
          style={{
            padding: 14, borderRadius: '50%',
            background: forceLocalTts ? 'rgba(34,197,94,0.3)' : 'rgba(0,0,0,0.3)',
            border: `1px solid ${forceLocalTts ? 'rgba(34,197,94,0.7)' : 'rgba(34,197,94,0.3)'}`,
            color: forceLocalTts ? '#86efac' : '#14532d',
            cursor: 'pointer',
            backdropFilter: 'blur(8px)',
            transition: 'all 0.3s',
            boxShadow: forceLocalTts ? '0 0 20px rgba(34,197,94,0.4)' : 'none',
          }}
        >
          <Volume2 size={18} />
        </button>
        <button
          onClick={toggleGhostMode}
          title={isGhostMode ? 'Ghost Mode ON — clicks pass through' : 'Ghost Mode OFF'}
          style={{
            padding: 14, borderRadius: '50%',
            background: isGhostMode ? 'rgba(139,92,246,0.3)' : 'rgba(0,0,0,0.3)',
            border: `1px solid ${isGhostMode ? 'rgba(139,92,246,0.7)' : 'rgba(6,182,212,0.4)'}`,
            color: isGhostMode ? '#a78bfa' : '#22d3ee',
            cursor: 'pointer',
            backdropFilter: 'blur(8px)',
            transition: 'all 0.3s',
            boxShadow: isGhostMode ? '0 0 20px rgba(139,92,246,0.4)' : 'none',
          }}
        >
          <Ghost size={18} />
        </button>
        <button
          onClick={() => setIsTerminalOpen(!isTerminalOpen)}
          style={{
            padding: 14, borderRadius: '50%',
            background: 'rgba(6,182,212,0.1)',
            border: '1px solid rgba(6,182,212,0.4)',
            color: '#22d3ee',
            cursor: 'pointer',
            backdropFilter: 'blur(8px)',
            transition: 'all 0.3s',
          }}
        >
          <Menu size={18} />
        </button>
      </div>

      <PipelineDrawer isOpen={isPipelineDrawerOpen} onClose={() => setIsPipelineDrawerOpen(false)} forceLocalTts={forceLocalTts} toggleLocalTts={toggleLocalTts} />
    </div>
  );
}

export default App;
