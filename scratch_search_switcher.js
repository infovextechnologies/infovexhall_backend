const fs = require("fs");
const path = require("path");

function walk(dir, results = []) {
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      if (!file.includes("node_modules") && !file.includes(".next") && !file.includes(".git")) {
        walk(fullPath, results);
      }
    } else {
      if (file.endsWith(".tsx") || file.endsWith(".ts")) {
        results.push(fullPath);
      }
    }
  });
  return results;
}

const files = walk(path.join(__dirname, "../hallsondesk-frontend_2/src"));
console.log("Searching in", files.length, "files...");

for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  if (content.includes("setActiveHall") || content.includes("accessible_halls")) {
    console.log(`Match in: ${path.relative(__dirname, file)}`);
    // Print lines containing the match
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      if (line.includes("setActiveHall") || line.includes("accessible_halls")) {
        console.log(`  L${idx + 1}: ${line.trim()}`);
      }
    });
  }
}
