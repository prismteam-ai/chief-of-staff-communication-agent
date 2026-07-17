/**
 * `@chief-of-staff/shared` — domain contracts, the communication state machine, the account model,
 * and the permission guard. One source of truth consumed identically by the API, the agent tools,
 * and the MCP server (design.md §8).
 */

export * from './normalized-message.js';
export * from './state-machine.js';
export * from './transition-record.js';
export * from './action-type.js';
export * from './confidence.js';
export * from './account.js';
export * from './permissions.js';
export * from './asana.js';
export * from './style-profile.js';
export * from './mcp-token.js';
export * from './dashboard-auth.js';
