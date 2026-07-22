import { spawnSync } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeRepositoryPath, scanRepository } from "./scan.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const MODULE_DIRECTORY = path.dirname(MODULE_PATH);
const DEFAULT_POLICY_PATH = path.join(MODULE_DIRECTORY, "policy.json");
const MAX_SOURCE_BYTES = 1024 * 1024;

class IngressError extends Error {
  constructor(code, line = undefined) {
    super(code);
    this.name = "IngressError";
    this.code = code;
    this.line = line;
  }
}

function sameFilesystemPath(left, right) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function isOutsideRoot(root, candidate) {
  const relation = path.relative(root, candidate);
  return (
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  );
}

function runGitStatus(repositoryRoot, args) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: "ignore",
  });
  if (result.error !== undefined || result.status === null) {
    throw new IngressError("GIT_COMMAND_FAILED");
  }
  return result.status;
}

function parseArguments(args) {
  const options = {
    repositoryRoot: process.cwd(),
    policyPath: DEFAULT_POLICY_PATH,
    destination: ".env",
    source: undefined,
    allowedKeys: [],
    format: "text",
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (
      ["--repo", "--policy", "--source", "--destination", "--allow", "--format"].includes(
        argument,
      )
    ) {
      const value = args[index + 1];
      if (value === undefined) throw new IngressError("CLI_ARGUMENT_INVALID");
      index += 1;
      if (argument === "--repo") options.repositoryRoot = value;
      if (argument === "--policy") options.policyPath = value;
      if (argument === "--source") options.source = value;
      if (argument === "--destination") options.destination = value;
      if (argument === "--allow") options.allowedKeys.push(value);
      if (argument === "--format") options.format = value;
      continue;
    }
    throw new IngressError("CLI_ARGUMENT_INVALID");
  }

  if (!new Set(["json", "text"]).has(options.format)) {
    throw new IngressError("CLI_ARGUMENT_INVALID");
  }
  if (!options.help && options.source === undefined) {
    throw new IngressError("SOURCE_REQUIRED");
  }
  if (!options.help && options.allowedKeys.length === 0) {
    throw new IngressError("ALLOWLIST_REQUIRED");
  }
  const uniqueKeys = new Set(options.allowedKeys);
  if (
    uniqueKeys.size !== options.allowedKeys.length ||
    options.allowedKeys.some((key) => !/^[A-Z][A-Z0-9_]*$/u.test(key))
  ) {
    throw new IngressError("ALLOWLIST_INVALID");
  }
  options.allowedKeys.sort();
  return options;
}

function parseEnvironmentFile(text) {
  const entries = new Map();
  const lines = text.split(/\r?\n/u);
  let ignoredLineCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const original = lines[index];
    const trimmed = original.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      ignoredLineCount += 1;
      continue;
    }
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length)
      : trimmed;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(withoutExport);
    if (match === null) {
      throw new IngressError("SOURCE_LINE_INVALID", index + 1);
    }
    const key = match[1];
    if (entries.has(key)) {
      throw new IngressError("SOURCE_KEY_DUPLICATE", index + 1);
    }
    const value = match[2].trim();
    if (value.includes("\0")) {
      throw new IngressError("SOURCE_VALUE_INVALID", index + 1);
    }
    entries.set(key, value);
  }
  return { entries, ignoredLineCount };
}

function sameStableIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readStableSource(sourcePath, repositoryRoot) {
  const requestedPath = path.resolve(sourcePath);
  let requestedStat;
  let canonicalSource;
  try {
    requestedStat = await fs.lstat(requestedPath, { bigint: true });
    canonicalSource = await fs.realpath(requestedPath);
  } catch {
    throw new IngressError("SOURCE_READ_FAILED");
  }
  if (requestedStat.isSymbolicLink()) {
    throw new IngressError("SOURCE_SYMLINK_DENIED");
  }
  if (!requestedStat.isFile()) {
    throw new IngressError("SOURCE_NOT_REGULAR_FILE");
  }
  if (requestedStat.size > BigInt(MAX_SOURCE_BYTES)) {
    throw new IngressError("SOURCE_SIZE_LIMIT_EXCEEDED");
  }
  if (!sameFilesystemPath(requestedPath, canonicalSource)) {
    throw new IngressError("SOURCE_PATH_REDIRECTION_DENIED");
  }
  if (!isOutsideRoot(repositoryRoot, canonicalSource)) {
    throw new IngressError("SOURCE_MUST_BE_OUTSIDE_REPOSITORY");
  }

  const noFollowFlag =
    process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  let contents;
  let beforeHandleStat;
  let afterHandleStat;
  try {
    handle = await fs.open(requestedPath, fsConstants.O_RDONLY | noFollowFlag);
    beforeHandleStat = await handle.stat({ bigint: true });
    if (!beforeHandleStat.isFile()) {
      throw new IngressError("SOURCE_NOT_REGULAR_FILE");
    }
    contents = await handle.readFile();
    afterHandleStat = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The fail-closed sanitized error below remains authoritative.
      }
    }
    if (error instanceof IngressError) throw error;
    throw new IngressError("SOURCE_READ_FAILED");
  }

  let afterPathStat;
  let afterRealPath;
  try {
    afterPathStat = await fs.lstat(requestedPath, { bigint: true });
    afterRealPath = await fs.realpath(requestedPath);
  } catch {
    throw new IngressError("SOURCE_CHANGED_DURING_READ");
  }
  if (
    afterPathStat.isSymbolicLink() ||
    !afterPathStat.isFile() ||
    !sameFilesystemPath(requestedPath, afterRealPath) ||
    !sameStableIdentity(requestedStat, beforeHandleStat) ||
    !sameStableIdentity(beforeHandleStat, afterHandleStat) ||
    !sameStableIdentity(afterHandleStat, afterPathStat) ||
    contents.length !== Number(afterHandleStat.size)
  ) {
    throw new IngressError("SOURCE_CHANGED_DURING_READ");
  }
  if (contents.includes(0)) {
    throw new IngressError("SOURCE_ENCODING_INVALID");
  }
  const text = contents.toString("utf8");
  if (text.includes("\uFFFD")) {
    throw new IngressError("SOURCE_ENCODING_INVALID");
  }
  return text;
}

