import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, VolumeX, Volume2, Bot, User, Loader2, Square } from 'lucide-react';
import { getJarvisSocket } from '../services/socket';
import ReactMarkdown from 'react-markdown';

export interface Message {
  id: string;
  role: 'user' | 'jarvis';
  text: string;
  streaming?: boolean;
}

interface ChatConsoleProps {
  isSilent: boolean;
  onSilentToggle: () => void;
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}

export function ChatConsole({ isSilent, onSilentToggle, messages, setMessages }: ChatConsoleProps) {
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamingIdRef = useRef<string | null>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Listen for chat_chunk / chat_end events from the WebSocket
  useEffect(() => {
    const socket = getJarvisSocket();
    if (!socket) return;

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'chat_chunk' && streamingIdRef.current) {
          const targetId = streamingIdRef.current;
          setMessages(prev =>
            prev.map(m =>
              m.id === targetId
                ? { ...m, text: m.text + data.text, streaming: true }
                : m
            )
          );
        }

        if (data.type === 'llm_response' && streamingIdRef.current) {
          const targetId = streamingIdRef.current;
          setMessages(prev =>
            prev.map(m =>
              m.id === targetId
                ? { ...m, text: m.text + (m.text ? '\n\n' : '') + data.text, streaming: true }
                : m
            )
          );
        }

        if (data.type === 'chat_end' && streamingIdRef.current) {
          const targetId = streamingIdRef.current;
          setMessages(prev =>
            prev.map(m =>
              m.id === targetId ? { ...m, streaming: false } : m
            )
          );
          streamingIdRef.current = null;
          setIsStreaming(false);
        }

        if (data.type === 'phone_alert' && data.payload) {
          const alertId = `jarvis-alert-${Date.now()}`;
          const pkg = data.payload.package || 'System';
          const text = data.payload.text || '';
          const alertText = `🔔 **New Notification from ${pkg}**\n\n${text}`;
          setMessages(prev => [
            ...prev,
            { id: alertId, role: 'jarvis', text: alertText }
          ]);
        }
      } catch (_) {}
    };

    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, []);

  const sendMessage = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const socket = getJarvisSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    // Add user bubble
    const userId = `user-${Date.now()}`;
    setMessages(prev => [...prev, { id: userId, role: 'user', text: trimmed }]);
    setInput('');

    // Add empty Jarvis streaming bubble
    const jarvisId = `jarvis-${Date.now()}`;
    streamingIdRef.current = jarvisId;
    setIsStreaming(true);
    setMessages(prev => [
      ...prev,
      { id: jarvisId, role: 'jarvis', text: '', streaming: true }
    ]);

    // Send to backend
    socket.send(JSON.stringify({
      type: 'chat_message',
      prompt: trimmed,
      silent: isSilent
    }));
  }, [input, isStreaming, isSilent]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const stopGeneration = useCallback(() => {
    setIsStreaming(false);
    
    if (streamingIdRef.current) {
      const targetId = streamingIdRef.current;
      setMessages(prev =>
        prev.map(m =>
          m.id === targetId ? { ...m, streaming: false } : m
        )
      );
      streamingIdRef.current = null;
    }

    const socket = getJarvisSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'stop_generation' }));
    }
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

  return (
    <div
      className="flex flex-col w-full h-full"
      style={{
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(20px)',
        borderRadius: '20px',
        border: '1px solid rgba(6,182,212,0.2)',
        boxShadow: '0 0 60px rgba(6,182,212,0.08)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid rgba(6,182,212,0.15)',
          background: 'rgba(6,182,212,0.04)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Bot size={18} color="#22d3ee" />
          <span style={{ fontFamily: 'monospace', color: '#22d3ee', fontWeight: 700, letterSpacing: 2, fontSize: 13 }}>
            JARVIS // TEXT CONSOLE
          </span>
        </div>

        {/* Silent Mode Toggle */}
        <button
          onClick={onSilentToggle}
          title={isSilent ? 'Silent Mode ON' : 'Silent Mode OFF'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 14px',
            borderRadius: 99,
            border: `1px solid ${isSilent ? 'rgba(239,68,68,0.5)' : 'rgba(6,182,212,0.4)'}`,
            background: isSilent ? 'rgba(239,68,68,0.08)' : 'rgba(6,182,212,0.08)',
            color: isSilent ? '#f87171' : '#22d3ee',
            fontFamily: 'monospace',
            fontSize: 11,
            cursor: 'pointer',
            transition: 'all 0.3s',
          }}
        >
          {isSilent ? <VolumeX size={13} /> : <Volume2 size={13} />}
          {isSilent ? 'SILENT ON' : 'SILENT OFF'}
        </button>
      </div>

      {/* Message Feed */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px 20px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(6,182,212,0.2) transparent',
        }}
      >
        {messages.map(msg => (
          <div
            key={msg.id}
            style={{
              display: 'flex',
              gap: 10,
              flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
            }}
          >
            {/* Avatar */}
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                background: msg.role === 'jarvis' ? 'rgba(6,182,212,0.15)' : 'rgba(99,102,241,0.15)',
                border: `1px solid ${msg.role === 'jarvis' ? 'rgba(6,182,212,0.3)' : 'rgba(99,102,241,0.3)'}`,
              }}
            >
              {msg.role === 'jarvis'
                ? <Bot size={14} color="#22d3ee" />
                : <User size={14} color="#818cf8" />}
            </div>

            {/* Bubble */}
            <div
              style={{
                maxWidth: '78%',
                padding: '10px 14px',
                borderRadius: msg.role === 'user' ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
                background: msg.role === 'jarvis'
                  ? 'rgba(6,182,212,0.06)'
                  : 'rgba(99,102,241,0.1)',
                border: `1px solid ${msg.role === 'jarvis' ? 'rgba(6,182,212,0.15)' : 'rgba(99,102,241,0.2)'}`,
                color: '#e2e8f0',
                fontFamily: 'monospace',
                fontSize: 13,
                lineHeight: 1.6,
                wordBreak: 'break-word',
              }}
            >
              {msg.role === 'jarvis' ? (
                <>
                  {msg.text ? (
                    <div className="prose prose-invert prose-sm max-w-none">
                      <ReactMarkdown>{msg.text}</ReactMarkdown>
                    </div>
                  ) : null}
                  {msg.streaming && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#22d3ee', marginTop: 4 }}>
                      <Loader2 size={12} className="animate-spin" />
                      <span style={{ fontSize: 11, opacity: 0.7 }}>computing...</span>
                    </span>
                  )}
                </>
              ) : (
                <span>{msg.text}</span>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input Bar */}
      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid rgba(6,182,212,0.15)',
          background: 'rgba(6,182,212,0.03)',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-end',
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your query... (Enter to send, Shift+Enter for new line)"
          rows={1}
          style={{
            flex: 1,
            background: 'rgba(0,0,0,0.4)',
            border: '1px solid rgba(6,182,212,0.25)',
            borderRadius: 12,
            padding: '10px 14px',
            color: '#e2e8f0',
            fontFamily: 'monospace',
            fontSize: 13,
            resize: 'none',
            outline: 'none',
            lineHeight: 1.5,
            minHeight: 40,
          }}
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button
            onClick={stopGeneration}
            title="Stop Generation"
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              border: '1px solid rgba(239,68,68,0.5)',
              background: 'rgba(239,68,68,0.15)',
              color: '#ef4444',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.2s',
              flexShrink: 0,
            }}
          >
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={sendMessage}
            disabled={!input.trim()}
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              border: '1px solid rgba(6,182,212,0.4)',
              background: input.trim() ? 'rgba(6,182,212,0.15)' : 'rgba(0,0,0,0.2)',
              color: input.trim() ? '#22d3ee' : '#374151',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: input.trim() ? 'pointer' : 'not-allowed',
              transition: 'all 0.2s',
              flexShrink: 0,
            }}
          >
            <Send size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
