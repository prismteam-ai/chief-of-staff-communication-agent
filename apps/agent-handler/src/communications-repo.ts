import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type {
  CommunicationState,
  Draft,
  NormalizedMessage,
  Recommendation,
  SuggestedAsanaAction,
  TransitionRecord,
} from '@chief-of-staff/shared';

/**
 * Read/update side of the communications table for the agent runtime. The ingest processor owns the
 * initial `putIngested` write (`apps/ingest/src/communications-repo.ts`); the agent reads that
 * record back and advances it with the recommendation, the draft, the new `status`, and an appended
 * transition audit trail — persisted with `marshallOptions.removeUndefinedValues` for the same
 * nested-`undefined` reason documented in the ingest repo (a participant with no `displayName`).
 *
 * `getById`/the record shape mirror the ingest repo so both packages agree on the one item per
 * `commId`; the agent adds the optional `recommendation`/`draft`/`transitions` fields (Task 6 reads
 * them from here) without changing the ingested shape.
 */
export interface AgentCommunicationRecord extends NormalizedMessage {
  commId: string;
  status: CommunicationState;
  ingestedAt: string;
  recommendation?: Recommendation;
  draft?: Draft;
  transitions?: TransitionRecord[];
  /**
   * Free-text context the user supplied via the api Lambda's `supplyContext` (Task 6 review fix —
   * see `apps/api/src/services/approval-service.ts#supplyContext`), present when this turn is a
   * re-run of a `needs_context` communication. `run-agent-turn.ts` threads every entry into the
   * classify/draft prompt as additional history so the re-classification is actually grounded in
   * it, not just re-run blind against the original message.
   */
  suppliedContext?: string[];
  /**
   * The `manageAsana` tool's proposed Asana action for this communication (Task 7, brief constraint
   * 4: "PROPOSES not executes"), when the agent chose to call it during this turn. Never written by
   * anything except `run-agent-turn.ts` persisting the tool's return value — this field is a
   * SUGGESTION, not a record of a performed write. Cleared implicitly once a human acts on it via
   * `createAsanaFollowup`/`linkAsana` (`apps/api`), which persist `asanaTaskGid` instead.
   */
  suggestedAsanaAction?: SuggestedAsanaAction;
}

let cachedClient: DynamoDBDocumentClient | undefined;
function client(): DynamoDBDocumentClient {
  cachedClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return cachedClient;
}

export interface PersistAgentOutcomeInput {
  commId: string;
  status: CommunicationState;
  recommendation: Recommendation;
  /** Present only when the confidence gate routed to `drafted`; absent for `needs_context`. */
  draft?: Draft;
  /** Transition records produced this turn (e.g. ingested→recommended, recommended→drafted). */
  transitions: TransitionRecord[];
  /** Present only when the agent called `manageAsana` this turn (Task 7) — a proposal, not a write. */
  suggestedAsanaAction?: SuggestedAsanaAction;
}

export interface AgentCommunicationsRepo {
  getById(commId: string): Promise<AgentCommunicationRecord | undefined>;
  persistOutcome(input: PersistAgentOutcomeInput): Promise<void>;
}

export function createAgentCommunicationsRepo(tableName: string): AgentCommunicationsRepo {
  return {
    async getById(commId) {
      const result = await client().send(new GetCommand({ TableName: tableName, Key: { commId } }));
      return result.Item as AgentCommunicationRecord | undefined;
    },

    /**
     * Advances one communication with the agent's outcome in a single conditional update. The
     * condition (`status = :expectedFrom`) guards against a concurrent writer having already moved
     * the record: the update sets the final `status` for this turn (the last transition's `to`) and
     * asserts the record was still in the FIRST transition's `from` state, so a double-fire of the
     * agent for the same commId fails the condition rather than re-recommending. Transitions are
     * appended to the audit list, not overwritten.
     */
    async persistOutcome({
      commId,
      status,
      recommendation,
      draft,
      transitions,
      suggestedAsanaAction,
    }) {
      const expectedFrom = transitions[0]?.from;
      const setClauses = [
        '#status = :status',
        'recommendation = :recommendation',
        'draft = :draft',
        'transitions = list_append(if_not_exists(transitions, :empty), :newTransitions)',
      ];
      if (suggestedAsanaAction) {
        setClauses.push('suggestedAsanaAction = :suggestedAsanaAction');
      }
      await client().send(
        new UpdateCommand({
          TableName: tableName,
          Key: { commId },
          UpdateExpression: `SET ${setClauses.join(', ')}`,
          ConditionExpression: expectedFrom
            ? '#status = :expectedFrom'
            : 'attribute_exists(commId)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': status,
            ':recommendation': recommendation,
            // `draft` is left as `undefined` on the needs_context path; removeUndefinedValues drops
            // the attribute rather than writing a null, so the record simply has no draft.
            ':draft': draft,
            ':newTransitions': transitions,
            ':empty': [] as TransitionRecord[],
            ...(expectedFrom ? { ':expectedFrom': expectedFrom } : {}),
            ...(suggestedAsanaAction ? { ':suggestedAsanaAction': suggestedAsanaAction } : {}),
          },
        }),
      );
    },
  };
}
