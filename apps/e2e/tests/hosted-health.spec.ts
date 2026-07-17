import { expect, test } from '@playwright/test';
test('hosted foundation health is reachable when a deployment URL is supplied', async ({
  request,
}) => {
  test.skip(
    !process.env.CHIEF_BASE_URL,
    'CHIEF_BASE_URL is required for hosted smoke validation.',
  );
  const response = await request.get('/');
  expect(response.ok()).toBe(true);
});
