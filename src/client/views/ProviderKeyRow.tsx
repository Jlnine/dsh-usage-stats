/**
 * 服务商卡片内的 Key 输入与保存行：该服务商的凭据变量名各配一个密码框
 * （如火山引擎两项 AK/SK），保存把非空输入经 Remote 写进 DSH 凭据中心
 * （不进配置文档、不回显、不进日志）。
 *
 * 与 ProviderForm 同一套安全流程：本地校验 → describeCredential 探测可写性
 * 与同名覆盖 → 需要覆盖时二次确认 → saveCredential 逐项写入 → onSaved 通知
 * 父组件立即刷新额度。密码框留空表示不修改该变量名的已有值。
 * 独立成文件，一个组件一个文件。
 */
import { useState } from 'react';

import { CREDENTIAL_VALUE_MAX_LENGTH } from '../../utils.ts';
import { describeCredential, saveCredential } from '../api.ts';

import css from './ProviderKeyRow.module.css';

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 单个输入框的填写值，键为环境变量名。 */
type KeyValues = Record<string, string>;

export function ProviderKeyRow({ refs, t, onSaved }: {
  t: PropsLocale<'dsh-usage-stats'>['t']
  /** 该服务的凭据变量名清单，按顺序渲染输入框。 */
  refs: string[]
  /** 保存成功后的回调：父组件刷新额度与卡片状态。 */
  onSaved: () => void
}) {
  const [values, setValues] = useState<KeyValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  /** 已配置同名 Key 的变量名清单；非空时按钮切换为覆盖确认，点一次才真写。 */
  const [overwrite, setOverwrite] = useState<string[]>([]);

  const setValue = (ref: string, value: string): void => {
    setSaved(false);
    setValues((prev) => ({ ...prev, [ref]: value }));
  };

  /** 取出本次非空的填写项（留空 = 不修改该变量名）。 */
  function filled(): [string, string][] {
    return refs
      .map((ref) => [ref, (values[ref] ?? '').trim()] as [string, string])
      .filter(([, value]) => value !== '');
  }

  /** 真正落库：逐项 saveCredential 写凭据中心，成功后清空输入框并回调。 */
  async function commit(entries: [string, string][]): Promise<void> {
    setBusy(true);
    setError('');
    try {
      for (const [ref, value] of entries) await saveCredential(ref, value);
      setValues({});
      setOverwrite([]);
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOverwrite([]);
    } finally {
      setBusy(false);
    }
  }

  /** 主提交：校验长度 → 探测可写性与同名覆盖 → 需要时进入二次确认。 */
  async function onSubmit(): Promise<void> {
    const entries = filled();
    if (entries.length === 0) {
      setError(t('providers.keyEmpty'));
      return;
    }
    if (entries.some(([, value]) => value.length > CREDENTIAL_VALUE_MAX_LENGTH)) {
      setError(t('providers.form.errKeyLong'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const probes = await Promise.all(entries.map(async ([ref]) => ({ ref, probe: await describeCredential(ref) })));
      if (probes.some(({ probe }) => !probe.writable)) {
        setError(t('providers.form.notWritable'));
        setBusy(false);
        return;
      }
      const existing = probes.filter(({ probe }) => probe.configured).map(({ ref }) => ref);
      if (existing.length > 0) {
        setOverwrite(existing);
        setBusy(false);
        return;
      }
      await commit(entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const onConfirmOverwrite = (): void => { void commit(filled()); };

  const label = (() => {
    if (busy) return t('providers.keySaving');
    if (overwrite.length > 0) return t('providers.form.confirmOverwrite');
    if (saved) return t('providers.keySaved');
    return t('providers.keySave');
  })();

  return (
    <>
      <span className={css.keyRow}>
        {refs.map((ref) => (
          <input
            key={ref}
            className={css.keyInput}
            type="password"
            autoComplete="new-password"
            placeholder={ref}
            aria-label={t('providers.keyInputAria', { ref }) as string}
            value={values[ref] ?? ''}
            onChange={(e) => setValue(ref, e.target.value)}
          />
        ))}
        <button
          type="button"
          className={overwrite.length > 0 ? css.saveBtnDanger : css.saveBtn}
          disabled={busy}
          onClick={() => { if (overwrite.length > 0) onConfirmOverwrite(); else void onSubmit(); }}
        >
          {label}
        </button>
      </span>
      {overwrite.length > 0 && (
        <span className={css.keyWarn}>
          {overwrite.map((ref) => t('providers.keyOverwriteHint', { ref })).join('；')}
        </span>
      )}
      {error !== '' && <span className={css.keyError}>{error}</span>}
    </>
  );
}