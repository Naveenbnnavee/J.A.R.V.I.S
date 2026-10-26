import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff } from 'lucide-react';

export interface VoiceExchange {
  id: string;
  role: 'user' | 'jarvis';
  text: string;
  streaming?: boolean;
}

interface VoiceUIProps {
  isRecording: boolean;
  isSpeaking: boolean;
  isAwake: boolean;
  isConnected: boolean;
  activeEngine: string;
  exchanges: VoiceExchange[];
  onToggleMic: () => void;
}


function AudioWave({ active, color, bars = 26 }: { active: boolean; color: string; bars?: number }) {
  return (
    <div className="flex items-center justify-center gap-[3px]" style={{ height: 36 }}>
      {Array.from({ length: bars }).map((_, i) => {
        const baseH = 4 + Math.sin((i / bars) * Math.PI) * 20;
        return (
          <motion.div
            key={i}
            style={{ backgroundColor: color, width: 3, borderRadius: 9999, minHeight: 3 }}
            animate={active ? {
              height: [baseH, baseH * (0.3 + Math.random() * 0.9), baseH],
            } : { height: 3 }}
            transition={active ? {
              duration: 0.45 + Math.random() * 0.35,
              repeat: Infinity,
              delay: (i / bars) * 0.4,
              ease: 'easeInOut',
            } : { duration: 0.3 }}
          />
        );
      })}
    </div>
  );
}

export const VoiceUI: React.FC<VoiceUIProps> = ({
  isRecording, isSpeaking, isAwake, exchanges, onToggleMic
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [waveKey, setWaveKey] = useState(0);

  useEffect(() => {
    setWaveKey(k => k + 1);
  }, [isSpeaking, isAwake]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [exchanges]);

  const waveActive = isSpeaking || isAwake;
  const waveColor = isSpeaking ? '#fbbf24' : '#a78bfa';

  const lastJarvis = [...exchanges].reverse().find(e => e.role === 'jarvis');
  const lastUser = [...exchanges].reverse().find(e => e.role === 'user');
  const history = exchanges.slice(0, -2);

  return (
    <div className="absolute inset-0 w-full h-full flex flex-col items-center justify-between py-24 px-8 font-mono select-none overflow-hidden">

      {/* Top Status Bar removed to avoid duplication with RadialHUD */}

      {/* ── Centre: Live Transcript ── */}
      <div className="flex-1 w-full max-w-2xl flex flex-col items-center justify-center gap-6 z-10">

        <AnimatePresence mode="wait">
          {lastUser && (
            <motion.div
              key={lastUser.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.4 }}
              className="text-center px-4"
            >
              <div style={{ color: 'rgba(148,163,184,0.45)', fontSize: 10, letterSpacing: 3, marginBottom: 6 }}>
                YOU SAID
              </div>
              <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.7 }}>
                "{lastUser.text}"
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Waveform */}
        <div className="py-1">
          <AudioWave key={waveKey} active={waveActive} color={waveColor} bars={28} />
        </div>

        {/* Jarvis Response Spotlight */}
        <AnimatePresence mode="wait">
          {lastJarvis && (
            <motion.div
              key={lastJarvis.id + String(lastJarvis.streaming)}
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              className="text-center max-w-xl w-full px-8 py-6 rounded-2xl relative"
              style={{
                background: 'rgba(251,191,36,0.04)',
                border: '1px solid rgba(251,191,36,0.14)',
                boxShadow: '0 0 50px rgba(251,191,36,0.05)',
              }}
            >
              {lastJarvis.streaming && (
                <motion.div
                  className="absolute top-0 left-0 h-0.5 bg-amber-400 rounded-full"
                  style={{ originX: 0 }}
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: 3, ease: 'linear', repeat: Infinity }}
                />
              )}
              <div style={{ color: 'rgba(251,191,36,0.45)', fontSize: 10, letterSpacing: 4, marginBottom: 10 }}>
                JARVIS
              </div>
              <p style={{ color: '#fef3c7', fontSize: 17, lineHeight: 1.8, fontWeight: 300, letterSpacing: 0.3 }}>
                {lastJarvis.text}
                {lastJarvis.streaming && (
                  <motion.span
                    animate={{ opacity: [1, 0] }}
                    transition={{ duration: 0.55, repeat: Infinity }}
                    style={{ color: '#fbbf24', marginLeft: 2 }}
                  >▋</motion.span>
                )}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

      </div>

      {/* ── Fade-out history ── */}
      {history.length > 0 && (
        <div
          ref={scrollRef}
          className="absolute w-full max-w-lg max-h-28 overflow-y-auto px-6"
          style={{
            bottom: 108,
            left: '50%',
            transform: 'translateX(-50%)',
            maskImage: 'linear-gradient(to top, black 55%, transparent)',
            scrollbarWidth: 'none',
          }}
        >
          {history.map(ex => (
            <div key={ex.id} className="flex gap-3 mb-2" style={{ opacity: 0.3 }}>
              <span style={{
                color: ex.role === 'jarvis' ? '#fbbf24' : '#94a3b8',
                fontSize: 9, letterSpacing: 2, minWidth: 40, paddingTop: 2,
              }}>
                {ex.role === 'jarvis' ? 'JRVS' : 'YOU'}
              </span>
              <p style={{ color: '#94a3b8', fontSize: 11, lineHeight: 1.5 }}>{ex.text}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Bottom Controls ── */}
      <div className="flex items-center justify-center gap-8 z-10 w-full relative">
        <div style={{ width: 60 }} /> {/* Spacer to perfectly center the mic button */}

        {/* Main Mic Button */}
        <motion.button
          onClick={onToggleMic}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.92 }}
          className="relative flex items-center justify-center rounded-full"
          style={{
            width: 76, height: 76,
            background: isRecording
              ? 'radial-gradient(circle, rgba(139,92,246,0.22) 0%, rgba(0,0,0,0.4) 100%)'
              : 'radial-gradient(circle, rgba(34,211,238,0.08) 0%, rgba(0,0,0,0.4) 100%)',
            border: isRecording ? '2px solid rgba(139,92,246,0.75)' : '2px solid rgba(34,211,238,0.25)',
            boxShadow: isRecording
              ? '0 0 35px rgba(139,92,246,0.35), inset 0 0 20px rgba(139,92,246,0.08)'
              : '0 0 15px rgba(34,211,238,0.08)',
          }}
        >
          {isRecording && (
            <>
              <motion.div
                className="absolute inset-0 rounded-full border border-violet-400"
                animate={{ scale: [1, 1.4, 1], opacity: [0.7, 0, 0.7] }}
                transition={{ duration: 1.6, repeat: Infinity }}
              />
              <motion.div
                className="absolute inset-0 rounded-full border border-violet-300"
                animate={{ scale: [1, 1.7, 1], opacity: [0.4, 0, 0.4] }}
                transition={{ duration: 1.6, repeat: Infinity, delay: 0.4 }}
              />
            </>
          )}
          {isRecording
            ? <Mic size={30} style={{ color: '#a78bfa' }} />
            : <MicOff size={30} style={{ color: '#22d3ee' }} />
          }
        </motion.button>

        <div style={{ color: 'rgba(148,163,184,0.35)', fontSize: 10, letterSpacing: 2, width: 60 }}>
          {isRecording ? 'TAP\nTO STOP' : 'TAP\nTO START'}
        </div>
      </div>
    </div>
  );
};
