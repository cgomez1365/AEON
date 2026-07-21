import React, { useState, useEffect, useCallback } from "react";

// =============================================
//  PACKAGE A: AUTONOMOUS ATS (SMART INTAKE ENGINE)
//  The $20,000 Deliverable Module
//  Intake → AI Grade → Alert Pipeline
// =============================================

const GRADE_COLORS = {
  A: '#00ff40', B: '#00f2ff', C: '#ffea00', D: '#ff8800', F: '#ff4466'
};

const STATUS_BADGES = {
  NEW:      { color: '#00f2ff', bg: 'rgba(0,242,255,0.1)', label: 'NEW' },
  GRADED_A: { color: '#00ff40', bg: 'rgba(0,255,64,0.1)', label: '★ TOP PICK' },
  GRADED:   { color: '#ffea00', bg: 'rgba(255,234,0,0.1)', label: 'GRADED' },
};

// Reusable Modal Wrapper Component
const Modal = ({ children, onClose, title, color = "#00f2ff" }) => (
  <div style={{
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(2, 5, 8, 0.85)', backdropFilter: 'blur(8px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
  }} onClick={onClose}>
    <div style={{
      background: '#0a0f18', border: `1px solid ${color}40`, borderRadius: '12px',
      padding: '24px', maxWidth: '600px', width: '90%', maxHeight: '90vh', overflowY: 'auto',
      boxShadow: `0 0 30px ${color}15`
    }} onClick={e => e.stopPropagation()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3 style={{ margin: 0, color, fontSize: '16px', letterSpacing: '1px' }}>{title}</h3>
        <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: '#64748b', fontSize: '20px', cursor: 'pointer' }}>✕</button>
      </div>
      {children}
    </div>
  </div>
);

