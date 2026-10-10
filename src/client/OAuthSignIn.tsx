/**
 * The card's OAuth QR sign-in section: one resting bar row plus a dialog
 * opened by the sign-in button.
 *
 * 参考：workbuddy2api-panel 的「添加账号」弹窗交互形态 —— 静态入口一行，
 *   点开后弹窗内分步走：获取授权链接 → 自动打开浏览器 → 弹窗内显示链接
 *   与等待状态 → 完成/失败回填结果。本实现沿用该步骤划分；弹窗样式直接
 *   用本项目导出/导入弹框的类（dsm-workbuddy-transfer-dialog），不引入
 *   第二套视觉。
 * 改动：自动打开浏览器。弹窗拦截的规避方式是「用户手势内同步 window.open
 *   占位，拿到授权 URL 后再导航」——点击「获取授权链接」的那一刻浏览器
 *   仍认定这是用户激活的手势链，占位窗口不会被拦；若 Host 环境连占位都
 *   拦（返回 null），降级为弹窗内手动「打开登录页」链接，功能不损失。
 *
 * 轮询循环压成一个组件内 effect：按 `OAUTH_POLL_INTERVAL_MS` 节奏问 Host
 *   「完成了吗」，完成即停。所有状态就地管理，零跨组件往返；Host 重启
 *   导致 loginId 失效会得到 done+error，与超时同一条文案路径。
 *
 * @module dsh-connect-workbuddy/client/OAuthSignIn
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { OAUTH_POLL_INTERVAL_MS, WORKBUDDY_OAUTH_PATH, withWorkBuddyRouteAction } from '../status-paths.ts'
import type { WorkBuddyWebRegion } from '../status-paths.ts'
import type { Translate } from './searched-paths.ts'
import { BusyOverlay } from './BusyOverlay.tsx'

/** Props: the region tab the section is rendered on, and the card's copy. */
export interface OAuthSignInProps {
  t: Translate
  region: WorkBuddyWebRegion
  /**
   * Called once the Host has stored the credential, so the CARD can re-read
   * its snapshot and show the new account immediately.
   *
   * The account only reaches the table through the usage route; without this
   * the row appeared on the next poll, and on a region that had no account
   * before the sign-in there was no poll at all — the new account showed up
   * only after the card was closed and reopened.
   */
  onAdded?: () => void | Promise<unknown>
}

/** One poll's body as the Host's route answers it. */
type PollBody =
  | { done: false }
  | { done: true, accountName?: string, accountId?: string, error?: string }

type Phase =
  | { kind: 'idle' }
  | { kind: 'opening' }
  | { kind: 'waiting', loginId: string, verificationUri: string, startedAtMs: number, expiresAtMs: number }
  /** The Host stored the credential; the card's re-read is still in flight. */
  | { kind: 'syncing', accountName: string }
  | { kind: 'finished', message: 'added' | 'cancelled' | 'error', accountName?: string, error?: string }

/** Seconds since the login started, for the waiting line. */
function elapsedSeconds(sinceMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - sinceMs) / 1000))
}

/** Copy the sign-in URL to the clipboard; true on success. */
async function copyUrl(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url)
    return true
  } catch {
    return false
  }
}

/**
 * The section. Rendered on BOTH sign-in states: a signed-out machine gains
 * its first account here; a signed-in one can add another without leaving
 * the card.
 */
