import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MODULE_PATH = fileURLToPath(import.meta.url);
const MODULE_DIRECTORY = path.dirname(MODULE_PATH);
const DEFAULT_POLICY_PATH = path.join(MODULE_DIRECTORY, "policy.json");
const GIT_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_REPORTED_PATH_CHARACTERS = 512;

class SecretPolicyError extends Error {
  constructor(code, relativePath = undefined) {
    super(code);
    this.name = "SecretPolicyError";
    this.code = code;
    this.relativePath = relativePath;
  }
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sameFilesystemPath(left, right) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

export function normalizeRepositoryPath(input) {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new SecretPolicyError("INVALID_REPOSITORY_PATH");
  }

  const slashPath = input.normalize("NFC").replaceAll("\\", "/");
  if (
    slashPath.startsWith("/") ||
    slashPath.startsWith("//") ||
    /^[A-Za-z]:\//u.test(slashPath)
  ) {
    throw new SecretPolicyError("PATH_OUTSIDE_REPOSITORY");
  }

  const normalized = path.posix.normalize(slashPath).replace(/^\.\//u, "");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new SecretPolicyError("PATH_OUTSIDE_REPOSITORY");
  }
  return normalized;
}

export function sanitizePathControls(input) {
  if (typeof input !== "string") return "[REDACTED_PATH]";
  return input.replace(/[\u0000-\u001F\u007F-\u009F]+/gu, "[CONTROL]");
}

export function sanitizeOutputPath(input, secretPatterns) {
  let sanitized = sanitizePathControls(input);
  for (const pattern of secretPatterns) {
    pattern.expression.lastIndex = 0;
    sanitized = sanitized.replace(pattern.expression, "[REDACTED]");
    pattern.expression.lastIndex = 0;
  }
  if (sanitized.length > MAX_REPORTED_PATH_CHARACTERS) {
    sanitized = `${sanitized.slice(0, MAX_REPORTED_PATH_CHARACTERS - 11)}[TRUNCATED]`;
  }
  return sanitized;
}

function secretRuleIdsInPath(relativePath, secretPatterns) {
  const ruleIds = [];
  for (const pattern of secretPatterns) {
    pattern.expression.lastIndex = 0;
    if (pattern.expression.test(relativePath)) ruleIds.push(pattern.id);
    pattern.expression.lastIndex = 0;
  }
  return ruleIds;
}

function validateStringArray(value, code) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SecretPolicyError(code);
  }
}

function compileRegex(regexSource, flags, code) {
  if (typeof regexSource !== "string" || typeof flags !== "string") {
    throw new SecretPolicyError(code);
  }
  if (/[^dgimsuvy]/u.test(flags)) {
    throw new SecretPolicyError(code);
  }
  const effectiveFlags = flags.includes("g") ? flags : `${flags}g`;
  try {
    const expression = new RegExp(regexSource, effectiveFlags);
    expression.lastIndex = 0;
    if (expression.test("")) {
      throw new SecretPolicyError(code);
    }
    expression.lastIndex = 0;
    return expression;
  } catch (error) {
    if (error instanceof SecretPolicyError) throw error;
    throw new SecretPolicyError(code);
  }
}

