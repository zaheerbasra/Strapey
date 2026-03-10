const fs = require('fs');

const backupFile = 'data/data.json.repair-backup.1772825156449';
const content = fs.readFileSync(backupFile, 'utf8');

console.log('Total bytes:', content.length);
console.log('Will truncate from error position: 842221');

// Truncate at error position and work backwards to find last }
let repaired = content.substring(0, 842221);

// Remove trailing incomplete JSON  
while (repaired.length > 0 && !repaired.endsWith('}')) {
  repaired = repaired.substring(0, repaired.length - 1);
}

console.log('After truncation:', repaired.length, 'bytes');

// Validate
try {
  const parsed = JSON.parse(repaired);
  console.log('✓ VALID JSON with', Object.keys(parsed).length, 'products');
  
  // Save repaired version
  fs.writeFileSync(backupFile, repaired);
  console.log('✓ Backup file repaired and saved');
  
  process.exit(0);
} catch (e) {
  console.error('✗ Still invalid:', e.message.substring(0, 100));
  process.exit(1);
}
