import { Faker, en, simpleFaker } from '@faker-js/faker';

export interface DemoPersonFixture {
  readonly id: string;
  readonly displayName: string;
}

export function createDeterministicDemoPeople(
  seed: number,
  count: number,
): readonly DemoPersonFixture[] {
  if (
    !Number.isSafeInteger(seed) ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 10_000
  ) {
    throw new Error(
      'Fixture seed/count are outside the deterministic bounded contract.',
    );
  }
  const faker = new Faker({ locale: en });
  faker.seed(seed);
  simpleFaker.seed(seed);
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      Object.freeze({
        id: `fixture-person-${index.toString().padStart(5, '0')}`,
        displayName: faker.person.fullName(),
      }),
    ),
  );
}