export function OAuthSignIn({ t, region, onAdded }: OAuthSignInProps): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [dialogOpen, setDialogOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pollTick, setPollTick] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // The waiting clock: one tick a second only while a login is in flight. A
  // login that runs PAST its stated expiry turns into a local timeout — the
  // Host's session expires independently, and this stops the UI waiting on a
  // dead loginId even if a poll answer was lost.
  const waiting = phase.kind === 'waiting'
  useEffect(() => {
    if (!waiting || phase.kind !== 'waiting') return
    const expiresAtMs = phase.expiresAtMs
    const timer = setInterval(() => {
      if (!mounted.current) return
      const now = Date.now()
      setNowMs(now)
      if (now > expiresAtMs) setPhase({ kind: 'finished', message: 'error', error: t('row.oauthTimedOut') })
    }, 1000)
    return () => { clearInterval(timer) }
  }, [waiting, phase, t])

  // The poll loop: one request per interval while waiting, ending on done.
  // A pending answer bumps `pollTick`, which re-arms this effect for the next
  // interval — one in-flight poll at a time, no accumulating timers.
  useEffect(() => {
    if (phase.kind !== 'waiting') return
    const { loginId } = phase
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(withWorkBuddyRouteAction(WORKBUDDY_OAUTH_PATH, region, 'poll'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ loginId }),
          })
          const body = await response.json() as PollBody
          if (cancelled || !mounted.current) return
          if (!response.ok || !body || typeof body !== 'object') {
            setPhase({ kind: 'finished', message: 'error', error: `HTTP ${response.status}` })
            return
          }
          if (!body.done) {
            setPollTick(tick => tick + 1)
            return
          }
          if (typeof body.error === 'string' && body.error !== '') {
            setPhase({ kind: 'finished', message: 'error', error: body.error })
          } else {
            const accountName = body.accountName ?? ''
            // Hold the veil across the re-read: the credential is stored, but
            // the account table changes only when the card's fresh snapshot
            // lands. Same reasoning as the import path in AccountTransfer.
            setPhase({ kind: 'syncing', accountName })
            await onAdded?.()
            if (cancelled || !mounted.current) return
            setPhase({ kind: 'finished', message: 'added', accountName })
          }
        } catch {
          // A transport blip is not a dead login; the next tick retries, and
          // the session deadline on the Host eventually ends a stuck login.
          setPollTick(tick => tick + 1)
        }
      })()
    }, OAUTH_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [onAdded, phase, pollTick, region])

  /**
   * Fetch the authorization URL AND open the browser in one gesture chain.
   * The placeholder window is opened synchronously — inside the click's user
   * activation, before any await — so popup blocking cannot intervene; the
   * URL is navigated once the Host answers. A blocked placeholder (null)
   * degrades to the manual link inside the dialog, losing nothing but the
   * convenience.
   */
  const start = async (placeholder: Window | null): Promise<void> => {
    setPhase({ kind: 'opening' })
    setCopied(false)
    try {
      const response = await fetch(withWorkBuddyRouteAction(WORKBUDDY_OAUTH_PATH, region, 'start'), {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const body = await response.json() as
        | { loginId?: string, verificationUri?: string, expiresIn?: number, error?: string }
      if (!mounted.current) { placeholder?.close(); return }
      if (!response.ok || typeof body.loginId !== 'string' || typeof body.verificationUri !== 'string') {
        placeholder?.close()
        setPhase({ kind: 'finished', message: 'error', error: body.error ?? `HTTP ${response.status}` })
        return
      }
      if (placeholder !== null) {
        placeholder.location.href = body.verificationUri
      }
      setPhase({
        kind: 'waiting',
        loginId: body.loginId,
        verificationUri: body.verificationUri,
        startedAtMs: Date.now(),
        // The route states the TTL in seconds; a Host that omits it gets the
        // documented 10 minutes rather than an invented longer window.
        expiresAtMs: Date.now() + (typeof body.expiresIn === 'number' && body.expiresIn > 0 ? body.expiresIn : 600) * 1000,
      })
      setNowMs(Date.now())
    } catch (error: unknown) {
      placeholder?.close()
      if (mounted.current) {
        setPhase({ kind: 'finished', message: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  /** Open the dialog and begin the login in the same click: the placeholder
   * window must be created synchronously to count as a user gesture. */
  const beginSignIn = (): void => {
    setDialogOpen(true)
    const placeholder = window.open('', '_blank', 'noopener,noreferrer')
    void start(placeholder)
  }

  /** Re-open the sign-in page from the waiting dialog (no new session). */
  const reopen = (): void => {
    if (phase.kind !== 'waiting') return
    window.open(phase.verificationUri, '_blank', 'noopener,noreferrer')
  }

  const finishText = phase.kind === 'finished'
    ? phase.message === 'added'
      ? t('row.oauthDone', { accountName: phase.accountName === '' || phase.accountName === undefined ? t('row.accountUnnamed') : phase.accountName })
      : phase.message === 'cancelled'
        ? t('row.oauthCancelled')
        : t('row.oauthError', { message: phase.error ?? '' })
    : ''

  return (
    <section className="dsm-workbuddy-bar" aria-label={t('row.oauthTitle')}>
      {/* Sign-in writes a credential and the account table then re-reads; the
          veil covers the gap so the new row appears without a manual reopen. */}
      <BusyOverlay
        visible={phase.kind === 'syncing'}
        message={t('row.oauthSyncing')}
        hint={t('row.veilHintList')}
      />
      <p className="dsm-workbuddy-bar-label">{t('row.oauthTitle')}</p>
      {phase.kind === 'finished'
        ? <p className={`dsm-workbuddy-bar-status ${phase.message === 'added' ? 'dsm-workbuddy-bar-ok' : 'dsm-workbuddy-bar-error'}`}>{finishText}</p>
        : phase.kind === 'waiting'
          ? <p className="dsm-workbuddy-bar-status">{t('row.oauthOpened')}</p>
          : null}
      <div className="dsm-workbuddy-bar-actions">
        <button
          type="button"
          className="dsm-btn dsm-btn-outline"
          disabled={phase.kind === 'opening'}
          onClick={beginSignIn}
        >
          {phase.kind === 'opening' ? t('row.oauthStarting') : t('row.oauthStart')}
        </button>
      </div>
      {dialogOpen
        ? <div className="dsm-workbuddy-transfer-dialog" role="dialog" aria-label={t('row.oauthTitle')}>
            {phase.kind === 'opening'
              ? <p>{t('row.oauthStarting')}</p>
              : phase.kind === 'waiting'
                ? <>
                    <p>{t('row.oauthOpenHint')}</p>
                    <p className="dsm-workbuddy-oauth-url">
                      <a href={phase.verificationUri} target="_blank" rel="noopener noreferrer">{phase.verificationUri}</a>
                    </p>
                    <p className="dsm-workbuddy-hint">
                      {t('row.oauthWaiting', { seconds: elapsedSeconds(phase.startedAtMs, nowMs) })}
                      {' '}
                      {t('row.oauthExpires', { minutes: Math.max(1, Math.round((phase.expiresAtMs - nowMs) / 60_000)) })}
                    </p>
                    <div className="dsm-workbuddy-transfer-dialog-actions">
                      <button
                        type="button"
                        className="dsm-btn dsm-btn-outline"
                        onClick={() => { void copyUrl(phase.verificationUri).then(ok => { if (mounted.current) setCopied(ok) }) }}
                      >
                        {copied ? t('row.oauthCopied') : t('row.oauthCopy')}
                      </button>
                      <button type="button" className="dsm-btn dsm-btn-outline" onClick={reopen}>{t('row.oauthReopen')}</button>
                      <button
                        type="button"
                        className="dsm-btn dsm-btn-outline"
                        onClick={() => { setPhase({ kind: 'finished', message: 'cancelled' }) }}
                      >
                        {t('row.oauthCancel')}
                      </button>
                    </div>
                  </>
                : phase.kind === 'finished'
                  ? <>
                      <p className={`${phase.message === 'added' ? 'dsm-workbuddy-bar-ok' : phase.message === 'error' ? 'dsm-workbuddy-bar-error' : ''}`}>{finishText}</p>
                      <div className="dsm-workbuddy-transfer-dialog-actions">
                        <button type="button" className="dsm-btn dsm-btn-outline" onClick={() => { setDialogOpen(false) }}>
                          {t('row.oauthDialogClose')}
                        </button>
                      </div>
                    </>
                  : null}
          </div>
        : null}
    </section>
  )
}
