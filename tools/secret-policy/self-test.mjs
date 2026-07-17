import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeRepositoryPath,
  sanitizeOutputPath,
  sanitizePathControls,
} from "./scan.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SCANNER_PATH = path.join(MODULE_DIRECTORY, "scan.mjs");
const INGRESS_PATH = path.join(MODULE_DIRECTORY, "ingest-env.mjs");
const POLICY_PATH = path.join(MODULE_DIRECTORY, "policy.json");
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "..", "..");
const TARGET_GITIGNORE = path.join(REPOSITORY_ROOT, ".gitignore");
const TEMP_PREFIX = "cos-secret-policy-self-test-";
const ASSIGNMENT_RULE_IDS = [
  "aws-secret-access-key-assignment",
  "high-confidence-secret-assignment",
  "presigned-request-signature",
];

class TestFailure extends Error {
  constructor(label) {
    super(label);
    this.name = "TestFailure";
    this.label = label;
  }
}
let checkCount = 0;

function check(condition, label) {
  checkCount += 1;
  if (!condition) throw new TestFailure(label);
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status === null) {
    throw new TestFailure("child-process-execution");
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    combined: `${result.stdout}${result.stderr}`,
  };
}

function runGit(repositoryRoot, args) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: "ignore",
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new TestFailure("temporary-git-command");
  }
}

function runGitStatus(repositoryRoot, args) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: "ignore",
  });
  if (result.error !== undefined || result.status === null) {
    throw new TestFailure("temporary-git-status-command");
  }
  return result.status;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new TestFailure(label);
  }
}

async function createRepository(directory) {
  await fs.mkdir(directory, { recursive: true });
  runGit(directory, ["init", "--quiet"]);
}

function makeSecrets() {
  const encode = (value) => Buffer.from(value, "utf8").toString("base64url");
  return {
    awsAccessKey: `${["AK", "IA"].join("")}${"A".repeat(16)}`,
    awsSecret: `${"b".repeat(20)}${"C".repeat(20)}`,
    github: `${["gh", "p_"].join("")}${"d".repeat(40)}`,
    openai: `${["s", "k-proj-"].join("")}${"e".repeat(32)}`,
    google: `${["AI", "za"].join("")}${"F".repeat(35)}`,
    slack: `${["xo", "xb-"].join("")}${"1234567890-abcdefghij"}`,
    slackWebhook: `${["https://hooks.", "slack.com/services/"].join("")}TABC123/BDEF456/${"g".repeat(24)}`,
    jwt: `${encode('{"alg":"HS256"}')}.${encode('{"sub":"fixture"}')}.${"h".repeat(24)}`,
    pem: ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
    presigned: `${["X-Amz-", "Signature="].join("")}${"a".repeat(64)}`,
    generic: "N".repeat(24),
  };
}

function assertNoValues(output, values, label) {
  for (const value of values) {
    check(!output.includes(value), label);
  }
}

