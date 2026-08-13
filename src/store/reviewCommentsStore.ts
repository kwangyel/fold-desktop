import { create } from "zustand";
import {
  DiffComment,
  NewDiffComment,
  loadComments,
  makeComment,
  saveComments,
} from "../lib/reviewComments";

type ReviewCommentsStore = {
  comments: DiffComment[];
  loading: boolean;
  /** Reload comments for the active worktree from disk. */
  refresh: () => Promise<void>;
  add: (input: NewDiffComment) => Promise<DiffComment>;
  remove: (id: string) => Promise<void>;
  setResolved: (id: string, resolved: boolean) => Promise<void>;
  updateBody: (id: string, body: string) => Promise<void>;
};

/** Persist the given list and reflect it in the store. */
async function commit(
  set: (partial: Partial<ReviewCommentsStore>) => void,
  comments: DiffComment[],
): Promise<void> {
  set({ comments });
  await saveComments(comments);
}

export const useReviewCommentsStore = create<ReviewCommentsStore>((set, get) => ({
  comments: [],
  loading: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const comments = await loadComments();
      set({ comments, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  add: async (input) => {
    const comment = makeComment(input);
    await commit(set, [...get().comments, comment]);
    return comment;
  },

  remove: async (id) => {
    await commit(
      set,
      get().comments.filter((c) => c.id !== id),
    );
  },

  setResolved: async (id, resolved) => {
    await commit(
      set,
      get().comments.map((c) => (c.id === id ? { ...c, resolved } : c)),
    );
  },

  updateBody: async (id, body) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    await commit(
      set,
      get().comments.map((c) => (c.id === id ? { ...c, body: trimmed } : c)),
    );
  },
}));

/** Comments for one file, ordered by line. */
export function selectCommentsForFile(
  comments: DiffComment[],
  file: string,
): DiffComment[] {
  return comments
    .filter((c) => c.file === file)
    .sort((a, b) => a.line - b.line);
}

/** Count of unresolved comments. */
export function selectUnresolvedCount(comments: DiffComment[]): number {
  return comments.reduce((n, c) => n + (c.resolved ? 0 : 1), 0);
}
