/**
 * Browser half: WorkBuddy credits and model management inside Plugin
 * configuration.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 浏览器插件的注册形态（`slots` / `locale` / `settingsScope` 三项注入、
 *     `LocaleNamespaceMap` 的模块增强、`settings.plugin.item` 槽位与
 *     `key` / `priority` 的 rc.7 写法、以及整个 apply 体包 try/catch
 *     以便槽位 API 变更时降级为 console.error 而不触发
 *     "Failed to load plugins" 红色横幅）来自该项目，
 *     其亦注明沿用 corrinehu/dsh-workbuddy-connect 的同一模式。
 * 改动：无实质改动，仅改为本插件的命名空间与组件名。
 *
 * NOTE: the try/catch boundary of this function is mirrored (duplicated) in
 * `tests/client-fallback.spec.ts`, because the real client entry imports
 * browser-only DSH packages that cannot load in the Node test environment.
 * That test therefore does not import this function — it replicates its
 * shape. If you change the guarded body or the `console.error` message here,
 * update the mirrored `apply()` in that spec too, or the fallback test will
 * silently diverge from this real implementation.
 *
 * @module dsh-connect-workbuddy/client
 */

import { WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES, WORKBUDDY_SETTINGS_NS } from '../status-paths.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// The `slots` service declaration moved host lines: `dsh-client-runtime/client`
// owned it up to 0.1.1-rc.2, and `dsh-client-ui-renderer/client` owns it from
// the 0.1.5 line (that package stopped being published). Both are type-only
// side-effect imports; whichever the host ships supplies the augmentation.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { WorkBuddyCard } from './WorkBuddyCard.tsx'
import type { WorkBuddyCardInjected } from './WorkBuddyCard.tsx'
import { ComposerCreditsGate } from './ComposerCreditsGate.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/**
 * The browser-side plugin context this entry needs.
 *
 * `ClientContext` used to be re-exported by `@deepseek-ai/dsh-client-runtime/client`;
 * that package stopped at 0.1.1-rc.2 and is neither published nor bundled on
 * the 0.1.7 line, so it cannot serve as a type source. The `slots` / `locale`
 * seats the card actually touches are declared by the client subpath modules
 * imported above, so naming them explicitly keeps this entry compilable.
 * Cordis' `Context` already carries the `effect` fiber API. (The 0.1.5-only
 * `settingsScope` service was removed with that line in 2.1.0.)
 */
