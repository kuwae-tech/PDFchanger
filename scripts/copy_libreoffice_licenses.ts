import path from "path";
import fs from "fs-extra";

const LICENSE_CANDIDATES = [
  "LICENSE",
  "LICENSE.txt",
  "NOTICE",
  "NOTICE.txt",
  "README",
  "README.txt"
];

export async function copyLibreOfficeLicenses(libreOfficeRoot: string, distDir: string): Promise<void> {
  const targetDir = path.join(distDir, "licenses", "third_party", "libreoffice");
  await fs.ensureDir(targetDir);

  for (const candidate of LICENSE_CANDIDATES) {
    const sourcePath = path.join(libreOfficeRoot, candidate);
    if (await fs.pathExists(sourcePath)) {
      await fs.copy(sourcePath, path.join(targetDir, candidate));
    }
  }
}
