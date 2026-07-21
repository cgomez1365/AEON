/**
 * Dynamically loads html2pdf.js from CDN if not already loaded,
 * then converts an HTML string into a downloadable PDF.
 * 
 * @param {string} htmlContent - The HTML string to convert
 * @param {string} filename - The output filename (without .pdf)
 * @param {object} options - Optional html2pdf options override
 */
export async function exportToPDF(rawContent, filename = 'AEON_Report', options = {}) {
  if (!window.html2pdf) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.2/html2pdf.bundle.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  const dateStr = new Date().toLocaleString();
  
  // Apply Premium AEON Base Template
  const htmlContent = `
    <div style="font-family: 'Inter', sans-serif; color: #111; background: #fff; line-height: 1.6; padding: 0.5in;">
      <!-- Header / Letterhead -->
      <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #000; padding-bottom: 20px; margin-bottom: 40px;">
        <div>
          <h1 style="margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -1px; text-transform: uppercase;">AEON</h1>
          <p style="margin: 4px 0 0; font-size: 10px; font-weight: 600; color: #555; letter-spacing: 2px;">ADVANCED SYSTEMS COMMAND</p>
        </div>
        <div style="text-align: right; font-size: 10px; color: #555;">
          <p style="margin: 0;"><strong>REF:</strong> ${filename.toUpperCase()}</p>
          <p style="margin: 4px 0 0;"><strong>GENERATED:</strong> ${dateStr}</p>
          <p style="margin: 4px 0 0; color: #d32f2f; font-weight: bold;">[ CONFIDENTIAL / INTERNAL ONLY ]</p>
        </div>
      </div>

      <!-- Main Content Block -->
      <div style="min-height: 7in;">
        ${rawContent}
      </div>

      <!-- Footer -->
      <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #ccc; font-size: 9px; color: #888; text-align: center; font-family: monospace;">
        <p style="margin: 0;">AEON OPERATIONS DIRECTORATE ?" UNAUTHORIZED DISTRIBUTION STRICTLY PROHIBITED</p>
        <p style="margin: 4px 0 0;">SYSTEM ID: ASO-992 // TERMINAL: NODE-PRIME</p>
      </div>
    </div>
  `;

  // Render off-screen but fully visible to html2canvas
  const container = document.createElement('div');
  container.innerHTML = htmlContent;
  container.style.cssText = 'position:fixed;top:0;left:0;width:8.5in;background:#ffffff;z-index:99999;opacity:0;pointer-events:none;';
  document.body.appendChild(container);

  const defaultOptions = {
    margin: [0, 0, 0, 0],
    filename: `${filename}.pdf`,
    image: { type: 'jpeg', quality: 1.0 },
    html2canvas: { scale: 2, useCORS: true, logging: false, letterRendering: true, windowWidth: 816 },
    jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
    ...options
  };

  try {
    // A small delay to ensure web fonts render
    await document.fonts.ready;
    await new Promise(r => setTimeout(r, 500));
    await window.html2pdf().set(defaultOptions).from(container).save();
  } finally {
    document.body.removeChild(container);
  }
}

/**
 * Generates an HTML report taking inspiration from the BGI Telemetry aesthetic.
 */
