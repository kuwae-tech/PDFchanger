import path from "path";
import fs from "fs-extra";
import https from "https";
import { spawn } from "child_process";
import { pipeline } from "stream/promises";
import { ensureAssets } from "./ensure_assets";
import { copyLibreOfficeLicenses } from "./copy_libreoffice_licenses";

const LO_VERSION = process.env.LO_VERSION ?? "25.8.4";
const LO_URL = `https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/win/x86_64/LibreOffice_${LO_VERSION}_Win_x86-64.msi`;

const repoRoot = process.cwd();
const vendorRoot = path.join(repoRoot, "vendor", "libreoffice");
const vendorMsiDir = path.join(vendorRoot, "msi");
const vendorExtractDir = path.join(vendorRoot, "extract");
const distDir = path.join(repoRoot, "dist");
const distLibreOfficeDir = path.join(distDir, "libreoffice");

const assetsDir = path.join(repoRoot, "assets");
const assetsConfigPath = path.join(assetsDir, "config", "config.json");
const assetsMplPath = path.join(assetsDir, "licenses", "MPL-2.0.txt");
const assetsNoticePath = path.join(assetsDir, "licenses", "NOTICE-LibreOffice.txt");
const assetsThirdPartyPath = path.join(assetsDir, "THIRD_PARTY_NOTICES.txt");

async function ensureDistDataSkeleton(): Promise<void> {
  const dataDir = path.join(distDir, "data");
  await fs.ensureDir(path.join(dataDir, "inbox"));
  await fs.ensureDir(path.join(dataDir, "work"));
  await fs.ensureDir(path.join(dataDir, "work_out"));
  await fs.ensureDir(path.join(dataDir, "archive", "originals"));
  await fs.ensureDir(path.join(dataDir, "archive", "work"));
  await fs.ensureDir(path.join(dataDir, "archive", "work_failed"));
  await fs.ensureDir(path.join(dataDir, "logs"));
  await fs.ensureDir(path.join(dataDir, "state"));
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function downloadWithRetries(url: string, destination: string, attempts = 3): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await downloadFile(url, destination);
      return;
    } catch (error) {
      lastError = error;
      const backoffMs = 1000 * Math.pow(2, attempt - 1);
      console.warn(`Download attempt ${attempt} failed. Retrying in ${backoffMs}ms...`, error);
      await delay(backoffMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Download failed after retries.");
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
  await ensureAssets();
  await fs.ensureDir(distDir);
  await fs.ensureDir(path.join(distDir, "config"));
  await fs.ensureDir(path.join(distDir, "licenses"));

  await fs.copy(assetsConfigPath, path.join(distDir, "config", "config.json"));
  await fs.copy(assetsMplPath, path.join(distDir, "licenses", "MPL-2.0.txt"));
  await fs.copy(assetsNoticePath, path.join(distDir, "licenses", "NOTICE-LibreOffice.txt"));
  await fs.copy(assetsThirdPartyPath, path.join(distDir, "THIRD_PARTY_NOTICES.txt"));
  await ensureDistDataSkeleton();
}

async function main(): Promise<void> {
  await ensureAssets();
  console.log(`Downloading LibreOffice ${LO_VERSION}...`);
  const msiPath = path.join(vendorMsiDir, `LibreOffice_${LO_VERSION}_Win_x86-64.msi`);

  if (!(await fs.pathExists(msiPath))) {
    await downloadWithRetries(LO_URL, msiPath, 3);
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
