import { defineTool } from '@deepseek-ai/dsh-tools'
import { hasToolErrorCode, toolError } from './errors.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  TeamRuntimeLike,
  TeamCallerHandle,
  TeamTaskActionLike,
  TeamTaskViewLike,
  CreateTeamTaskRequestLike,
  UpdateTeamTaskRequestLike,
} from './teams-loop.ts'

/**
 * `recursive_audit_team` — the T3 entry path: a turn-driven adapter over the
 * live `agentTeams` task board. ONE call advances the audit→repair→re-audit
 * state machine by one transition, so the agent drives the loop across turns
 * as continuable-child settlement notices arrive in its inbox.
 *
 * Why one step per call: the live subagents service has no public parent-side
 * "await settlement" promise — a continuable child's verdict arrives as a
 * `subagent-settled` message on a LATER turn. The pure whole-loop driver
 * (`auditToPass` in teams-loop.ts) models the full state machine and is the
 * tested reference; this tool is its honest turn-driven shell.
 */

/** Project one live task view to an owned, lossless-JSON-safe record. */
function taskViewToJson(view: TeamTaskViewLike): JsonValue {
  // Read only leaf fields; never pass the live service object into the model
  // context (the tool boundary is where a live view becomes owned JSON).
  return {
    id: view.id,
    revision: view.revision,
    subject: view.subject,
    description: view.description,
    status: view.status,
    blockedBy: [...view.blockedBy],
    writeScopes: [...view.writeScopes],
    ownerName: view.ownerName ?? null,
    ready: view.ready,
    writeScopeWarnings: [...view.writeScopeWarnings],
  }
}

/** Wrap a non-JSON-pure value in the standard error envelope, coded for greppability. */
function errorJson(message: string): JsonValue {
  // T24: every refusal must begin with a stable code so a consumer can branch on
  // it. The teams loop's own messages carry no code, so wrap them; one that
  // already has a code is passed through rather than double-wrapped.
  return { error: hasToolErrorCode(message) ? message : toolError('RUNTIME_REFUSED', message) }
}

export function createRecursiveAuditTeamTool(teams: TeamRuntimeLike | null) {
  return defineTool({
    name: 'recursive_audit_team',
    description: 'Advance one agentTeams Task-board transition for the recursive audit loop (create → claim → edit(REVISE) → complete(APPROVE) → release/interrupt). Drive one step per turn as continuable-child settlement notices arrive; complete the task (and lock the phase) ONLY after an APPROVE verdict.',
    parameters: {
      action: { type: 'string', description: 'create | claim | edit | complete | release | interrupt | get | list. Required.' },
      taskId: { type: 'string', description: 'Task id for claim/edit/complete/release/interrupt/get.' },
      expectedRevision: { type: 'number', description: 'CAS revision for claim/edit/complete/release.' },
      subject: { type: 'string', description: 'Task subject (create).' },
      description: { type: 'string', description: 'Task description (create) or appended repair note (edit).' },
      blockedBy: { type: 'array', items: { type: 'string' }, description: 'Task blockers (create).' },
      writeScopes: { type: 'array', items: { type: 'string' }, description: 'Advisory write scopes (create).' },
      targetName: { type: 'string', description: 'Teammate name to interrupt (interrupt).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: {
      action?: string
      taskId?: string
      expectedRevision?: number
      subject?: string
      description?: string
      blockedBy?: string[]
      writeScopes?: string[]
      targetName?: string
    }, exec) {
      const action = args.action ?? ''
      if (!teams) return errorJson('agentTeams service is not available in this composition')
      // SAFETY: exec.agent is the live Team member Agent (a superset of the
      // named opaque handle); the seam reads only id/session identity and never
      // serializes it. When no agent owns the call, an empty handle degrades to
      // an anonymous caller (the service admits/denies by its own authority).
      const caller: TeamCallerHandle = exec.agent ?? {}

      try {
        switch (action) {
          case 'create': {
            if (!args.subject || !args.description) return errorJson('create requires subject and description')
            const createRequest: CreateTeamTaskRequestLike = {
              subject: args.subject,
              description: args.description,
            }
            if (args.blockedBy !== undefined) createRequest.blockedBy = args.blockedBy
            if (args.writeScopes !== undefined) createRequest.writeScopes = args.writeScopes
            const view = await teams.createTask(caller, createRequest)
            return taskViewToJson(view)
          }
          case 'claim':
          case 'edit':
          case 'complete':
          case 'release': {
            if (!args.taskId || args.expectedRevision === undefined) {
              return errorJson(action + ' requires taskId and expectedRevision')
            }
            // SAFETY: this case arm is reachable only for action 'claim' | 'edit' |
            // 'complete' | 'release' (the switch discriminates on the same string),
            // each a member of TeamTaskActionLike's subset; the cast re-asserts that
            // narrowing across the four fall-through labels without widening scope.
            const updateAction = action as TeamTaskActionLike
            const updateRequest: UpdateTeamTaskRequestLike = {
              taskId: args.taskId,
              expectedRevision: args.expectedRevision,
              action: updateAction,
            }
            if (action === 'edit' && args.description !== undefined) updateRequest.description = args.description
            const view = await teams.updateTask(caller, updateRequest)
            return taskViewToJson(view)
          }
          case 'interrupt': {
            if (!args.targetName) return errorJson('interrupt requires targetName')
            if (!teams.interrupt) return errorJson('no interrupt seam')
            const outcome = teams.interrupt(caller, args.targetName)
            return { previousStatus: outcome.previousStatus }
          }
          case 'get': {
            if (!args.taskId) return errorJson('get requires taskId')
            if (!teams.getTask) return errorJson('no getTask seam')
            return taskViewToJson(teams.getTask(caller, args.taskId))
          }
          case 'list': {
            if (!teams.listTasks) return errorJson('no listTasks seam')
            return teams.listTasks(caller).map(taskViewToJson)
          }
          default:
            return errorJson('unsupported action: ' + action + ' (create|claim|edit|complete|release|interrupt|get|list)')
        }
      } catch (err) {
        return errorJson(err instanceof Error ? err.message : String(err))
      }
    },
  })
}
