export interface ChiefAgent<TRequest, TResult> {
  readonly manifestHash: string;
  run(request: TRequest): Promise<TResult>;
}

export * from './application-agent.js';
export * from './canonical.js';
export * from './evidence.js';
export * from './model-runtime.js';
export * from './safety.js';
export * from './style.js';
