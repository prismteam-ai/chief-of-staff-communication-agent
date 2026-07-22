import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';

export class PersistenceConflictError extends Error {
  public constructor() {
    super('The persistence precondition was not satisfied.');
    this.name = 'PersistenceConflictError';
  }
}

export function translatePersistenceError(error: unknown): never {
  if (
    error instanceof TransactionCanceledException ||
    error instanceof ConditionalCheckFailedException
  ) {
    throw new PersistenceConflictError();
  }
  throw error;
}
