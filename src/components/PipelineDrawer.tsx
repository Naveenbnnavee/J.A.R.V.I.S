import React, { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Activity, Server, Film, Image, Layers, Scissors,
  CheckCircle, Clock, Power, Play, Loader2, AlertTriangle
} from 'lucide-react';
import { addSocketListener, removeSocketListener } from '../services/socket';

interface PipelineDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  forceLocalTts: boolean;
  toggleLocalTts: (enabled: boolean) => void;
}

interface ScrapStatus {
  scrapConfig: {
    isEnabled: boolean;
    mode: 'manual' | 'auto';
    status: string;
    currentEpisodeDir: string | null;
  };
  episodeState: {
    status: string;
    total_scenes: number;
    episode_dir: string;
    title: string;
    last_run_date?: string;
    pending_review?: boolean;
  } | null;
  clipsInfo: {
    readyCount: number;
    totalScenes: number;
    missingScenes: number[];
    readyClips: number[];
  } | null;
}

const PHASES = ['Idle', 'Scripting', 'Assets', 'Compositing', 'AWAITING_CLIPS', 'Rendering', 'Stitching', 'Complete'];

export const PipelineDrawer: React.FC<PipelineDrawerProps> = ({ isOpen, onClose, forceLocalTts, toggleLocalTts }) => {
  const [pipelineStatus, setPipelineStatus] = useState('Idle');
  const [logs, setLogs] = useState<string[]>([]);
  const [scrapStatus, setScrapStatus] = useState<ScrapStatus | null>(null);
  const [isAssembling, setIsAssembling] = useState(false);
  const [assembleError, setAssembleError] = useState<string | null>(null);
  const [assembleSuccess, setAssembleSuccess] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const fetchScrapStatus = useCallback(async () => {
    try {
      const res = await fetch('http://localhost:3000/api/scrap/status');
      if (res.ok) {
        const data = await res.json();
        setScrapStatus(data);
        if (data.scrapConfig?.status) setPipelineStatus(data.scrapConfig.status);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    fetchScrapStatus();
    const interval = setInterval(fetchScrapStatus, 5000);
    return () => clearInterval(interval);
  }, [isOpen, fetchScrapStatus]);

  useEffect(() => {
    const handleMessage = (data: any) => {
      if (data.type === 'pipeline_status') setPipelineStatus(data.status);
      else if (data.type === 'pipeline_log' || data.type === 'agent_log') {
        setLogs(prev => [...prev, data.text].slice(-100));
      } else if (data.type === 'scrap_awaiting_clips' || data.type === 'scrap_awaiting_clips') {
        fetchScrapStatus();
        showToast('Pipeline paused — drop your clips and assemble!');
      } else if (data.type === 'scrap_assembled') {
        setIsAssembling(false);
        setAssembleSuccess(true);
        fetchScrapStatus();
        showToast('Episode assembled successfully!');
      }
    };
    addSocketListener(handleMessage);
    return () => removeSocketListener(handleMessage);
  }, [fetchScrapStatus]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    if (scrapStatus?.scrapConfig?.status && scrapStatus.scrapConfig.status !== 'ASSEMBLING') {
      setIsAssembling(false);
    }
  }, [scrapStatus?.scrapConfig?.status]);

  const toggleEnabled = async () => {
    if (!scrapStatus) return;
    const next = !scrapStatus.scrapConfig.isEnabled;
    await fetch('http://localhost:3000/api/scrap/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isEnabled: next }),
    });
    fetchScrapStatus();
    showToast(next ? 'Scrap Pipeline ENABLED' : 'Scrap Pipeline DISABLED');
  };

  const toggleMode = async (mode: 'manual' | 'auto') => {
    await fetch('http://localhost:3000/api/scrap/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    fetchScrapStatus();
  };

  const startPipeline = async () => {
    const res = await fetch('http://localhost:3000/api/scrap/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Scrap & Spark Episode' }),
    });
    const data = await res.json();
    if (!res.ok) showToast(`Error: ${data.error}`);
    else showToast('Pipeline started!');
    fetchScrapStatus();
  };

  const assembleEpisode = async () => {
    setIsAssembling(true);
    setAssembleError(null);
    setAssembleSuccess(false);
    try {
      const res = await fetch('http://localhost:3000/api/scrap/assemble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setIsAssembling(false);
        if (data.missingScenes) setAssembleError(`Missing scenes: ${data.missingScenes.join(', ')}`);
        else setAssembleError(data.error || 'Assembly failed.');
      }
      // Success is handled via WebSocket scrap_assembled event
    } catch (e: any) {
      setIsAssembling(false);
      setAssembleError(e.message);
    }
  };

  const cfg = scrapStatus?.scrapConfig;
  const episodeState = scrapStatus?.episodeState;
  const clipsInfo = scrapStatus?.clipsInfo;
  const isAwaitingClips = episodeState?.status === 'AWAITING_CLIPS';
  const isPendingReview = episodeState?.status === 'PENDING_REVIEW' || scrapStatus?.scrapConfig?.status === 'PENDING_REVIEW';
  const allClipsReady = clipsInfo ? clipsInfo.missingScenes.length === 0 : false;
  const todayStr = new Date().toISOString().split('T')[0];
  const hasUploadedToday = episodeState?.last_run_date === todayStr;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          drag
          dragMomentum={false}
          dragElastic={0}
          dragConstraints={false}
          whileDrag={{ cursor: 'grabbing' }}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ type: 'spring', damping: 25, stiffness: 200 }}
          style={{
            position: 'fixed',
            top: 80,   // below 64px Tauri drag-region strip
            right: 24,
            width: 400,
            zIndex: 9999,
          }}
          className="bg-slate-900/97 backdrop-blur-xl border border-cyan-900/60 rounded-2xl shadow-[0_0_60px_rgba(6,182,212,0.15)] flex flex-col overflow-hidden"
        >
          {/* Drag Handle Header — grab the header to move the panel */}
          <div
            style={{ cursor: 'grab' }}
            className="flex items-center justify-between p-4 border-b border-cyan-900/30 bg-slate-950/60 select-none"
          >
            <div className="flex items-center gap-2 text-cyan-400">
              <Activity className="animate-pulse" size={18} />
              <h2 className="font-mono font-bold tracking-wider text-sm">SCRAP & SPARK PIPELINE</h2>
              <span style={{
                fontSize: 10, padding: '1px 8px', borderRadius: 99, fontFamily: 'monospace',
                background: cfg?.isEnabled ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                border: `1px solid ${cfg?.isEnabled ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)'}`,
                color: cfg?.isEnabled ? '#34d399' : '#f87171',
              }}>
                {cfg?.isEnabled ? 'ENABLED' : 'DISABLED'}
              </span>
            </div>
            <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-white rounded-full hover:bg-slate-800 transition-colors">
              <X size={16} />
            </button>
          </div>

          <div
            className="overflow-y-auto"
            style={{ maxHeight: 'calc(100vh - 160px)' }}
            onPointerDown={e => e.stopPropagation()}
          >
            {/* Controls */}
            <div className="p-4 border-b border-cyan-900/20 flex flex-col gap-3">
              {/* Master Power Toggle */}
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-slate-400 uppercase tracking-widest">Master Power</span>
                <button
                  onClick={toggleEnabled}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '5px 14px', borderRadius: 99,
                    cursor: 'pointer', fontFamily: 'monospace', fontSize: 11, fontWeight: 700,
                    background: cfg?.isEnabled ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.1)',
                    border: `1px solid ${cfg?.isEnabled ? 'rgba(16,185,129,0.5)' : 'rgba(239,68,68,0.4)'}`,
                    color: cfg?.isEnabled ? '#34d399' : '#f87171',
                    boxShadow: cfg?.isEnabled ? '0 0 15px rgba(16,185,129,0.2)' : 'none',
                    transition: 'all 0.3s',
                  }}
                >
                  <Power size={12} />
                  {cfg?.isEnabled ? 'ACTIVE' : 'INACTIVE'}
                </button>
              </div>

              {/* Mode Selector */}
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-slate-400 uppercase tracking-widest">Mode</span>
                <div style={{ display: 'flex', gap: 4, background: 'rgba(0,0,0,0.4)', padding: 3, borderRadius: 99, border: '1px solid rgba(6,182,212,0.15)' }}>
                  {(['manual', 'auto'] as const).map(m => (
                    <button key={m} onClick={() => toggleMode(m)} style={{
                      padding: '4px 12px', borderRadius: 99, border: 'none', cursor: 'pointer',
                      fontFamily: 'monospace', fontSize: 10, fontWeight: 700,
                      background: cfg?.mode === m ? 'rgba(6,182,212,0.2)' : 'transparent',
                      color: cfg?.mode === m ? '#22d3ee' : '#4b5563',
                      boxShadow: cfg?.mode === m ? '0 0 10px rgba(6,182,212,0.2)' : 'none',
                      transition: 'all 0.2s',
                    }}>
                      {m === 'manual' ? 'Manual (Google Flow)' : 'Auto'}
                    </button>
                  ))}
                </div>
              </div>
              
              {/* Voice Engine Toggle */}
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-slate-400 uppercase tracking-widest">Voice Engine</span>
                <button
                  onClick={() => toggleLocalTts(!forceLocalTts)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '5px 14px', borderRadius: 99,
                    cursor: 'pointer', fontFamily: 'monospace', fontSize: 11, fontWeight: 700,
                    background: forceLocalTts ? 'rgba(34,197,94,0.15)' : 'rgba(14,165,233,0.15)',
                    border: `1px solid ${forceLocalTts ? 'rgba(34,197,94,0.5)' : 'rgba(14,165,233,0.5)'}`,
                    color: forceLocalTts ? '#4ade80' : '#7dd3fc',
                    boxShadow: forceLocalTts ? '0 0 15px rgba(34,197,94,0.2)' : '0 0 15px rgba(14,165,233,0.1)',
                    transition: 'all 0.3s',
                  }}
                >
                  {forceLocalTts ? 'LOCAL (PIPER)' : 'CLOUD (GEMINI)'}
                </button>
              </div>

              {/* Start Button */}
              <button
                onClick={startPipeline}
                disabled={!cfg?.isEnabled || cfg?.status === 'RUNNING'}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  padding: '8px 0', borderRadius: 10,
                  cursor: cfg?.isEnabled ? 'pointer' : 'not-allowed',
                  fontFamily: 'monospace', fontSize: 12, fontWeight: 700, letterSpacing: 1,
                  background: cfg?.isEnabled ? 'rgba(6,182,212,0.15)' : 'rgba(100,116,139,0.1)',
                  color: cfg?.isEnabled ? '#22d3ee' : '#475569',
                  border: `1px solid ${cfg?.isEnabled ? 'rgba(6,182,212,0.4)' : 'rgba(100,116,139,0.2)'}`,
                  transition: 'all 0.3s',
                }}
              >
                {cfg?.status === 'RUNNING' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {cfg?.status === 'RUNNING' ? 'RUNNING...' : 'START PIPELINE'}
              </button>
            </div>

            {/* Uploaded Panel */}
            {hasUploadedToday && !isPendingReview && cfg?.status !== 'RUNNING' && (
              <div className="p-4 border-b border-cyan-900/20" style={{ background: 'rgba(16,185,129,0.05)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle size={14} className="text-emerald-400" />
                  <h3 className="font-mono text-xs text-emerald-400 uppercase tracking-widest">Daily Upload Complete</h3>
                </div>
                <p className="font-mono text-xs text-slate-400">Today's episode has been successfully uploaded to YouTube! The pipeline has been reset to idle.</p>
              </div>
            )}

            {/* AWAITING_CLIPS Panel */}
            {isAwaitingClips && clipsInfo && (
              <div className="p-4 border-b border-cyan-900/20">
                <div className="flex items-center gap-2 mb-3">
                  <Film size={14} className="text-amber-400" />
                  <h3 className="font-mono text-xs text-amber-400 uppercase tracking-widest">Clip Status</h3>
                  <span style={{
                    marginLeft: 'auto', fontSize: 11, fontFamily: 'monospace',
                    padding: '2px 10px', borderRadius: 99,
                    background: allClipsReady ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)',
                    color: allClipsReady ? '#34d399' : '#fbbf24',
                    border: `1px solid ${allClipsReady ? 'rgba(16,185,129,0.4)' : 'rgba(245,158,11,0.4)'}`,
                  }}>
                    {clipsInfo.readyCount} / {clipsInfo.totalScenes} Clips Ready
                  </span>
                </div>

                {clipsInfo.missingScenes.length > 0 && (
                  <div className="mb-3">
                    <p className="font-mono text-xs text-slate-500 mb-2">Missing scenes:</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {clipsInfo.missingScenes.map(n => (
                        <span key={n} style={{
                          fontSize: 10, fontFamily: 'monospace', padding: '2px 8px', borderRadius: 6,
                          background: 'rgba(239,68,68,0.1)', color: '#fca5a5',
                          border: '1px solid rgba(239,68,68,0.3)',
                        }}>
                          scene_{String(n).padStart(2, '0')}.mp4
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {assembleError && (
                  <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
                    <p className="font-mono text-xs text-red-400 flex items-center gap-2">
                      <AlertTriangle size={12} /> {assembleError}
                    </p>
                  </div>
                )}

                {assembleSuccess && (
                  <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 8, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)' }}>
                    <p className="font-mono text-xs text-emerald-400 flex items-center gap-2">
                      <CheckCircle size={12} /> Episode assembled! Check 05_final/final_episode.mp4
                    </p>
                  </div>
                )}

                <button
                  onClick={assembleEpisode}
                  disabled={!allClipsReady || isAssembling}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    width: '100%', padding: '9px 0', borderRadius: 10,
                    cursor: allClipsReady && !isAssembling ? 'pointer' : 'not-allowed',
                    fontFamily: 'monospace', fontSize: 12, fontWeight: 700, letterSpacing: 1,
                    background: allClipsReady ? 'rgba(16,185,129,0.15)' : 'rgba(100,116,139,0.1)',
                    color: allClipsReady ? '#34d399' : '#475569',
                    border: `1px solid ${allClipsReady ? 'rgba(16,185,129,0.4)' : 'rgba(100,116,139,0.2)'}`,
                    boxShadow: allClipsReady ? '0 0 20px rgba(16,185,129,0.15)' : 'none',
                    transition: 'all 0.3s',
                  }}
                >
                  {isAssembling
                    ? <><Loader2 size={14} className="animate-spin" /> ASSEMBLING...</>
                    : <><Scissors size={14} /> ASSEMBLE EPISODE</>
                  }
                </button>
              </div>
            )}

            {/* PENDING_REVIEW Panel */}
            {isPendingReview && (
              <div className="p-4 border-b border-cyan-900/20">
                <div className="flex items-center gap-2 mb-3">
                  <CheckCircle size={14} className="text-emerald-400" />
                  <h3 className="font-mono text-xs text-emerald-400 uppercase tracking-widest">Awaiting Approval</h3>
                </div>
                <p className="font-mono text-xs text-slate-400 mb-3">Episode assembled successfully! Uploading automatically in 10 minutes...</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={async () => {
                      await fetch('http://localhost:3000/api/scrap/upload', { method: 'POST' });
                      fetchScrapStatus();
                      showToast('Upload initiated!');
                    }}
                    style={{
                      flex: 1, padding: '8px 0', borderRadius: 8,
                      background: 'rgba(16,185,129,0.15)', color: '#34d399', border: '1px solid rgba(16,185,129,0.4)',
                      fontFamily: 'monospace', fontSize: 11, fontWeight: 700, cursor: 'pointer'
                    }}
                  >
                    APPROVE & UPLOAD
                  </button>
                  <button
                    onClick={async () => {
                      await fetch('http://localhost:3000/api/scrap/cancel_upload', { method: 'POST' });
                      fetchScrapStatus();
                      showToast('Upload aborted.');
                    }}
                    style={{
                      flex: 1, padding: '8px 0', borderRadius: 8,
                      background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.4)',
                      fontFamily: 'monospace', fontSize: 11, fontWeight: 700, cursor: 'pointer'
                    }}
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            )}

            {/* Phase Indicator */}
            <div className="p-4 border-b border-cyan-900/20">
              <h3 className="text-xs text-slate-500 font-mono mb-3 uppercase tracking-widest">Pipeline Stages</h3>
              <div className="flex flex-col gap-2">
                {PHASES.map((phase) => {
                  const isActive = phase === pipelineStatus || (phase === 'AWAITING_CLIPS' && isAwaitingClips);
                  const phaseIdx = PHASES.indexOf(phase);
                  const statusIdx = PHASES.indexOf(pipelineStatus);
                  const isPast = statusIdx > phaseIdx && !isActive;

                  let Icon: any = Clock;
                  if (phase === 'Scripting') Icon = Server;
                  else if (phase === 'Assets') Icon = Image;
                  else if (phase === 'Compositing') Icon = Layers;
                  else if (phase === 'AWAITING_CLIPS') Icon = Film;
                  else if (phase === 'Rendering') Icon = Film;
                  else if (phase === 'Stitching') Icon = Scissors;
                  else if (phase === 'Complete') Icon = CheckCircle;

                  return (
                    <div key={phase} className={`flex items-center gap-3 transition-colors duration-500 ${isActive ? 'text-cyan-400' : isPast ? 'text-emerald-600' : 'text-slate-700'}`}>
                      <div className={`p-1.5 rounded-full ${isActive ? 'bg-cyan-900/50 shadow-[0_0_12px_rgba(34,211,238,0.3)] animate-pulse border border-cyan-500/50' : ''}`}>
                        <Icon size={12} />
                      </div>
                      <span className={`font-mono text-xs ${isActive ? 'font-bold' : ''}`}>
                        {phase === 'AWAITING_CLIPS' ? 'Awaiting Clips' : phase}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Logs */}
            <div className="p-4">
              <h3 className="text-xs text-slate-500 font-mono uppercase tracking-widest mb-2">Pipeline Logs</h3>
              <div style={{ height: 160, overflowY: 'auto', background: 'rgba(0,0,0,0.4)', borderRadius: 8, padding: '8px 12px' }}>
                {logs.length === 0 ? (
                  <div className="text-slate-600 text-center italic mt-4 text-xs font-mono">Waiting for logs...</div>
                ) : (
                  logs.map((log, i) => (
                    <div key={i} className="font-mono text-xs text-slate-300 border-l-2 border-cyan-800/30 pl-2 py-0.5">
                      <span className="text-cyan-700 mr-2">[{new Date().toLocaleTimeString()}]</span>
                      {log}
                    </div>
                  ))
                )}
                <div ref={logsEndRef} />
              </div>
            </div>
          </div>

          {/* Toast Notification */}
          <AnimatePresence>
            {toast && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                style={{
                  position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)',
                  background: 'rgba(6,182,212,0.15)', border: '1px solid rgba(6,182,212,0.4)',
                  backdropFilter: 'blur(10px)', padding: '5px 18px', borderRadius: 99,
                  fontSize: 11, fontFamily: 'monospace', color: '#22d3ee', whiteSpace: 'nowrap',
                  zIndex: 10,
                }}
              >
                {toast}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};