async function loadPolicy(policyPath) {
  let rawPolicy;
  try {
    rawPolicy = await fs.readFile(policyPath, "utf8");
  } catch {
    throw new SecretPolicyError("POLICY_READ_FAILED");
  }

  let policy;
  try {
    policy = JSON.parse(rawPolicy);
  } catch {
    throw new SecretPolicyError("POLICY_PARSE_FAILED");
  }

  if (
    policy === null ||
    typeof policy !== "object" ||
    policy.schemaVersion !== 1 ||
    typeof policy.policyId !== "string" ||
    policy.policyId.length === 0 ||
    policy.scan === null ||
    typeof policy.scan !== "object" ||
    !Number.isSafeInteger(policy.scan.maxFileBytes) ||
    policy.scan.maxFileBytes <= 0 ||
    !Number.isSafeInteger(policy.scan.maxFindings) ||
    policy.scan.maxFindings <= 0 ||
    policy.valueFreeEnvironmentTemplates === null ||
    typeof policy.valueFreeEnvironmentTemplates !== "object" ||
    typeof policy.valueFreeEnvironmentTemplates.ruleId !== "string" ||
    policy.valueFreeEnvironmentTemplates.ruleId.length === 0 ||
    !Array.isArray(policy.prohibitedPaths) ||
    !Array.isArray(policy.secretPatterns)
  ) {
    throw new SecretPolicyError("POLICY_SCHEMA_INVALID");
  }
  validateStringArray(
    policy.valueFreeEnvironmentTemplates.paths,
    "POLICY_SCHEMA_INVALID",
  );

  const valueFreeTemplatePaths = new Set(
    policy.valueFreeEnvironmentTemplates.paths.map((templatePath) =>
      normalizeRepositoryPath(templatePath),
    ),
  );
  if (
    valueFreeTemplatePaths.size !==
    policy.valueFreeEnvironmentTemplates.paths.length
  ) {
    throw new SecretPolicyError("POLICY_TEMPLATE_PATH_DUPLICATE");
  }

  const pathIds = new Set();
  const prohibitedPaths = policy.prohibitedPaths.map((rule) => {
    if (
      rule === null ||
      typeof rule !== "object" ||
      typeof rule.id !== "string" ||
      rule.id.length === 0 ||
      typeof rule.regex !== "string"
    ) {
      throw new SecretPolicyError("POLICY_PATH_RULE_INVALID");
    }
    validateStringArray(rule.allow, "POLICY_PATH_RULE_INVALID");
    if (pathIds.has(rule.id)) {
      throw new SecretPolicyError("POLICY_RULE_ID_DUPLICATE");
    }
    pathIds.add(rule.id);
    return {
      id: rule.id,
      expression: compileRegex(rule.regex, "iu", "POLICY_PATH_RULE_INVALID"),
      allow: rule.allow.map((source) =>
        compileRegex(source, "iu", "POLICY_PATH_RULE_INVALID"),
      ),
    };
  });

  const contentIds = new Set();
  if (pathIds.has(policy.valueFreeEnvironmentTemplates.ruleId)) {
    throw new SecretPolicyError("POLICY_RULE_ID_DUPLICATE");
  }
  contentIds.add(policy.valueFreeEnvironmentTemplates.ruleId);
  const secretPatterns = policy.secretPatterns.map((rule) => {
    if (
      rule === null ||
      typeof rule !== "object" ||
      typeof rule.id !== "string" ||
      rule.id.length === 0
    ) {
      throw new SecretPolicyError("POLICY_CONTENT_RULE_INVALID");
    }
    if (contentIds.has(rule.id) || pathIds.has(rule.id)) {
      throw new SecretPolicyError("POLICY_RULE_ID_DUPLICATE");
    }
    contentIds.add(rule.id);
    return {
      id: rule.id,
      expression: compileRegex(
        rule.regex,
        rule.flags,
        "POLICY_CONTENT_RULE_INVALID",
      ),
    };
  });

  return {
    schemaVersion: policy.schemaVersion,
    policyId: policy.policyId,
    maxFileBytes: policy.scan.maxFileBytes,
    maxFindings: policy.scan.maxFindings,
    valueFreeEnvironmentTemplates: {
      ruleId: policy.valueFreeEnvironmentTemplates.ruleId,
      paths: valueFreeTemplatePaths,
    },
    prohibitedPaths,
    secretPatterns,
  };
}

async function runGit(repositoryRoot, args) {
  try {
    const result = await execFileAsync("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      windowsHide: true,
    });
    return result.stdout;
  } catch {
    throw new SecretPolicyError("GIT_COMMAND_FAILED");
  }
}

