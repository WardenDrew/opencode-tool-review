import path from 'node:path';
import { deadline, encode, makeReviewer, ReviewDenied } from './reviewer.js';
import { makeInspector } from './evidence.js';

export function configuration(raw) {
  const allowed = ['model', 'policy', 'maxRisk', 'maxSteps', 'timeoutMs', 'maxConcurrent', 'evidenceFiles', 'tools'];
  if (!raw || Object.keys(raw).some(key => !allowed.includes(key))) throw new Error('Unknown tool-review option');
  const model = raw.model;
  if (!model || typeof model.providerID !== 'string' || !model.providerID.trim() ||
      typeof model.id !== 'string' || !model.id.trim() || Object.keys(model).some(k => !['providerID', 'id'].includes(k)))
    throw new Error('tool-review requires model: { providerID, id }');
  const value = { model, policy: '', maxRisk: 'medium', maxSteps: 4, timeoutMs: 30_000, maxConcurrent: 4, evidenceFiles: [], tools: ['shell', 'execute'], ...raw };
  if (!['low', 'medium'].includes(value.maxRisk) || typeof value.policy !== 'string' || value.policy.length > 8000)
    throw new Error('Invalid tool-review policy');
  for (const [key, max] of [['maxSteps', 8], ['timeoutMs', 120_000], ['maxConcurrent', 32]])
    if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > max) throw new Error(`Invalid ${key}`);
  if (!Array.isArray(value.evidenceFiles) || value.evidenceFiles.length > 32 || value.evidenceFiles.some(file =>
    typeof file !== 'string' || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')))
    throw new Error('evidenceFiles must contain at most 32 relative file paths');
  if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.length > 32 ||
      value.tools.some(tool => typeof tool !== 'string' || !tool))
    throw new Error('tools must contain 1 to 32 non-empty tool names');
  return JSON.parse(encode(value));
}

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function lock(event, keys) {
  for (const key of keys) {
    const approved = freeze(event[key]);
    Object.defineProperty(event, key, {
      get: () => approved,
      set: value => { if (value !== approved) throw new ReviewDenied('approved invocation cannot be changed'); },
      configurable: false, enumerable: true,
    });
  }
}

// Plugin.define is an identity function in V2; exporting this shape avoids a runtime dependency.
export default {
  id: 'ironwatch.tool-review',
  async setup(ctx) {
    // Register guards even on bad configuration, so a missing model cannot silently disable review.
    let options, configError;
    try {
      if (!/^2\.0\.\d+(?:[-+].*)?$/.test(ctx.app.version))
        console.warn(`tool-review supports OpenCode 2.0.x; running on ${ctx.app.version}`);
      options = configuration(ctx.options);
    } catch (error) { configError = error; }
    let active = 0;
    let closed = false;
    const controllers = new Set();
    const waiters = [];
    // Saturated capacity queues the review; take runs synchronously inside release, so the cap is exact.
    const capacity = () => new Promise(resolve => {
      const take = () => { active++; resolve(); };
      if (active >= options.maxConcurrent) { waiters.push(take); return; }
      take();
    });
    const release = () => {
      active--;
      const next = waiters.shift();
      if (next) next();
    };
    const inspect = options && makeInspector(ctx.location.directory, options.evidenceFiles);
    const review = options && makeReviewer({ generate: input => ctx.generate.text(input), inspect, options });
    const audit = async (proposal, steps, outcome) => {
      if (!proposal.sessionID) return;
      const decision = steps.findLast(step => step.type === 'decision');
      const inspections = steps.filter(step => step.type === 'inspect').map(step => step.file);
      const text = [
        `Tool review for ${proposal.tool} (${proposal.kind}): ${outcome}`,
        decision && `Reviewer result: ${decision.decision}; risk: ${decision.risk}; effect: ${decision.effect}; user intent covered: ${decision.authorized}`,
        decision && `Reviewer analysis: ${decision.analysis}`,
        decision && `Reviewer reason: ${decision.reason}`,
        inspections.length && `Evidence requested: ${inspections.join(', ')}`,
      ].filter(Boolean).join('\n');
      const status = outcome === 'allowed' ? 'ALLOWED' : 'BLOCKED';
      const detail = decision
        ? `${decision.reason} — ${decision.analysis}`
        : outcome.replace(/^blocked: Tool review blocked execution: /, '');
      const description = `Tool review ${status}: ${proposal.tool}${decision ? ` (${decision.risk})` : ''} — ${detail}`
        .replace(/\s+/g, ' ').slice(0, 500);
      await ctx.session.synthetic({ sessionID: proposal.sessionID, text, description, resume: false });
    };
    const guard = async (proposal, getContext, verify) => {
      if (closed || configError) {
        const denied = new ReviewDenied('reviewer unavailable or misconfigured');
        try { await audit(proposal, [], `blocked: ${denied.message}`); } catch { /* Preserve the denial. */ }
        throw denied;
      }
      const steps = [];
      const controller = new AbortController();
      controllers.add(controller);
      // Saturated capacity queues the review behind running ones; the deadline covers the wait.
      // Keep a hung provider counted until it settles, even after the execution deadline expires.
      const work = (async () => {
        try {
          await capacity();
          return await review(proposal, await getContext(), controller.signal, step => steps.push(step));
        }
        finally { release(); controllers.delete(controller); }
      })();
      try {
        await deadline(() => work, options.timeoutMs);
        if (closed) throw new ReviewDenied('plugin unloaded during review');
        verify();
        await audit(proposal, steps, 'allowed');
      } catch (error) {
        controller.abort();
        if (error instanceof ReviewDenied) {
          try { await audit(proposal, steps, `blocked: ${error.message}`); } catch { /* Preserve the denial. */ }
          throw error;
        }
        // Provider errors may include credentials, HTTP bodies, or command arguments.
        const denied = new ReviewDenied('review failed; no approval was issued');
        try { await audit(proposal, steps, `blocked: ${denied.message}`); } catch { /* Preserve the denial. */ }
        throw denied;
      }
    };
    const registrations = [];
    registrations.push(await ctx.tool.hook('execute.before', async event => {
      // Only opt-in tools are reviewed; the rest pass without review, audit, or delay.
      if (options && !options.tools.includes(event.tool)) return;
      const initial = encode({ tool: event.tool, input: event.input });
      const proposal = JSON.parse(initial);
      proposal.kind = 'tool';
      proposal.directory = ctx.location.directory;
      proposal.sessionID = event.sessionID;
      await guard(proposal, async () => {
        const [messages, tools] = await Promise.all([
          ctx.session.context({ sessionID: event.sessionID }), ctx.tool.list(),
        ]);
        if (!Array.isArray(messages) || !Array.isArray(tools)) throw new ReviewDenied('context unavailable');
        // Only actual user messages can supply authorization; compaction is explicitly incomplete.
        const userMessages = messages.filter(m => m.type === 'user').map(m => ({ id: m.id, text: m.text }));
        const definition = tools.find(tool => tool.id === event.tool);
        return { userMessages, compacted: messages.some(m => m.type === 'compaction'),
          toolDescription: definition?.description ?? 'No registered description; investigate or deny.' };
      }, () => {
        if (encode({ tool: event.tool, input: event.input }) !== initial) throw new ReviewDenied('tool changed during review');
        lock(event, ['tool', 'input']);
      });
    }));
    return async () => {
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.all(registrations.map(registration => registration.dispose()));
    };
  },
};
