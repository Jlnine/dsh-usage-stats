/**
 * 添加 / 编辑一个自定义 Bearer 余额服务商。
 *
 * 预置模板（Kimi / OpenRouter，端点与字段路径经官方文档核实）自动带出查询定义；
 * 选「通用」则自行填写。Key 是密码框：添加时必填、编辑时留空表示不修改已有 Key。
 * 保存流程：本地校验 → describeCredential 探测同名覆盖与可写性 → （需要时二次确认）
 * → saveCredential 写凭据中心 → 回调把不含密钥的配置交给父组件写 profile 文档。
 * 独立成文件，一个组件一个文件。
 */
import { useState } from 'react';

import { CREDENTIAL_REF_PATTERN } from '../../utils.ts';
import { describeCredential, saveCredential } from '../api.ts';

import css from './ProviderForm.module.css';

import type { CustomProviderConfig } from '../../types.ts';
import type { UsageStatsKey } from '../locales.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 预置模板：值经官方文档核实；generic 为空白通用模板。 */
interface Preset {
  key: string
  labelKey: UsageStatsKey
  label: string
  ref: string
  endpoint: string
  valuePath: string
  currency: string
}

const PRESETS: Preset[] = [
  { key: 'generic', labelKey: 'providers.tpl.generic', label: '通用（自定义）', ref: '', endpoint: '', valuePath: 'data.balance', currency: 'CNY' },
  { key: 'kimi', labelKey: 'providers.tpl.kimi', label: 'Kimi（月之暗面）', ref: 'MOONSHOT_API_KEY', endpoint: 'https://api.moonshot.cn/v1/users/me/balance', valuePath: 'data.available_balance', currency: 'CNY' },
  { key: 'openrouter', labelKey: 'providers.tpl.openrouter', label: 'OpenRouter', ref: 'OPENROUTER_API_KEY', endpoint: 'https://openrouter.ai/api/v1/auth/key', valuePath: 'data.limit_remaining', currency: 'USD' },
];

export interface ProviderFormProps {
  t: PropsLocale<'dsh-usage-stats'>['t']
  /** 编辑既有配置时传入；添加为 null。 */
  initial: CustomProviderConfig | null
  onCancel: () => void
  /** 保存成功：父组件把配置（无密钥）upsert 进 customProviders。 */
  onSaved: (config: CustomProviderConfig) => void
}

interface FormState {
  label: string
  ref: string
  key: string
  endpoint: string
  valuePath: string
  currency: string
}

/** 新建自定义服务商稳定 id：custom-<8 位 base36>，冲突概率可忽略，仍由配置归一化去重兜底。 */
function newId(): string {
  return `custom-${Math.random().toString(36).slice(2, 10)}`;
}

