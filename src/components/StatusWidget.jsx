import React, { useState, useEffect } from 'react';
import { Activity, Server, Database } from 'lucide-react';

const StatusWidget = () => {
  const [metrics, setMetrics] = useState({ uptime: '0h 0m', memory: '0MB', latency: '0ms' });

  useEffect(() => {
    const updateMetrics = () => {
      // Simulate real-time metrics
      const uptimeSecs = Math.floor(performance.now() / 1000);
      const h = Math.floor(uptimeSecs / 3600);
      const m = Math.floor((uptimeSecs % 3600) / 60);
      const s = uptimeSecs % 60;
      
      setMetrics({
        uptime: `${h}h ${m}m ${s}s`,
        memory: `${(performance.memory?.usedJSHeapSize / 1048576).toFixed(1)} MB`,
        latency: `${Math.floor(Math.random() * 20 + 5)}ms`
      });
    };

    const interval = setInterval(updateMetrics, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ marginTop: '20px', padding: '15px', backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: '8px', border: '1px solid rgba(0,242,255,0.1)' }}>
      <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 'bold', marginBottom: '10px', letterSpacing: '1px' }}>SYSTEM METRICS</div>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: '#94a3b8' }}>
            <Server size={12} /> Uptime
          </div>
          <span style={{ fontSize: '11px', color: '#00f2ff', fontFamily: 'monospace' }}>{metrics.uptime}</span>
        </div>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: '#94a3b8' }}>
            <Database size={12} /> Memory
          </div>
          <span style={{ fontSize: '11px', color: '#00f2ff', fontFamily: 'monospace' }}>{metrics.memory}</span>
        </div>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: '#94a3b8' }}>
            <Activity size={12} /> Latency
          </div>
          <span style={{ fontSize: '11px', color: '#00ff40', fontFamily: 'monospace' }}>{metrics.latency}</span>
        </div>
      </div>
    </div>
  );
};

export default StatusWidget;
