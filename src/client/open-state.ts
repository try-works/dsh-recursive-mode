/**
 * Shared board open-state (run 08 R1): module-level store behind the launcher,
 * the shell.overlay entry, and the board<->inspector swap. Zero session events,
 * zero host mutation — the client remains a read-only projection (R5/R9).
 */
import { useSyncExternalStore } from 'react'

export interface BoardSelection {
  worktreeRoot: string;
  runId: string;
}

export interface BoardState {
  open: boolean;
  selection: BoardSelection | null;
}

export interface BoardOpenState {
  get(): BoardState;
  openBoard(): void;
  close(): void;
  openInspector(selection: BoardSelection): void;
  backToBoard(): void;
  subscribe(fn: () => void): () => void;
}

export function createBoardState(initial: BoardState = { open: false, selection: null }): BoardOpenState {
  let state: BoardState = initial;
  const listeners = new Set<() => void>();
  const emit = (): void => { for (const fn of listeners) fn() };
  return {
    get: () => state,
    openBoard: () => { state = { ...state, open: true }; emit(); },
    close: () => { state = { ...state, open: false, selection: null }; emit(); },
    openInspector: (selection) => { state = { ...state, open: true, selection }; emit(); },
    backToBoard: () => { state = { ...state, selection: null }; emit(); },
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) }; },
  };
}

/** App-wide singleton shared by the launcher, overlay, board, and inspector. */
export const boardState = createBoardState();

export function useBoardState(store: BoardOpenState = boardState): BoardState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
