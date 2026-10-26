import { useRef, useCallback, useState } from 'react';

export const useAudioPlayback = () => {
  const audioContextRef = useRef<AudioContext | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [playbackVolume, setPlaybackVolume] = useState(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Queue to handle streaming gapless audio
  const audioQueue = useRef<AudioBuffer[]>([]);
  const nextPlayTime = useRef<number>(0);
  const isPlayingRef = useRef<boolean>(false);
  const playbackSessionId = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const updateVolume = useCallback(() => {
    if (analyserRef.current) {
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteFrequencyData(dataArray);
      
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length;
      setPlaybackVolume(average);
    }
    animationFrameRef.current = requestAnimationFrame(updateVolume);
  }, []);

  const initContext = () => {
    if (!audioContextRef.current) {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContext();
      audioContextRef.current = ctx;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
      updateVolume();
    }
  };

  const playQueue = useCallback(() => {
    const ctx = audioContextRef.current;
    if (!ctx || audioQueue.current.length === 0) {
      setIsSpeaking(false);
      isPlayingRef.current = false;
      return;
    }

    setIsSpeaking(true);
    isPlayingRef.current = true;

    // Ensure nextPlayTime is not in the past
    if (nextPlayTime.current < ctx.currentTime) {
      nextPlayTime.current = ctx.currentTime + 0.05; // Small buffer
    }

    const buffer = audioQueue.current.shift();
    if (!buffer) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(analyserRef.current!);
    
    source.start(nextPlayTime.current);
    nextPlayTime.current += buffer.duration;
    
    activeSourcesRef.current.push(source);

    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
      if (audioQueue.current.length > 0) {
        playQueue();
      } else {
        isPlayingRef.current = false;
        // Delay UI state only for visual smoothness
        setTimeout(() => {
            if (!isPlayingRef.current) {
                setIsSpeaking(false);
            }
        }, 500);
      }
    };
  }, []);

  const queueAudioChunk = useCallback(async (base64Audio: string, format?: string) => {
    const currentSession = playbackSessionId.current;
    initContext();
    const ctx = audioContextRef.current!;

    // Convert base64 to ArrayBuffer
    const binaryString = window.atob(base64Audio);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    try {
      let audioBuffer: AudioBuffer;
      if (format === 'pcm_16000') {
        const int16 = new Int16Array(bytes.buffer);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 32768.0;
        }
        audioBuffer = ctx.createBuffer(1, float32.length, 16000);
        audioBuffer.getChannelData(0).set(float32);
      } else {
        audioBuffer = await ctx.decodeAudioData(bytes.buffer);
      }
      
      if (currentSession !== playbackSessionId.current) {
        return; // Stale chunk from before an interruption, drop it
      }
      
      audioQueue.current.push(audioBuffer);

      if (!isPlayingRef.current) {
        playQueue();
      }
    } catch (err) {
      console.error("Failed to decode audio chunk", err);
    }
  }, [playQueue]);

  const stopPlayback = useCallback(() => {
    playbackSessionId.current += 1;
    audioQueue.current = [];
    isPlayingRef.current = false;
    setIsSpeaking(false);
    
    // Stop all currently playing sources to immediately halt audio
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    activeSourcesRef.current = [];
    
    if (audioContextRef.current) {
        nextPlayTime.current = audioContextRef.current.currentTime;
    }
  }, []);

  const setSpeakingState = useCallback((state: boolean) => {
    setIsSpeaking(state);
  }, []);

  return { isSpeaking, playbackVolume, queueAudioChunk, stopPlayback, setSpeakingState };
};
