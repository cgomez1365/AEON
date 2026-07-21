import React, { createContext, useContext, useState, useEffect } from 'react';

const TelemetryContext = createContext();

export function useTelemetry() {
  return useContext(TelemetryContext);
}

export function TelemetryProvider({ children }) {
  const [apiUsage, setApiUsage] = useState({
    totalRequests: 0,
    totalTokens: 0,
    staffUsage: {
      qwen: { requests: 0, tokens: 0 },
      zenith: { requests: 0, tokens: 0 },
      groq: { requests: 0, tokens: 0 },
      gemini: { requests: 0, tokens: 0 },
      gemini_lite: { requests: 0, tokens: 0 },
      gemma4: { requests: 0, tokens: 0 },
      flash_live: { requests: 0, tokens: 0 },
      imagen4: { requests: 0, tokens: 0 },
      embedding: { requests: 0, tokens: 0 },
      grounding: { requests: 0, tokens: 0 },
      tiny: { requests: 0, tokens: 0 },
      phi: { requests: 0, tokens: 0 }
    }
  });

  const [telemetryError, setTelemetryError] = useState(false);
  const [lastFetched, setLastFetched] = useState(null);

  // Fetch telemetry — try live endpoint first, fall back to legacy, then Supabase
  useEffect(() => {
    const fetchTelemetry = async () => {
      // Try live LLM telemetry (tracks every gemini/groq/ollama call in real-time)
      try {
        const res = await fetch('/api/llm-telemetry');
        if (res.ok) {
          const live = await res.json();
          if (live.totalCalls > 0) {
            const staffUsage = {};
            (live.models || []).forEach(m => {
              const key = m.engine === 'groq' ? 'groq' : m.engine === 'ollama' ? 'zenith' : 'gemini';
              if (!staffUsage[key]) staffUsage[key] = { requests: 0, tokens: 0 };
              staffUsage[key].requests += m.requests;
              staffUsage[key].tokens += m.tokens;
            });
            setApiUsage(prev => ({
              ...prev,
              totalRequests: live.totalCalls,
              totalTokens: live.totalTokens,
              totalCost: live.totalTokens * 0.00000015,
              staffUsage: { ...prev.staffUsage, ...staffUsage },
            }));
            setTelemetryError(false);
            setLastFetched(Date.now());
            return;
          }
        }
      } catch {}

      // Fallback: legacy /api/telemetry
      try {
        const res = await fetch('/api/telemetry');
        if (res.ok) {
          const data = await res.json();
          setApiUsage(prev => ({
            ...prev,
            totalRequests: data.totalRequests,
            totalTokens: data.totalTokens,
            totalCost: data.totalCost || 0,
            staffUsage: { ...prev.staffUsage, ...data.staffUsage }
          }));
          setTelemetryError(false);
          setLastFetched(Date.now());
          return;
        }
      } catch {}

      setTelemetryError(true);
    };
    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 10000);
    return () => clearInterval(interval);
  }, []);

  const trackApiCall = (staffId, tokensUsed = 150) => {
    setApiUsage(prev => {
      const current = prev.staffUsage[staffId] || { requests: 0, tokens: 0 };
      return {
        ...prev,
        totalRequests: prev.totalRequests + 1,
        totalTokens: prev.totalTokens + tokensUsed,
        staffUsage: {
          ...prev.staffUsage,
          [staffId]: {
            requests: current.requests + 1,
            tokens: current.tokens + tokensUsed
          }
        }
      };
    });
  };

  const recordApiUsage = (tokens) => trackApiCall('gemini', tokens);

  return (
    <TelemetryContext.Provider value={{ apiUsage, trackApiCall, recordApiUsage, telemetryError, lastFetched }}>
      {children}
    </TelemetryContext.Provider>
  );
}
