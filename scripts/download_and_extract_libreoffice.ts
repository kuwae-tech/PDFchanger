import path from "path";
import fs from "fs-extra";
import https from "https";
import { spawn } from "child_process";
import { pipeline } from "stream/promises";
import { copyLibreOfficeLicenses } from "./copy_libreoffice_licenses";

const LO_VERSION = process.env.LO_VERSION ?? "25.8.4";
const LO_URL = `https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/win/x86_64/LibreOffice_${LO_VERSION}_Win_x86-64.msi`;

const repoRoot = path.resolve(__dirname, "..", "..");
const vendorRoot = path.join(repoRoot, "vendor", "libreoffice");
const vendorMsiDir = path.join(vendorRoot, "msi");
const vendorExtractDir = path.join(vendorRoot, "extract");
const distDir = path.join(repoRoot, "dist");
const distLibreOfficeDir = path.join(distDir, "libreoffice");

const assetsDir = path.join(repoRoot, "assets");
const assetsConfigDir = path.join(assetsDir, "config");
const assetsConfigPath = path.join(assetsConfigDir, "config.json");

const defaultConfig = {
  watchRoot: "./data",
  inbox: "inbox",
  work: "work",
  output: "output",
  archiveOriginals: "archive/originals",
  archiveWork: "archive/work",
  archiveWorkFailed: "archive/work_failed",
  logs: "logs",
  state: "state",
  polling: false,
  pollingIntervalMs: 1000,
  stableCheckIntervalMs: 500,
  stableChecks: 6,
  stableTimeoutMs: 60000,
  jobTimeoutMs: 300000
};

async function ensureAssetsConfig(): Promise<void> {
  await fs.ensureDir(assetsConfigDir);
  if (!(await fs.pathExists(assetsConfigPath))) {
    await fs.writeJson(assetsConfigPath, defaultConfig, { spaces: 2 });
  }
}

async function downloadFile(url: string, destination: string): Promise<void> {
  await fs.ensureDir(path.dirname(destination));

  await new Promise<void>((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destination).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed (${response.statusCode}) for ${url}`));
        return;
      }

      const fileStream = fs.createWriteStream(destination);
      pipeline(response, fileStream)
        .then(resolve)
        .catch(reject);
    }).on("error", reject);
  });
}

async function runMsiexec(msiPath: string, targetDir: string): Promise<void> {
  await fs.ensureDir(targetDir);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("msiexec", ["/a", msiPath, "/qn", `TARGETDIR=${targetDir}`], {
      stdio: "inherit",
      shell: false
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`msiexec failed with code ${code ?? "unknown"}`));
      }
    });
  });
}

async function findLibreOfficeRoot(searchDir: string): Promise<string> {
  const queue: string[] = [searchDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const programPath = path.join(current, "program");
    if (await fs.pathExists(path.join(programPath, "soffice.com"))) {
      return current;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push(path.join(current, entry.name));
      }
    }
  }
  throw new Error("Unable to locate LibreOffice program directory after extraction.");
}

async function copyStaticAssets(): Promise<void> {
  await ensureAssetsConfig();
  await fs.ensureDir(distDir);
  await fs.ensureDir(path.join(distDir, "config"));
  await fs.ensureDir(path.join(distDir, "licenses"));

  await fs.copy(assetsConfigPath, path.join(distDir, "config", "config.json"));
  await fs.copy(path.join(assetsDir, "licenses", "MPL-2.0.txt"), path.join(distDir, "licenses", "MPL-2.0.txt"));
  await fs.copy(path.join(assetsDir, "THIRD_PARTY_NOTICES.txt"), path.join(distDir, "THIRD_PARTY_NOTICES.txt"));
}

async function main(): Promise<void> {
  console.log(`Downloading LibreOffice ${LO_VERSION}...`);
  const msiPath = path.join(vendorMsiDir, `LibreOffice_${LO_VERSION}_Win_x86-64.msi`);

  if (!(await fs.pathExists(msiPath))) {
    await downloadFile(LO_URL, msiPath);
  } else {
    console.log("MSI already exists, skipping download.");
  }

  await fs.remove(vendorExtractDir);
  await runMsiexec(msiPath, vendorExtractDir);

  const libreOfficeRoot = await findLibreOfficeRoot(vendorExtractDir);
  const sofficePath = path.join(libreOfficeRoot, "program", "soffice.com");
  if (!(await fs.pathExists(sofficePath))) {
    throw new Error("Expected soffice.com not found after extraction.");
  }

  await fs.remove(distLibreOfficeDir);
  await fs.copy(libreOfficeRoot, distLibreOfficeDir);

  await copyStaticAssets();
  await copyLibreOfficeLicenses(libreOfficeRoot, distDir);

  console.log("LibreOffice vendor extraction complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
