const injectionPatterns = [
  /ignore (?:all |any )?(?:previous|prior|system) instructions/iu,
  /reveal (?:the )?(?:system prompt|secret|credential|token)/iu,
  /(?:act|pretend) as (?:the )?system/iu,
  /<\/?(?:system|assistant|tool)>/iu,
  /(?:send|export|post) (?:all )?(?:secrets|credentials|private data)/iu,
] as const;

export function containsPromptInjection(text: string): boolean {
  return injectionPatterns.some((pattern) => pattern.test(text));
}

export const agentToolPolicy = Object.freeze({
  allowed: Object.freeze(['get_cited_fact', 'get_style_profile'] as const),
  deniedEffectClasses: Object.freeze([
    'send_message',
    'approve',
    'create_asana_task',
    'update_asana_task',
    'create_asana_comment',
  ] as const),
  maximumSteps: 4,
  maximumSchemaRepairs: 1,
});

export const agentSafetyBoundary = Object.freeze({
  directExternalEffects: false,
  approvalRequired: true,
  modelFallbackAllowed: false,
} as const);

export const agentSafetyBoundaryHash = immutableHash(agentSafetyBoundary);
import { immutableHash } from './canonical.js';