async function verifyRepositoryIdentity(repositoryRoot) {
  let requestedRoot;
  try {
    requestedRoot = await fs.realpath(path.resolve(repositoryRoot));
    const stat = await fs.stat(requestedRoot);
    if (!stat.isDirectory()) {
      throw new SecretPolicyError("REPOSITORY_NOT_DIRECTORY");
    }
  } catch (error) {
    if (error instanceof SecretPolicyError) throw error;
    throw new SecretPolicyError("REPOSITORY_IDENTITY_FAILED");
  }

  const topLevelOutput = await runGit(requestedRoot, [
    "rev-parse",
    "--show-toplevel",
  ]);
  const reportedRoot = topLevelOutput.trim();
  if (reportedRoot.length === 0) {
    throw new SecretPolicyError("REPOSITORY_IDENTITY_FAILED");
  }

  let canonicalReportedRoot;
  try {
    canonicalReportedRoot = await fs.realpath(reportedRoot);
  } catch {
    throw new SecretPolicyError("REPOSITORY_IDENTITY_FAILED");
  }
  if (!sameFilesystemPath(requestedRoot, canonicalReportedRoot)) {
    throw new SecretPolicyError("REPOSITORY_ROOT_MISMATCH");
  }
  return requestedRoot;
}

async function enumerateRepositoryFiles(repositoryRoot) {
  const output = await runGit(repositoryRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--full-name",
    "-z",
  ]);
  const files = output
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => normalizeRepositoryPath(entry));
  return [...new Set(files)].sort(compareText);
}

function pathRuleFor(relativePath, rules) {
  const policyPath = relativePath.toLowerCase();
  for (const rule of rules) {
    rule.expression.lastIndex = 0;
    if (!rule.expression.test(policyPath)) continue;
    const allowed = rule.allow.some((allowExpression) => {
      allowExpression.lastIndex = 0;
      return allowExpression.test(policyPath);
    });
    if (!allowed) return rule.id;
  }
  return undefined;
}

function buildLineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineNumberAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function safeAbsolutePath(repositoryRoot, relativePath) {
  const absolutePath = path.resolve(repositoryRoot, ...relativePath.split("/"));
  const relation = path.relative(repositoryRoot, absolutePath);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new SecretPolicyError("PATH_OUTSIDE_REPOSITORY", relativePath);
  }
  return absolutePath;
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

async function readStableRegularFile(
  repositoryRoot,
  relativePath,
  maxFileBytes,
) {
  const absolutePath = safeAbsolutePath(repositoryRoot, relativePath);
  let beforePathStat;
  let beforeRealPath;
  try {
    beforePathStat = await fs.lstat(absolutePath, { bigint: true });
    beforeRealPath = await fs.realpath(absolutePath);
  } catch {
    throw new SecretPolicyError("FILE_IDENTITY_FAILED", relativePath);
  }
  if (beforePathStat.isSymbolicLink()) {
    throw new SecretPolicyError("SYMLINK_SCAN_DENIED", relativePath);
  }
  if (!beforePathStat.isFile()) {
    throw new SecretPolicyError("NON_REGULAR_FILE_DENIED", relativePath);
  }
  if (!sameFilesystemPath(absolutePath, beforeRealPath)) {
    throw new SecretPolicyError("FILE_PATH_REDIRECTION_DENIED", relativePath);
  }
  if (beforePathStat.size > BigInt(maxFileBytes)) {
    throw new SecretPolicyError("FILE_SIZE_LIMIT_EXCEEDED", relativePath);
  }

  const noFollowFlag =
    process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  let contents;
  let beforeHandleStat;
  let afterHandleStat;
  try {
    handle = await fs.open(absolutePath, fsConstants.O_RDONLY | noFollowFlag);
    beforeHandleStat = await handle.stat({ bigint: true });
    if (!beforeHandleStat.isFile()) {
      throw new SecretPolicyError("NON_REGULAR_FILE_DENIED", relativePath);
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
    if (error instanceof SecretPolicyError) throw error;
    throw new SecretPolicyError("FILE_READ_FAILED", relativePath);
  }

  let afterPathStat;
  let afterRealPath;
  try {
    afterPathStat = await fs.lstat(absolutePath, { bigint: true });
    afterRealPath = await fs.realpath(absolutePath);
  } catch {
    throw new SecretPolicyError("FILE_CHANGED_DURING_SCAN", relativePath);
  }
  if (
    afterPathStat.isSymbolicLink() ||
    !afterPathStat.isFile() ||
    !sameFilesystemPath(absolutePath, afterRealPath) ||
    !sameStableIdentity(beforePathStat, beforeHandleStat) ||
    !sameStableIdentity(beforeHandleStat, afterHandleStat) ||
    !sameStableIdentity(afterHandleStat, afterPathStat) ||
    contents.length !== Number(afterHandleStat.size)
  ) {
    throw new SecretPolicyError("FILE_CHANGED_DURING_SCAN", relativePath);
  }
  return contents;
}

function addValueFreeTemplateFindings(
  text,
  reportedPath,
  ruleId,
  findings,
) {
  const keys = new Set();
  const lines = text.split(/\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/u, "");
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=$/u.exec(trimmed);
    if (match === null || keys.has(match[1])) {
      findings.push({
        type: "template_policy",
        ruleId,
        path: reportedPath,
        line: index + 1,
      });
      continue;
    }
    keys.add(match[1]);
  }
}

