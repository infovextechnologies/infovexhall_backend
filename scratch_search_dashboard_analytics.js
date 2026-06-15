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
      if (file.endsWith('.ts') || file.endsWith('.tsx')) {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes(query)) {
          console.log(`Match: ${filePath}`);
        }
      }
    }
  }
}

searchDir('d:\\INFOVEX_PRODUCT\\HALLFLOW\\HALLS_ON_DESK\\hallsondesk-frontend_2\\src', 'DashboardAnalytics');