export type WorkBuddyClientContext = Context & {
  slots: Context['slots']
  locale: Context['locale']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy plugin card copy. */
    'settings.workbuddy': WorkBuddySettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-connect-workbuddy-client'
/**
 * Client services required by the Plugin configuration contribution.
 *
 * Deliberately only the two services that exist on BOTH host lines. The
 * settings surface differs by line — 0.1.5 provides `settingsScope`, 0.1.7
 * replaces it with `configForms` — and Cordis' dependency gate is hard: any
 * inject entry the running line does not provide keeps `apply` from ever
 * running. Probing both via `ctx.get()` (which returns undefined, never
 * throws, for an absent service) is what lets one build serve both lines.
 */
export const inject = ['slots', 'locale']

/** Register card copy and the WorkBuddy card under Plugin configuration. */
export function apply(ctx: WorkBuddyClientContext): void {
  try {
    const namespace = 'settings.workbuddy'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-connect-workbuddy: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyCardInjected['t']

    // Soft service probe. Property access on an undeclared service THROWS
    // ("cannot get property X without inject") — `?.` guards null/undefined,
    // not a throwing getter — while `ctx.get()` returns undefined for an
    // absent service. Never touch `ctx.configForms` / `ctx.settingsScope`
    // directly; go through `get`.
    const softGet = (name: string): unknown => (ctx as unknown as { get(name: string): unknown }).get(name)

    let settingsScope: WorkBuddyCardInjected['settingsScope'] | undefined
    const forms = softGet('configForms') as
      | {
          describe(): { getSnapshot(): { view?: { namespaces?: { ns: string }[] } } }
          get(ns: string): WorkBuddyCardInjected['settingsScope']
          whileServed(
            namespaces: readonly string[],
            register: (served: ReadonlySet<string>) => () => void,
          ): () => void
        }
      | undefined
    // 0.1.7+ only: `configForms` is the client settings surface. The legacy
    // `settingsScope` service was removed with the 0.1.5 line (2.1.0), so
    // there is no fallback to bind.

    /** Register one card slot; returns its disposer, or undefined if it failed. */
    const registerCard = (slotName: string, key: string): (() => void) | undefined => {
      try {
        return ctx.slots.inject(slotName as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; key: string; priority: number; inject: () => WorkBuddyCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: slotName,
          key,
          priority: 30,
          inject: () => settingsScope === undefined
            ? { t }
            : { t, settingsScope },
        }, WorkBuddyCard))
      } catch (error: unknown) {
        // Isolated per slot on purpose: a failed registration must never take
        // the other slots down with it.
        console.error(`[dsh-connect-workbuddy] card slot "${slotName}" failed to register (host provider unaffected):`, error)
        return undefined
      }
    }

    /**
     * Credit readout in the composer tool row (`conversation.input.left`, a
     * session-scope list slot).
     *
     * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
     *   — 该项目的 `registerComposerPoints`：无条件注册插槽、由 gate 读
     *     `modelSelection` 投影自行决定是否渲染。本项目原先放在侧边栏底部
     *     （`sidebar.footer.action`），那里是**单个 root 级共享行**，两个连接器
     *     插件各占一行会互相挤压；输入框这行是 per-session 且按 provider 归属，
     *     天然只有一个插件的积分相关。
     *
     * Provider-scoped on purpose: it renders only while the session's selected
     * model belongs to this plugin, which is what keeps two connector plugins
     * from competing for one shared row. Registration is unconditional; the
     * gate reads the Host's `modelSelection` projection and returns null for
     * every other provider, so nothing is drawn and no fetch loop starts while
     * another provider is selected.
     */
    const registerComposerCredits = (): (() => void) | undefined => {
      try {
        return ctx.slots.inject('conversation.input.left' as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; id: string; order: number; locale: string; inject: () => WorkBuddyCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: 'conversation.input.left',
          id: 'dsh-connect-workbuddy-composer-credits',
          order: 4,
          locale: namespace,
          // `settingsScope` rides along so the gate can honor the card's
          // per-region switch without a second writer.
          inject: () => settingsScope === undefined
            ? { t }
            : { t, settingsScope },
        }, ComposerCreditsGate))
      } catch (error: unknown) {
        console.error('[dsh-connect-workbuddy] composer credits slot failed to register (host provider unaffected):', error)
        return undefined
      }
    }

    /**
     * Every slot this plugin contributes, and how to (re)create them.
     *
     * Kept as one list because the binding of `settingsScope` and the slot
     * registrations must move TOGETHER: see {@link bindSettingsScope} for why a
     * late-arriving namespace has to produce fresh registrations rather than a
     * mutated closure.
     */
    /**
     * Disposers of the slots registered for the CURRENT namespace binding.
     *
     * Declared before {@link bindSettingsScope} because that function closes
     * over it and reassigns it; the binding is only armed at the end of `apply`,
     * so this is initialised by then either way — hoisting it keeps that
     * ordering a non-requirement rather than a trap.
     */
    let liveDisposers: Array<() => void> = []

    const registerAllSlots = (): Array<() => void> => [
      registerCard('plugins.bundle.config', 'dsh-connect-workbuddy'),
      registerCard('plugins.row.config', 'dsh-connect-workbuddy#dsh-connect-workbuddy'),
      registerComposerCredits(),
    ].filter((disposer): disposer is () => void => disposer !== undefined)

    /**
     * Bind `settingsScope` to whichever namespace the Host really serves, and
     * RE-REGISTER every slot when that answer changes.
     *
     * Why this is not a one-shot read at startup — the shipped 4.3.0 defect
     * (issue #46): the mirror is filled by an async `remote.settings.describe()`,
     * so at `apply` time `view` is usually still absent. The old code read that
     * absence as "the declared name must be right", bound
     * `forms.get('workbuddy')`, and never looked again. `ConfigFormController.
     * derive()` matches the namespace EXACTLY, so the guessed form stayed
     * `unavailable` forever; the composer gate — reading only that scope —
     * judged the opt-out switch `undefined !== false` and kept rendering the
     * readout. Unticking the box wrote `false` correctly and changed nothing on
     * screen.
     *
     * `whileServed` is the Host's own idiom for this (`mirror.subscribe` plus an
     * immediate sync). It is strictly better than re-reading the snapshot by
     * hand because it ALSO withdraws the binding if the Host stops serving our
     * namespace, and it hands `register` the set of namespaces actually served
     * — so the choice is made from live data instead of a captured guess.
     *
     * `register` runs on the unserved→served EDGE, not on every mirror update
     * (see the service's `sync`), so the disposal below is not a churn loop: it
     * clears whatever a previous edge left registered. That replacement is NOT
     * optional, because the renderer caches each entry's inject result by object
     * identity (`rootInjectCache` / `cachedRootInject` in
     * `dsh-client-ui-renderer`: `if (!props) { props = runInject(...) }`), so an
     * entry registered before the mirror landed is never re-evaluated. Late
     * binding can therefore only work if the OLD registrations are disposed and
     * NEW ones created — which is what this callback does.
     */
    const bindSettingsScope = (): void => {
      if (forms === undefined || typeof forms.whileServed !== 'function') {
        // No settings surface on this host (or a pre-`whileServed` line): fall
        // back to binding the declared name once and registering once. The card
        // then renders read-only, which is the documented degradation.
        settingsScope = forms?.get(WORKBUDDY_SETTINGS_NS)
        liveDisposers = registerAllSlots()
        return
      }
      // Wrapped in `ctx.effect` so the watch is torn down with the plugin fiber,
      // per the service's contract (`whileServed` registers nothing on our
      // context by itself).
      ctx.effect(() => forms.whileServed(
        WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES,
        (served) => {
          // The mirror has spoken. The candidate list is ORDERED, so the first
          // spelling the Host actually serves wins; the `/workbuddy/i` sweep is
          // a last resort for an entry id naming this plugin in a way the
          // candidate list does not anticipate (a wrapper prefix, a suffix).
          const ns = WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES.find(candidate => served.has(candidate))
            ?? [...served].find(entry => /workbuddy/i.test(entry))
          settingsScope = ns === undefined ? undefined : forms.get(ns)
          // Replace, never append: the renderer's inject cache is keyed by entry
          // identity, so a stale registration would keep serving stale props.
          for (const dispose of liveDisposers) {
            try { dispose() } catch { /* already disposed by the slot service */ }
          }
          liveDisposers = registerAllSlots()
          return () => {
            for (const dispose of liveDisposers) {
              try { dispose() } catch { /* already disposed by the slot service */ }
            }
            liveDisposers = []
          }
        },
      ), 'dsh-connect-workbuddy: settings namespace binding')
    }

    bindSettingsScope()
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-connect-workbuddy] client card failed to load (host provider unaffected):', error)
  }
}
