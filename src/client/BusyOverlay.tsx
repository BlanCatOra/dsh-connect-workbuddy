/**
 * The shared busy veil: one overlay for every account operation whose result
 * only lands on screen after the list re-read.
 *
 * 参考：workbuddy2api-panel 的「添加账号」弹窗 —— 操作期间用一层蒙版把界面
 *   定住并说明正在做什么，而不是让用户对着没有变化的表格猜。本实现把该形态
 *   抽成可复用组件，供删除、导入、扫码添加三处共用同一套视觉与语义。
 * 改动：不只表示「请求还在飞」，而是持续到**列表刷新落地**为止。这两个时刻
 *   之间有一段真空期（Host 已改完、卡片的 usage 快照还没回来），过去这段
 *   真空期就是用户看到的「删了但还在」「导入了但没出现」——把遮罩的关闭条件
 *   绑在刷新完成上，延迟就从「看不见」变成「看着它发生」。
 *
 * 遮罩本身不自己计时：文案由调用方按场景给出（删除中 / 导入中 / 添加中），
 *   超时由调用方控制，这里只负责「显示什么」。这是它唯一需要被共用的事实
 *   来源——各处的场景文案不同，视觉与语义必须一致。
 *
 * @module dsh-connect-workbuddy/client/BusyOverlay
 */

import { createElement as h } from 'react'
import type { ReactElement } from 'react'

/** Props: the veil's message, whether it is showing, and an optional detail line. */
export interface BusyOverlayProps {
  /** The scenario line, already translated by the caller (e.g. "正在删除…"). */
  message: string
  /** Extra detail under the message, already translated; omitted when absent. */
  hint?: string
  /**
   * Whether the veil is up. Rendering nothing while false keeps the common
   * resting case free of an invisible layer that would still eat clicks.
   */
  visible: boolean
}

/**
 * The veil. Deliberately NOT a modal dialog: it carries no focusable control
 * and no dismissal — there is nothing for the user to decide, only a step to
 * wait through. `aria-busy` plus a polite live region state that to screen
 * readers, which is the whole accessibility contract a wait screen needs.
 */
export function BusyOverlay({ message, hint, visible }: BusyOverlayProps): ReactElement | null {
  if (!visible) return null
  return (
    <div className="dsm-workbuddy-veil" role="status" aria-busy="true" aria-live="polite">
      <div className="dsm-workbuddy-veil-card">
        <span className="dsm-workbuddy-veil-spinner" aria-hidden="true" />
        <span className="dsm-workbuddy-veil-text">{message}</span>
        {hint === undefined ? null : <span className="dsm-workbuddy-veil-hint">{hint}</span>}
      </div>
    </div>
  )
}