export function generateClientReportHTML(client) {
  const invoices = client.invoices || [];
  const totalInvoiced = invoices.reduce((s, i) => s + Number(i.amount || 0), 0);
  const paidInvoices = invoices.filter(i => i.status === 'paid');
  const totalPaid = paidInvoices.reduce((s, i) => s + Number(i.amount || 0), 0);
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;600;700&family=Inter:wght@400;600;800&display=swap');
      .bgi-page {
        width: 8.5in;
        height: 11in;
        box-sizing: border-box;
        padding: 0.8in;
        background-color: #FFFFFF;
        background-image: 
          linear-gradient(rgba(15, 23, 42, 0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(15, 23, 42, 0.03) 1px, transparent 1px);
        background-size: 20px 20px;
        font-family: 'Inter', sans-serif;
        color: #0F172A;
        position: relative;
        page-break-after: always;
      }
      .bgi-header-band {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        border-bottom: 1px solid #E2E8F0;
        padding-bottom: 16px;
        margin-bottom: 40px;
      }
      .bgi-mono {
        font-family: 'Geist Mono', monospace;
      }
      .bgi-accent {
        color: #FF5E00;
      }
      .bgi-accent-border {
        border-color: #FF5E00;
      }
      .bgi-label {
        font-size: 10px;
        letter-spacing: 0.2em;
        color: #64748B;
        text-transform: uppercase;
      }
      .bgi-title {
        font-size: 36px;
        font-weight: 800;
        letter-spacing: -1px;
        text-transform: uppercase;
        margin: 0;
      }
      .bgi-section-title {
        font-size: 14px;
        font-weight: 800;
        color: #64748B;
        letter-spacing: 1px;
        text-transform: uppercase;
        border-bottom: 1px solid #E2E8F0;
        padding-bottom: 4px;
        margin: 0 0 15px 0;
      }
      .bgi-card {
        background: #F8FAFC;
        border: 1px solid #E2E8F0;
        padding: 16px;
        border-radius: 4px;
      }
      .bgi-table th {
        background: #F1F5F9;
        padding: 8px 12px;
        text-align: left;
        font-weight: 600;
        border-bottom: 2px solid #CBD5E1;
      }
      .bgi-table td {
        padding: 10px 12px;
        border-bottom: 1px solid #E2E8F0;
      }
      .bgi-footer {
        position: absolute;
        bottom: 0.8in;
        left: 0.8in;
        right: 0.8in;
        display: flex;
        justify-content: space-between;
        border-top: 1px solid #E2E8F0;
        padding-top: 12px;
      }
    </style>

    <div class="bgi-page">
      <div class="bgi-header-band">
        <div class="bgi-mono bgi-label">SYSTEM RE-ENGINEERING ROADMAP // BLUEPRINT</div>
        <div style="text-align: right;">
          <div class="bgi-mono" style="font-size:9px;color:#64748B;letter-spacing:1px;">DOC_REF_CODE</div>
          <div class="bgi-mono bgi-accent" style="font-size:12px;font-weight:700;">AEON-OP-2026</div>
        </div>
      </div>

      <div style="display:flex;align-items:center;margin-bottom:40px;">
        <div style="width:64px;height:64px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;display:flex;align-items:center;justify-content:center;margin-right:20px;">
          <svg width="40" height="40" viewBox="0 0 100 100" fill="none" class="bgi-accent">
            <circle cx="50" cy="50" r="18" stroke="currentColor" stroke-width="6" />
            <path d="M50 12 L50 24 M50 76 L50 88 M12 50 L24 50 M76 50 L88 50" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>
          </svg>
        </div>
        <div>
          <div class="bgi-mono bgi-label" style="font-weight:700;color:#64748B;">BROKEN GEAR INDUSTRIES // AEON COMMAND</div>
          <div class="bgi-mono" style="font-size:16px;font-weight:800;text-transform:uppercase;">
            CRISTIAN GOMEZ <span class="bgi-accent">//</span> CHIEF EXECUTIVE OFFICER
          </div>
        </div>
      </div>

      <div style="border-left:4px solid #FF5E00;padding-left:24px;margin-bottom:40px;">
        <h2 class="bgi-title">${client.name}</h2>
        <p style="color:#64748B;font-size:14px;margin:8px 0 0 0;">An executive-level operational strategy proposing systematic software implementation to drop administrative friction.</p>
      </div>

      <h3 class="bgi-section-title"><span class="bgi-accent">//</span> 01_TARGET_TELEMETRY</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:40px;">
        <div class="bgi-card" style="border-left:4px solid #FF5E00;">
          <div class="bgi-mono bgi-label" style="margin-bottom:8px;">Pipeline Engine</div>
          <div style="margin-bottom:4px;font-size:14px;"><strong>Stage:</strong> <span class="bgi-accent" style="font-weight:700;">${client.stage || 'N/A'}</span></div>
          <div style="margin-bottom:4px;font-size:14px;"><strong>Scale:</strong> ${client.scale || 'N/A'}</div>
          <div style="font-size:14px;"><strong>MRR Target:</strong> <span style="color:#059669;font-weight:800;">$${Number(client.emrr || 0).toLocaleString()}/mo</span></div>
        </div>
        <div class="bgi-card" style="border-left:4px solid #0F172A;">
          <div class="bgi-mono bgi-label" style="margin-bottom:8px;">Command Contact</div>
          <div style="margin-bottom:4px;font-weight:700;font-size:16px;">${client.contact?.name || 'N/A'}</div>
          <div style="margin-bottom:4px;font-size:13px;color:#475569;">${client.contact?.email || 'N/A'}</div>
          <div style="font-size:13px;color:#475569;">${client.contact?.phone || 'N/A'}</div>
        </div>
      </div>

      <h3 class="bgi-section-title"><span class="bgi-accent">//</span> 02_STRATEGIC_SOLUTION</h3>
      <div style="margin-bottom:40px;">
        <div style="font-size:14px;margin-bottom:10px;"><strong>Proposed Architecture:</strong> <span style="font-weight:700;">${client.solution || 'N/A'}</span></div>
        <div class="bgi-card" style="background:#FFFFFF;font-size:13px;line-height:1.6;color:#334155;">
          ${client.details ? client.details.replace(/\\n/g, '<br/>') : '<span style="color:#94A3B8;font-style:italic;">No structural intel gathered.</span>'}
        </div>
      </div>

      <div class="bgi-footer">
        <span class="bgi-mono" style="font-size:8px;color:#64748B;letter-spacing:1px;">AEON // V3 EXECUTIVE ENGINE</span>
        <span class="bgi-mono" style="font-size:8px;color:#64748B;">PAGE 01 // 02</span>
      </div>
    </div>

    <!-- PAGE 2 -->
    <div class="bgi-page">
      <h3 class="bgi-section-title"><span class="bgi-accent">//</span> 03_FINANCIAL_LEDGER</h3>
      
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:15px;margin-bottom:30px;">
        <div class="bgi-card" style="background:#0F172A;color:#FFFFFF;text-align:center;border:none;">
          <div class="bgi-mono bgi-label" style="color:#94A3B8;margin-bottom:4px;">Total Allocated</div>
          <div style="font-size:24px;font-weight:800;font-family:'Geist Mono',monospace;">$${totalInvoiced.toLocaleString()}</div>
        </div>
        <div class="bgi-card" style="background:#F0FDF4;color:#065F46;border-color:#86EFAC;text-align:center;">
          <div class="bgi-mono bgi-label" style="color:#166534;margin-bottom:4px;">Capital Secured</div>
          <div style="font-size:24px;font-weight:800;font-family:'Geist Mono',monospace;">$${totalPaid.toLocaleString()}</div>
        </div>
        <div class="bgi-card" style="background:#FEF2F2;color:#991B1B;border-color:#FCA5A5;text-align:center;">
          <div class="bgi-mono bgi-label" style="color:#991B1B;margin-bottom:4px;">Outstanding</div>
          <div style="font-size:24px;font-weight:800;font-family:'Geist Mono',monospace;">$${(totalInvoiced - totalPaid).toLocaleString()}</div>
        </div>
      </div>

      ${invoices.length > 0 ? `
      <table class="bgi-table" style="width:100%;border-collapse:collapse;font-size:12px;">
        <tr>
          <th>Description</th>
          <th>Issue Date</th>
          <th style="text-align:right;">Amount</th>
          <th style="text-align:center;">Status</th>
        </tr>
        ${invoices.map(inv => `
          <tr>
            <td><strong>${inv.description || 'N/A'}</strong>${inv.invoiceNumber ? `<br/><span style="color:#64748B;font-size:10px;">#${inv.invoiceNumber}</span>` : ''}</td>
            <td>${inv.date || 'N/A'}${inv.dueDate ? `<br/><span style="color:#64748B;font-size:10px;">Due: ${inv.dueDate}</span>` : ''}</td>
            <td style="text-align:right;font-weight:700;font-family:'Geist Mono',monospace;">$${Number(inv.amount || 0).toLocaleString()}</td>
            <td style="text-align:center;">
              <span style="padding:4px 8px;border-radius:4px;font-size:9px;font-weight:800;letter-spacing:1px;background:${inv.status === 'paid' ? '#DCFCE7;color:#166534' : '#FEF3C7;color:#92400E'};">
                ${(inv.status || 'pending').toUpperCase()}
              </span>
            </td>
          </tr>
        `).join('')}
      </table>` : '<div class="bgi-card" style="text-align:center;color:#94A3B8;font-style:italic;font-size:13px;">No capital injections recorded in ledger.</div>'}

      <div style="margin-top:60px;padding-top:20px;border-top:2px solid #E2E8F0;">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;">
          <div>
            <div style="border-bottom:1px solid #94A3B8;width:200px;margin-bottom:8px;"></div>
            <div class="bgi-mono" style="font-size:9px;font-weight:700;color:#64748B;">CRISTIAN GOMEZ // ARCHITECT</div>
          </div>
          <div style="text-align:right;">
            <div class="bgi-mono" style="font-size:9px;color:#64748B;letter-spacing:1px;margin-bottom:4px;">SYSTEM CLOCK SIGNATURE</div>
            <div class="bgi-mono bgi-accent" style="font-size:10px;font-weight:700;">${now}</div>
          </div>
        </div>
      </div>

      <div class="bgi-footer">
        <span class="bgi-mono" style="font-size:8px;color:#64748B;letter-spacing:1px;">AEON // V3 EXECUTIVE ENGINE</span>
        <span class="bgi-mono" style="font-size:8px;color:#64748B;">PAGE 02 // 02</span>
      </div>
    </div>
  `;
}

/**
 * Generates an HTML report from HR audit text (Markdown-like).
 */
export function generateHRAuditReportHTML(auditText, clientName = 'N/A', role = 'N/A') {
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  // Convert markdown-like text to basic HTML
  const htmlBody = auditText
    .replace(/^### (.*$)/gm, '<h3 style="color:#0f172a;margin:20px 0 8px;">$1</h3>')
    .replace(/^## (.*$)/gm, '<h2 style="color:#0f172a;margin:24px 0 10px;">$1</h2>')
    .replace(/^# (.*$)/gm, '<h1 style="color:#0f172a;margin:28px 0 12px;">$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.*$)/gm, '<li style="margin:4px 0;">$1</li>')
    .replace(/\n/g, '<br/>');

  return `
    <div style="padding:40px;">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #7c3aed;padding-bottom:20px;margin-bottom:30px;">
        <div>
          <h1 style="margin:0;font-size:28px;color:#0f172a;">AEON HR ARSENAL</h1>
          <p style="margin:4px 0 0;color:#64748b;font-size:14px;">Professional Audit Report</p>
        </div>
        <div style="text-align:right;">
          <div style="font-size:12px;color:#94a3b8;">Client: ${clientName}</div>
          <div style="font-size:12px;color:#94a3b8;">Role: ${role}</div>
          <div style="font-size:12px;color:#94a3b8;">Generated: ${now}</div>
        </div>
      </div>
      <div style="line-height:1.7;color:#334155;font-size:14px;">
        ${htmlBody}
      </div>
      <div style="margin-top:40px;padding-top:20px;border-top:1px solid #e2e8f0;text-align:center;color:#94a3b8;font-size:11px;">
        AEON Command Center · HR Arsenal Audit Report · ${now}
      </div>
    </div>
  `;
}

/**
 * Generates an HTML report for a list of leads scraped and enriched by Orion.
 */
export function generateMasterScrapeReportHTML(leads, queryStr) {
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;600;700&family=Inter:wght@400;600;800&display=swap');
      .bgi-page {
        width: 8.5in;
        min-height: 11in;
        box-sizing: border-box;
        padding: 0.8in;
        background-color: #FFFFFF;
        background-image: 
          linear-gradient(rgba(15, 23, 42, 0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(15, 23, 42, 0.03) 1px, transparent 1px);
        background-size: 20px 20px;
        font-family: 'Inter', sans-serif;
        color: #0F172A;
        position: relative;
      }
      .bgi-header-band {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        border-bottom: 1px solid #E2E8F0;
        padding-bottom: 16px;
        margin-bottom: 30px;
      }
      .bgi-mono {
        font-family: 'Geist Mono', monospace;
      }
      .bgi-accent {
        color: #FF5E00;
      }
      .bgi-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
        margin-bottom: 30px;
      }
      .bgi-table th {
        background: #F1F5F9;
        padding: 8px;
        text-align: left;
        font-weight: 600;
        border-bottom: 2px solid #CBD5E1;
        color: #475569;
        text-transform: uppercase;
      }
      .bgi-table td {
        padding: 8px;
        border-bottom: 1px solid #E2E8F0;
        vertical-align: top;
      }
      .bgi-footer {
        border-top: 1px solid #E2E8F0;
        padding-top: 12px;
        display: flex;
        justify-content: space-between;
        margin-top: 40px;
      }
    </style>

    <div class="bgi-page">
      <div class="bgi-header-band">
        <div class="bgi-mono" style="font-size:10px;letter-spacing:0.2em;color:#64748B;text-transform:uppercase;">
          AEON ORION SCRAPER // INTELLIGENCE DOSSIER
        </div>
        <div style="text-align: right;">
          <div class="bgi-mono" style="font-size:9px;color:#64748B;letter-spacing:1px;">QUERY_HASH</div>
          <div class="bgi-mono bgi-accent" style="font-size:12px;font-weight:700;">${btoa(queryStr).substring(0, 8).toUpperCase()}</div>
        </div>
      </div>

      <div style="margin-bottom:30px;">
        <h1 style="margin:0 0 5px 0;font-size:28px;font-weight:800;text-transform:uppercase;">TARGET SECTOR DOSSIER</h1>
        <p style="margin:0;color:#64748B;font-size:14px;"><strong>Query Executed:</strong> "${queryStr}"</p>
        <p style="margin:5px 0 0 0;color:#64748B;font-size:13px;"><strong>Leads Extracted & Enriched:</strong> ${leads.length}</p>
      </div>

      <table class="bgi-table">
        <tr>
          <th style="width:25%;">Entity Name</th>
          <th style="width:20%;">Industry & Revenue</th>
          <th style="width:30%;">Target Base</th>
          <th style="width:25%;">Contact Vector</th>
        </tr>
        ${leads.map(lead => `
          <tr>
            <td>
              <strong style="color:#0F172A;font-size:12px;">${lead.name}</strong><br/>
              <a href="${lead.url || '#'}" style="color:#3B82F6;text-decoration:none;font-size:9px;">${lead.url ? (lead.url.length > 35 ? lead.url.substring(0,35)+'...' : lead.url) : 'No Web Vector'}</a>
            </td>
            <td>
              <span style="font-weight:600;color:#FF5E00;">${lead.scale || 'Unknown'}</span><br/>
              <span class="bgi-mono" style="font-size:10px;color:#64748B;">${lead.intakeNotes ? lead.intakeNotes.replace('Est. Revenue: ', '') : 'Unknown Rev'}</span>
            </td>
            <td style="color:#475569;">
              ${lead.projectScope ? lead.projectScope.replace('Target Base: ', '') : 'N/A'}
            </td>
            <td class="bgi-mono" style="font-size:10px;color:#0F172A;">
              ${lead.contact?.phone || 'No Phone Number'}
            </td>
          </tr>
        `).join('')}
      </table>

      <div class="bgi-footer">
        <div>
          <div class="bgi-mono" style="font-size:9px;font-weight:700;color:#64748B;">CRISTIAN GOMEZ // ARCHITECT</div>
        </div>
        <div style="text-align:right;">
          <div class="bgi-mono" style="font-size:9px;color:#64748B;letter-spacing:1px;">SYSTEM CLOCK SIGNATURE</div>
          <div class="bgi-mono bgi-accent" style="font-size:10px;font-weight:700;">${now}</div>
        </div>
      </div>
    </div>
  `;
}
