import { motion } from 'framer-motion';

export type ReactorState = 'idle' | 'listening' | 'speaking';

interface ArcReactorProps {
  volume?: number; // 0 to 255 from AnalyserNode
  state?: ReactorState;
}

export const ArcReactor = ({ volume = 0, state = 'idle' }: ArcReactorProps) => {
  // Normalize volume to a 0-100 scale roughly
  const normalizedVolume = Math.min(100, (volume / 255) * 100);
  
  // Scale based on audio level (0-100) -> mapping to 1-1.5
  const dynamicScale = state === 'idle' ? 1 : 1 + (normalizedVolume / 100) * 0.5;
  const glowIntensity = state === 'idle' ? 20 : 20 + (normalizedVolume / 100) * 60; // mapping to blur radius

  // Determine Colors based on state
  // Cyan for listening, Gold for speaking
  const coreColor = state === 'speaking' ? 'bg-amber-400' : 'bg-cyan-400';
  const shadowColor = state === 'speaking' ? 'rgba(251, 191, 36, 0.6)' : 'rgba(34, 211, 238, 0.6)';
  const ringColor = state === 'speaking' ? 'border-amber-400/30' : 'border-cyan-400/30';
  const middleRingColor = state === 'speaking' ? 'border-amber-300/20' : 'border-cyan-300/20';
  const innerDetailColor = state === 'speaking' ? 'border-amber-200' : 'border-cyan-200';
  const innerCoreColor = state === 'speaking' ? 'bg-amber-100' : 'bg-cyan-100';

  return (
    <div className="flex items-center justify-center w-80 h-80 relative group">
      {/* Outer Ring */}
      <motion.div 
        className={`absolute w-full h-full rounded-full border-4 ${ringColor} border-dashed transition-colors duration-500`}
        animate={{ rotate: 360 }}
        transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
      />
      
      {/* Middle Ring */}
      <motion.div 
        className={`absolute w-64 h-64 rounded-full border-2 ${middleRingColor} transition-colors duration-500`}
        animate={{ rotate: -360 }}
        transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
      />
      
      {/* Inner Glowing Core */}
      <motion.div
        className={`absolute w-40 h-40 rounded-full ${coreColor} mix-blend-screen transition-colors duration-500`}
        animate={{ scale: dynamicScale }}
        style={{
          boxShadow: `0 0 ${glowIntensity}px ${glowIntensity / 2}px ${shadowColor}, inset 0 0 ${glowIntensity}px rgba(255, 255, 255, 0.8)`,
        }}
        transition={{ type: "spring", stiffness: 300, damping: 15 }}
      />

      {/* Core Center */}
      <div className="absolute w-24 h-24 rounded-full bg-white shadow-[0_0_30px_rgba(255,255,255,1)] flex items-center justify-center">
         {/* Inner detail */}
         <div className={`w-16 h-16 rounded-full border-2 ${innerDetailColor} opacity-50 flex items-center justify-center transition-colors duration-500`}>
            <div className={`w-8 h-8 ${innerCoreColor} rounded-full shadow-inner blur-[1px] transition-colors duration-500`}></div>
         </div>
      </div>
    </div>
  );
};
