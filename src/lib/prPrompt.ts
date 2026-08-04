export function mergeBranchPrompt(targetBranch: string): string {
  return `Merge the current branch into ${targetBranch}.

Steps:
1. Run: git status (check for uncommitted changes — warn me if there are any)
2. Run: git rev-parse --abbrev-ref HEAD (note the current branch name)
3. Run: git checkout ${targetBranch}
4. Run: git merge <current-branch>
5. If the merge succeeds, report which commits were merged and run git checkout <current-branch> to return.
6. If there are conflicts, list the conflicted files, explain what needs to be resolved, then run git merge --abort and git checkout <current-branch> to return to a clean state.`;
}

export const PR_CREATION_PROMPT = `The user requested a pull request. The target branch is origin/main.

Create the PR yourself — do not stop to ask for confirmation. Complete every step below, then report the PR URL.

Follow these steps to create the PR:

1. If you have any skills related to creating PRs, invoke them now. Instructions there take precedence over these instructions.
2. Run \`git status\` to check for uncommitted changes. If there are any, review them with \`git diff\`, then stage and commit them with a clear, conventional commit message that summarizes the changes.
3. Determine the current branch with \`git rev-parse --abbrev-ref HEAD\`. If the branch has no upstream or has unpushed commits, push with \`git push -u origin HEAD\`. If it tracks a remote branch with a different name or remote, push to that upstream instead.
4. Review the full diff against the target with \`git diff origin/main...HEAD\` so the description covers ALL changes on the branch, not just this session.
5. Create the PR with:
   \`\`\`
   gh pr create --base main --title "<title>" --body "$(cat <<'EOF'
   <body>
   EOF
   )"
   \`\`\`
   - Keep the title under 80 characters.
   - Body format:
     ## Summary
     (2-3 concise bullet points describing all changes on the branch)

     ## Test plan
     (checklist of what to verify)
6. Report the created PR URL back to the user.

If a step genuinely fails (e.g. a git error, missing gh auth, or no changes at all to commit or push), explain what failed and ask the user for help. Otherwise, do not ask — commit, push, and open the PR.`;