export default function ATSPanel() {
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [grading, setGrading] = useState(null); // candidateId being graded
  const [batchGrading, setBatchGrading] = useState(false);
  const [showIntake, setShowIntake] = useState(false);
  const [alertResult, setAlertResult] = useState(null);
  const [selectedCandidate, setSelectedCandidate] = useState(null); // For AI Grade Details Modal

  // Intake form state
  const [form, setForm] = useState({ name: '', email: '', phone: '', role: '', jobDescription: '', resumeBase64: '', resumeFileName: '' });

  const fetchCandidates = useCallback(async () => {
    try {
      const res = await fetch('/api/ats/candidates');
      if (res.ok) { setCandidates(await res.json()); return; }
    } catch {}
    // Supabase fallback for Vercel
    try {
      const sbUrl = import.meta.env.VITE_SUPABASE_URL;
      const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const sbRes = await fetch(`${sbUrl}/rest/v1/aeon_candidates?select=*&order=submitted_at.desc`, { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } });
      if (sbRes.ok) setCandidates(await sbRes.json());
    } catch (e) { console.error('Failed to load candidates', e); }
  }, []);

  useEffect(() => { fetchCandidates(); }, [fetchCandidates]);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.type !== 'application/pdf') return alert('Please upload a PDF file.');
    
    const reader = new FileReader();
    reader.onload = () => {
      // Result is data:application/pdf;base64,...
      const base64 = reader.result.split(',')[1];
      setForm({ ...form, resumeBase64: base64, resumeFileName: file.name });
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async () => {
    if (!form.name || !form.role || !form.jobDescription) return alert('Name, Role, and Job Description are required.');
    if (!form.resumeBase64) return alert('Please upload a PDF Resume.');
    setLoading(true);
    try {
      const res = await fetch('/api/ats/intake', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (res.ok) {
        setForm({ name: '', email: '', phone: '', role: '', jobDescription: '', resumeBase64: '', resumeFileName: '' });
        setShowIntake(false);
        await fetchCandidates();
        setLoading(false);
        return;
      }
    } catch {}
    // Supabase direct insert fallback for Vercel
    try {
      const sbUrl = import.meta.env.VITE_SUPABASE_URL;
      const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      await fetch(`${sbUrl}/rest/v1/aeon_candidates`, {
        method: 'POST',
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          name: form.name, email: form.email || null, phone: form.phone || null,
          role: form.role, job_description: form.jobDescription,
          resume_text: form.resumeBase64 ? `[PDF uploaded: ${form.resumeFileName}]` : '',
          status: 'UNGRADED', grade: null, score: null, submitted_at: new Date().toISOString(),
        }),
      });
      setForm({ name: '', email: '', phone: '', role: '', jobDescription: '', resumeBase64: '', resumeFileName: '' });
      setShowIntake(false);
      await fetchCandidates();
    } catch (e) { alert('Intake failed: ' + e.message); }
    setLoading(false);
  };

  const handleGrade = async (id) => {
    setGrading(id);
    try {
      const res = await fetch('/api/ats/grade', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: id })
      });
      if (res.ok) { await fetchCandidates(); setGrading(null); return; }
    } catch {}
    // Server-side AI proxy fallback
    try {
      const candidate = candidates.find(c => c.id === id);
      if (!candidate) { setGrading(null); return; }
      const aiRes = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: `Grade this job candidate on a scale of 0-100. Return ONLY a JSON object: {"grade":"A/B/C/D/F","score":0-100,"summary":"1 sentence"}\n\nName: ${candidate.name}\nRole: ${candidate.role}\nJob Description: ${candidate.job_description || ''}\nResume: ${(candidate.resume_text || '').slice(0, 2000)}`, role: 'chat' }),
      });
      const ad = await aiRes.json();
      let parsed;
      try { parsed = JSON.parse(ad.text || '{}'); } catch { parsed = { grade: 'C', score: 50, summary: 'Grading unavailable' }; }
      const sbUrl = import.meta.env.VITE_SUPABASE_URL;
      const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      await fetch(`${sbUrl}/rest/v1/aeon_candidates?id=eq.${id}`, {
        method: 'PATCH',
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ grade: parsed.grade, score: parsed.score, status: 'GRADED', grading_summary: parsed.summary }),
      });
      await fetchCandidates();
    } catch (e) { alert('Grading failed: ' + e.message); }
    setGrading(null);
  };

  const handleBatchGrade = async () => {
    setBatchGrading(true);
    try {
      const res = await fetch('/api/ats/grade-all', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      alert(`Batch complete: ${data.graded}/${data.total} candidates graded.`);
      await fetchCandidates();
    } catch (e) { alert('Batch grading failed: ' + e.message); }
    setBatchGrading(false);
  };

  const handleAlert = async (id) => {
    try {
      const res = await fetch('/api/ats/alert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: id })
      });
      const data = await res.json();
      setAlertResult(data.alert);
    } catch (e) { alert('Alert generation failed: ' + e.message); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Remove this candidate?')) return;
    try {
      const res = await fetch(`/api/ats/candidates/${id}`, { method: 'DELETE' });
      if (res.ok) { await fetchCandidates(); return; }
    } catch {}
    try {
      const sbUrl = import.meta.env.VITE_SUPABASE_URL;
      const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      await fetch(`${sbUrl}/rest/v1/aeon_candidates?id=eq.${id}`, { method: 'DELETE', headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } });
    } catch {}
    await fetchCandidates();
  };

  const graded = candidates.filter(c => c.grade);
  const ungraded = candidates.filter(c => !c.grade);
  const topPicks = candidates.filter(c => c.interviewRecommendation === 'RECOMMEND');

  return (
    <div style={{ padding: '24px', color: '#e5e2e1', display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* HEADER */}
      <div style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(0,255,64,0.3)', borderRadius: '12px', padding: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: '0 0 6px 0', color: '#00ff40', fontSize: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span>🎯</span> AUTONOMOUS ATS
            </h2>
            <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', margin: 0 }}>
              Smart Intake Engine — AI-Powered Candidate Grading & Alerts · Package A ($20,000 Deliverable)
            </p>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={handleBatchGrade}
              disabled={batchGrading || ungraded.length === 0}
              style={{
                padding: '10px 18px', background: batchGrading ? 'rgba(0,242,255,0.1)' : 'linear-gradient(135deg, #0077ff, #00f2ff)',
                color: batchGrading ? '#00f2ff' : '#000', fontWeight: 700, border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '12px', letterSpacing: '0.5px'
              }}
            >
              {batchGrading ? '⏳ GRADING ALL...' : `⚡ GRADE ALL (${ungraded.length})`}
            </button>
            <button
              onClick={() => setShowIntake(true)}
              style={{
                padding: '10px 18px', background: 'rgba(0,255,64,0.1)',
                color: '#00ff40', fontWeight: 700, border: `1px solid #00ff40`,
                borderRadius: '8px', cursor: 'pointer', fontSize: '12px'
              }}
            >
              + NEW CANDIDATE
            </button>
          </div>
        </div>
      </div>

      {/* STATS ROW */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
        {[
          { label: 'Total Candidates', value: candidates.length, color: '#00f2ff' },
          { label: 'Ungraded', value: ungraded.length, color: '#ffea00' },
          { label: 'Graded', value: graded.length, color: '#b565d6' },
          { label: 'Top Picks (A)', value: topPicks.length, color: '#00ff40' },
        ].map(s => (
          <div key={s.label} style={{
            background: 'rgba(0,0,0,0.3)', border: `1px solid ${s.color}33`, borderRadius: '10px', padding: '16px', textAlign: 'center'
          }}>
            <div style={{ fontSize: '28px', fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase', marginTop: '4px' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* INTAKE FORM MODAL */}
      {showIntake && (
        <Modal title="📋 CANDIDATE INTAKE" color="#00ff40" onClose={() => setShowIntake(false)}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <input aria-label="Full Name" placeholder="Full Name *" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} />
            <input aria-label="Role Applied For" placeholder="Role Applied For *" value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} style={inputStyle} />
            <input aria-label="Email" placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} style={inputStyle} />
            <input aria-label="Phone" placeholder="Phone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} style={inputStyle} />
          </div>
          
          <div style={{ marginBottom: '12px' }}>
            <textarea
              aria-label="Job Description"
              placeholder="Paste the target Job Description (JD) here... *"
              value={form.jobDescription}
              onChange={e => setForm({ ...form, jobDescription: e.target.value })}
              rows={5}
              style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace', fontSize: '12px' }}
            />
          </div>

          <div style={{ padding: '16px', background: 'rgba(0,0,0,0.5)', border: '1px dashed #00ff40', borderRadius: '8px', textAlign: 'center' }}>
            <label style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '24px' }}>📄</span>
              <span style={{ color: form.resumeFileName ? '#00ff40' : '#ccc', fontWeight: 700, fontSize: '13px' }}>
                {form.resumeFileName ? `✓ ${form.resumeFileName}` : 'UPLOAD PDF RESUME *'}
              </span>
              <input type="file" accept="application/pdf" style={{ display: 'none' }} onChange={handleFileUpload} />
            </label>
          </div>

          <button
            onClick={handleSubmit} disabled={loading}
            style={{
              marginTop: '16px', width: '100%', padding: '14px', background: 'linear-gradient(90deg, #00ff40, #00cc33)',
              color: '#000', fontWeight: 800, border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', letterSpacing: '1px'
            }}
          >
            {loading ? 'SUBMITTING...' : '✓ SUBMIT CANDIDATE'}
          </button>
        </Modal>
      )}

      {/* CANDIDATE TABLE */}
      <div style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '2fr 1.5fr 80px 80px 1.2fr 200px',
          padding: '12px 16px', background: 'rgba(0,0,0,0.5)', fontSize: '10px', fontWeight: 700,
          color: '#64748b', letterSpacing: '1px', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.06)'
        }}>
          <span>Candidate</span><span>Role</span><span>Grade</span><span>Score</span><span>Status</span><span>Actions</span>
        </div>

        {candidates.length === 0 && (
          <div style={{ padding: '40px', textAlign: 'center', color: '#64748b', fontSize: '13px' }}>
            No candidates yet. Click <strong style={{ color: '#00ff40' }}>+ NEW CANDIDATE</strong> to begin the intake pipeline.
          </div>
        )}

        {candidates.map(c => {
          const badge = STATUS_BADGES[c.status] || STATUS_BADGES.NEW;
          return (
            <div key={c.id} style={{
              display: 'grid', gridTemplateColumns: '2fr 1.5fr 80px 80px 1.2fr 200px',
              padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)', alignItems: 'center',
              background: c.interviewRecommendation === 'RECOMMEND' ? 'rgba(0,255,64,0.02)' : 'transparent',
              transition: 'background 0.2s'
            }}>
              {/* Name + Email */}
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>{c.name}</div>
                <div style={{ fontSize: '11px', color: '#64748b' }}>{c.email || 'No email'}</div>
              </div>

              {/* Role */}
              <div style={{ fontSize: '12px', color: '#b0b0b0' }}>{c.role}</div>

              {/* Grade */}
              <div style={{ fontSize: '18px', fontWeight: 800, color: GRADE_COLORS[c.grade] || '#64748b' }}>
                {c.grade || '—'}
              </div>

              {/* Score */}
              <div style={{ fontSize: '14px', fontWeight: 700, color: c.score >= 80 ? '#00ff40' : c.score >= 60 ? '#ffea00' : '#ff4466' }}>
                {c.score != null ? `${c.score}` : '—'}
              </div>

              {/* Status Badge */}
              <div>
                <span style={{
                  display: 'inline-block', padding: '4px 10px', borderRadius: '4px', fontSize: '10px', fontWeight: 700,
                  color: badge.color, background: badge.bg, letterSpacing: '0.5px'
                }}>
                  {badge.label}
                </span>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: '6px' }}>
                {!c.grade && (
                  <button onClick={() => handleGrade(c.id)} disabled={grading === c.id} aria-label={`Grade ${c.name}`} style={actionBtnStyle('#00f2ff')}>
                    {grading === c.id ? '...' : '⚡ Grade'}
                  </button>
                )}
                {c.grade && (
                  <button onClick={() => setSelectedCandidate(c)} aria-label={`View grade details for ${c.name}`} style={actionBtnStyle('#b565d6')}>
                    📖 Details
                  </button>
                )}
                {c.grade && (
                  <button onClick={() => handleAlert(c.id)} aria-label={`Generate hiring alert for ${c.name}`} style={actionBtnStyle('#00ff40')}>📧 Alert</button>
                )}
                <button onClick={() => handleDelete(c.id)} aria-label={`Remove ${c.name}`} style={actionBtnStyle('#ff4466')}>✕</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* AI GRADE DETAILS MODAL */}
      {selectedCandidate && (
        <Modal 
          title={`AI GRADE DOSSIER: ${selectedCandidate.name}`} 
          color={GRADE_COLORS[selectedCandidate.grade] || '#00f2ff'} 
          onClose={() => setSelectedCandidate(null)}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', background: 'rgba(0,0,0,0.3)', padding: '16px', borderRadius: '8px' }}>
            <div>
              <div style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>Applied Role</div>
              <div style={{ fontSize: '16px', color: '#fff', fontWeight: 600 }}>{selectedCandidate.role}</div>
            </div>
            <div style={{
              fontSize: '24px', fontWeight: 900, color: GRADE_COLORS[selectedCandidate.grade],
              background: `${GRADE_COLORS[selectedCandidate.grade]}15`, padding: '6px 16px', borderRadius: '8px'
            }}>
              {selectedCandidate.grade} · {selectedCandidate.score}
            </div>
          </div>
          
          <div style={{ marginBottom: '20px' }}>
            <h4 style={{ color: '#00f2ff', fontSize: '13px', margin: '0 0 8px 0' }}>Rationale</h4>
            <div style={{ fontSize: '13px', color: '#ccc', lineHeight: 1.6, background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '6px' }}>
              {selectedCandidate.gradeRationale}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
            <div>
              <h4 style={{ color: '#00ff40', fontSize: '13px', margin: '0 0 8px 0' }}>✓ Strengths</h4>
              <ul style={{ margin: 0, paddingLeft: '16px', color: '#ccc', fontSize: '12px', lineHeight: 1.5 }}>
                {(selectedCandidate.topStrengths || []).map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
            <div>
              <h4 style={{ color: '#ff4466', fontSize: '13px', margin: '0 0 8px 0' }}>⚠ Red Flags</h4>
              <ul style={{ margin: 0, paddingLeft: '16px', color: '#ccc', fontSize: '12px', lineHeight: 1.5 }}>
                {(selectedCandidate.redFlags || []).length > 0 
                  ? selectedCandidate.redFlags.map((r, i) => <li key={i}>{r}</li>)
                  : <li>None identified.</li>
                }
              </ul>
            </div>
          </div>

          <div style={{
            padding: '12px', borderRadius: '8px', fontSize: '14px', fontWeight: 700, textAlign: 'center',
            color: selectedCandidate.interviewRecommendation === 'RECOMMEND' ? '#00ff40' : selectedCandidate.interviewRecommendation === 'MAYBE' ? '#ffea00' : '#ff4466',
            background: selectedCandidate.interviewRecommendation === 'RECOMMEND' ? 'rgba(0,255,64,0.1)' : selectedCandidate.interviewRecommendation === 'MAYBE' ? 'rgba(255,234,0,0.1)' : 'rgba(255,68,102,0.1)'
          }}>
            {selectedCandidate.interviewRecommendation === 'RECOMMEND' ? '✓ RECOMMEND FOR INTERVIEW' : selectedCandidate.interviewRecommendation === 'MAYBE' ? '? MAYBE — NEEDS REVIEW' : '✕ PASS'}
          </div>
        </Modal>
      )}

      {/* ALERT MODAL */}
      {alertResult && (
        <Modal title="📧 HIRING ALERT DISPATCH" color="#00ff40" onClose={() => setAlertResult(null)}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: '#fff', marginBottom: '12px' }}>
            Subject: {alertResult.subject}
          </div>
          <div style={{
            padding: '16px', background: 'rgba(0,0,0,0.4)', borderRadius: '8px', fontSize: '13px',
            color: '#ccc', whiteSpace: 'pre-wrap', lineHeight: '1.6', borderLeft: '3px solid #00ff40'
          }}>
            {alertResult.body}
          </div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
            <button
              onClick={() => { navigator.clipboard.writeText(`Subject: ${alertResult.subject}\n\n${alertResult.body}`); }}
              style={{ flex: 1, padding: '12px', background: 'rgba(0,242,255,0.1)', border: '1px solid #00f2ff', color: '#00f2ff', fontWeight: 700, borderRadius: '8px', cursor: 'pointer' }}
            >
              📋 Copy to Clipboard
            </button>
            <button
              onClick={() => setAlertResult(null)}
              style={{ flex: 1, padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#888', fontWeight: 700, borderRadius: '8px', cursor: 'pointer' }}
            >
              Close
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const inputStyle = {
  padding: '10px 12px', background: 'rgba(0,0,0,0.5)', color: '#fff',
  border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', fontSize: '13px'
  // No `outline: none` — keep the browser's default focus ring for keyboard nav (WCAG 2.4.7).
};

const actionBtnStyle = (color) => ({
  padding: '6px 12px', background: `${color}10`, border: `1px solid ${color}40`,
  color, fontWeight: 700, borderRadius: '4px', cursor: 'pointer', fontSize: '11px',
  display: 'flex', alignItems: 'center', justifyContent: 'center'
});
