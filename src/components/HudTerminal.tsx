import { useRef, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Terminal, Cpu, Activity, Wifi, Radio, Smartphone, Copy, Check } from 'lucide-react';

interface HudTerminalProps {
  isOpen: boolean;
  onToggle: () => void;
  logs?: string[];
  activeEngine?: string;
  sysTelemetry?: any;
}

export const HudTerminal = ({ isOpen, onToggle: _onToggle, logs = [], activeEngine = 'Standing By', sysTelemetry }: HudTerminalProps) => {
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, isOpen]);

  const copyTunnelUrl = () => {
    if (sysTelemetry?.tunnelUrl) {
      navigator.clipboard.writeText(sysTelemetry.tunnelUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const engineColor = activeEngine === 'Standing By' ? '#6b7280'
    : activeEngine.startsWith('Groq') ? '#22d3ee'
    : activeEngine.startsWith('Gemini') ? '#facc15'
    : '#4ade80'; // Local Ollama = green

  return (
    <>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ x: "100%", opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: "100%", opacity: 0 }}
            transition={{ type: "spring", damping: 20, stiffness: 100 }}
            className="fixed right-0 top-0 h-full w-96 bg-black/60 backdrop-blur-xl border-l border-cyan-500/30 p-6 flex flex-col text-cyan-50 font-mono shadow-[-10px_0_30px_rgba(6,182,212,0.15)] z-50 pointer-events-auto"
          >
            <div className="flex items-center justify-between mb-6 border-b border-cyan-500/30 pb-4">
              <div className="flex items-center gap-3">
                <Terminal className="text-cyan-400 w-6 h-6 animate-pulse" />
                <h2 className="text-xl font-bold tracking-widest text-cyan-400 uppercase">Jarvis Terminal</h2>
              </div>
              <span className="text-[10px] bg-cyan-950/80 text-cyan-400 border border-cyan-700/50 px-2 py-0.5 rounded font-mono">
                {sysTelemetry?.latency || '32ms'}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-6 pr-1 custom-scrollbar">
              {/* System Status */}
              <section className="space-y-3">
                <h3 className="text-xs text-cyan-300/70 uppercase tracking-widest font-bold">System Telemetry</h3>
                <div className="bg-slate-950/60 rounded-lg border border-cyan-900/50 p-4 space-y-2.5 text-xs shadow-inner">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-slate-300"><Cpu className="w-3.5 h-3.5 text-cyan-400"/> Memory</span>
                    <span className="text-emerald-400 font-bold">{sysTelemetry?.memoryUsage || "12.4 GB"} / {sysTelemetry?.memoryTotal || "16.0 GB"}</span>
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-slate-300"><Activity className="w-3.5 h-3.5 text-cyan-400"/> LLM Router</span>
                    <span style={{ color: engineColor, transition: 'color 0.4s ease', fontWeight: 700, fontSize: 11, letterSpacing: 1 }}>
                      ● {activeEngine.toUpperCase()}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-slate-300"><Wifi className="w-3.5 h-3.5 text-cyan-400"/> ElevenLabs</span>
                    <span className="text-emerald-400 font-bold">Connected</span>
                  </div>

                  <div className="flex items-center justify-between pt-1 border-t border-cyan-900/30">
                    <span className="flex items-center gap-2 text-slate-300"><Smartphone className="w-3.5 h-3.5 text-cyan-400"/> Companion</span>
                    <span className={`font-bold ${sysTelemetry?.phoneConnected ? 'text-emerald-400' : 'text-amber-500'}`}>
                      {sysTelemetry?.phoneConnected ? 'CONNECTED' : 'DISCONNECTED'}
                    </span>
                  </div>

                  {/* Public Tunnel Link */}
                  <div className="pt-2 border-t border-cyan-900/30 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2 text-slate-300"><Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse"/> Public Tunnel</span>
                      <span className={`font-bold text-[11px] ${sysTelemetry?.tunnelUrl ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {sysTelemetry?.tunnelUrl ? 'ONLINE' : 'CONNECTING...'}
                      </span>
                    </div>
                    {sysTelemetry?.tunnelUrl ? (
                      <div className="flex items-center justify-between bg-cyan-950/40 border border-cyan-800/40 rounded px-2.5 py-1.5 gap-2">
                        <span className="text-[11px] text-cyan-200 truncate select-all font-mono" title={sysTelemetry.tunnelUrl}>
                          {sysTelemetry.tunnelUrl}
                        </span>
                        <button
                          onClick={copyTunnelUrl}
                          className="text-cyan-400 hover:text-cyan-200 transition-colors p-1"
                          title="Copy Tunnel URL"
                        >
                          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    ) : (
                      <div className="text-[10px] text-slate-500 italic">Starting localtunnel daemon...</div>
                    )}

                    {/* Local Wi-Fi Direct Link */}
                    {sysTelemetry?.localCompanionUrl && (
                      <div className="pt-1 flex items-center justify-between text-[10px] text-slate-400">
                        <span className="truncate font-mono">Wi-Fi: {sysTelemetry.localCompanionUrl}</span>
                        <button
                          onClick={() => {
                            if (sysTelemetry?.localCompanionUrl) {
                              navigator.clipboard.writeText(sysTelemetry.localCompanionUrl);
                            }
                          }}
                          className="text-cyan-400 hover:text-cyan-200 ml-1 underline cursor-pointer"
                        >
                          Copy
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* Logs */}
              <section className="space-y-3 flex flex-col">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs text-cyan-300/70 uppercase tracking-widest font-bold">Activity & Tunnel Log</h3>
                  <span className="text-[10px] text-slate-500">{logs.length} events</span>
                </div>
                <div className="bg-slate-950/80 rounded-lg border border-cyan-900/50 p-4 h-72 overflow-y-auto font-mono text-xs space-y-2 shadow-inner">
                  {logs.length === 0 ? (
                    <p className="text-cyan-400 animate-pulse">_ Standing by for system & tunnel events...</p>
                  ) : (
                    logs.map((log, i) => {
                      const isTunnel = log.includes('[Tunnel]');
                      const isCompanion = log.includes('[Phone Companion]') || log.includes('[Companion');
                      const isError = log.includes('[Error]');
                      const isSecurity = log.includes('[Security]');
                      const isJarvis = log.includes('Jarvis:');
                      const isUser = log.includes('User:');

                      let colorClass = 'text-slate-300';
                      if (isTunnel) colorClass = 'text-sky-300 font-semibold border-l-2 border-sky-400 pl-2 bg-sky-950/20 py-0.5 rounded-r';
                      else if (isCompanion) colorClass = 'text-emerald-300 font-semibold border-l-2 border-emerald-400 pl-2 bg-emerald-950/20 py-0.5 rounded-r';
                      else if (isError) colorClass = 'text-rose-400 font-semibold';
                      else if (isSecurity) colorClass = 'text-amber-300';
                      else if (isJarvis) colorClass = 'text-cyan-200';
                      else if (isUser) colorClass = 'text-cyan-400/80';

                      return (
                        <p key={i} className={`${colorClass} break-words leading-relaxed`}>
                          {log}
                        </p>
                      );
                    })
                  )}
                  <div ref={logEndRef} />
                </div>
              </section>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
