const { writeGlobalSignals } = require("./firebase");
const { runScanForMode } = require("./signals");

const MODE_LIST = ["LOOSE", "MEDIUM", "STRICT"];

async function main() {
  console.log("⏰ Main bot scan started:", new Date().toISOString());
  
  const signalsByMode = {};
  for (const mode of MODE_LIST) {
    try {
      signalsByMode[mode] = await runScanForMode(mode);
      const count = Object.keys(signalsByMode[mode].coins || {}).length;
      const actionable = Object.values(signalsByMode[mode].coins || {})
        .filter(c => c.signal === "BUY" || c.signal === "SELL").length;
      console.log(`✅ ${mode}: ${count} coins scanned, ${actionable} actionable (${count - actionable} neutral/wait)`);
    } catch (e) {
      console.error(`❌ ${mode} failed:`, e.message);
    }
  }
  
  if (Object.keys(signalsByMode).length > 0) {
    await writeGlobalSignals(signalsByMode);
  }
  
  console.log("✅ Main bot scan complete — signals written to Firestore");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
