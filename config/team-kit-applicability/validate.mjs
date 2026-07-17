import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
const MODULE_DIRECTORY = path.dirname(MODULE_PATH);
const DEFAULT_REGISTRY = path.join(MODULE_DIRECTORY, "registry.json");
const DEFAULT_SCHEMA = path.join(MODULE_DIRECTORY, "registry.schema.json");
const ALLOWED_STATES = new Set([
  "adopted",
  "adapted",
  "not_applicable",
  "exception_pending",
]);
const REQUIRED_IDS = new Set([
  "shared_ci_cd",
  "lexicon",
  "main_dashboard",
  "pagerduty",
  "aws_oidc",
  "langsmith",
  "chat_sdk",
  "agentcore_memory",
]);
const TOP_LEVEL_KEYS = [
  "assessment",
  "decisionDate",
  "entries",
  "registryId",
  "schemaVersion",
  "stateSemantics",
];
const ENTRY_KEYS = [
  "accessStatus",
  "capability",
  "dataHandlingImpact",
  "evidence",
  "id",
  "implementationStatus",
  "liveConformanceClaimed",
  "owner",
  "releaseConsequence",
  "sourceContract",
  "state",
  "trigger",
];

class RegistryError extends Error {
  constructor(code) {
    super(code);
    this.name = "RegistryError";
    this.code = code;
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

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

async function parseJsonFile(filePath, readCode, parseCode) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    throw new RegistryError(readCode);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new RegistryError(parseCode);
  }
}

function validateRegistry(registry) {
  if (!exactKeys(registry, TOP_LEVEL_KEYS)) {
    throw new RegistryError("REGISTRY_TOP_LEVEL_INVALID");
  }
  if (
    registry.schemaVersion !== 1 ||
    registry.assessment !== "chief-of-staff-communication-agent" ||
    !nonEmptyString(registry.registryId) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(registry.decisionDate) ||
    !exactKeys(registry.stateSemantics, [...ALLOWED_STATES]) ||
    [...ALLOWED_STATES].some(
      (state) => !nonEmptyString(registry.stateSemantics[state]),
    ) ||
    !Array.isArray(registry.entries) ||
    registry.entries.length !== REQUIRED_IDS.size
  ) {
    throw new RegistryError("REGISTRY_HEADER_INVALID");
  }

  const seenIds = new Set();
  const stateCounts = Object.fromEntries(
    [...ALLOWED_STATES].sort().map((state) => [state, 0]),
  );
  for (const entry of registry.entries) {
    if (!exactKeys(entry, ENTRY_KEYS)) {
      throw new RegistryError("REGISTRY_ENTRY_SHAPE_INVALID");
    }
    if (
      !REQUIRED_IDS.has(entry.id) ||
      seenIds.has(entry.id) ||
      !ALLOWED_STATES.has(entry.state) ||
      !nonEmptyString(entry.capability) ||
      !nonEmptyString(entry.sourceContract) ||
      !nonEmptyString(entry.implementationStatus) ||
      !new Set(["verified", "not_verified", "not_required"]).has(
        entry.accessStatus,
      ) ||
      !nonEmptyString(entry.owner) ||
      !Array.isArray(entry.evidence) ||
      entry.evidence.length === 0 ||
      entry.evidence.some((item) => !nonEmptyString(item)) ||
      !nonEmptyString(entry.trigger) ||
      !nonEmptyString(entry.dataHandlingImpact) ||
      !nonEmptyString(entry.releaseConsequence) ||
      entry.liveConformanceClaimed !== false
    ) {
      throw new RegistryError("REGISTRY_ENTRY_INVALID");
    }
    if (
      entry.state === "exception_pending" &&
      !entry.releaseConsequence.toLowerCase().includes("cannot") &&
      !entry.releaseConsequence.toLowerCase().includes("block") &&
      !entry.releaseConsequence.toLowerCase().includes("must not")
    ) {
      throw new RegistryError("PENDING_EXCEPTION_NOT_FAIL_CLOSED");
    }
    if (
      entry.state === "not_applicable" &&
      entry.accessStatus !== "not_required"
    ) {
      throw new RegistryError("NOT_APPLICABLE_ACCESS_INVALID");
    }
    seenIds.add(entry.id);
    stateCounts[entry.state] += 1;
  }
  if ([...REQUIRED_IDS].some((id) => !seenIds.has(id))) {
    throw new RegistryError("REGISTRY_ENTRY_MISSING");
  }
  return stateCounts;
}

function validateSchemaDocument(schema) {
  if (
    schema === null ||
    typeof schema !== "object" ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    schema.properties?.entries?.minItems !== REQUIRED_IDS.size ||
    schema.properties?.entries?.maxItems !== REQUIRED_IDS.size
  ) {
    throw new RegistryError("SCHEMA_DOCUMENT_INVALID");
  }
  const stateEnum = schema.properties?.entries?.items?.properties?.state?.enum;
  if (
    !Array.isArray(stateEnum) ||
    stateEnum.length !== ALLOWED_STATES.size ||
    [...ALLOWED_STATES].some((state) => !stateEnum.includes(state))
  ) {
    throw new RegistryError("SCHEMA_STATE_ENUM_INVALID");
  }
}

function parseArguments(args) {
  const options = {
    registry: DEFAULT_REGISTRY,
    schema: DEFAULT_SCHEMA,
    format: "text",
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (["--registry", "--schema", "--format"].includes(argument)) {
      const value = args[index + 1];
      if (value === undefined) throw new RegistryError("CLI_ARGUMENT_INVALID");
      index += 1;
      if (argument === "--registry") options.registry = value;
      if (argument === "--schema") options.schema = value;
      if (argument === "--format") options.format = value;
      continue;
    }
    throw new RegistryError("CLI_ARGUMENT_INVALID");
  }
  if (!new Set(["json", "text"]).has(options.format)) {
    throw new RegistryError("CLI_ARGUMENT_INVALID");
  }
  return options;
}

function render(report, format) {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  if (report.status === "valid") {
    const counts = Object.entries(report.stateCounts)
      .map(([state, count]) => `${state}=${count}`)
      .join(" ");
    return `team-kit-applicability: VALID entries=${report.entryCount} ${counts}\nlive_conformance_claimed=false\n`;
  }
  return `team-kit-applicability: ERROR code=${report.code}\nlive_conformance_claimed=false\n`;
}

async function runCli() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        "Usage: node config/team-kit-applicability/validate.mjs [--registry PATH] [--schema PATH] [--format text|json]\n",
      );
      return 0;
    }
    const registry = await parseJsonFile(
      options.registry,
      "REGISTRY_READ_FAILED",
      "REGISTRY_JSON_INVALID",
    );
    const schema = await parseJsonFile(
      options.schema,
      "SCHEMA_READ_FAILED",
      "SCHEMA_JSON_INVALID",
    );
    validateSchemaDocument(schema);
    const stateCounts = validateRegistry(registry);
    process.stdout.write(
      render(
        {
          schemaVersion: 1,
          status: "valid",
          entryCount: registry.entries.length,
          stateCounts,
          liveConformanceClaimed: false,
        },
        options.format,
      ),
    );
    return 0;
  } catch (error) {
    const report = {
      schemaVersion: 1,
      status: "error",
      code:
        error instanceof RegistryError
          ? error.code
          : "UNCLASSIFIED_REGISTRY_ERROR",
      liveConformanceClaimed: false,
    };
    process.stdout.write(render(report, options?.format ?? "json"));
    return 2;
  }
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath !== "" && sameFilesystemPath(invokedPath, MODULE_PATH)) {
  process.exitCode = await runCli();
}
