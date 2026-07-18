# Deterministic evaluator retrieval seed

Use this operator command once after `ChiefProductStack` is deployed and before
hosted acceptance. It seeds only the fixed, synthetic two-email evaluator
corpus. It does not read `.config`, provider credentials, Gmail, or private
archives.

## Run

Use the already verified AWS profile and `us-east-2`. Read the three exported
bindings from the deployed product stack; do not copy values from the console.

```powershell
$env:AWS_PROFILE = '<selected-profile>'
$env:AWS_REGION = 'us-east-2'
$stack = 'ChiefProductStack'

$env:RETRIEVAL_TABLE_NAME = aws cloudformation describe-stacks --stack-name $stack --query "Stacks[0].Outputs[?OutputKey=='RetrievalTableName'].OutputValue | [0]" --output text
$env:SNAPSHOT_BUCKET_NAME = aws cloudformation describe-stacks --stack-name $stack --query "Stacks[0].Outputs[?OutputKey=='SnapshotBucketName'].OutputValue | [0]" --output text
$env:PRODUCT_DATA_KEY_ARN = aws cloudformation describe-stacks --stack-name $stack --query "Stacks[0].Outputs[?OutputKey=='ProductDataKeyArn'].OutputValue | [0]" --output text

pnpm seed:evaluator-retrieval
```

The equivalent explicit form is:

```powershell
pnpm seed:evaluator-retrieval -- --table-name '<table>' --bucket-name '<bucket>' --kms-key-arn '<key-arn>' --region 'us-east-2'
```

The command emits one non-secret JSON result line:

```json
{"schemaVersion":"1","seedVersion":"chief-evaluator-retrieval-seed.v1","seedId":"e35428221407a13f6b01d5196abab9c7357c5bfbd3c76b9ee284197180bf8217","status":"seeded","scopeHash":"b591109c0ddfc4a602f56768cbbd7df2eb9606f7d45dc986cf5ca6f914dca4f1","authorizationEpoch":1,"manifestHash":"<deployment-bound-sha256>","generation":2,"chunkCount":2,"sourceCount":2}
```

On an exact rerun, `status` is `already_current` and the manifest identity and
generation remain unchanged. The recovery suite proves both an exact partial
catalog with no head and a valid one-record promoted head: each converges to the
same readable two-record authority, and its next run is idempotent. A recovery
from other valid partial generations may retain a different generation number.
The stable corpus identity is `seedId`; the manifest hash also binds the
deployed bucket/object versions.

## Fail-closed behavior

Before staging, the command strongly reads the fixed authorization epoch,
current head, and bounded epoch-qualified catalog. It accepts only absent,
partial, or complete state whose records exactly match this seed. A stale
epoch, foreign scope, extra record, conflicting record, corrupt object, or
mixed catalog exits nonzero with a machine-readable `SEED_*` code. It never
accepts scope, tenant, account, brand, role, epoch, corpus, or effect-policy
overrides.

The write path is the production path:

```text
canonical Gmail fixture
  -> S3RetrievalMutationSink
  -> DynamoS3RetrievalAuthority.register
  -> bounded Query enumeration
  -> DurableRetrievalCompactor
  -> transactional epoch check + head CAS
  -> bounded snapshot validation
```

No DynamoDB `Scan`, manual console write, in-memory hosted fallback, provider
call, model call, or external effect is involved.

## Local verification boundary

Run `pnpm test:evaluator-seed` to build the complete dependency subgraphs and
exercise contracts, API identity binding, and the seed/recovery suite. Its
in-memory artifact and authority adapters prove deterministic records,
idempotency, fail-closed drift handling, promoted readability, and exact-ref
fusion. They do not prove deployed DynamoDB transaction behavior, S3 versioning,
KMS policy enforcement, or Object Lock retention; verify those separately from
the synthesized template and deployed stack.
