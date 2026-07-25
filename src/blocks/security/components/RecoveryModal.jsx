import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Eye, EyeOff, X } from 'lucide-react';
import ModalPortal from '../../../components/ModalPortal.jsx';
import './RecoveryModal.css';

const formatSeconds = (milliseconds) => Math.max(0, Math.ceil(milliseconds / 1000));

export default function RecoveryModal({
  open,
  initialUsername = '',
  onClose,
  onRecovered,
  onEmergencyLogin,
}) {
  const [username, setUsername] = useState(initialUsername);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [release, setRelease] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [clock, setClock] = useState(Date.now());

  const request = async (url, body) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Recovery request failed.');
    return result;
  };

  const loadQuestions = async (identity = username) => {
    if (!identity.trim()) return setMessage('Enter your username.');
    setBusy(true);
    setMessage('');
    try {
      const result = await request('/api/security/recovery/challenge', { username: identity.trim() });
      setUsername(identity.trim());
      setQuestions(result.questions || []);
      setAnswers({});
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setUsername(initialUsername);
    setQuestions([]);
    setAnswers({});
    setRelease(null);
    setPassword('');
    setConfirm('');
    setMessage('');
    setShowPassphrase(false);
    setCopied(false);
    if (initialUsername.trim()) loadQuestions(initialUsername);
  }, [open, initialUsername]);

  useEffect(() => {
    if (!release) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [release]);

  const allAnswered = questions.length === 3 && questions.every(question => String(answers[question.questionId] || '').trim());
  const strength = useMemo(() => [
    password.length >= 8,
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
  ].filter(Boolean).length, [password]);

  const verifyAnswers = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const result = await request('/api/security/recovery/verify', {
        username,
        answers: questions.map(question => ({
          questionId: question.questionId,
          answer: answers[question.questionId],
        })),
      });
      setRelease(result);
      setClock(Date.now());
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async (event) => {
    event.preventDefault();
    if (password !== confirm) return setMessage('Passwords do not match.');
    setBusy(true);
    setMessage('');
    try {
      const result = await request('/api/security/recovery/reset', {
        recoveryToken: release.recoveryToken,
        newPassword: password,
      });
      onRecovered(result.token);
    } catch (error) {
      setMessage(error.message);
      setBusy(false);
    }
  };

  const copyPassphrase = async () => {
    await navigator.clipboard.writeText(release.temporaryPassphrase);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const useEmergencyPassphrase = async () => {
    setBusy(true);
    setMessage('');
    try {
      await onEmergencyLogin(release.username, release.temporaryPassphrase);
    } catch (error) {
      setMessage(error.message);
      setBusy(false);
    }
  };

  if (!open) return null;

  const tokenSeconds = release ? formatSeconds(release.expiresAt - clock) : 0;
  const emergencySeconds = release ? formatSeconds(release.emergencyExpiresAt - clock) : 0;

  return (
    <ModalPortal ariaLabel="Break-glass password recovery" onEscape={onClose}>
      <div className="recovery-overlay">
        <section className="recovery-panel" aria-labelledby="recovery-title">
          <button type="button" className="recovery-icon-button recovery-close" aria-label="Close recovery" title="Close" onClick={onClose}>
            <X aria-hidden="true" size={20} />
          </button>
          <img className="recovery-mark" src="/brand/aeon-mark/aeon-icon-64.png" width="48" height="48" alt="" />
          <h1 id="recovery-title">Break-glass recovery</h1>

          {!release && questions.length === 0 && (
            <form onSubmit={(event) => { event.preventDefault(); loadQuestions(); }}>
              <p>Confirm the local operator account to retrieve its three Vault recovery questions.</p>
              <label htmlFor="recovery-username">Username</label>
              <input id="recovery-username" autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)} />
              <button className="recovery-primary" type="submit" disabled={busy || !username.trim()}>
                {busy ? 'Loading...' : 'Continue'}
              </button>
            </form>
          )}

          {!release && questions.length === 3 && (
            <form onSubmit={verifyAnswers}>
              <p>All three answers must match. Five failed attempts lock recovery for 15 minutes.</p>
              {questions.map((question, index) => (
                <label key={question.questionId} htmlFor={`recovery-answer-${question.questionId}`}>
                  <span>{index + 1}. {question.text}</span>
                  <input
                    id={`recovery-answer-${question.questionId}`}
                    autoComplete="off"
                    required
                    value={answers[question.questionId] || ''}
                    onChange={event => setAnswers(current => ({ ...current, [question.questionId]: event.target.value }))}
                  />
                </label>
              ))}
              <button className="recovery-primary" type="submit" disabled={busy || !allAnswered}>
                {busy ? 'Verifying...' : 'Verify all answers'}
              </button>
            </form>
          )}

          {release && (
            <div>
              <p className="recovery-success">Identity verified. Choose one recovery action.</p>
              <label htmlFor="recovery-stored-username">Stored username</label>
              <input id="recovery-stored-username" readOnly value={release.username} />

              <section className="recovery-action" aria-labelledby="reset-password-title">
                <h2 id="reset-password-title">Reset password</h2>
                <p role="timer" aria-live="polite">Authorization expires in {tokenSeconds}s.</p>
                <form onSubmit={resetPassword}>
                  <label htmlFor="recovery-new-password">New password</label>
                  <input id="recovery-new-password" type="password" autoComplete="new-password" required value={password} onChange={event => setPassword(event.target.value)} />
                  <label htmlFor="recovery-confirm-password">Confirm new password</label>
                  <input id="recovery-confirm-password" type="password" autoComplete="new-password" required value={confirm} onChange={event => setConfirm(event.target.value)} />
                  <button className="recovery-primary" type="submit" disabled={busy || strength < 4 || password !== confirm || tokenSeconds === 0}>
                    Reset password and enter AEON
                  </button>
                </form>
              </section>

              <section className="recovery-action" aria-labelledby="emergency-title">
                <h2 id="emergency-title">Temporary emergency passphrase</h2>
                <p role="timer" aria-live="polite">Single use. Expires in {emergencySeconds}s.</p>
                <div className="recovery-secret-row">
                  <code aria-label={showPassphrase ? 'Temporary passphrase visible' : 'Temporary passphrase masked'}>
                    {showPassphrase ? release.temporaryPassphrase : 'AEON-XXXX-XXXX-XXXX-XXXX'}
                  </code>
                  <button type="button" className="recovery-icon-button" aria-label={showPassphrase ? 'Hide passphrase' : 'Show passphrase'} title={showPassphrase ? 'Hide' : 'Show'} onClick={() => setShowPassphrase(current => !current)}>
                    {showPassphrase ? <EyeOff aria-hidden="true" size={18} /> : <Eye aria-hidden="true" size={18} />}
                  </button>
                  <button type="button" className="recovery-icon-button" aria-label="Copy temporary passphrase" title="Copy" onClick={copyPassphrase}>
                    {copied ? <Check aria-hidden="true" size={18} /> : <Copy aria-hidden="true" size={18} />}
                  </button>
                </div>
                <button type="button" className="recovery-secondary" disabled={busy || emergencySeconds === 0} onClick={useEmergencyPassphrase}>
                  Enter with temporary passphrase
                </button>
              </section>
            </div>
          )}

          <div className="recovery-message" aria-live="polite" role={message ? 'alert' : 'status'}>{message}</div>
        </section>
      </div>
    </ModalPortal>
  );
}
