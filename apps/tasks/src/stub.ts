import type { BoardId } from "@cloudysuite/access";

// Not exported from the package. Only client.ts may import this, and
// boundaries.test.ts fails if anything else touches the binding.
export function boardStub(env: Env, boardId: BoardId) {
  return env.BOARD.get(env.BOARD.idFromName(boardId));
}
