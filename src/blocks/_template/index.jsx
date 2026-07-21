import React from 'react';

// The only requirement: default-export a React component. The kernel mounts it
// at the manifest's `route`. Everything else (nav entry, readiness, API wiring)
// comes from block.manifest.json — never hardcode block facts anywhere else.
export default function TemplateBlock() {
  return (
    <div style={{ padding: 24 }}>
      <h2>🧩 hello block</h2>
      <p>Copy <code>src/blocks/_template/</code>, rename the folder and every
        <code>_template</code> reference in <code>block.manifest.json</code>, restart —
        your block is live in nav. Run <code>npm run aeon lint &lt;id&gt;</code> before shipping.</p>
    </div>
  );
}
