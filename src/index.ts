import path from "path";
import os from "os";
import fs from "fs-extra";
import chokidar from "chokidar";
import { spawn } from "child_process";
import winston from "winston";
import dayjs from "dayjs";
import { pathToFileURL } from "url";

interface AppConfig {
  watchRoot: string;
  inbox: string;
  work: string;
  output: string;
  archiveOriginals: string;
  archiveWork: string;
  archiveWorkFailed: string;
  logs: string;
  state: string;
  polling: boolean;
  pollingIntervalMs: number;
  stableCheckIntervalMs: number;
  stableChecks: number;
  stableTimeoutMs: number;
  jobTimeoutMs: number;
}

interface ProcessedState {
  processed: Record<string, { processedAt: string; status: string }>;
}

interface Paths {
  baseDir: string;
  configPath: string;
  watchRoot: string;
  inboxDir: string;
  workDir: string;
  outputDir: string;
  archiveOriginalsDir: string;
  archiveWorkDir: string;
  archiveWorkFailedDir: string;
  logsDir: string;
  stateDir: string;
  stateFile: string;
  appLog: string;
  jobsLog: string;
  libreOfficeDir: string;
}

const defaultConfig: AppConfig = {
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

function resolveBaseDir(): string {
  if ((process as NodeJS.Process & { pkg?: unknown }).pkg) {
    return path.dirname(process.execPath);
  }
  return path.resolve(process.cwd(), "dist");
}

async function loadConfig(baseDir: string): Promise<{ config: AppConfig; configPath: string }> {
  const configPath = path.join(baseDir, "config", "config.json");
  await fs.ensureDir(path.dirname(configPath));
  if (!(await fs.pathExists(configPath))) {
    await fs.writeJson(configPath, defaultConfig, { spaces: 2 });
    return { config: defaultConfig, configPath };
  }
  const loaded = await fs.readJson(configPath);
  const merged = { ...defaultConfig, ...loaded } as AppConfig;
  return { config: merged, configPath };
}

function buildPaths(baseDir: string, config: AppConfig): Paths {
  const watchRoot = path.resolve(baseDir, config.watchRoot);
  const inboxDir = path.join(watchRoot, config.inbox);
  const workDir = path.join(watchRoot, config.work);
  const outputDir = path.join(watchRoot, config.output);
  const archiveOriginalsDir = path.join(watchRoot, config.archiveOriginals);
  const archiveWorkDir = path.join(watchRoot, config.archiveWork);
  const archiveWorkFailedDir = path.join(watchRoot, config.archiveWorkFailed);
  const logsDir = path.join(watchRoot, config.logs);
  const stateDir = path.join(watchRoot, config.state);
  const stateFile = path.join(stateDir, "processed.json");
  return {
    baseDir,
    configPath: path.join(baseDir, "config", "config.json"),
    watchRoot,
    inboxDir,
    workDir,
    outputDir,
    archiveOriginalsDir,
    archiveWorkDir,
    archiveWorkFailedDir,
    logsDir,
    stateDir,
    stateFile,
    appLog: path.join(logsDir, "app.log"),
    jobsLog: path.join(logsDir, "jobs.ndjson"),
    libreOfficeDir: path.join(baseDir, "libreoffice")
  };
}

async function ensureDirectories(paths: Paths): Promise<void> {
  await fs.ensureDir(paths.inboxDir);
  await fs.ensureDir(paths.workDir);
  await fs.ensureDir(paths.outputDir);
  await fs.ensureDir(paths.archiveOriginalsDir);
  await fs.ensureDir(paths.archiveWorkDir);
  await fs.ensureDir(paths.archiveWorkFailedDir);
  await fs.ensureDir(paths.logsDir);
  await fs.ensureDir(paths.stateDir);
}

async function loadState(stateFile: string): Promise<ProcessedState> {
  if (!(await fs.pathExists(stateFile))) {
    return { processed: {} };
  }
  return fs.readJson(stateFile);
}

async function saveState(stateFile: string, state: ProcessedState): Promise<void> {
  await fs.writeJson(stateFile, state, { spaces: 2 });
}

function createLogger(appLog: string): winston.Logger {
  return winston.createLogger({
    level: "info",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.File({ filename: appLog })
    ]
  });
}

function toFileUri(targetPath: string): string {
  return pathToFileURL(targetPath).toString();
}

async function waitForStableFile(filePath: string, config: AppConfig, logger: winston.Logger): Promise<boolean> {
  const timeoutAt = Date.now() + config.stableTimeoutMs;
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() < timeoutAt) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size === lastSize) {
        stableCount += 1;
        if (stableCount >= config.stableChecks) {
          return true;
        }
      } else {
        stableCount = 0;
        lastSize = stat.size;
      }
    } catch (error) {
      logger.warn("Failed to stat file during stability check", { filePath, error: String(error) });
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, config.stableCheckIntervalMs));
  }
  return false;
}

function buildUniqueName(base: string, ext: string): string {
  const stamp = dayjs().format("YYYYMMDD_HHmmss");
  return `${base}__${stamp}${ext}`;
}

