import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, Delete, Hash, Send } from 'lucide-react';

type VerifyMethod = 'select' | 'pin' | 'telegram_sent';

interface PinModalProps {
  sessionKey: string | null;
  score: string;
  hasTelegram: boolean; // whether server has Telegram configured
  onSubmit: (pin: string, sessionKey: string) => void;
  onRequestTelegram: (sessionKey: string) => void;
  onDismiss: () => void;
}

export const PinModal: React.FC<PinModalProps> = ({
  sessionKey, score, hasTelegram, onSubmit, onRequestTelegram, onDismiss
}) => {
  const [pin, setPin] = useState('');
  const [method, setMethod] = useState<VerifyMethod>('select');
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset every time a new challenge arrives
  useEffect(() => {
    if (sessionKey) {
      setPin('');
      setMethod('select');
    }
  }, [sessionKey]);

  // Focus after switching to PIN view
  useEffect(() => {
    if (method === 'pin') {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [method]);

  const handleDigit = (d: string) => {
    if (pin.length < 4) setPin(prev => prev + d);
  };
  const handleBackspace = () => setPin(prev => prev.slice(0, -1));
  const handleSubmit = () => {
    if (!sessionKey || pin.length < 4) return;
    onSubmit(pin, sessionKey);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!sessionKey) return;
      if (e.key === 'Escape') { onDismiss(); return; }
      if (method !== 'pin') return;
      if (e.key >= '0' && e.key <= '9') handleDigit(e.key);
      else if (e.key === 'Backspace') handleBackspace();
      else if (e.key === 'Enter') handleSubmit();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sessionKey, pin, method]);

  // Auto-submit on 4 digits
  useEffect(() => {
    if (pin.length === 4) handleSubmit();
  }, [pin]);

  const handleTelegram = () => {
    if (!sessionKey) return;
    onRequestTelegram(sessionKey);
    setMethod('telegram_sent');
  };

  /* ─── Shared Header ─────────────────────────────── */
  const Header = () => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{
        width: 52, height: 52, borderRadius: '50%',
        background: 'rgba(239, 68, 68, 0.15)',
        border: '1px solid rgba(239, 68, 68, 0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}>
        <ShieldAlert size={24} color="#ef4444" />
      </div>
      <p style={{ color: '#ef4444', fontWeight: 700, fontSize: 15, margin: 0, fontFamily: 'monospace' }}>
        VOICE UNRECOGNIZED
      </p>
      <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11, margin: 0, fontFamily: 'monospace' }}>
        Score: {score} &nbsp;|&nbsp; Required: 0.65
      </p>
    </div>
  );

  /* ─── Screen: Method Selection ───────────────────── */
  const SelectScreen = () => (
    <motion.div key="select" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, textAlign: 'center', margin: 0, fontFamily: 'monospace' }}>
        Select verification method
      </p>

      {/* PIN option */}
      <motion.button
        whileHover={{ scale: 1.03, borderColor: 'rgba(59,130,246,0.7)', background: 'rgba(59,130,246,0.12)' }}
        whileTap={{ scale: 0.97 }}
        onClick={() => setMethod('pin')}
        style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '14px 18px', borderRadius: 14,
          border: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(255,255,255,0.04)',
          cursor: 'pointer', color: 'white', textAlign: 'left',
        }}
      >
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
        }}>
          <Hash size={18} color="#3b82f6" />
        </div>
        <div>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 14, fontFamily: 'monospace' }}>Master PIN</p>
          <p style={{ margin: 0, fontSize: 11, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>Enter your 4-digit PIN on this device</p>
        </div>
      </motion.button>

      {/* Telegram option */}
      <motion.button
        whileHover={hasTelegram ? { scale: 1.03, borderColor: 'rgba(45,212,191,0.7)', background: 'rgba(45,212,191,0.12)' } : {}}
        whileTap={hasTelegram ? { scale: 0.97 } : {}}
        onClick={hasTelegram ? handleTelegram : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '14px 18px', borderRadius: 14,
          border: '1px solid rgba(255,255,255,0.12)',
          background: hasTelegram ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.1)',
          cursor: hasTelegram ? 'pointer' : 'not-allowed', color: 'white', textAlign: 'left',
          opacity: hasTelegram ? 1 : 0.4,
        }}
      >
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'rgba(45,212,191,0.15)', border: '1px solid rgba(45,212,191,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
        }}>
          <Send size={18} color="#2dd4bf" />
        </div>
        <div>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 14, fontFamily: 'monospace' }}>
            Telegram Alert {!hasTelegram && <span style={{ color: '#6b7280', fontSize: 10 }}>(not configured)</span>}
          </p>
          <p style={{ margin: 0, fontSize: 11, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>Send approval request to your phone</p>
        </div>
      </motion.button>

      <p style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10, margin: 0, fontFamily: 'monospace', textAlign: 'center' }}>
        ESC to cancel · session expires in 3 min
      </p>
    </motion.div>
  );

  /* ─── Screen: PIN Pad ────────────────────────────── */
  const PinScreen = () => (
    <motion.div key="pin" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, width: '100%' }}>

      {/* Back */}
      <button onClick={() => { setPin(''); setMethod('select'); }}
        style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', padding: 0 }}>
        ← Back
      </button>

      {/* PIN dots */}
      <div style={{ display: 'flex', gap: 14 }}>
        {[0, 1, 2, 3].map(i => (
          <motion.div key={i}
            animate={{
              backgroundColor: i < pin.length ? '#3b82f6' : 'rgba(255,255,255,0.1)',
              scale: i < pin.length ? 1.2 : 1,
              boxShadow: i < pin.length ? '0 0 12px rgba(59,130,246,0.6)' : 'none'
            }}
            transition={{ type: 'spring', stiffness: 400 }}
            style={{ width: 16, height: 16, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.2)' }}
          />
        ))}
      </div>

      {/* Numpad */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, width: '100%' }}>
        {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((key, idx) => (
          <motion.button key={idx}
            whileHover={{ scale: key ? 1.05 : 1, background: key ? 'rgba(59,130,246,0.2)' : 'transparent' }}
            whileTap={{ scale: key ? 0.92 : 1 }}
            onClick={() => { if (key === '⌫') handleBackspace(); else if (key) handleDigit(key); }}
            style={{
              height: 56, borderRadius: 12,
              border: key ? '1px solid rgba(255,255,255,0.1)' : 'none',
              background: key ? 'rgba(255,255,255,0.05)' : 'transparent',
              color: key === '⌫' ? '#ef4444' : 'white',
              fontSize: 22, fontWeight: 600, fontFamily: 'monospace',
              cursor: key ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {key === '⌫' ? <Delete size={18} color="#ef4444" /> : key}
          </motion.button>
        ))}
      </div>
      <p style={{ color: 'rgba(255,255,255,0.25)', fontSize: 11, margin: 0, fontFamily: 'monospace' }}>
        Enter MASTER PIN · ESC to cancel
      </p>
    </motion.div>
  );

  /* ─── Screen: Telegram Sent ─────────────────────── */
  const TelegramSentScreen = () => (
    <motion.div key="telegram" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center' }}>
      <motion.div animate={{ y: [0, -6, 0] }} transition={{ repeat: Infinity, duration: 2 }}
        style={{
          width: 56, height: 56, borderRadius: '50%',
          background: 'rgba(45,212,191,0.15)', border: '1px solid rgba(45,212,191,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
        <Send size={26} color="#2dd4bf" />
      </motion.div>
      <p style={{ color: '#2dd4bf', fontWeight: 700, fontSize: 14, margin: 0, fontFamily: 'monospace' }}>Alert Sent to Telegram</p>
      <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, margin: 0, fontFamily: 'monospace', lineHeight: 1.6 }}>
        Check your Telegram bot for an alert.<br />
        Approve from your phone to authorize.
      </p>
      <button onClick={() => setMethod('pin')}
        style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace' }}>
        Enter PIN instead
      </button>
    </motion.div>
  );

  /* ─── Root Render ─────────────────────────────────── */
  return (
    <AnimatePresence>
      {sessionKey && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.80)', backdropFilter: 'blur(8px)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <motion.div
            initial={{ scale: 0.85, y: 40, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.85, y: 40, opacity: 0 }}
            transition={{ type: 'spring', damping: 20, stiffness: 200 }}
            style={{
              background: 'linear-gradient(135deg, #0f1117 0%, #1a1f2e 100%)',
              border: '1px solid rgba(239,68,68,0.35)',
              borderRadius: 20,
              padding: '32px 28px',
              width: 340,
              boxShadow: '0 0 60px rgba(239,68,68,0.12), 0 20px 60px rgba(0,0,0,0.6)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 22,
            }}
          >
            <Header />
            <AnimatePresence mode="wait">
              {method === 'select'       && <SelectScreen />}
              {method === 'pin'          && <PinScreen />}
              {method === 'telegram_sent'&& <TelegramSentScreen />}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
