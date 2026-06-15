const process = require("process");

process.on("exit", (code) => {
  console.log("PROCESS EXITED WITH CODE:", code);
});

console.log("Starting server...");
require("./server.js");

let seconds = 0;
setInterval(() => {
  seconds++;
  console.log(`Alive for ${seconds}s. Active handles:`, process._getActiveHandles().length);
}, 1000);
