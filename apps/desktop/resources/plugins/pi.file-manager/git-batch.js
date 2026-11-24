// Bulk index actions use a reviewed list of literal files, never `git add .`.
function createGitBatch({ gitContext, panelState, panelCommand, gitFileAllowed, gitCheckIndexPath, gitBusy, staleGit, invalidateGitSnapshots, audit, fail }) {
  return async function handleBatch(payload) {
    const ctx = await gitContext(payload);
    const stage = payload.action === 'stage';
    if (!stage && payload.action !== 'unstage') throw fail('GIT_PATH', 'Unknown index operation.');
    if (gitBusy.has(ctx.root)) throw fail('GIT_BUSY', 'Another Git operation is running.');
    gitBusy.add(ctx.root);
    try {
      const s = await panelState(ctx);
      if (s.revision !== payload.revision) throw staleGit();
      const entries = s.entries.filter(e => stage ? e.worktree !== ' ' : ![' ', '?'].includes(e.index));
      if (!entries.length) throw fail('GIT_EMPTY', 'No eligible files.');
      const paths = entries.map(e => e.path);
      if (paths.length > 100 || paths.reduce((n, p) => n + p.length + 4, 0) > 15000) throw fail('GIT_LIMIT', 'For changes of this size use Git directly.');
      for (const e of entries) {
        if (e.status === 'conflicted' || !await gitFileAllowed(ctx.root, e.path, 'write', ctx.nested)) throw fail('GIT_PATH', 'Review conflicts or protected paths in Git.');
        await gitCheckIndexPath(ctx, e.path, s.parent);
      }
      if (stage) {
        const fields = (await panelCommand(ctx, ['check-attr', '-z', 'filter', '--', ...paths])).stdout.toString().split('\0');
        if (paths.some((_, i) => !['unset', 'unspecified'].includes(fields[3*i+2]))) throw fail('GIT_FILTER', 'Stage files with custom filters in Git.');
      }
      if ((await panelState(ctx)).revision !== s.revision || (await gitContext(payload)).key !== ctx.key) throw staleGit();
      await panelCommand(ctx, stage ? ['update-index', '--add', '--remove', '--', ...paths] : s.parent ? ['reset','-q',s.parent,'--',...paths] : ['rm','--cached','-f','--',...paths]);
      invalidateGitSnapshots(); await audit({ api: 'fm.git.batch', path: ctx.root, count: paths.length, result: 'ok' });
      return { ok: true, count: paths.length };
    } finally { gitBusy.delete(ctx.root); }
  };
}
module.exports = { createGitBatch };
