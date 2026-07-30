import React, { useState } from "react";

// =============================================
//  RESUME GRADER
//  Paste your resume + a job description -> instant, compliance-first fit score.
//  Stateless: nothing is stored. (Legacy candidate-pipeline API endpoints remain
//  mounted but are no longer used by this UI.)
// =============================================

const GRADE_COLORS = { A: '#00ff40', B: '#00f2ff', C: '#ffea00', D: '#ff8800', F: '#ff4466' };
const REC_COLORS = { RECOMMEND: '#00ff40', MAYBE: '#ffea00', PASS: '#ff4466' };
const SUBSCORE_MAX = { skills: 40, experience: 30, seniority: 15, requirements: 15 };
const SUBSCORE_LABEL = { skills: 'Skills match', experience: 'Relevant experience', seniority: 'Seniority fit', requirements: 'Role requirements' };

const card = { background: 'rgba(12,16,26,0.6)', border: '1px solid rgba(0,242,255,0.14)', borderRadius: '12px', padding: '18px' };
const textareaStyle = {
  width: '100%', minHeight: '160px', resize: 'vertical', background: 'rgba(2,5,8,0.6)',
  border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '12px',
  color: '#e5e2e1', fontSize: '13px', fontFamily: 'inherit', lineHeight: 1.5, outline: 'none',
};

export default function ResumeGrader() {
  const [resume, setResume] = useState('');
  const [jd, setJd] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const grade = async () => {
    if (!resume.trim()) { setError('Paste your resume first.'); return; }
    setLoading(true); setError(''); setResult(null);
    try {
      const res = await fetch('/api/resume-grader/grade', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resume, jobDescription: jd }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Grading failed');
      setResult(data.result);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', padding: '20px', color: '#e5e2e1' }}>
      {/* Header */}
      <div style={{ ...card, marginBottom: '16px' }}>
        <h2 style={{ margin: 0, color: '#00f2ff', fontSize: '20px', letterSpacing: '1px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span aria-hidden="true">🎯</span> RESUME GRADER
        </h2>
        <p style={{ margin: '6px 0 0', color: 'rgba(229,226,225,0.6)', fontSize: '13px' }}>
          Paste your resume and the job posting — get an instant, compliance-first fit score (EEOC-safe: judged on skills &amp; experience only). Nothing is stored.
        </p>
      </div>

      {/* Inputs */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
        <div>
          <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '1px', color: 'rgba(0,242,255,0.7)', marginBottom: '6px' }}>YOUR RESUME</label>
          <textarea style={textareaStyle} value={resume} onChange={e => setResume(e.target.value)} placeholder="Paste your full resume text here…" />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '1px', color: 'rgba(0,242,255,0.7)', marginBottom: '6px' }}>JOB DESCRIPTION <span style={{ color: 'rgba(229,226,225,0.35)', fontWeight: 400 }}>(optional)</span></label>
          <textarea style={textareaStyle} value={jd} onChange={e => setJd(e.target.value)} placeholder="Paste the job posting you're targeting…" />
        </div>
      </div>

      <button
        onClick={grade} disabled={loading}
        style={{
          width: '100%', padding: '14px', borderRadius: '8px', cursor: loading ? 'wait' : 'pointer',
          background: loading ? 'rgba(0,242,255,0.15)' : 'rgba(0,242,255,0.12)',
          border: '1px solid rgba(0,242,255,0.35)', color: '#00f2ff', fontSize: '14px', fontWeight: 700,
          letterSpacing: '1px', transition: 'all 0.2s',
        }}>
        {loading ? 'GRADING…' : 'GRADE MY RESUME'}
      </button>

      {error && <div style={{ marginTop: '14px', padding: '12px', borderRadius: '8px', background: 'rgba(255,68,102,0.1)', border: '1px solid rgba(255,68,102,0.3)', color: '#ff4466', fontSize: '13px' }}>{error}</div>}

      {/* Result */}
      {result && (
        <div style={{ ...card, marginTop: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', marginBottom: '18px', flexWrap: 'wrap' }}>
            <div style={{
              width: '72px', height: '72px', borderRadius: '14px', display: 'grid', placeItems: 'center',
              fontSize: '40px', fontWeight: 800, color: GRADE_COLORS[result.grade] || '#00f2ff',
              background: `${GRADE_COLORS[result.grade] || '#00f2ff'}14`, border: `1px solid ${GRADE_COLORS[result.grade] || '#00f2ff'}55`,
            }}>{result.grade}</div>
            <div>
              <div style={{ fontSize: '28px', fontWeight: 800 }}>{result.score}<span style={{ fontSize: '16px', color: 'rgba(229,226,225,0.5)' }}>/100</span></div>
              {result.interviewRecommendation && (
                <div style={{ marginTop: '4px', display: 'inline-block', padding: '3px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 700, letterSpacing: '1px',
                  color: REC_COLORS[result.interviewRecommendation] || '#00f2ff', background: `${REC_COLORS[result.interviewRecommendation] || '#00f2ff'}18` }}>
                  {result.interviewRecommendation}
                </div>
              )}
            </div>
          </div>

          {/* Subscores */}
          {result.subscores && (
            <div style={{ marginBottom: '16px' }}>
              {Object.keys(SUBSCORE_MAX).map(k => {
                const val = Number(result.subscores[k]) || 0;
                const pct = Math.round((val / SUBSCORE_MAX[k]) * 100);
                return (
                  <div key={k} style={{ marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'rgba(229,226,225,0.6)', marginBottom: '3px' }}>
                      <span>{SUBSCORE_LABEL[k]}</span><span>{val}/{SUBSCORE_MAX[k]}</span>
                    </div>
                    <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: '#00f2ff', boxShadow: '0 0 8px rgba(0,242,255,0.5)' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {result.rationale && <p style={{ fontSize: '13px', lineHeight: 1.6, color: 'rgba(229,226,225,0.85)', marginBottom: '16px' }}>{result.rationale}</p>}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div>
              <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '1px', color: '#00ff40', marginBottom: '8px' }}>TOP STRENGTHS</div>
              {(result.topStrengths || []).length ? (result.topStrengths || []).map((s, i) => (
                <div key={i} style={{ fontSize: '12px', color: 'rgba(229,226,225,0.8)', marginBottom: '5px' }}>✓ {s}</div>
              )) : <div style={{ fontSize: '12px', color: 'rgba(229,226,225,0.4)' }}>—</div>}
            </div>
            <div>
              <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '1px', color: '#ff8800', marginBottom: '8px' }}>GAPS TO ADDRESS</div>
              {(result.redFlags || []).length ? (result.redFlags || []).map((s, i) => (
                <div key={i} style={{ fontSize: '12px', color: 'rgba(229,226,225,0.8)', marginBottom: '5px' }}>△ {s}</div>
              )) : <div style={{ fontSize: '12px', color: 'rgba(229,226,225,0.4)' }}>—</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
