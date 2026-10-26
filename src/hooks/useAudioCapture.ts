import { useState, useRef, useCallback, useEffect } from 'react';
import { getJarvisSocket } from '../services/socket';

export const useAudioCapture = (onAudioChunk: (chunk: Blob) => void) => {
  const [isRecording, setIsRecording] = useState(false);
  const [micVolume, setMicVolume] = useState(0);
  
  const vadRef = useRef<any>(null);
  const isIntentionalStopRef = useRef(false);

  const stopRecording = useCallback(() => {
    isIntentionalStopRef.current = true;
    if (vadRef.current) {
      try {
        if (typeof vadRef.current.destroy === 'function') {
          vadRef.current.destroy();
        } else {
          vadRef.current.pause();
        }
      } catch (e) {
        console.error("Error stopping VAD", e);
      }
      vadRef.current = null;
    }
    setIsRecording(false);
    setMicVolume(0);
  }, []);

  const startRecording = useCallback(async () => {
    try {
      isIntentionalStopRef.current = false;
      
      const myvad = await (window as any).vad.MicVAD.new({
        positiveSpeechThreshold: 0.8, // Require higher confidence to start
        minSpeechFrames: 5,           // Must be speech for ~150ms
        preSpeechPadFrames: 5,        // Keep 150ms before speech
        redemptionFrames: 30,         // Wait 900ms of silence before ending (prevents cutting off naturally spoken pauses)
        onSpeechStart: () => {
          if (isIntentionalStopRef.current) return;
          setMicVolume(100); // Visual indicator
        },
        onSpeechEnd: (audio: Float32Array) => {
          if (isIntentionalStopRef.current) return;
          setMicVolume(0);
          const socket = getJarvisSocket();
          if (socket && socket.readyState === WebSocket.OPEN) {
            const wavBuffer = (window as any).vad.utils.encodeWAV(audio);
            const blob = new Blob([wavBuffer], { type: 'audio/wav' });
            onAudioChunk(blob);
          }
        },
        onVADMisfire: () => {
          if (isIntentionalStopRef.current) return;
          setMicVolume(0);
        }
      });
      
      myvad.start();
      
      vadRef.current = myvad;
      setIsRecording(true);
    } catch (err) {
      console.error("Failed to start VAD capture", err);
    }
  }, [onAudioChunk]);

  // Clean up on unmount
  useEffect(() => {
    return () => stopRecording();
  }, [stopRecording]);

  return { isRecording, micVolume, startRecording, stopRecording };
};
