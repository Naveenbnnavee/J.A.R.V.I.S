import React, { useEffect, useRef } from 'react';
import { Terminal, Folder, File, Code, Cpu } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface DeveloperWorkspaceProps {
  logs: string[];
  files: string[];
  status: string;
  serverLive?: boolean;
  previewUrl?: string;
}

export const DeveloperWorkspace: React.FC<DeveloperWorkspaceProps> = ({ logs, files, status, serverLive, previewUrl }) => {
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <motion.div 
      initial={{ opacity: 0, y: 50, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 50, scale: 0.95 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="absolute inset-0 flex items-center justify-center pointer-events-none p-12"
    >
      <div className="w-full max-w-[90vw] h-[80vh] flex gap-4 pointer-events-auto mt-10">
        
        {/* Left Panel: File Tree & Status */}
        <motion.div 
          animate={{ width: serverLive ? '20%' : '33%' }}
          className="flex flex-col gap-4"
        >
          
          {/* Status Box */}
          <div className="bg-black/40 backdrop-blur-md border border-cyan-500/30 rounded-2xl p-6 shadow-[0_0_30px_rgba(6,182,212,0.15)] flex flex-col items-center justify-center relative overflow-hidden">
            <div className="absolute top-0 w-full h-1 bg-gradient-to-r from-transparent via-cyan-500 to-transparent animate-pulse" />
            <Cpu className="text-cyan-400 mb-3 animate-pulse" size={32} />
            <h2 className="text-cyan-100 font-mono text-lg font-bold tracking-widest uppercase text-center">{status || 'Initializing...'}</h2>
          </div>

          {/* File Tree */}
          <div className="flex-1 bg-black/40 backdrop-blur-md border border-slate-700/50 rounded-2xl p-6 flex flex-col overflow-hidden shadow-2xl">
            <div className="flex items-center gap-2 text-slate-300 mb-4 border-b border-slate-700/50 pb-3">
              <Folder size={18} className="text-amber-400" />
              <span className="font-mono font-bold tracking-wider uppercase text-sm">./workspace</span>
            </div>
            
            <div className="flex-1 overflow-y-auto font-mono text-sm space-y-2 pr-2 custom-scrollbar">
              {files.length === 0 ? (
                <div className="text-slate-500 italic h-full flex flex-col items-center justify-center gap-2">
                  <Code size={24} className="opacity-50" />
                  No files generated yet.
                </div>
              ) : (
                files.map((file, i) => (
                  <motion.div 
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    key={i} 
                    className="flex items-center gap-3 text-cyan-200 bg-cyan-950/20 px-3 py-2 rounded-lg border border-cyan-900/30 break-all"
                  >
                    <File size={14} className="text-cyan-400 shrink-0" />
                    {file}
                  </motion.div>
                ))
              )}
            </div>
          </div>
        </motion.div>

        {/* Middle Panel: Live Preview */}
        <AnimatePresence>
          {serverLive && (
            <motion.div 
              initial={{ width: 0, opacity: 0, scale: 0.9 }}
              animate={{ width: '60%', opacity: 1, scale: 1 }}
              exit={{ width: 0, opacity: 0, scale: 0.9 }}
              className="bg-white rounded-2xl overflow-hidden border border-slate-700/50 shadow-2xl relative"
            >
              <div className="absolute top-0 w-full h-8 bg-slate-900 border-b border-slate-700 flex items-center px-4">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/80"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80"></div>
                </div>
                <div className="ml-4 font-mono text-xs text-slate-400">{previewUrl || 'http://localhost:5173'}</div>
              </div>
              <iframe 
                src={previewUrl || 'http://localhost:5173'} 
                className="w-full h-full pt-8 bg-white"
                sandbox="allow-scripts allow-same-origin allow-forms"
                title="Live Preview"
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Right Panel: Terminal Execution Logs */}
        <motion.div 
          animate={{ width: serverLive ? '20%' : '67%' }}
          className="bg-slate-950/80 backdrop-blur-xl border border-slate-700/50 rounded-2xl flex flex-col overflow-hidden shadow-2xl"
        >
          <div className="bg-slate-900/80 px-4 py-3 border-b border-slate-700/50 flex items-center gap-3">
            <Terminal size={16} className="text-slate-400" />
            <span className="font-mono text-slate-300 text-sm tracking-wider">EXECUTION_LOGS.sh</span>
          </div>
          
          <div ref={terminalRef} className="flex-1 p-6 overflow-y-auto font-mono text-sm custom-scrollbar flex flex-col gap-1">
            {logs.map((log, i) => (
              <div key={i} className="text-slate-300 leading-relaxed break-words">
                <span className="text-slate-600 mr-3 shrink-0">[{String(i).padStart(4, '0')}]</span>
                {log.includes('[Error]') || log.includes('Error:') || log.includes('Failed') || log.includes('DENIED') ? (
                  <span className="text-red-400">{log}</span>
                ) : log.includes('[Agent]') ? (
                  <span className="text-emerald-400">{log.replace('[Agent]', '').trim()}</span>
                ) : (
                  <span>{log}</span>
                )}
              </div>
            ))}
          </div>
        </motion.div>

      </div>
    </motion.div>
  );
};
