import path from "path";
import fs from "fs-extra";
import archiver from "archiver";

const repoRoot = path.resolve(__dirname, "..", "..");
const distDir = path.join(repoRoot, "dist");
const outputZip = path.join(distDir, "DocFolderPdfWatcher-win-x64.zip");

async function zipDist(): Promise<void> {
  if (!(await fs.pathExists(distDir))) {
    throw new Error("dist directory does not exist. Run build steps first.");
  }

  await fs.remove(outputZip);
  await fs.ensureDir(distDir);

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputZip);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    archive.on("error", (err: Error) => reject(err));

    archive.pipe(output);
    archive.directory(distDir, false, (entry: { name?: string }) => {
      if (entry.name === path.basename(outputZip)) {
        return false;
      }
      return entry;
    });
    archive.finalize().catch(reject);
  });
}

zipDist().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