async function runLibreOffice(
  paths: Paths,
  config: AppConfig,
  inputPath: string,
  outputDir: string,
  outputBaseName: string,
  logger: winston.Logger
): Promise<string> {
  const programDir = path.join(paths.libreOfficeDir, "program");
  const sofficeCom = path.join(programDir, "soffice.com");
  const sofficeExe = path.join(programDir, "soffice.exe");
  const sofficePath = (await fs.pathExists(sofficeCom)) ? sofficeCom : sofficeExe;

  if (!(await fs.pathExists(sofficePath))) {
    throw new Error(`LibreOffice binary not found at ${sofficePath}`);
  }

  const profileDir = path.join(os.tmpdir(), "doc2pdf-profile", outputBaseName);
  await fs.ensureDir(profileDir);
  const profileUri = toFileUri(profileDir);

  const args = [
    "--headless",
    "--nologo",
    "--nofirststartwizard",
    "--norestore",
    "--invisible",
    `-env:UserInstallation=${profileUri}`,
    "--convert-to",
    "pdf",
    "--outdir",
    outputDir,
    inputPath
  ];

  logger.info("Starting LibreOffice conversion", { inputPath, outputDir, sofficePath });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(sofficePath, args, { shell: false });
    const timeout = setTimeout(() => {
      logger.error("LibreOffice conversion timed out", { inputPath });
      child.kill();
      reject(new Error("LibreOffice conversion timed out"));
    }, config.jobTimeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`LibreOffice exited with code ${code ?? "unknown"}`));
      }
    });
  });

  const outputPdf = path.join(outputDir, `${outputBaseName}.pdf`);
  if (!(await fs.pathExists(outputPdf))) {
    throw new Error(`Expected output PDF missing at ${outputPdf}`);
  }

  await fs.remove(profileDir);
  return outputPdf;
}

async function appendJobLog(logPath: string, entry: Record<string, unknown>): Promise<void> {
  const line = `${JSON.stringify(entry)}\n`;
  await fs.appendFile(logPath, line, "utf8");
}

async function main(): Promise<void> {
  const baseDir = resolveBaseDir();
  const { config } = await loadConfig(baseDir);
  const paths = buildPaths(baseDir, config);
  await ensureDirectories(paths);

  const logger = createLogger(paths.appLog);
  logger.info("Starting DocFolderPdfWatcher", { baseDir, watchRoot: paths.watchRoot });

  const state = await loadState(paths.stateFile);
  const queue: string[] = [];
  let processing = false;

  const validExts = new Set([".doc", ".docx", ".xls", ".xlsx"]);

  const processQueue = async (): Promise<void> => {
    if (processing) return;
    processing = true;

    while (queue.length > 0) {
      const filePath = queue.shift();
      if (!filePath) continue;

      const ext = path.extname(filePath).toLowerCase();
      if (!validExts.has(ext)) {
        continue;
      }

      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (error) {
        logger.warn("File disappeared before processing", { filePath, error: String(error) });
        continue;
      }

      const processedKey = `${filePath}|${stat.size}|${stat.mtimeMs}`;
      if (state.processed[processedKey]) {
        logger.info("Skipping already processed file", { filePath });
        continue;
      }

      const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const startedAt = new Date().toISOString();
      let status = "failed";
      let outputPdf: string | null = null;
      let errorMessage: string | null = null;
      let workFileName: string | null = null;
      let workPath: string | null = null;

      try {
        const stable = await waitForStableFile(filePath, config, logger);
        if (!stable) {
          throw new Error("File stability check failed");
        }

        const baseName = path.basename(filePath, ext);
        const uniqueBase = buildUniqueName(baseName, "");
        workFileName = `${uniqueBase}${ext}`;
        workPath = path.join(paths.workDir, workFileName);

        await fs.copyFile(filePath, workPath);

        try {
          await fs.move(filePath, path.join(paths.archiveOriginalsDir, workFileName), { overwrite: false });
        } catch (moveError) {
          logger.warn("Failed to move original to archive", { filePath, error: String(moveError) });
        }

        outputPdf = await runLibreOffice(
          paths,
          config,
          workPath,
          paths.outputDir,
          uniqueBase,
          logger
        );

        try {
          await fs.move(workPath, path.join(paths.archiveWorkDir, workFileName), { overwrite: false });
        } catch (moveError) {
          logger.warn("Failed to move work copy to archive", { workPath, error: String(moveError) });
        }
        status = "success";
      } catch (error) {
        errorMessage = String(error);
        logger.error("Job failed", { filePath, error: errorMessage });
        if (workFileName && workPath && await fs.pathExists(workPath)) {
          await fs.move(workPath, path.join(paths.archiveWorkFailedDir, workFileName), { overwrite: true });
        }
      } finally {
        state.processed[processedKey] = { processedAt: new Date().toISOString(), status };
        await saveState(paths.stateFile, state);

        await appendJobLog(paths.jobsLog, {
          jobId,
          filePath,
          outputPdf,
          status,
          error: errorMessage,
          startedAt,
          finishedAt: new Date().toISOString()
        });
      }
    }

    processing = false;
  };

  const watcher = chokidar.watch(paths.inboxDir, {
    ignoreInitial: true,
    persistent: true,
    usePolling: config.polling,
    interval: config.pollingIntervalMs
  });

  watcher.on("add", (filePath) => {
    queue.push(path.resolve(filePath));
    void processQueue();
  });

  watcher.on("error", (error) => {
    logger.error("Watcher error", { error: String(error) });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
