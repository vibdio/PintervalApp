// Minimal event bus with phase/priority/lock/abort (based on 開発方針)
export class EventBus {
  constructor() {
    /** @type {Record<string, Array<{ fn:Function, phase:'pre'|'main'|'post', priority:number, lockKey?:string }>>} */
    this.handlers = {};
    /** map for lockKey -> AbortController */
    this.locks = new Map();
  }

  /**
   * Register an event handler
   * @param {string} name
   * @param {(payload:any, ctx:{ txId:string, signal:AbortSignal })=>Promise<void>|void} fn
   * @param {{ phase?: 'pre'|'main'|'post', priority?: number, lockKey?: string }} [opt]
   */
  on(name, fn, opt={}) {
    const entry = {
      fn,
      phase: opt.phase ?? 'main',
      priority: opt.priority ?? 0,
      lockKey: opt.lockKey
    };
    if (!this.handlers[name]) this.handlers[name] = [];
    this.handlers[name].push(entry);
  }

  /**
   * Emit event (standard)
   * @param {string} name
   * @param {any} payload
   * @param {{ txId?: string, signal?: AbortSignal }} [opt]
   */
  async emit(name, payload, opt={}) {
    const txId = opt.txId || crypto.randomUUID?.() || String(Date.now());
    const signal = opt.signal;

    const entries = (this.handlers[name] || []).slice().sort((a, b) => {
      const phaseOrder = (v) => v === 'pre' ? 0 : (v === 'main' ? 1 : 2);
      const d = phaseOrder(a.phase) - phaseOrder(b.phase);
      if (d !== 0) return d;
      if (a.priority !== b.priority) return b.priority - a.priority; // desc
      return 0; // registration order preserved by stable sort
    });

    for (const h of entries) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await h.fn(payload, { txId, signal: signal || new AbortController().signal });
    }
  }

  /**
   * Emit with "switch" semantics (cancel previous for the same lockKey)
   * @param {string} name 
   * @param {any} payload 
   * @param {{ lockKey: string, txId?: string }} opt 
   */
  async emitSwitch(name, payload, opt) {
    if (!opt?.lockKey) throw new Error('lockKey is required for emitSwitch');
    const prev = this.locks.get(opt.lockKey);
    if (prev) prev.abort();

    const controller = new AbortController();
    this.locks.set(opt.lockKey, controller);

    try {
      await this.emit(name, payload, { txId: opt.txId, signal: controller.signal });
    } finally {
      // if we are still the latest controller for the lockKey, clear it
      if (this.locks.get(opt.lockKey) === controller) {
        this.locks.delete(opt.lockKey);
      }
    }
  }
}

export const bus = new EventBus();

// Event contract (document)
// name: 'search:run' payload: { query: string }
//  - pre: validate query
//  - main: fetch images via /api/search
//  - post: update UI
// name: 'play:start' payload: none
// name: 'play:pause' payload: none
// name: 'play:stop' payload: none
// name: 'play:next' payload: { reset: boolean }
// name: 'countdown:tick' payload: { remainMs: number }
