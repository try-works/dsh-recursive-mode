/**
 * Client-namespace projection of the recursive domain (Phase D R3): a pure
 * re-export of the package's types outlet. Client code imports ONLY the
 * client namespace (repo discipline), so ./client projects the same
 * single-source content ./types serves to host consumers — zero duplication
 * (the goal client.ts pattern).
 *
 * @module dsh-recursive-mode/client
 */

export type * from './types.ts'
