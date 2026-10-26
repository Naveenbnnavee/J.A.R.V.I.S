import { useState, useEffect, useCallback } from 'react';
import { getJarvisSocket, addSocketListener, removeSocketListener } from '../services/socket';

export const useJarvisWebSocket = (
  onJarvisSpeak: (audioBase64: string, format?: string) => void,
  onLog: (msg: string) => void,
  stopPlayback: () => void,
  onFileWritten?: (file: string) => void,
  onToggleGhostMode?: (state: boolean) => void,
  onTTSStart?: () => void,
  onTTSEnd?: () => void,
  onReminder?: (msg: string) => void,
  onPlayChime?: () => void
) => {
  const [isConnected, setIsConnected] = useState(false);
  const [pendingAction, setPendingAction] = useState<any>(null);
  const [visionPrompt, setVisionPrompt] = useState<string | null>(null);
  const [wakeWordTimestamp, setWakeWordTimestamp] = useState<number>(0);
  const [serverLive, setServerLive] = useState<boolean>(false);
  const [previewUrl, setPreviewUrl] = useState<string>('http://localhost:5173');
  const [activeEngine, setActiveEngine] = useState<string>('Standing By');
  const [activeNodes, setActiveNodes] = useState<Record<string, 'idle' | 'active' | 'error'>>({});
  const [youtubePipelineEnabled, setYoutubePipelineEnabled] = useState<boolean>(false);
  const [forceLocalTts, setForceLocalTts] = useState<boolean>(false);
  const [authChallenge, setAuthChallenge] = useState<{ sessionKey: string; score: string } | null>(null);
  const [hasTelegram, setHasTelegram] = useState(false);
  const [phoneAlert, setPhoneAlert] = useState<any>(null);
  const [sysTelemetry, setSysTelemetry] = useState<{memoryUsage: string, memoryTotal: string, coreTemp: string, latency: string, phoneConnected: boolean, tunnelUrl?: string | null, localCompanionUrl?: string | null} | null>(null);
  const [generatedImage, setGeneratedImage] = useState<{ url: string; prompt: string } | null>(null);

  useEffect(() => {
    // Polling socket state since React might miss the initial open event
    const checkConnection = () => {
      const currentSocket = getJarvisSocket();
      setIsConnected(currentSocket ? currentSocket.readyState === WebSocket.OPEN : false);
    };
    const interval = setInterval(checkConnection, 1000);
    checkConnection();

    const handleMessage = (data: any) => {
      if (data.type === '_connected') {
        setIsConnected(true);
        // Request initial state on connect
        const socket = getJarvisSocket();
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'get_youtube_pipeline_state' }));
        }
      } else if (data.type === 'tts_audio') {
        onJarvisSpeak(data.audioBase64, data.format);
      } else if (data.type === 'tts_start') {
        if (onTTSStart) onTTSStart();
      } else if (data.type === 'tts_end') {
        if (onTTSEnd) onTTSEnd();
      } else if (data.type === 'log') {
        onLog(data.text);
      } else if (data.type === 'llm_response') {
        onLog(`Jarvis: ${data.text}`);
      } else if (data.type === 'agent_log') {
        onLog(`[Agent] ${data.text}`);
        // Clear pending action if voice authorized
        if (data.text === '[Voice Authorized]' || data.text === '[Voice Denied]') {
            setPendingAction(null);
        }
      } else if (data.type === 'pending_approval') {
        setPendingAction(data.action);
      } else if (data.type === 'trigger_webcam') {
        setVisionPrompt(data.prompt);
      } else if (data.type === 'user_interrupt') {
        onLog('[System] Voice interruption acknowledged.');
        stopPlayback();
        setPendingAction(null);
      } else if (data.type === 'file_written') {
        if (onFileWritten) onFileWritten(data.filePath);
      } else if (data.type === 'wake_word_detected') {
        setWakeWordTimestamp(Date.now());
      } else if (data.type === 'server_live') {
        setServerLive(true);
        if (data.url) setPreviewUrl(data.url);
        onLog('[System] Live Preview Server connected.');
      } else if (data.type === 'engine_status') {
        setActiveEngine(data.engine);
      } else if (data.type === 'toggle_ghost_mode') {
        if (onToggleGhostMode) onToggleGhostMode(data.state);
      } else if (data.type === 'node_status') {
        setActiveNodes(prev => ({ ...prev, [data.node]: data.status }));
      } else if (data.type === 'youtube_pipeline_state') {
        setYoutubePipelineEnabled(data.enabled);
        if (data.forceLocalTts !== undefined) setForceLocalTts(data.forceLocalTts);
      } else if (data.type === 'local_tts_state') {
        setForceLocalTts(data.enabled);
      } else if (data.type === 'reminder') {
        if (onReminder) onReminder(data.message);
      } else if (data.type === 'play_chime') {
        if (onPlayChime) onPlayChime();
      } else if (data.type === 'AUTH_REQUIRED') {
        setAuthChallenge({ sessionKey: data.sessionKey, score: data.score });
        setHasTelegram(!!data.hasTelegram);
        onLog('[Security] Voice not recognized. PIN required.');
      } else if (data.type === 'AUTH_RESULT') {
        if (data.success) {
          setAuthChallenge(null);
          onLog('[Security] PIN accepted. Command authorized.');
        } else {
          onLog(`[Security] ${data.message}`);
        }
      } else if (data.type === 'phone_alert') {
        setPhoneAlert(data.payload);
        // Auto-dismiss after 10 seconds
        setTimeout(() => setPhoneAlert(null), 10000);
      } else if (data.type === 'sys_telemetry') {
        setSysTelemetry({
          memoryUsage: data.memoryUsage,
          memoryTotal: data.memoryTotal,
          coreTemp: data.coreTemp,
          latency: data.latency,
          phoneConnected: data.phoneConnected,
          tunnelUrl: data.tunnelUrl || null
        });
      } else if (data.type === 'companion_tunnel_url') {
        if (data.url) {
          onLog(`[Tunnel] Link: ${data.url}`);
          setSysTelemetry(prev => prev ? ({ ...prev, tunnelUrl: data.url }) : null);
        }
      } else if (data.type === 'generated_image') {
        setGeneratedImage({ url: data.url, prompt: data.prompt });
      }
    };

    addSocketListener(handleMessage);

    return () => {
      removeSocketListener(handleMessage);
      clearInterval(interval);
    };
  }, [onJarvisSpeak, onLog]);

  const sendAudioChunk = useCallback((blob: Blob) => {
    const socket = getJarvisSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(blob);
    }
  }, []);

  const approveAction = useCallback((id: string) => {
    const socket = getJarvisSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'approval_granted', id }));
      setPendingAction(null);
    }
  }, []);

  const denyAction = useCallback((id: string) => {
    const socket = getJarvisSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'approval_denied', id }));
      setPendingAction(null);
    }
  }, []);

  const toggleYoutubePipeline = useCallback((enabled: boolean) => {
    const socket = getJarvisSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'toggle_youtube_pipeline', enabled }));
    }
  }, []);

  const toggleLocalTts = useCallback((enabled: boolean) => {
    const socket = getJarvisSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'toggle_local_tts', enabled }));
    }
  }, []);

  const submitPin = useCallback((pin: string, sessionKey: string) => {
    const socket = getJarvisSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'SUBMIT_PIN', pin, sessionKey }));
    }
  }, []);

  const requestTelegramAuth = useCallback((sessionKey: string) => {
    const socket = getJarvisSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'REQUEST_TELEGRAM_AUTH', sessionKey }));
    }
  }, []);

  const clearVisionPrompt = useCallback(() => setVisionPrompt(null), []);
  const clearAuthChallenge = useCallback(() => setAuthChallenge(null), []);
  const clearGeneratedImage = useCallback(() => setGeneratedImage(null), []);

  return { isConnected, sendAudioChunk, pendingAction, approveAction, denyAction, visionPrompt, clearVisionPrompt, wakeWordTimestamp, serverLive, previewUrl, activeEngine, activeNodes, youtubePipelineEnabled, toggleYoutubePipeline, forceLocalTts, toggleLocalTts, authChallenge, hasTelegram, phoneAlert, submitPin, requestTelegramAuth, clearAuthChallenge, sysTelemetry, generatedImage, clearGeneratedImage };
};
