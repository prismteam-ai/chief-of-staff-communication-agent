import { acceptLinkedinArchiveZip } from './archive-acceptance.js';
import { LinkedinArchiveImportError } from './errors.js';

const archivePath = process.argv[2];
if (archivePath === undefined || process.argv.length !== 3) {
  process.stderr.write(
    `${JSON.stringify({ schemaVersion: '1', status: 'fail', errorCode: 'ARCHIVE_PATH_REQUIRED' })}\n`,
  );
  process.exitCode = 2;
} else {
  try {
    const report = await acceptLinkedinArchiveZip(archivePath, {
      tenantId: 'local-acceptance-tenant',
      accountId: 'local-acceptance-account',
      importedAt: '2026-07-17T00:00:00.000Z',
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: '1',
        status: 'fail',
        errorCode:
          error instanceof LinkedinArchiveImportError
            ? error.code
            : 'UNEXPECTED_ERROR',
      })}\n`,
    );
    process.exitCode = 1;
  }
}
