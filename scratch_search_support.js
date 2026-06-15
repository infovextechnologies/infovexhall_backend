const fs = require('fs');
const path = require('path');

function searchDir(dir, query) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      if (!file.startsWith('.') && file !== 'node_modules' && file !== '.next') {
        searchDir(filePath, query);
      }
    } else {
      if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.jsx')) {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.toLowerCase().includes(query.toLowerCase()) || file.toLowerCase().includes(query.toLowerCase())) {
          console.log(`Match in file: ${filePath}`);
        }
      }
    }
  }
}

console.log("--- Searching for 'ticket' in frontend ---");
searchDir('d:\\INFOVEX_PRODUCT\\HALLFLOW\\HALLS_ON_DESK\\hallsondesk-frontend_2\\src', 'ticket');
console.log("--- Searching for 'support' in frontend ---");
searchDir('d:\\INFOVEX_PRODUCT\\HALLFLOW\\HALLS_ON_DESK\\hallsondesk-frontend_2\\src', 'support');
