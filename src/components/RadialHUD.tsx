import React, { useEffect, useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { ArcReactor, ReactorState } from './ArcReactor';
import { Database, Globe, MessageCircle, Activity, DollarSign, TerminalSquare } from 'lucide-react';

export type NodeStatus = 'idle' | 'active' | 'error';

export interface AgentNode {
  id: string;
  label: string;
  icon: React.ReactNode;
  angle: number; // Angle in degrees on the radial map
  status: NodeStatus;
}

interface RadialHUDProps {
  reactorState: ReactorState;
  reactorVolume: number;
  activeNodes: Record<string, NodeStatus>; // map of node id -> status
  memoryUsage: string;
  llmTier: string;
  latency: string;
  coreTemp: string;
  isServerLive?: boolean;
  isPhoneConnected?: boolean;
}

const DEFAULT_NODES: AgentNode[] = [
  { id: 'developer', label: 'Developer', icon: <TerminalSquare size={20} />, angle: 0, status: 'idle' },
  { id: 'archivist', label: 'Archivist', icon: <Database size={20} />, angle: 60, status: 'idle' },
  { id: 'web_search', label: 'Web Search', icon: <Globe size={20} />, angle: 120, status: 'idle' },
  { id: 'whatsapp', label: 'WhatsApp', icon: <MessageCircle size={20} />, angle: 180, status: 'idle' },
  { id: 'system_health', label: 'Sys Health', icon: <Activity size={20} />, angle: 240, status: 'idle' },
  { id: 'finance', label: 'Finance', icon: <DollarSign size={20} />, angle: 300, status: 'idle' }
];

export const RadialHUD: React.FC<RadialHUDProps> = ({ 
  reactorState, reactorVolume, activeNodes, memoryUsage, llmTier, latency, coreTemp, isPhoneConnected = false
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<AgentNode[]>(DEFAULT_NODES);

  useEffect(() => {
    setNodes(prev => prev.map(n => ({
      ...n,
      status: activeNodes[n.id] || 'idle'
    })));
  }, [activeNodes]);

  const radius = 250; // Distance of nodes from center

  const getNodeColor = (status: NodeStatus) => {
    switch(status) {
      case 'active': return 'text-amber-400 border-amber-400 shadow-[0_0_15px_rgba(251,191,36,0.6)] bg-amber-400/10';
      case 'error': return 'text-red-500 border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.6)] bg-red-500/10';
      case 'idle':
      default: return 'text-cyan-400 border-cyan-400/50 shadow-[0_0_10px_rgba(34,211,238,0.3)] bg-cyan-900/20';
    }
  };

  const getLineColor = (status: NodeStatus) => {
    switch(status) {
      case 'active': return 'stroke-amber-400 opacity-80';
      case 'error': return 'stroke-red-500 opacity-80';
      case 'idle':
      default: return 'stroke-cyan-500/30';
    }
  };

  return (
    <div className="relative w-full h-full flex items-center justify-center bg-transparent overflow-hidden font-mono" ref={containerRef}>
      
      {/* Dynamic Grid Background */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:40px_40px]"></div>
      <div className="absolute inset-0 bg-[radial-gradient(circle_800px_at_50%_50%,transparent_0%,rgba(3,7,18,0.5)_100%)]"></div>

      {/* Telemetry Panel Left */}
      <div className="absolute left-8 top-8 flex flex-col gap-4 text-xs text-cyan-500 z-10">
        <div className="p-3 border border-cyan-900 bg-cyan-950/20 rounded backdrop-blur-sm w-48">
          <div className="text-[10px] uppercase tracking-widest text-cyan-700 mb-1">SYS MEMORY</div>
          <div className="text-xl text-cyan-300 font-bold tracking-wider">{memoryUsage}</div>
        </div>
        <div className="p-3 border border-cyan-900 bg-cyan-950/20 rounded backdrop-blur-sm w-48">
          <div className="text-[10px] uppercase tracking-widest text-cyan-700 mb-1">ROUTER STATUS</div>
          <div className="text-sm text-amber-400 font-bold uppercase tracking-wider">{llmTier}</div>
        </div>
      </div>

      {/* Telemetry Panel Right */}
      <div className="absolute right-8 top-8 flex flex-col gap-4 text-xs text-cyan-500 z-10">
        <div className="p-3 border border-cyan-900 bg-cyan-950/20 rounded backdrop-blur-sm text-right w-48">
          <div className="text-[10px] uppercase tracking-widest text-cyan-700 mb-1">NETWORK STATUS</div>
          <div className="text-xl text-cyan-300 font-bold tracking-wider">{latency}</div>
        </div>
        <div className="p-3 border border-cyan-900 bg-cyan-950/20 rounded backdrop-blur-sm text-right w-48">
          <div className="text-[10px] uppercase tracking-widest text-cyan-700 mb-1">CORE TEMP</div>
          <div className="text-sm text-cyan-300 font-bold uppercase tracking-wider">{coreTemp}</div>
        </div>
        <div className="p-3 border border-cyan-900 bg-cyan-950/20 rounded backdrop-blur-sm text-right w-48">
          <div className="text-[10px] uppercase tracking-widest text-cyan-700 mb-1">PHONE COMPANION</div>
          <div className={`text-sm font-bold uppercase tracking-wider ${isPhoneConnected ? 'text-cyan-300' : 'text-amber-500'}`}>
            {isPhoneConnected ? 'CONNECTED' : 'DISCONNECTED'}
          </div>
        </div>
      </div>

      {/* Connection Lines (SVG) */}
      <svg className="absolute w-[800px] h-[800px] pointer-events-none" viewBox="0 0 800 800">
        <defs>
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>
        {nodes.map(node => {
          const cx = 400;
          const cy = 400;
          const rad = (node.angle * Math.PI) / 180;
          // Target slightly inside the node div
          const targetX = cx + (radius - 40) * Math.cos(rad);
          const targetY = cy + (radius - 40) * Math.sin(rad);

          return (
            <motion.line
              key={`line-${node.id}`}
              x1={cx}
              y1={cy}
              x2={targetX}
              y2={targetY}
              className={`${getLineColor(node.status)} stroke-2 transition-colors duration-500`}
              filter={node.status !== 'idle' ? 'url(#glow)' : ''}
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 1.5, ease: 'easeInOut' }}
            />
          );
        })}
      </svg>

      {/* Orbiting Nodes */}
      {nodes.map(node => {
        const rad = (node.angle * Math.PI) / 180;
        const x = Math.cos(rad) * radius;
        const y = Math.sin(rad) * radius;

        return (
          <motion.div
            key={node.id}
            className={`absolute flex flex-col items-center justify-center p-3 rounded-full border-2 ${getNodeColor(node.status)} backdrop-blur-md transition-all duration-500`}
            style={{ x, y, width: '80px', height: '80px' }}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ 
              scale: node.status === 'active' ? 1.15 : 1, 
              opacity: 1,
            }}
          >
            {node.status === 'active' && (
              <motion.div 
                className="absolute inset-0 rounded-full border-2 border-amber-400"
                animate={{ scale: [1, 1.3, 1], opacity: [0.8, 0, 0.8] }}
                transition={{ duration: 1.5, repeat: Infinity }}
              />
            )}
            {node.icon}
            <span className="absolute -bottom-6 text-[10px] tracking-widest whitespace-nowrap opacity-80 uppercase">
              {node.label}
            </span>
          </motion.div>
        );
      })}

      {/* Central Arc Reactor */}
      <div className="z-10 flex flex-col items-center gap-8">
        <ArcReactor volume={reactorVolume} state={reactorState} />
        
        {/* Audio Waveform Viz */}
        <div className="flex items-end justify-center h-12 gap-1 w-64">
          {[...Array(32)].map((_, i) => {
            // Pseudo-random static height for idle, active reactive for speaking/listening
            const h = reactorState !== 'idle' ? Math.max(10, Math.random() * (reactorVolume / 255 * 100)) : 4;
            const bg = reactorState === 'speaking' ? 'bg-amber-400' : 'bg-cyan-500';
            return (
              <motion.div
                key={i}
                className={`w-1 rounded-t-sm ${bg} opacity-70`}
                animate={{ height: `${h}%` }}
                transition={{ duration: 0.1 }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};
