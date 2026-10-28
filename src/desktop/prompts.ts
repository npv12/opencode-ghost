import { createEffect, onCleanup } from 'solid-js';
import { Schema } from 'effect';
import { Command, Plugin, createKeyed } from '@opencode/plugin/gui';
import { PredictionController } from '../prediction/controller.mjs';
import { contextText } from '../prediction/context.mjs';
import { INVALIDATING_EVENTS } from '../opencode/snapshot.mjs';
import { nextWordChunk } from '../prediction/word.mjs';
import { createPromptGhost, promptEditorSnapshot } from './prompt-editor.mjs';

type Context = Parameters<Plugin.Setup>[0];
type Model = { providerID: string; id: string; variant?: string };
const bounded = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

export function completionModel(value: unknown): Model | undefined {
  if (typeof value === 'string') {
    const hash = value.indexOf('#'), ref = hash < 0 ? value : value.slice(0, hash), slash = ref.indexOf('/');
    if (slash < 1 || slash === ref.length - 1) return;
    return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(hash < 0 ? {} : { variant: value.slice(hash + 1) }) };
  }
  if (value && typeof value === 'object') {
    const model = value as Model;
    if (typeof model.providerID === 'string' && model.providerID && typeof model.id === 'string' && model.id)
      return { providerID: model.providerID, id: model.id, ...(typeof model.variant === 'string' ? { variant: model.variant } : {}) };
  }
}

