import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './aurora.css'


class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error("[AEON] Root crash:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: "100dvh", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          background: "#131313", color: "#ff7f50", fontFamily: "monospace",
          padding: "24px", textAlign: "center", gap: "16px"
        }}>
          <div style={{ fontSize: "32px" }}>⚠️</div>
          <div style={{ fontSize: "18px", fontWeight: 700 }}>AEON Runtime Error</div>
          <div style={{
            background: "rgba(255,127,80,0.1)", border: "1px solid rgba(255,127,80,0.3)",
            borderRadius: "8px", padding: "16px", maxWidth: "600px",
            fontSize: "13px", color: "#ffb4ab", textAlign: "left", wordBreak: "break-word"
          }}>
            {this.state.error?.message || "Unknown error"}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: "10px 24px", background: "#00f2ff", color: "#002022",
              border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: 600
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