export function ProviderForm({ t, initial, onCancel, onSaved }: ProviderFormProps) {
  const isEdit = initial !== null;
  const [preset, setPreset] = useState<string>('generic');
  const [form, setForm] = useState<FormState>({
    label: initial?.label ?? '',
    ref: initial?.credentialRef ?? '',
    key: '',
    endpoint: initial?.endpoint ?? '',
    valuePath: initial?.valuePath ?? 'data.balance',
    currency: initial?.currency ?? 'CNY',
  });
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState(false);
  /** 同名 Key 已存在时进入覆盖确认；null=不需要，object=待确认的探测结果。 */
  const [overwrite, setOverwrite] = useState<{ configured: boolean; writable: boolean } | null>(null);

  const set = (field: keyof FormState, value: string): void => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  /** 选择模板：带出查询定义与建议变量名，但不覆盖编辑中的既有值之外用户已手改内容（简单整表覆盖）。 */
  const choosePreset = (key: string): void => {
    setPreset(key);
    if (isEdit) return; // 编辑时不冲掉已有定义
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    setForm((prev) => ({
      ...prev,
      ref: p.ref || prev.ref,
      endpoint: p.endpoint || prev.endpoint,
      valuePath: p.valuePath,
      currency: p.currency,
      label: prev.label || (p.key === 'generic' ? '' : p.label),
    }));
  };

  /** 本地字段校验，返回首个错误文案键对应文本；通过返回空串。 */
  function validate(): string {
    if (form.label.trim() === '') return t('providers.form.errLabel');
    if (!CREDENTIAL_REF_PATTERN.test(form.ref.trim())) return t('providers.form.errRef');
    if (!isEdit && form.key.length === 0) return t('providers.form.errKeyRequired');
    if (form.key.length > 4096) return t('providers.form.errKeyLong');
    if (!/^https:\/\//i.test(form.endpoint.trim())) return t('providers.form.errEndpoint');
    if (form.valuePath.trim() === '') return t('providers.form.errPath');
    return '';
  }

  /** 组装配置（不含密钥）。 */
  function buildConfig(): CustomProviderConfig {
    return {
      id: initial?.id ?? newId(),
      label: form.label.trim(),
      endpoint: form.endpoint.trim(),
      credentialRef: form.ref.trim(),
      valuePath: form.valuePath.trim(),
      currency: form.currency.trim() || 'CNY',
      enabled: initial?.enabled ?? true,
      showInSidebar: initial?.showInSidebar ?? false,
      fetchMinutes: initial?.fetchMinutes ?? 5,
    };
  }

  /** 真正落库：写 Key（编辑留空则跳过）后交父组件保存配置。 */
  async function commit(config: CustomProviderConfig, writeKey: boolean): Promise<void> {
    setBusy(true);
    setError('');
    try {
      if (writeKey) await saveCredential(config.credentialRef, form.key);
      onSaved(config);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOverwrite(null);
    } finally {
      setBusy(false);
    }
  }

  /** 主提交：先探测同名覆盖与可写性，需要写 Key 且已存在则进入二次确认。 */
  async function onSubmit(): Promise<void> {
    const msg = validate();
    if (msg) {
      setError(msg);
      return;
    }
    const config = buildConfig();
    const writeKey = !isEdit || form.key.length > 0;
    if (!writeKey) {
      // 编辑且未填新 Key：无需探测凭据，直接保存配置。
      await commit(config, false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const probe = await describeCredential(config.credentialRef);
      if (!probe.writable) {
        setError(t('providers.form.notWritable'));
        setBusy(false);
        return;
      }
      if (probe.configured) {
        setOverwrite(probe);
        setBusy(false);
        return;
      }
      await commit(config, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className={css.form}>
      <div className={css.title}>{isEdit ? t('providers.form.editTitle') : t('providers.form.addTitle')}</div>

      <label className={css.field}>
        <span className={css.label}>{t('providers.form.template')}</span>
        <select className={css.input} value={preset} onChange={(e) => choosePreset(e.target.value)} disabled={isEdit}>
          {PRESETS.map((p) => (
            <option key={p.key} value={p.key}>{t(p.labelKey)}</option>
          ))}
        </select>
      </label>

      <label className={css.field}>
        <span className={css.label}>{t('providers.form.name')}</span>
        <input className={css.input} value={form.label} maxLength={30}
          placeholder={t('providers.form.namePh') as string}
          onChange={(e) => set('label', e.target.value)} />
      </label>

      <label className={css.field}>
        <span className={css.label}>{t('providers.form.ref')}</span>
        <input className={css.input} value={form.ref}
          placeholder={t('providers.form.refPh') as string}
          onChange={(e) => set('ref', e.target.value)} />
      </label>

      <label className={css.field}>
        <span className={css.label}>
          {t('providers.form.key')}
          {isEdit && <span className={css.hint}>{t('providers.form.keyEditHint')}</span>}
        </span>
        <input className={css.input} type="password" autoComplete="new-password"
          placeholder={isEdit ? (t('providers.form.keyEditPh') as string) : (t('providers.form.keyPh') as string)}
          value={form.key} onChange={(e) => set('key', e.target.value)} />
      </label>

      <label className={css.field}>
        <span className={css.label}>{t('providers.form.endpoint')}</span>
        <input className={css.input} value={form.endpoint} inputMode="url"
          placeholder="https://api.example.com/v1/user/balance"
          onChange={(e) => set('endpoint', e.target.value)} />
      </label>

      <div className={css.row}>
        <label className={`${css.field} ${css.grow}`}>
          <span className={css.label}>{t('providers.form.path')}</span>
          <input className={css.input} value={form.valuePath}
            placeholder="data.balance"
            onChange={(e) => set('valuePath', e.target.value)} />
        </label>
        <label className={`${css.field} ${css.currency}`}>
          <span className={css.label}>{t('providers.form.currency')}</span>
          <input className={css.input} value={form.currency} maxLength={8}
            onChange={(e) => set('currency', e.target.value)} />
        </label>
      </div>

      {overwrite && (
        <div className={css.warn}>
          {t('providers.form.overwrite', { ref: form.ref.trim() })}
        </div>
      )}
      {error !== '' && <div className={css.error}>{error}</div>}

      <div className={css.actions}>
        <button type="button" className={css.ghost} onClick={onCancel} disabled={busy}>
          {t('providers.form.cancel')}
        </button>
        {overwrite ? (
          <button type="button" className={css.danger} disabled={busy}
            onClick={() => { void commit(buildConfig(), true); }}>
            {busy ? t('providers.form.saving') : t('providers.form.confirmOverwrite')}
          </button>
        ) : (
          <button type="button" className={css.primary} disabled={busy}
            onClick={() => { void onSubmit(); }}>
            {busy ? t('providers.form.saving') : t('providers.form.save')}
          </button>
        )}
      </div>
    </div>
  );
}
