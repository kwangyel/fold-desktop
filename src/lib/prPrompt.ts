/**
 * Prompt for the local-repo commit step. The agent reviews the diff, writes a
 * commit message, and commits — it must not merge into the target branch.
 */
export function commitChangesPrompt(targetBranch: string): string {
  const base = targetBranch.trim() || "main";
  return `The user wants to commit their work so it can later be merged into ${base}.

Commit the changes yourself — do not merge, rebase, or check out ${base}. Complete every step below, then stop.

Follow these steps:

1. Run \`git status\` and \`git rev-parse --abbrev-ref HEAD\` to confirm the current branch and working tree state.
2. Review the full set of uncommitted changes with \`git diff\` and \`git diff --cached\`. Also skim \`git diff ${base}...HEAD\` so the commit message fits the branch as a whole when there are already commits.
3. If there are no uncommitted changes, say so and stop. Do not create an empty commit.
4. Stage all relevant changes (\`git add -A\` unless the user clearly left something out on purpose), then commit with a clear, conventional commit message that summarizes the changes.
5. Run \`git status\` again and report the new commit (hash + subject). Do not merge into ${base}, do not rebase, and do not push.

If a step genuinely fails, explain what failed and ask the user for help. Otherwise, do not ask — stage and commit.`;
}

/** Prompt that tells the agent to open a PR against `targetBranch` (default main). */
export function prCreationPrompt(targetBranch: string): string {
  const base = targetBranch.trim() || "main";
  return `The user requested a pull request. The target branch is origin/${base}.

Create the PR yourself — do not stop to ask for confirmation. Complete every step below, then report the PR URL.

Follow these steps to create the PR:

1. If you have any skills related to creating PRs, invoke them now. Instructions there take precedence over these instructions.
2. Run \`git status\` to check for uncommitted changes. If there are any, review them with \`git diff\`, then stage and commit them with a clear, conventional commit message that summarizes the changes.
3. Determine the current branch with \`git rev-parse --abbrev-ref HEAD\`. If the branch has no upstream or has unpushed commits, push with \`git push -u origin HEAD\`. If it tracks a remote branch with a different name or remote, push to that upstream instead.
4. Review the full diff against the target with \`git diff origin/${base}...HEAD\` so the description covers ALL changes on the branch, not just this session.
5. Create the PR with:
   \`\`\`
   gh pr create --base ${base} --title "<title>" --body "$(cat <<'EOF'
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
}
