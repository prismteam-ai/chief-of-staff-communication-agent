# Deterministic evaluator retrieval seed

Use this operator command after `ChiefProductStack` is deployed and before
hosted acceptance. It seeds the fixed synthetic V2 retrieval corpus: 1,120
messages in 160 threads across seven channels, seven account scopes, and two
brand scopes. The product service regenerates the matching inbox rows and seven
synthetic fixture connector cards from the source-owned V2 corpus; only its
small identity/integrity marker, approval/execution state, and the separate
retrieval head are durable. The command does not read `.config`, provider
credentials, Gmail, or private archives.

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
{"schemaVersion":"1","seedVersion":"chief-evaluator-retrieval-seed.v2","seedId":"e6755bf3f2cd96a4b4af9c395e6a9a89775f311c0a14680e9ac700ce31e96af3","status":"seeded","scopeHash":"78f117a88b1fc73ce8c394e2045888eb102fd34ee3e8c77fbaa75cb21d9a8e3d","authorizationEpoch":1,"manifestHash":"<deployment-bound-sha256>","generation":1,"chunkCount":1120,"sourceCount":1120,"threadCount":160,"accountCount":7,"brandCount":2,"channelCounts":{"gmail":161,"microsoft_graph":161,"sms":161,"whatsapp":161,"x":161,"linkedin_archive":161,"future_demo":154},"brandCounts":{"brand-northstar":637,"brand-harbor":483}}
```

`generation: 1` is the fresh-state example, not a required value for every
deployment. The stable corpus identity is `seedId`; the manifest hash also
binds the deployed bucket and immutable object versions.

## Rerun, recovery, and rollback

- An exact rerun returns `status: already_current` and preserves the promoted
  manifest hash and generation.
- An exact partial V2 catalog with no head is completed and promoted with
  `status: seeded`.
- A valid partial promoted head is completed as a new generation. The recovery
  test advances the one-record generation 1 head to a full generation 2 head;
  its next run returns `already_current` without another advance.
- Foreign scope, stale epoch, extra or conflicting records, mixed catalog
  state, or corrupt staged/snapshot objects fail closed. The command does not
  delete the current head, guess a rollback target, or offer a destructive
  force-reset path.
- Rolling application code back does not roll retained DynamoDB/S3 state back.
  Redeploy the reviewed release and run the seeder belonging to that release;
  do not delete retained tables, immutable objects, or Object-Locked snapshots.
  The V2 command neither garbage-collects older scopes/generations nor converts
  incompatible state in place.

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
