import { collectSessionReferenceIds } from './dist/references.js';
import { prepareReferencedMessage } from './dist/prepare.js';
import { budgetPercent, referenceBudget, referencePage } from './context.mjs';

/** The existing permissioned Before Send hook owns the model-facing transformation. */
export default function sessionMentions(pi) {
  pi.on('input', async (event, ctx) => {
    if (!collectSessionReferenceIds(event.text, [], event.sessionId).length) return { action: 'continue' };
    try {
      const usage = ctx.getContextUsage();
      const settings = pi.getPluginSettings();
      const result = await prepareReferencedMessage(event.text, {
        excludeSessionId: event.sessionId,
        signal: ctx.signal,
        budgetTokens: referenceBudget(event.text, {
          contextWindow: usage?.contextWindow,
          usedTokens: usage?.tokens,
          maxOutputTokens: ctx.model?.maxTokens,
          hasAttachments: event.attachments?.length > 0,
        }, budgetPercent(settings.budgetPercent)),
        loadPage: async (id, before, signal) => {
          signal.throwIfAborted();
          const page = await pi.recap({ scope: 'session', sessionId: id, limit: 400,
            ...(before === undefined ? {} : { before }) });
          signal.throwIfAborted();
          if (!page || page.scope !== 'session') throw new Error('The referenced session could not be read.');
          return referencePage(page, id);
        },
      });
      if (result.status === 'blocked') return { action: 'handled', reason: result.reason };
      const omitted = result.notices.filter((notice) => notice.omittedKnown || notice.olderUnread || notice.readLimitReached);
      if (omitted.length) {
        // Presentation is best-effort; it must not convert a valid rewrite into a timeout.
        void Promise.resolve(ctx.ui.notify(omitted.map((notice) =>
          `${notice.title}: ${notice.includedTurns} complete Q&A included; ${notice.omittedKnown} known older turns omitted${notice.olderUnread || notice.readLimitReached ? '; older history not fully read' : ''}.`
        ).join('\n'), 'warning')).catch(() => {});
      }
      return { action: 'transform', text: result.content };
    } catch (error) {
      return { action: 'handled', reason: error instanceof Error ? error.message : 'Session reference preparation failed.' };
    }
  });
}
