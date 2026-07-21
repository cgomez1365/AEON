const fs = require('fs');
const lines = fs.readFileSync('server.cjs', 'utf8').split('\n');
const newLines = [
  ...lines.slice(0, 2736),
  '// Injecting AEON Modular Plugins',
  'require("./modules/ats_engine")(app, validateSDI, geminiRequest, writeOSAudit, supabase);',
  'require("./modules/logistics_ledger")(app, validateSDI, writeOSAudit);',
  ...lines.slice(3075)
];
fs.writeFileSync('server.cjs', newLines.join('\n'));
console.log("server.cjs patched successfully");