async function verifyDestination(destination, repositoryRoot) {
  const absoluteDestination = path.isAbsolute(destination)
    ? path.resolve(destination)
    : path.resolve(repositoryRoot, destination);
  if (isOutsideRoot(repositoryRoot, absoluteDestination)) {
    throw new IngressError("DESTINATION_OUTSIDE_REPOSITORY");
  }

  const relativeDestination = normalizeRepositoryPath(
    path.relative(repositoryRoot, absoluteDestination),
  );
  if (
    relativeDestination.includes("/") ||
    relativeDestination === ".env.example" ||
    !/^(?:\.env(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_-]+\.env)$/u.test(
      relativeDestination,
    )
  ) {
    throw new IngressError("DESTINATION_NAME_DENIED");
  }

  const ignoredStatus = runGitStatus(repositoryRoot, [
    "check-ignore",
    "--quiet",
    "--no-index",
    "--",
    relativeDestination,
  ]);
  if (ignoredStatus === 1) {
    throw new IngressError("DESTINATION_NOT_IGNORED");
  }
  if (ignoredStatus !== 0) {
    throw new IngressError("GIT_COMMAND_FAILED");
  }

  const trackedStatus = runGitStatus(repositoryRoot, [
    "ls-files",
    "--error-unmatch",
    "--",
    relativeDestination,
  ]);
  if (trackedStatus === 0) {
    throw new IngressError("DESTINATION_TRACKED");
  }
  if (trackedStatus !== 1) {
    throw new IngressError("GIT_COMMAND_FAILED");
  }

  try {
    await fs.lstat(absoluteDestination);
    throw new IngressError("DESTINATION_EXISTS");
  } catch (error) {
    if (error instanceof IngressError) throw error;
    if (error?.code !== "ENOENT") {
      throw new IngressError("DESTINATION_IDENTITY_FAILED");
    }
  }
  return { absoluteDestination, relativeDestination };
}

async function writeExclusive(destination, contents) {
  let handle;
  try {
    handle = await fs.open(destination, "wx", 0o600);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.chmod(destination, 0o600);
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The sanitized failure below remains authoritative.
      }
    }
    try {
      await fs.unlink(destination);
    } catch {
      // The sanitized failure below remains authoritative.
    }
    throw new IngressError("DESTINATION_WRITE_FAILED");
  }
}

async function ingest(options) {
  const scanReport = await scanRepository({
    repositoryRoot: options.repositoryRoot,
    policyPath: options.policyPath,
  });
  if (scanReport.status !== "clean") {
    throw new IngressError("REPOSITORY_SECRET_POLICY_FAILED");
  }

  let repositoryRoot;
  try {
    repositoryRoot = await fs.realpath(path.resolve(options.repositoryRoot));
  } catch {
    throw new IngressError("REPOSITORY_IDENTITY_FAILED");
  }
  const destination = await verifyDestination(
    options.destination,
    repositoryRoot,
  );
  const sourceText = await readStableSource(options.source, repositoryRoot);
  const parsed = parseEnvironmentFile(sourceText);
  const selected = [];
  for (const key of options.allowedKeys) {
    if (!parsed.entries.has(key)) {
      throw new IngressError("REQUIRED_KEY_MISSING");
    }
    const value = parsed.entries.get(key);
    if (value.length === 0 || value === '""' || value === "''") {
      throw new IngressError("REQUIRED_VALUE_EMPTY");
    }
    selected.push(`${key}=${value}`);
  }

  await writeExclusive(
    destination.absoluteDestination,
    `${selected.join("\n")}\n`,
  );
  return {
    schemaVersion: 1,
    status: "imported",
    destination: destination.relativeDestination,
    importedKeys: [...options.allowedKeys],
    importedKeyCount: options.allowedKeys.length,
    ignoredKeyCount: parsed.entries.size - options.allowedKeys.length,
    valuesEmitted: false,
  };
}

function safeError(error) {
  const report = {
    schemaVersion: 1,
    status: "error",
    code: error instanceof IngressError ? error.code : "UNCLASSIFIED_INGRESS_ERROR",
    valuesEmitted: false,
  };
  if (error instanceof IngressError && error.line !== undefined) {
    report.line = error.line;
  }
  return report;
}

function render(report, format) {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  if (report.status === "imported") {
    return `credential-ingress: IMPORTED destination=${report.destination} keys=${report.importedKeys.join(",")} ignored_keys=${report.ignoredKeyCount}\nvalues_emitted=false\n`;
  }
  const line = report.line === undefined ? "" : ` line=${report.line}`;
  return `credential-ingress: ERROR code=${report.code}${line}\nvalues_emitted=false\n`;
}

async function runCli() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        "Usage: node tools/secret-policy/ingest-env.mjs --repo PATH --source PATH --allow KEY [--allow KEY ...] [--destination .env] [--format text|json]\n",
      );
      return 0;
    }
    const report = await ingest(options);
    process.stdout.write(render(report, options.format));
    return 0;
  } catch (error) {
    const format = options?.format === "text" ? "text" : "json";
    process.stdout.write(render(safeError(error), format));
    return 2;
  }
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath !== "" && sameFilesystemPath(invokedPath, MODULE_PATH)) {
  process.exitCode = await runCli();
}