function safeError(error, sanitizePath = sanitizePathControls) {
  if (error instanceof SecretPolicyError) {
    return error.relativePath === undefined
      ? { code: error.code }
      : { code: error.code, path: sanitizePath(error.relativePath) };
  }
  return { code: "UNCLASSIFIED_SCANNER_ERROR" };
}

function sortFindings(findings) {
  findings.sort((left, right) => {
    return (
      compareText(left.path, right.path) ||
      compareText(left.ruleId, right.ruleId) ||
      (left.line ?? 0) - (right.line ?? 0)
    );
  });
}

function sortErrors(errors) {
  errors.sort((left, right) => {
    return (
      compareText(left.path ?? "", right.path ?? "") ||
      compareText(left.code, right.code)
    );
  });
}

export async function scanRepository({
  repositoryRoot,
  policyPath = DEFAULT_POLICY_PATH,
}) {
  const policy = await loadPolicy(path.resolve(policyPath));
  const verifiedRoot = await verifyRepositoryIdentity(repositoryRoot);
  const repositoryFiles = await enumerateRepositoryFiles(verifiedRoot);
  const findings = [];
  const errors = [];
  let scannedFileCount = 0;
  const reportPath = (relativePath) =>
    sanitizeOutputPath(relativePath, policy.secretPatterns);

  for (const relativePath of repositoryFiles) {
    const prohibitedRuleId = pathRuleFor(
      relativePath,
      policy.prohibitedPaths,
    );
    if (prohibitedRuleId !== undefined) {
      findings.push({
        type: "prohibited_path",
        ruleId: prohibitedRuleId,
        path: reportPath(relativePath),
        line: null,
      });
      continue;
    }

    const pathSecretRuleIds = secretRuleIdsInPath(
      relativePath,
      policy.secretPatterns,
    );
    if (pathSecretRuleIds.length > 0) {
      for (const ruleId of pathSecretRuleIds) {
        findings.push({
          type: "secret_pattern_in_path",
          ruleId,
          path: reportPath(relativePath),
          line: null,
        });
      }
      continue;
    }

    try {
      const contents = await readStableRegularFile(
        verifiedRoot,
        relativePath,
        policy.maxFileBytes,
      );
      const text = contents.toString("utf8");
      const lineStarts = buildLineStarts(text);
      const findingKeys = new Set();
      scannedFileCount += 1;

      if (policy.valueFreeEnvironmentTemplates.paths.has(relativePath)) {
        addValueFreeTemplateFindings(
          text,
          reportPath(relativePath),
          policy.valueFreeEnvironmentTemplates.ruleId,
          findings,
        );
      }

      for (const pattern of policy.secretPatterns) {
        pattern.expression.lastIndex = 0;
        let match;
        while ((match = pattern.expression.exec(text)) !== null) {
          const line = lineNumberAt(lineStarts, match.index);
          const findingKey = `${pattern.id}\0${line}`;
          if (!findingKeys.has(findingKey)) {
            findingKeys.add(findingKey);
            findings.push({
              type: "secret_pattern",
              ruleId: pattern.id,
              path: reportPath(relativePath),
              line,
            });
          }
          if (findings.length > policy.maxFindings) {
            throw new SecretPolicyError(
              "FINDING_LIMIT_EXCEEDED",
              relativePath,
            );
          }
          if (match[0].length === 0) pattern.expression.lastIndex += 1;
        }
      }
      if (findings.length > policy.maxFindings) {
        throw new SecretPolicyError(
          "FINDING_LIMIT_EXCEEDED",
          relativePath,
        );
      }
    } catch (error) {
      errors.push(safeError(error, reportPath));
    }
  }

  sortFindings(findings);
  sortErrors(errors);
  const status =
    errors.length > 0 ? "error" : findings.length > 0 ? "findings" : "clean";

  return {
    schemaVersion: 1,
    status,
    repositoryIdentityVerified: true,
    policyId: policy.policyId,
    enumeratedFileCount: repositoryFiles.length,
    scannedFileCount,
    findingCount: findings.length,
    errorCount: errors.length,
    valuesEmitted: false,
    findings,
    errors,
  };
}

