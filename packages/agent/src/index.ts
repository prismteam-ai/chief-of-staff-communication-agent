export interface ChiefAgent<TRequest, TResult> {
  readonly manifestHash: string;
  run(request: TRequest): Promise<TResult>;
}

export const agentSafetyBoundary = Object.freeze({
  directExternalEffects: false,
  approvalRequired: true,
  modelFallbackAllowed: false,
} as const);