async function safeRemoveTempRoot(tempRoot) {
  const resolvedTemp = path.resolve(os.tmpdir());
  const resolvedRoot = path.resolve(tempRoot);
  if (
    path.dirname(resolvedRoot) !== resolvedTemp ||
    !path.basename(resolvedRoot).startsWith(TEMP_PREFIX)
  ) {
    throw new TestFailure("temporary-cleanup-boundary");
  }
  await fs.rm(resolvedRoot, { recursive: true, force: true });
  try {
    await fs.lstat(resolvedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new TestFailure("temporary-cleanup-verification");
  }
  throw new TestFailure("temporary-cleanup-verification");
}

async function runTests(tempRoot) {
  const secrets = makeSecrets();
  const secretValues = Object.values(secrets);
  const assignmentValues = [
    secrets.awsSecret,
    secrets.generic,
    "a".repeat(64),
  ];

  const policy = parseJson(
    await fs.readFile(POLICY_PATH, "utf8"),
    "assignment-policy-json",
  );
  const assignmentRules = new Map(
    policy.secretPatterns
      .filter((rule) => ASSIGNMENT_RULE_IDS.includes(rule.id))
      .map((rule) => [rule.id, rule]),
  );
  check(
    assignmentRules.size === ASSIGNMENT_RULE_IDS.length,
    "assignment-policy-rule-count",
  );
  const assignmentSamples = new Map([
    [
      "aws-secret-access-key-assignment",
      {
        crossLine: `AWS_SECRET_ACCESS_KEY =\r\n${secrets.awsSecret}`,
        sameLine: `AWS_SECRET_ACCESS_KEY \t= \t${secrets.awsSecret}`,
      },
    ],
    [
      "high-confidence-secret-assignment",
      {
        crossLine: `client_secret :\n${secrets.generic}`,
        sameLine: `client_secret\t:\t"${secrets.generic}"`,
      },
    ],
    [
      "presigned-request-signature",
      {
        crossLine: `${["X-Amz-", "Signature="].join("")}\r\n${"a".repeat(64)}`,
        sameLine: secrets.presigned,
      },
    ],
  ]);
  for (const ruleId of ASSIGNMENT_RULE_IDS) {
    const rule = assignmentRules.get(ruleId);
    check(rule !== undefined, `assignment-policy-rule-${ruleId}`);
    const expression = new RegExp(rule.regex, rule.flags);
    const sample = assignmentSamples.get(ruleId);
    expression.lastIndex = 0;
    check(
      expression.exec(sample.crossLine) === null,
      `assignment-cross-line-rejected-${ruleId}`,
    );
    expression.lastIndex = 0;
    const sameLineMatch = expression.exec(`header\r\n${sample.sameLine}`);
    check(sameLineMatch !== null, `assignment-same-line-detected-${ruleId}`);
    check(
      !/[\r\n]/u.test(sameLineMatch[0]),
      `assignment-full-match-line-bound-${ruleId}`,
    );
  }

  check(
    normalizeRepositoryPath("config\\team-kit-applicability\\registry.json") ===
      "config/team-kit-applicability/registry.json",
    "windows-path-normalization",
  );
  check(
    normalizeRepositoryPath("docs/operations/credential-ingress.md") ===
      "docs/operations/credential-ingress.md",
    "linux-path-normalization",
  );
  let traversalRejected = false;
  try {
    normalizeRepositoryPath("..\\outside.env");
  } catch {
    traversalRejected = true;
  }
  check(traversalRejected, "path-traversal-rejected");
  check(
    sanitizePathControls("safe/\nname\t.txt") ===
      "safe/[CONTROL]name[CONTROL].txt",
    "control-path-sanitization",
  );
  const sanitizedErrorPath = sanitizeOutputPath(
    `errors/${secrets.github}\nfailed.txt`,
    [
      {
        expression: new RegExp(
          "\\bgh[p]_[A-Za-z0-9_]{36,255}\\b",
          "g",
        ),
      },
    ],
  );
  check(
    sanitizedErrorPath.includes("[REDACTED]") &&
      sanitizedErrorPath.includes("[CONTROL]") &&
      !sanitizedErrorPath.includes(secrets.github),
    "error-path-value-redaction",
  );

  const ignoreBehaviorRepo = path.join(tempRoot, "gitignore-behavior-repo");
  await createRepository(ignoreBehaviorRepo);
  const targetGitignore = await fs.readFile(TARGET_GITIGNORE, "utf8");
  await fs.writeFile(
    path.join(ignoreBehaviorRepo, ".gitignore"),
    targetGitignore,
  );
  for (const ignoredPath of [
    ".env",
    "credential-export.json",
    "github-token.txt",
    "auth-export.yaml",
    "client-secret-export.json",
    "service-account-prod.yml",
  ]) {
    check(
      runGitStatus(ignoreBehaviorRepo, [
        "check-ignore",
        "--quiet",
        "--no-index",
        "--",
        ignoredPath,
      ]) === 0,
      `target-gitignore-ignored-${ignoredPath}`,
    );
  }
  for (const visiblePath of [".env.example", "src/design-tokens.json"]) {
    check(
      runGitStatus(ignoreBehaviorRepo, [
        "check-ignore",
        "--quiet",
        "--no-index",
        "--",
        visiblePath,
      ]) === 1,
      `target-gitignore-visible-${visiblePath}`,
    );
  }

  const positiveRepo = path.join(tempRoot, "positive-repo");
  await createRepository(positiveRepo);
  const positiveLines = [
    secrets.awsAccessKey,
    `AWS_SECRET_ACCESS_KEY=${secrets.awsSecret}`,
    secrets.github,
    secrets.openai,
    secrets.google,
    secrets.slack,
    secrets.slackWebhook,
    secrets.jwt,
    secrets.pem,
    `${secrets.presigned}`,
    `client_secret=${secrets.generic}`,
  ];
  await fs.writeFile(path.join(positiveRepo, "leaks.txt"), positiveLines.join("\n"));
  await fs.writeFile(path.join(positiveRepo, ".env"), `TOKEN=${secrets.generic}\n`);
  await fs.writeFile(
    path.join(positiveRepo, ".env.example"),
    `SHOULD_BE_EMPTY=${secrets.generic}\n`,
  );
  await fs.writeFile(
    path.join(positiveRepo, "developer-accessKeys.csv"),
    `id,secret\nfixture,${secrets.awsSecret}\n`,
  );
  await fs.writeFile(path.join(positiveRepo, "id_ed25519"), secrets.pem);
  await fs.writeFile(
    path.join(positiveRepo, "token.json"),
    JSON.stringify({ token: secrets.github }),
  );
  for (const decoratedName of [
    "github-token.txt",
    "credential-export.json",
    "auth-export.yaml",
    "client-secret-export.json",
    "service-account-prod.yml",
  ]) {
    await fs.writeFile(path.join(positiveRepo, decoratedName), "placeholder\n");
  }
  const secretBearingFilename = `${secrets.github}-notes.txt`;
  await fs.writeFile(
    path.join(positiveRepo, secretBearingFilename),
    "safe body\n",
  );

  const positiveArgs = [
    "--repo",
    positiveRepo,
    "--policy",
    POLICY_PATH,
    "--format",
    "json",
  ];
  const positiveFirst = runNode(SCANNER_PATH, positiveArgs);
  const positiveSecond = runNode(SCANNER_PATH, positiveArgs);
  check(positiveFirst.status === 1, "positive-exit-code");
  check(positiveFirst.stdout === positiveSecond.stdout, "deterministic-output");
  check(positiveFirst.stderr === "", "positive-stderr-empty");
  const positiveReport = parseJson(positiveFirst.stdout, "positive-json");
  check(positiveReport.status === "findings", "positive-status");
  check(positiveReport.valuesEmitted === false, "positive-redaction-flag");
  const positiveRuleIds = new Set(
    positiveReport.findings.map((finding) => finding.ruleId),
  );
  for (const requiredRule of [
    "aws-access-key-id",
    "aws-secret-access-key-assignment",
    "github-token",
    "openai-api-key",
    "google-api-or-oauth-secret",
    "slack-token",
    "slack-webhook",
    "jwt",
    "pem-private-key",
    "presigned-request-signature",
    "high-confidence-secret-assignment",
    "dotenv-file",
    "access-key-or-credential-csv",
    "private-key-file",
    "token-or-credential-export",
    "value-free-env-template",
  ]) {
    check(positiveRuleIds.has(requiredRule), `positive-rule-${requiredRule}`);
  }
  for (const decoratedName of [
    "github-token.txt",
    "credential-export.json",
    "auth-export.yaml",
    "client-secret-export.json",
    "service-account-prod.yml",
  ]) {
    check(
      positiveReport.findings.some(
        (finding) =>
          finding.ruleId === "token-or-credential-export" &&
          finding.path === decoratedName,
      ),
      `decorated-export-rejected-${decoratedName}`,
    );
  }
  check(
    positiveReport.findings.some(
      (finding) =>
        finding.type === "secret_pattern_in_path" &&
        finding.ruleId === "github-token" &&
        finding.path.includes("[REDACTED]") &&
        !finding.path.includes(secrets.github),
    ),
    "secret-bearing-filename-redacted",
  );
  assertNoValues(positiveFirst.combined, secretValues, "positive-output-redacted");

  const assignmentCrossLineRepo = path.join(
    tempRoot,
    "assignment-cross-line-repo",
  );
  await createRepository(assignmentCrossLineRepo);
  await fs.writeFile(
    path.join(assignmentCrossLineRepo, "assignments.txt"),
    [...assignmentSamples.values()]
      .map((sample) => sample.crossLine)
      .join("\n"),
  );
  const assignmentCrossLine = runNode(SCANNER_PATH, [
    "--repo",
    assignmentCrossLineRepo,
    "--policy",
    POLICY_PATH,
    "--format",
    "json",
  ]);
  check(assignmentCrossLine.status === 0, "assignment-cross-line-exit-code");
  const assignmentCrossLineReport = parseJson(
    assignmentCrossLine.stdout,
    "assignment-cross-line-json",
  );
  check(
    assignmentCrossLineReport.status === "clean",
    "assignment-cross-line-status",
  );
  check(
    assignmentCrossLineReport.findingCount === 0,
    "assignment-cross-line-no-findings",
  );
  check(
    assignmentCrossLineReport.valuesEmitted === false,
    "assignment-cross-line-redaction-flag",
  );
  assertNoValues(
    assignmentCrossLine.combined,
    assignmentValues,
    "assignment-cross-line-output-redacted",
  );

  const assignmentSameLineRepo = path.join(
    tempRoot,
    "assignment-same-line-repo",
  );
  await createRepository(assignmentSameLineRepo);
  await fs.writeFile(
    path.join(assignmentSameLineRepo, "assignments.txt"),
    [...assignmentSamples.values()].map((sample) => sample.sameLine).join("\n"),
  );
  const assignmentSameLine = runNode(SCANNER_PATH, [
    "--repo",
    assignmentSameLineRepo,
    "--policy",
    POLICY_PATH,
    "--format",
    "json",
  ]);
  check(assignmentSameLine.status === 1, "assignment-same-line-exit-code");
  const assignmentSameLineReport = parseJson(
    assignmentSameLine.stdout,
    "assignment-same-line-json",
  );
  check(
    assignmentSameLineReport.status === "findings",
    "assignment-same-line-status",
  );
  check(
    assignmentSameLineReport.findingCount === ASSIGNMENT_RULE_IDS.length,
    "assignment-same-line-finding-count",
  );
  const assignmentFindingRuleIds = new Set(
    assignmentSameLineReport.findings.map((finding) => finding.ruleId),
  );
  for (const ruleId of ASSIGNMENT_RULE_IDS) {
    check(
      assignmentFindingRuleIds.has(ruleId),
      `assignment-same-line-rule-${ruleId}`,
    );
  }
  check(
    assignmentSameLineReport.valuesEmitted === false,
    "assignment-same-line-redaction-flag",
  );
  assertNoValues(
    assignmentSameLine.combined,
    assignmentValues,
    "assignment-same-line-output-redacted",
  );

  const negativeRepo = path.join(tempRoot, "negative-repo");
  await createRepository(negativeRepo);
  await fs.writeFile(path.join(negativeRepo, ".gitignore"), ".env\n.env.*\n*.env\n!.env.example\n");
  await fs.writeFile(path.join(negativeRepo, ".env"), `TOKEN=${secrets.openai}\n`);
  await fs.writeFile(path.join(negativeRepo, ".env.example"), "TOKEN=\n");
  await fs.writeFile(
    path.join(negativeRepo, "safe.txt"),
    "Credential values are supplied only through an approved ignored file.\n",
  );
  const negative = runNode(SCANNER_PATH, [
    "--repo",
    negativeRepo,
    "--policy",
    POLICY_PATH,
    "--format",
    "json",
  ]);
  check(negative.status === 0, "negative-exit-code");
  const negativeReport = parseJson(negative.stdout, "negative-json");
  check(negativeReport.status === "clean", "negative-status");
  check(negativeReport.findingCount === 0, "negative-no-findings");
  assertNoValues(negative.combined, secretValues, "ignored-output-redacted");

  const trackedIgnoredRepo = path.join(tempRoot, "tracked-ignored-repo");
  await createRepository(trackedIgnoredRepo);
  await fs.writeFile(path.join(trackedIgnoredRepo, ".gitignore"), ".env\n");
  await fs.writeFile(
    path.join(trackedIgnoredRepo, ".env"),
    `TOKEN=${secrets.github}\n`,
  );
  runGit(trackedIgnoredRepo, ["add", "--force", "--", ".env"]);
  const trackedIgnored = runNode(SCANNER_PATH, [
    "--repo",
    trackedIgnoredRepo,
    "--policy",
    POLICY_PATH,
    "--format",
    "json",
  ]);
  check(trackedIgnored.status === 1, "tracked-ignored-exit-code");
  const trackedIgnoredReport = parseJson(
    trackedIgnored.stdout,
    "tracked-ignored-json",
  );
  check(
    trackedIgnoredReport.findings.some(
      (finding) =>
        finding.ruleId === "dotenv-file" && finding.path === ".env",
    ),
    "tracked-ignored-detected",
  );
  assertNoValues(
    trackedIgnored.combined,
    secretValues,
    "tracked-ignored-output-redacted",
  );

  const trackedRootConfigRepo = path.join(
    tempRoot,
    "tracked-root-config-repo",
  );
  await createRepository(trackedRootConfigRepo);
  await fs.writeFile(
    path.join(trackedRootConfigRepo, ".gitignore"),
    "/.config/\n",
  );
  await fs.mkdir(path.join(trackedRootConfigRepo, ".config"));
  await fs.writeFile(
    path.join(trackedRootConfigRepo, ".config", "provider.txt"),
    `${secrets.openai}\n`,
  );
  await fs.writeFile(
    path.join(trackedRootConfigRepo, "safe.txt"),
    "safe body\n",
  );
  runGit(trackedRootConfigRepo, [
    "add",
    "--force",
    "--",
    ".config/provider.txt",
  ]);
  const rootConfigScan = runNode(SCANNER_PATH, [
    "--repo",
    trackedRootConfigRepo,
    "--policy",
    POLICY_PATH,
    "--format",
    "json",
  ]);
  check(rootConfigScan.status === 1, "root-config-exit-code");
  const rootConfigReport = parseJson(rootConfigScan.stdout, "root-config-json");
  check(
    rootConfigReport.findings.some(
      (finding) =>
        finding.ruleId === "root-local-config" &&
        finding.path === ".config/provider.txt" &&
        finding.type === "prohibited_path",
    ),
    "root-config-path-rejected",
  );
  check(
    rootConfigReport.enumeratedFileCount - rootConfigReport.scannedFileCount ===
      1,
    "root-config-not-counted-as-scanned",
  );
  check(
    !rootConfigReport.findings.some(
      (finding) =>
        finding.path === ".config/provider.txt" &&
        finding.type === "secret_pattern",
    ),
    "root-config-content-not-scanned",
  );
  assertNoValues(
    rootConfigScan.combined,
    secretValues,
    "root-config-output-redacted",
  );

  const notRepository = path.join(tempRoot, "not-a-repository");
  await fs.mkdir(notRepository);
  const identityFailure = runNode(SCANNER_PATH, [
    "--repo",
    notRepository,
    "--policy",
    POLICY_PATH,
    "--format",
    "json",
  ]);
  check(identityFailure.status === 2, "identity-failure-exit-code");
  const identityReport = parseJson(identityFailure.stdout, "identity-json");
  check(identityReport.status === "error", "identity-failure-status");
  check(
    identityReport.repositoryIdentityVerified === false,
    "identity-failure-closed",
  );

  const malformedPolicy = path.join(tempRoot, "malformed-policy.json");
  await fs.writeFile(malformedPolicy, "{");
  const policyFailure = runNode(SCANNER_PATH, [
    "--repo",
    negativeRepo,
    "--policy",
    malformedPolicy,
    "--format",
    "json",
  ]);
  check(policyFailure.status === 2, "policy-failure-exit-code");
  const policyReport = parseJson(policyFailure.stdout, "policy-failure-json");
  check(policyReport.status === "error", "policy-failure-status");
  check(
    policyReport.errors[0]?.code === "POLICY_PARSE_FAILED",
    "policy-failure-code",
  );

  const ingressRepo = path.join(tempRoot, "ingress-repo");
  const ingressSourceDirectory = path.join(tempRoot, "account-sources");
  await createRepository(ingressRepo);
  await fs.mkdir(ingressSourceDirectory);
  await fs.writeFile(
    path.join(ingressRepo, ".gitignore"),
    ".env\n.env.*\n*.env\n!.env.example\n",
  );
  const loaderClientId = `fixture-client-${"i".repeat(20)}`;
  const loaderSecret = `fixture-secret-${"j".repeat(24)}`;
  const ignoredValue = `fixture-ignored-${"k".repeat(24)}`;
  const ingressSource = path.join(ingressSourceDirectory, "provider.env");
  await fs.writeFile(
    ingressSource,
    [
      `GOOGLE_CLIENT_ID=${loaderClientId}`,
      `GOOGLE_CLIENT_SECRET=${loaderSecret}`,
      `UNUSED_PROVIDER_VALUE=${ignoredValue}`,
      "",
    ].join("\n"),
  );
  const ingress = runNode(INGRESS_PATH, [
    "--repo",
    ingressRepo,
    "--policy",
    POLICY_PATH,
    "--source",
    ingressSource,
    "--allow",
    "GOOGLE_CLIENT_SECRET",
    "--allow",
    "GOOGLE_CLIENT_ID",
    "--format",
    "json",
  ]);
  check(ingress.status === 0, "ingress-exit-code");
  const ingressReport = parseJson(ingress.stdout, "ingress-json");
  check(ingressReport.status === "imported", "ingress-status");
  check(ingressReport.valuesEmitted === false, "ingress-redaction-flag");
  check(ingressReport.importedKeyCount === 2, "ingress-key-count");
  check(ingressReport.ignoredKeyCount === 1, "ingress-ignored-count");
  assertNoValues(
    ingress.combined,
    [loaderClientId, loaderSecret, ignoredValue],
    "ingress-output-redacted",
  );
  const importedFile = await fs.readFile(path.join(ingressRepo, ".env"), "utf8");
  check(importedFile.includes(loaderClientId), "ingress-client-id-persisted");
  check(importedFile.includes(loaderSecret), "ingress-secret-persisted");
  check(!importedFile.includes(ignoredValue), "ingress-minimum-only");

  const postIngressScan = runNode(SCANNER_PATH, [
    "--repo",
    ingressRepo,
    "--policy",
    POLICY_PATH,
    "--format",
    "json",
  ]);
  check(postIngressScan.status === 0, "post-ingress-scan-exit-code");
  assertNoValues(
    postIngressScan.combined,
    [loaderClientId, loaderSecret, ignoredValue],
    "post-ingress-output-redacted",
  );

  const secondIngress = runNode(INGRESS_PATH, [
    "--repo",
    ingressRepo,
    "--policy",
    POLICY_PATH,
    "--source",
    ingressSource,
    "--allow",
    "GOOGLE_CLIENT_ID",
    "--format",
    "json",
  ]);
  check(secondIngress.status === 2, "existing-destination-exit-code");
  const secondIngressReport = parseJson(
    secondIngress.stdout,
    "existing-destination-json",
  );
  check(
    secondIngressReport.code === "DESTINATION_EXISTS",
    "existing-destination-fails-closed",
  );
  assertNoValues(
    secondIngress.combined,
    [loaderClientId, loaderSecret, ignoredValue],
    "existing-destination-output-redacted",
  );
}

let tempRoot;
let failureLabel;
let cleanupValidated = false;
try {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  await runTests(tempRoot);
} catch (error) {
  failureLabel =
    error instanceof TestFailure ? error.label : "unclassified-test-failure";
} finally {
  if (tempRoot !== undefined) {
    try {
      await safeRemoveTempRoot(tempRoot);
      cleanupValidated = true;
    } catch {
      failureLabel = "temporary-cleanup";
    }
  }
}

if (failureLabel === undefined && cleanupValidated) {
  process.stdout.write(
    `secret-policy self-test: PASS\nchecks=${checkCount}\nfixtures=os-temp-only\ncleanup=validated\nvalues_emitted=false\n`,
  );
} else {
  process.stdout.write(
    `secret-policy self-test: FAIL check=${failureLabel ?? "temporary-cleanup"}\nfixtures=os-temp-only\ncleanup=${cleanupValidated ? "validated" : "failed"}\nvalues_emitted=false\n`,
  );
  process.exitCode = 1;
}