export function renderReport(report, format) {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  const lines = [
    `secret-policy: ${report.status.toUpperCase()} enumerated=${report.enumeratedFileCount ?? 0} scanned=${report.scannedFileCount ?? 0} findings=${report.findingCount ?? 0} errors=${report.errorCount ?? 0}`,
  ];
  for (const finding of report.findings ?? []) {
    const location =
      finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
    lines.push(`FINDING rule=${finding.ruleId} path=${location}`);
  }
  for (const error of report.errors ?? []) {
    const location = error.path === undefined ? "" : ` path=${error.path}`;
    lines.push(`ERROR code=${error.code}${location}`);
  }
  lines.push("values_emitted=false");
  return `${lines.join("\n")}\n`;
}

function parseArguments(args) {
  const options = {
    repositoryRoot: process.cwd(),
    policyPath: DEFAULT_POLICY_PATH,
    format: "text",
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (["--repo", "--policy", "--format"].includes(argument)) {
      const value = args[index + 1];
      if (value === undefined) throw new SecretPolicyError("CLI_ARGUMENT_INVALID");
      index += 1;
      if (argument === "--repo") options.repositoryRoot = value;
      if (argument === "--policy") options.policyPath = value;
      if (argument === "--format") options.format = value;
      continue;
    }
    throw new SecretPolicyError("CLI_ARGUMENT_INVALID");
  }
  if (!new Set(["json", "text"]).has(options.format)) {
    throw new SecretPolicyError("CLI_ARGUMENT_INVALID");
  }
  return options;
}

function errorReport(error) {
  return {
    schemaVersion: 1,
    status: "error",
    repositoryIdentityVerified: false,
    policyId: null,
    enumeratedFileCount: 0,
    scannedFileCount: 0,
    findingCount: 0,
    errorCount: 1,
    valuesEmitted: false,
    findings: [],
    errors: [safeError(error)],
  };
}

async function runCli() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        "Usage: node tools/secret-policy/scan.mjs [--repo PATH] [--policy PATH] [--format text|json]\n",
      );
      return 0;
    }
    const report = await scanRepository(options);
    process.stdout.write(renderReport(report, options.format));
    if (report.status === "clean") return 0;
    if (report.status === "findings") return 1;
    return 2;
  } catch (error) {
    const format = options?.format === "text" ? "text" : "json";
    process.stdout.write(renderReport(errorReport(error), format));
    return 2;
  }
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath !== "" && sameFilesystemPath(invokedPath, MODULE_PATH)) {
  process.exitCode = await runCli();
}
