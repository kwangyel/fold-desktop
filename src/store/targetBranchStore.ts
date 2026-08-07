import { create } from "zustand";

export const DEFAULT_TARGET_BRANCH = "main";

type TargetBranchStore = {
  /** Target branch per project id. Missing → {@link DEFAULT_TARGET_BRANCH}. */
  byProjectId: Record<string, string>;
  setTargetBranch: (projectId: string, branch: string) => void;
};

export const useTargetBranchStore = create<TargetBranchStore>((set) => ({
  byProjectId: {},
  setTargetBranch: (projectId, branch) =>
    set((s) => ({
      byProjectId: { ...s.byProjectId, [projectId]: branch },
    })),
}));

/** Resolve the PR / merge target for a project (defaults to `main`). */
export function selectTargetBranch(
  byProjectId: Record<string, string>,
  projectId: string | null | undefined,
): string {
  if (!projectId) return DEFAULT_TARGET_BRANCH;
  return byProjectId[projectId] ?? DEFAULT_TARGET_BRANCH;
}
