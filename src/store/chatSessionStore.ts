import { create } from "zustand";
import {
  deleteChat,
  listChats,
  renameChat,
  type ChatSummary,
} from "../lib/chats";

/**
 * UI-facing index of persisted chats, keyed by worktree path.
 *
 * Chats live in per-worktree SQLite databases, so this store holds one list per
 * worktree rather than one global list. Only chats that have received at least
 * one prompt appear here — draft tabs are never written to disk.
 */
type ChatSessionStore = {
  byWorktree: Record<string, ChatSummary[]>;
  /** Re-read one worktree's chat list from disk. */
  refresh: (worktree: string) => Promise<void>;
  /** Re-read several worktrees at once (e.g. after a project loads). */
  refreshAll: (worktrees: string[]) => Promise<void>;
  remove: (worktree: string, chatId: string) => Promise<void>;
  rename: (worktree: string, chatId: string, title: string) => Promise<void>;
  /** Drop cached entries for a worktree that was archived or removed. */
  forget: (worktree: string) => void;
  /** Most recently updated chat for a worktree, if any. */
  latest: (worktree: string) => ChatSummary | undefined;
};

export const useChatSessionStore = create<ChatSessionStore>((set, get) => ({
  byWorktree: {},

  refresh: async (worktree) => {
    if (!worktree) return;
    const chats = await listChats(worktree);
    set((state) => ({
      byWorktree: { ...state.byWorktree, [worktree]: chats },
    }));
  },

  refreshAll: async (worktrees) => {
    const unique = Array.from(new Set(worktrees.filter(Boolean)));
    if (unique.length === 0) return;
    const results = await Promise.all(
      unique.map(async (wt) => [wt, await listChats(wt)] as const),
    );
    set((state) => {
      const byWorktree = { ...state.byWorktree };
      for (const [wt, chats] of results) byWorktree[wt] = chats;
      return { byWorktree };
    });
  },

  remove: async (worktree, chatId) => {
    await deleteChat(worktree, chatId);
    set((state) => ({
      byWorktree: {
        ...state.byWorktree,
        [worktree]: (state.byWorktree[worktree] ?? []).filter(
          (c) => c.id !== chatId,
        ),
      },
    }));
  },

  rename: async (worktree, chatId, title) => {
    await renameChat(worktree, chatId, title);
    set((state) => ({
      byWorktree: {
        ...state.byWorktree,
        [worktree]: (state.byWorktree[worktree] ?? []).map((c) =>
          c.id === chatId ? { ...c, title } : c,
        ),
      },
    }));
  },

  forget: (worktree) =>
    set((state) => {
      if (!(worktree in state.byWorktree)) return state;
      const { [worktree]: _dropped, ...rest } = state.byWorktree;
      return { byWorktree: rest };
    }),

  // `chat_list` returns newest-first, so the head is the most recent.
  latest: (worktree) => get().byWorktree[worktree]?.[0],
}));
