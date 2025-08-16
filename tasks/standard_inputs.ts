import { task } from "hardhat/config";
import fs from "fs";
import path from "path";

task("extract-standard-inputs", "Extract Solidity standard JSON inputs from build-info").setAction(async (_, hre) => {
  const buildInfoPath = path.join(hre.config.paths.artifacts, "build-info");
  const outputPath = path.join(hre.config.paths.root, "standard-inputs");

  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath);
  }

  const files = fs.readdirSync(buildInfoPath).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const fullPath = path.join(buildInfoPath, file);
    const content = JSON.parse(fs.readFileSync(fullPath, "utf8"));

    const input = content.input;
    if (!input || !input.sources) continue;

    for (const [sourcePath] of Object.entries(input.sources)) {
      const contractName = path.basename(sourcePath, ".sol").replace(/[^a-zA-Z0-9]/g, "_");
      const outputFile = path.join(outputPath, `${contractName}-standard-input.json`);
      fs.writeFileSync(outputFile, JSON.stringify({ ...input }, null, 2));
      console.log(`✅ Exported ${outputFile}`);
    }
  }

  console.log(`\n🎉 Done! Extracted standard inputs for ${files.length} build info files.`);
});