export function setupPromptCompletion(ctx: Context) {
  const config = ctx.options.promptCompletion;
  const options: Record<string, unknown> = config && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, unknown> : {};
  const preference = ctx.storage.store('prompt-completion-enabled', { schema: Schema.Struct({ enabled: Schema.Boolean }), initial: { enabled: options.enabled === true } });
  const enabled = () => preference.ready() && preference.value?.enabled === true;
  const automatic = options.automatic !== false;
  const debounce = bounded(options.typingDebounceMs, 500, 100, 5000);
  const cooldown = bounded(options.cooldownMs, 1500, 0, 10000);
  const ghost = createPromptGhost(document);
  let disposed = false, broken = false, composing = false, foreground = document.hasFocus() && document.visibilityState !== 'hidden', queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextRequestAt = 0, scheduled = '';
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const enqueue = () => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => { queued = false; refresh(); });
  };
  const controller = new PredictionController({ automatic,
    timeoutMs: bounded(options.timeoutMs, 7000, 1000, 15000), onChange: enqueue,
    generate: (request, requestOptions) => {
      const session = ctx.sessions.current();
      if (!session) return Promise.reject(new Error('No routed session'));
      return session.server.client.generate.text({ model: request.model as Model, prompt: request.prompt }, requestOptions);
    },
  });
  function snapshot() {
    const session = ctx.sessions.current(), composer = ctx.screen.current()?.composer;
    const field = promptEditorSnapshot(composer, { document, composing });
    const selected = composer?.model();
    const catalog = session?.server.data.location.model.list(session.location);
    const configured = options.predictionModel !== undefined;
    let model = configured ? completionModel(options.predictionModel) : selected && { providerID: selected.providerID, id: selected.modelID, variant: undefined as string | undefined };
    const available = catalog?.find(item => model && item.enabled && item.providerID === model.providerID && item.id === model.id);
    if (model && !configured) model = { ...model, variant: ['none', 'minimal', 'low'].find(id => available?.variants.some(variant => variant.id === id)) };
    if (!available || model?.variant && !available.variants.some(variant => variant.id === model!.variant)) model = undefined;
    const running = !!session && session.server.data.session.status(session.id) === 'running';
    const context = contextText(session?.server.data.session.message.list(session.id) || [], { running, maxCharacters: 10000 });
    const eligible = enabled() && !broken && foreground && field.eligible && !!session && !!model &&
      field.prefix.length <= 2000 && !/^\s*[!/]/.test(field.prefix);
    return { ...field, eligible, composer, session, model, context,
      // The bounded context itself is a collision-free in-memory revision; never log it.
      revision: context, running, sessionID: session ? `${session.key}\0${session.directory}` : null,
      requestable: eligible, presentable: eligible,
    };
  }
  const key = (value: ReturnType<typeof snapshot>) => JSON.stringify([value.sessionID, value.revision, value.model, value.prefix]);
  function schedule(value: ReturnType<typeof snapshot>) {
    if (!automatic || !value.requestable || !controller.needsRequest ||
        (value.prefix === '' ? value.context === '[]' || value.running : [...value.prefix.trim()].length < 3)) { clearTimer(); return; }
    const identity = key(value);
    if (timer && scheduled === identity) return;
    clearTimer(); scheduled = identity;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || broken) return;
      try {
        const latest = snapshot(); controller.update(latest);
        if (key(latest) !== identity || !latest.requestable || !controller.needsRequest) return;
        nextRequestAt = Date.now() + cooldown;
        void controller.request(latest, 'desktop').catch(fail);
      } catch { fail(); }
    }, Math.max(debounce, nextRequestAt - Date.now()));
  }
  function fail() { broken = true; clearTimer(); controller.dispose(); ghost.clear(); }
  function refresh() {
    if (disposed || broken) return;
    try {
      const value = snapshot(); controller.update(value);
      const state = controller.state;
      ghost.update({ ...value, eligible: value.presentable }, state.status === 'ready' && state.sessionID === value.sessionID && state.prefix === value.prefix ? state.suggestion || '' : '');
      schedule(value);
    } catch { fail(); }
  }
  function accept(word = false) {
    if (disposed || broken) return false;
    try {
      refresh();
      const value = snapshot(), state = controller.state;
      if (!ghost.visible || !value.eligible || state.status !== 'ready' || state.sessionID !== value.sessionID || state.prefix !== value.prefix) return false;
      const suffix = word ? nextWordChunk(state.suggestion) : state.suggestion;
      if (!suffix || !value.composer) return false;
      controller.dismiss(); ghost.clear(); clearTimer();
      // insert preserves mention nodes and attachments; setText would flatten mentions.
      // The DOM adapter has just verified a collapsed caret at the end of this exact draft.
      value.composer.insert(suffix);
      enqueue();
      return true;
    } catch { fail(); return false; }
  }
  function dismiss() { clearTimer(); controller.dismiss(); ghost.clear(); }
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || composing || disposed || broken) return;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    const word = event.key === 'ArrowRight' && !event.shiftKey && !event.metaKey && (event.altKey !== event.ctrlKey);
    if ((event.key === 'Tab' && plain || word) && !event.repeat && accept(word)) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (event.key === 'Escape' && plain && ghost.visible && promptEditorSnapshot(ctx.screen.current()?.composer, { document, composing }).eligible) {
      dismiss(); event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (event.key === 'Enter' || event.key === 'Tab' && event.shiftKey) { dismiss(); return; }
    enqueue();
  };
  const events: [EventTarget, string, EventListener, boolean][] = [];
  const listen = (target: EventTarget, name: string, handler: EventListener, capture = false) => {
    target.addEventListener(name, handler, capture); events.push([target, name, handler, capture]);
  };
  listen(document, 'keydown', keydown as EventListener, true);
  for (const name of ['input', 'selectionchange', 'focusin', 'focusout', 'pointerup', 'keyup']) listen(document, name, enqueue, true);
  listen(document, 'scroll', enqueue, true);
  listen(document, 'compositionstart', () => { composing = true; enqueue(); }, true);
  listen(document, 'compositionend', () => { composing = false; enqueue(); }, true);
  listen(window, 'blur', () => { foreground = false; enqueue(); });
  listen(window, 'focus', () => { foreground = document.visibilityState !== 'hidden'; enqueue(); });
  listen(document, 'visibilitychange', () => { foreground = document.hasFocus() && document.visibilityState !== 'hidden'; enqueue(); });
  listen(window, 'resize', enqueue);
  // focused() is not reactive; this also notices native popovers that opened without an input event.
  const poll = setInterval(() => { if (ghost.visible || ctx.screen.current()?.composer.focused()) enqueue(); }, 150);
  createEffect(refresh);
  createKeyed(() => ctx.sessions.current()?.server.data, data => {
    onCleanup(data.listen(({ details }) => {
      const event = details as { type: string; data?: { sessionID?: string } };
      if (event.data?.sessionID !== ctx.sessions.current()?.id) return;
      if (INVALIDATING_EVENTS.has(event.type)) { controller.invalidate(); ghost.clear(); }
      enqueue();
    }));
  });
  ctx.add(Command, (): Command => ({ id: 'prompt-completion.generate', title: 'Suggest or complete the prompt', group: 'Prompt', section: 'prompt',
    bind: 'mod+alt+j', editable: true, enabled: enabled() && !!ctx.sessions.current(), run: () => {
      ctx.screen.current()?.composer.focus();
      queueMicrotask(() => {
        if (disposed || broken) return;
        try { const value = snapshot(); controller.update(value); clearTimer(); void controller.request(value, 'desktop-manual', { manual: true }).catch(fail); } catch { fail(); }
      });
    } }));
  ctx.add(Command, (): Command => ({ id: 'prompt-completion.toggle', title: enabled() ? 'Disable prompt completion' : 'Enable prompt completion', group: 'Prompt',
    run: () => { preference.set({ enabled: !enabled() }); dismiss(); enqueue(); } }));
  ctx.add(Command, { id: 'prompt-completion.status', title: 'Desktop completion status', group: 'Prompt', run: () => {
    const value = snapshot(), stats = controller.diagnostics;
    void ctx.dialogs.alert({ title: 'Desktop completion', description: `Enabled: ${enabled()}. Inline: ${ghost.visible}. State: ${broken ? 'adapter-error' : controller.state.status}. Editor: ${value.reason}. Model: ${value.model ? `${value.model.providerID}/${value.model.id}#${value.model.variant || 'default'}` : 'unavailable'}. Requests: ${stats.requests}. Cache hits: ${stats.cacheHits}. Last latency: ${stats.latencyMs ?? '—'} ms.` });
  } });
  const dispose = () => {
    if (disposed) return;
    disposed = true; clearTimer(); clearInterval(poll); controller.dispose(); ghost.dispose();
    for (const [target, name, handler, capture] of events) target.removeEventListener(name, handler, capture);
  };
  onCleanup(dispose);
  return { refresh, accept, dismiss, dispose, get state() { return controller.state; }, get diagnostics() { return controller.diagnostics; } };
}

export default Plugin.define({ setup(ctx) { setupPromptCompletion(ctx); } });
