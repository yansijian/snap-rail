/**
 * The plugin feed-source editor: the URL list the search and update sweep
 * merge. Split out of the plugins page so the settings shell hosts the entry
 * beside its own close control.
 *
 * @module @snap-rail/ui/settings-pages/plugin-feed
 */

import type { Context } from '@snap-rail/cordis'
import { PLUGINS_FEED_URLS_KEY } from '@snap-rail/app-boot/contract'
import '@snap-rail/app-boot/contract'
import { rpcErrorText } from '@snap-rail/connection'
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Stack } from '../components/index.ts'

/** The feed-source editor dialog; the open state lives with the opener. */
export function PluginFeedDialog(props: { ctx: Context, open: boolean, onOpenChange: (open: boolean) => void }): ReactNode {
  const { open } = props
  const link = props.ctx.client.link
  const [urls, setUrls] = useState<readonly string[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  // A fresh read per open; an empty read means the factory default list is
  // in force.
  useEffect(() => {
    if (!open) return
    void link.call('settings.get', { key: PLUGINS_FEED_URLS_KEY }).then(result => {
      if (result.ok && Array.isArray(result.value.value)) {
        setUrls(result.value.value.filter((entry): entry is string => typeof entry === 'string'))
      }
    }).catch(() => undefined)
  }, [open, link])

  const save = (): void => {
    for (const url of urls) {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
      } catch {
        setError('插件源地址需要以 http(s) 开头')
        return
      }
    }
    setError(undefined)
    void link.call('settings.set', { key: PLUGINS_FEED_URLS_KEY, value: urls }).then(result => {
      if (!result.ok) {
        setError(rpcErrorText(result.error))
        return
      }
      props.onOpenChange(false)
    }).catch(cause => setError(String(cause)))
  }

  const append = (): void => {
    const value = draft.trim()
    if (value === '') return
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
    } catch {
      setError('请填写 http(s) 开头的插件源地址')
      return
    }
    setError(undefined)
    setDraft('')
    setUrls(current => current.includes(value) ? current : [...current, value])
  }

  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent presentation="modal" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>插件源</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Stack gap="sm">
            {urls.length === 0 && (
              <div style={{ fontSize: 'var(--snap-text-xs)', color: 'var(--snap-color-muted)' }}>尚未添加自定义源（当前使用出厂默认源）。</div>
            )}
            {urls.map((url, index) => (
              <div key={url} style={{ display: 'flex', gap: 'var(--snap-space-sm)', alignItems: 'center' }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--snap-text-xs)' }}>{url}</span>
                <Button intent="neutral" emphasis="ghost" size="sm" aria-label={`移除 ${url}`} onClick={() => setUrls(current => current.filter((_, at) => at !== index))}>✕</Button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 'var(--snap-space-sm)', width: '100%' }}>
              <Input
                value={draft}
                placeholder="https://…"
                style={{ flex: 1, minWidth: 0 }}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') append() }}
              />
              <Button intent="neutral" emphasis="outline" onClick={append}>添加源</Button>
            </div>
            {error !== undefined && (
              <div role="alert" style={{ color: 'var(--snap-color-danger)', fontSize: 'var(--snap-text-sm)' }}>{error}</div>
            )}
          </Stack>
        </DialogBody>
        <DialogFooter>
          <Button intent="neutral" emphasis="outline" onClick={() => props.onOpenChange(false)}>取消</Button>
          <Button intent="primary" data-plugins-feed-save onClick={save}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
