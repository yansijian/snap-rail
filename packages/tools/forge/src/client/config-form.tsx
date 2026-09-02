/**
 * The LLM endpoint configuration form: service address, key, and model for
 * any OpenAI-compatible provider (DeepSeek, GLM, OpenAI, an on-site
 * gateway). Writes land in the `forge.llm` settings key and hot-apply — the
 * next session send picks them up without a restart. The key is stored in
 * this terminal's settings.json (single-operator device; not a secret
 * store). Rendered inside the studio window's settings dialog.
 *
 * @module @snap-rail/forge/client/config-form
 */

import type { Context } from '@snap-rail/cordis'
import type { ClientHandle } from '@snap-rail/client-runtime'
import { useEffect, useState, type ReactNode } from 'react'
import { rpcErrorText } from '@snap-rail/connection'
import '@snap-rail/station-rpc/contract'
import { Button, Input, Label } from '@snap-rail/client-ui'
import { FORGE_LLM_KEY, llmConfigSchema } from '../contract.ts'

/** The configuration form; `onSaved` fires after a successful write. */
export function LlmConfigForm(props: { ctx: Context, onSaved?(): void }): ReactNode {
  const link: ClientHandle['link'] = props.ctx.client.link
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void link.call('settings.get', { key: FORGE_LLM_KEY }).then(result => {
      if (!result.ok || result.value.value === null) return
      const parsed = llmConfigSchema.safeParse(result.value.value)
      if (!parsed.success) return
      setBaseUrl(parsed.data.baseUrl)
      setApiKey(parsed.data.apiKey)
      setModel(parsed.data.model)
    })
  }, [link])

  const valid = llmConfigSchema.safeParse({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() })

  const save = (): void => {
    if (!valid.success || busy) return
    setBusy(true)
    setNotice(null)
    void link.call('settings.set', { key: FORGE_LLM_KEY, value: valid.data }).then(result => {
      if (!result.ok) {
        setNotice(rpcErrorText(result.error))
        return
      }
      setSaved(true)
      props.onSaved?.()
      window.setTimeout(() => { setSaved(false) }, 1500)
    }).finally(() => { setBusy(false) })
  }

  return (
    <div className="space-y-4" data-forge="config">
      <div className="space-y-1.5">
        <Label>服务地址（含版本段，如 https://api.deepseek.com/v1）</Label>
        <Input
          value={baseUrl}
          placeholder="https://api.deepseek.com/v1"
          onChange={event => { setBaseUrl(event.target.value) }}
        />
      </div>
      <div className="space-y-1.5">
        <Label>API 密钥</Label>
        <Input
          type="password"
          value={apiKey}
          placeholder="sk-…"
          onChange={event => { setApiKey(event.target.value) }}
        />
      </div>
      <div className="space-y-1.5">
        <Label>模型</Label>
        <Input
          value={model}
          placeholder="deepseek-chat"
          onChange={event => { setModel(event.target.value) }}
        />
      </div>
      {notice !== null && <p className="text-sm text-destructive" role="alert">{notice}</p>}
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          任何 OpenAI 兼容服务均可（DeepSeek / GLM / OpenAI / 内网网关）。密钥保存在本机 settings.json。
        </p>
        <Button size="lg" disabled={!valid.success || busy} onClick={save}>
          {busy ? '保存中…' : saved ? '已保存' : '保存'}
        </Button>
      </div>
    </div>
  )
}
