/**
 * 服务商 Tab：内置六家一家一卡——DeepSeek 余额、Z.ai 额度、OpenCode Go 额度三家
 * （各自独立监控，数据显示来自底部角标同一份轮询）与 SiliconFlow / 小米 MiMo /
 * 火山引擎三家余额厂商（服务端 usageStats/providerQuotas 一次聚合返回，本组件在
 * Tab 挂载期间轮询，切走即停止），加上用户自助添加的 Bearer 余额厂商。
 *
 * 每张卡片统一提供：Key 输入与保存（写入 DSH 凭据中心，ProviderKeyRow）、
 * 启用监控 / 在侧边栏展示 / 抓取间隔三项开关（ProviderSwitchRows）。
 * 内置三家的开关按家存储在 builtinProviders；自定义厂商可添加 / 编辑 / 删除，
 * 删除只移除配置，凭据中心里的 Key 保留。本文件不接触密钥值。
 */

import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { useState, type ReactNode } from 'react';

import { BUILTIN_PROVIDER_IDS, clampProvidersFetchMinutes, goLevelOf } from '../../utils.ts';
import { HintCard } from '../components/HintCard.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { useProviderQuotas } from '../useQuota.ts';

import { ProviderForm } from './ProviderForm.tsx';
import { ProviderKeyRow } from './ProviderKeyRow.tsx';
import css from './ProvidersTab.module.css';
import { ProviderSwitchRows, type ProviderSwitchKeys } from './ProviderSwitchRows.tsx';

import type {
  CustomProviderConfig,
  DeepSeekBalance,
  ProviderQuotaAmount,
  ProviderQuotaEntry,
  ProviderQuotaWindow,
  UsageSettings,
  ZaiQuota,
} from '../../types.ts';
import type { UsageStatsKey } from '../locales.ts';
import type { GoQuota } from '../useQuota.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 额度窗口 kind → 文案键。 */
const WINDOW_LABEL_KEY: Record<ProviderQuotaWindow['kind'], UsageStatsKey> = {
  plan: 'providers.window.plan',
  month: 'providers.window.month',
};

/** 内置余额厂商 id → 显示名文案键。 */
const PROVIDER_NAME_KEY: Record<string, UsageStatsKey> = {
  siliconflow: 'provider.siliconflow',
  'xiaomi-mimo': 'provider.xiaomiMimo',
  volcengine: 'provider.volcengine',
};

/** 内置余额厂商的凭据变量名清单（顺序即卡片里输入框顺序）。 */
const PROVIDER_KEY_REFS: Record<string, string[]> = {
  siliconflow: ['SILICONFLOW_API_KEY'],
  'xiaomi-mimo': ['XIAOMI_MIMO_API_KEY', 'XIAOMI_TOKEN_PLAN_CN'],
  volcengine: ['VOLCENGINE_ACCESS_KEY_ID', 'VOLCENGINE_SECRET_ACCESS_KEY'],
};

/** 多凭据厂商的补充说明文案键；单凭据厂商不渲染。 */
const PROVIDER_CRED_HINT_KEY: Record<string, UsageStatsKey | undefined> = {
  siliconflow: undefined,
  'xiaomi-mimo': 'providers.mimo.credHint',
  volcengine: 'providers.volcengine.credHint',
};

/** 内置三家与自定义厂商共用的一套通用开关文案。 */
const BUILTIN_SWITCH_KEYS: ProviderSwitchKeys = {
  enabled: 'providers.cardEnabled',
  enabledHint: 'providers.cardEnabledHint',
  sidebar: 'providers.cardSidebar',
  sidebarHint: 'providers.cardSidebarHint',
  interval: 'providers.interval',
  intervalHint: 'settings.providersIntervalHint',
};

/** 自助添加厂商的开关文案（带 {name} 插值）。 */
const CUSTOM_SWITCH_KEYS: ProviderSwitchKeys = {
  enabled: 'settings.customEnabled',
  enabledHint: 'settings.customEnabledHint',
  sidebar: 'settings.customShowSidebar',
  sidebarHint: 'settings.customShowSidebarHint',
  interval: 'settings.customInterval',
  intervalHint: 'settings.providersIntervalHint',
};

/** DeepSeek / Z.ai / OpenCode Go 三家监控的开关文案（各自既有文案）。 */
const DEEPSEEK_SWITCH_KEYS: ProviderSwitchKeys = {
  enabled: 'settings.deepseekEnabled',
  enabledHint: 'settings.deepseekEnabledHint',
  sidebar: 'settings.showDeepSeekInSidebar',
  sidebarHint: 'settings.showDeepSeekInSidebarHint',
  interval: 'settings.deepseekInterval',
  intervalHint: 'settings.deepseekIntervalHint',
};
const ZAI_SWITCH_KEYS: ProviderSwitchKeys = {
  enabled: 'settings.zaiEnabled',
  enabledHint: 'settings.zaiEnabledHint',
  sidebar: 'settings.showZaiInSidebar',
  sidebarHint: 'settings.showZaiInSidebarHint',
  interval: 'settings.zaiInterval',
  intervalHint: 'settings.zaiIntervalHint',
};
const GO_SWITCH_KEYS: ProviderSwitchKeys = {
  enabled: 'settings.goEnabled',
  enabledHint: 'settings.goEnabledHint',
  sidebar: 'settings.showGoInSidebar',
  sidebarHint: 'settings.showGoInSidebarHint',
  interval: 'settings.goInterval',
  intervalHint: 'settings.goIntervalHint',
};

/** 金额格式化：两位小数，未知显示 --。 */
function money(v: number | null): string {
  return v === null || Number.isNaN(v) ? '--' : v.toFixed(2);
}

/** 服务商 Tab：内置六家 + 自定义厂商卡片列表，含 Key 保存、开关与立即刷新。 */
export function ProvidersTab({ settings, t, onUpdateSettings, go, deepseek, zai, onRefreshGo, onRefreshDeepSeek, onRefreshZai }: {
  settings: UsageSettings
  t: PropsLocale<'dsh-usage-stats'>['t']
  onUpdateSettings: (patch: Partial<UsageSettings>) => void
  /** OpenCode Go 额度（底部角标同一份轮询）。 */
  go: GoQuota | null
  /** DeepSeek 余额（底部角标同一份轮询）。 */
  deepseek: DeepSeekBalance | null
  /** Z.ai 额度（底部角标同一份轮询）。 */
  zai: ZaiQuota | null
  onRefreshGo: () => void
  onRefreshDeepSeek: () => void
  onRefreshZai: () => void
}) {
  const enabledBuiltins = settings.builtinProviders.filter((p) => p.enabled);
  const custom = settings.customProviders;
  const enabledCustom = custom.filter((p) => p.enabled);
  // 任一来源启用就轮询内置余额厂商；内置家只带启用的 id，自定义只带启用的。
  const pollEnabled = enabledBuiltins.length > 0 || enabledCustom.length > 0;
  // 页面轮询间隔取所有在查的家里最小的抓取间隔（保证最勤的那家不过期）。
  const pollMinutes = [...enabledBuiltins, ...enabledCustom].reduce(
    (min, p) => Math.min(min, clampProvidersFetchMinutes(p.fetchMinutes)),
    clampProvidersFetchMinutes(Number.NaN),
  );
  const [data, refresh] = useProviderQuotas(pollEnabled, pollMinutes, enabledBuiltins.map((p) => p.id), enabledCustom);

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const entryById = new Map<string, ProviderQuotaEntry>(data?.providers.map((p) => [p.id, p]) ?? []);

  /** 内置三家：按 id 只改该家的部分字段，整表写回（配置里不含密钥值）。 */
  function patchBuiltin(id: string, patch: { enabled?: boolean; showInSidebar?: boolean; fetchMinutes?: number }): void {
    const next = settings.builtinProviders.map((p) => (p.id === id ? { ...p, ...patch } : p));
    onUpdateSettings({ builtinProviders: next });
  }

  /** 内置三家的偏好与默认值：硬编码兜底（配置归一化已保证三家齐全）。 */
  function builtinSettingsOf(id: string): { enabled: boolean; showInSidebar: boolean; fetchMinutes: number } {
    const found = settings.builtinProviders.find((p) => p.id === id);
    return found ?? { enabled: true, showInSidebar: false, fetchMinutes: clampProvidersFetchMinutes(Number.NaN) };
  }

  function upsertProvider(config: CustomProviderConfig): void {
    const exists = settings.customProviders.some((p) => p.id === config.id);
    const next = exists
      ? settings.customProviders.map((p) => (p.id === config.id ? config : p))
      : [...settings.customProviders, config];
    onUpdateSettings({ customProviders: next });
    setAdding(false);
    setEditingId(null);
  }

  function removeProvider(id: string): void {
    onUpdateSettings({ customProviders: settings.customProviders.filter((p) => p.id !== id) });
    setConfirmDeleteId(null);
  }

  /** 卡片标题行：名称 + 套餐徽标 + Key 输入保存行。 */
  function renderCardHead(name: ReactNode, plan: string | null, keys: ReactNode): ReactNode {
    return (
      <div className={css.cardHead}>
        <span className={css.name}>{name}</span>
        {plan !== null && plan !== '' && <span className={css.plan}>{plan}</span>}
        {keys}
      </div>
    );
  }

  // 金额类明细（余额型服务商）：总额 + 赠送/充值拆分
  function renderAmounts(amounts: ProviderQuotaAmount[]) {
    return (
      <div className={css.amounts}>
        {amounts.map((a) => (
          <div className={css.amountBlock} key={a.currency}>
            <div className={css.amountMain}>
              <span className={css.amountCurrency}>{a.currency}</span>
              <span className={css.amountTotal}>{money(a.total)}</span>
            </div>
            {(a.granted !== null || a.toppedUp !== null) && (
              <div className={css.amountDetails}>
                {a.granted !== null && (
                  <div className={css.amountDetailRow}>
                    <span className={css.amountDetailLabel}>{t('providers.amount.granted')}</span>
                    <span className={css.amountDetailValue}>{money(a.granted)}</span>
                  </div>
                )}
                {a.toppedUp !== null && (
                  <div className={css.amountDetailRow}>
                    <span className={css.amountDetailLabel}>{t('providers.amount.toppedUp')}</span>
                    <span className={css.amountDetailValue}>{money(a.toppedUp)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  // 百分比行清单（DeepSeek 以外三家的卡片摘要）：一行一窗口，含百分比条与重置时间
  function renderPercentRows(rows: { key: string; label: string; pct: number; reset: string | null }[]) {
    return (
      <div className={css.windows}>
        {rows.map((row) => {
          const pct = Math.round(Math.max(0, Math.min(100, row.pct)));
          const level = goLevelOf(pct);
          const cls = level === 'over' ? css.fillOver : level === 'warn' ? css.fillWarn : '';
          const pctCls = level === 'over' ? css.pctOver : level === 'warn' ? css.pctWarn : '';
          return (
            <div className={css.windowRow} key={row.key}>
              <span className={css.windowTop}>
                <span className={css.windowLabel}>{row.label}</span>
                <span className={`${css.pct} ${pctCls}`}>{pct}%</span>
              </span>
              <span className={css.bar}>
                <span className={`${css.barFill} ${cls}`} style={{ width: pct + '%' }} />
              </span>
              <span className={css.windowReset}>
                {row.reset ? t('providers.resetsAt', { time: new Date(row.reset).toLocaleString() }) : ''}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  // 百分比窗口（套餐额度型服务商）：套餐总额度 / 本月用量
  function renderWindows(windows: ProviderQuotaWindow[]) {
    return renderPercentRows(windows.map((w) => ({
      key: w.kind,
      label: t(WINDOW_LABEL_KEY[w.kind]),
      pct: w.percent,
      reset: w.resetsAt,
    })));
  }

  // 单家卡片内容，按状态分支；keyRefs 为未配置时的凭据变量名提示。
  function renderEntryBody(entry: ProviderQuotaEntry | undefined, keyRefs: string[], off: boolean) {
    if (off) return <span className={shared.goHint}>{t('providers.monitorOff')}</span>;
    if (entry === undefined) return <span className={shared.goHint}>{t('state.loading')}</span>;
    if (entry.status === 'no-key') {
      return <span className={shared.goHint}>{t('providers.cardKeyHint', { keys: keyRefs.join(' / ') })}</span>;
    }
    if (entry.status === 'error') {
      return <HintCard text={entry.error ?? t('providers.unavailable')} variant="error" />;
    }
    if (entry.amounts.length === 0 && entry.windows.length === 0) {
      return <span className={shared.goHint}>{t('providers.noData')}</span>;
    }
    return (
      <>
        {renderAmounts(entry.amounts)}
        {renderWindows(entry.windows)}
      </>
    );
  }

  const editing = editingId !== null ? custom.find((p) => p.id === editingId) ?? null : null;

  // ---- 三家独立监控（DeepSeek / Z.ai / Go）的卡片内容 ----
  // 状态提示同一写法：未启用给关闭提示，未配置给卡片内的 Key 提示，其余按 status 分支，
  // 卡片 Key 行在标题行里。
  function monitorHint(status: 'no-plan' | 'error', noPlanText: string): ReactNode {
    if (status === 'no-plan') return <span className={shared.goHint}>{noPlanText}</span>;
    return <HintCard text={t('providers.unavailable')} variant="error" />;
  }

  const deepseekBody = (() => {
    if (!settings.deepseekEnabled) return <span className={shared.goHint}>{t('providers.monitorOff')}</span>;
    if (deepseek === null) return <span className={shared.goHint}>{t('state.loading')}</span>;
    if (deepseek.status === 'no-key') {
      return <span className={shared.goHint}>{t('providers.cardKeyHint', { keys: 'DEEPSEEK_API_KEY' })}</span>;
    }
    if (deepseek.status === 'error') return <HintCard text={t('deepseek.unavailable')} variant="error" />;
    if (!deepseek.isAvailable || deepseek.balances.length === 0) {
      return <span className={shared.goHint}>{t('deepseek.balancesEmpty')}</span>;
    }
    return (
      <div className={css.amounts}>
        {deepseek.balances.map((b) => (
          <div className={css.amountBlock} key={b.currency}>
            <div className={css.amountMain}>
              <span className={css.amountCurrency}>{b.currency}</span>
              <span className={css.amountTotal}>{b.totalBalance}</span>
            </div>
            <div className={css.amountDetails}>
              <div className={css.amountDetailRow}>
                <span className={css.amountDetailLabel}>{t('deepseek.grantedBalance')}</span>
                <span className={css.amountDetailValue}>{b.grantedBalance}</span>
              </div>
              <div className={css.amountDetailRow}>
                <span className={css.amountDetailLabel}>{t('deepseek.toppedUpBalance')}</span>
                <span className={css.amountDetailValue}>{b.toppedUpBalance}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  })();

  const zaiBody = (() => {
    if (!settings.zaiEnabled) return <span className={shared.goHint}>{t('providers.monitorOff')}</span>;
    if (zai === null) return <span className={shared.goHint}>{t('state.loading')}</span>;
    if (zai.status === 'no-key') {
      return <span className={shared.goHint}>{t('providers.cardKeyHint', { keys: 'ZAI_API_KEY / ZAI_CODING_CN_API_KEY' })}</span>;
    }
    if (zai.status !== 'ok') {
      return monitorHint(zai.status, t('zai.noPlan'));
    }
    const rows = [
      zai.session !== null ? { key: 'session', label: t('zai.session'), pct: zai.session.percent, reset: zai.session.resetsAt } : null,
      zai.weekly !== null ? { key: 'weekly', label: t('zai.weekly'), pct: zai.weekly.percent, reset: zai.weekly.resetsAt } : null,
      zai.webSearches !== null ? { key: 'web', label: t('zai.webSearches'), pct: zai.webSearches.percent, reset: zai.webSearches.resetsAt } : null,
    ].filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length === 0) return <span className={shared.goHint}>{t('zai.noData')}</span>;
    return renderPercentRows(rows);
  })();

  const goBody = (() => {
    if (!settings.goEnabled) return <span className={shared.goHint}>{t('providers.monitorOff')}</span>;
    if (go === null) return <span className={shared.goHint}>{t('state.loading')}</span>;
    if (go.status === 'no-key') {
      return <span className={shared.goHint}>{t('providers.cardKeyHint', { keys: 'OPENCODE_GO_API_KEY' })}</span>;
    }
    if (go.status !== 'ok') {
      return monitorHint(go.status, t('go.noPlan'));
    }
    const rows = [
      go.rolling !== null ? { key: 'rolling', label: t('go.rolling'), pct: go.rolling.percent, reset: go.rolling.resetsAt } : null,
      go.weekly !== null ? { key: 'weekly', label: t('go.weekly'), pct: go.weekly.percent, reset: go.weekly.resetsAt } : null,
      go.monthly !== null ? { key: 'monthly', label: t('go.monthly'), pct: go.monthly.percent, reset: go.monthly.resetsAt } : null,
    ].filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length === 0) return <span className={shared.goHint}>{t('providers.noData')}</span>;
    return renderPercentRows(rows);
  })();

  return (
    <div className={shared.section}>
      <div className={shared.sectionHead}>
        <span className={shared.sectionLabel}>{t('providers.title')}</span>
        <button
          type="button"
          className={css.refresh}
          aria-label={t('providers.refresh') as string}
          title={t('providers.refresh') as string}
          onClick={() => { refresh(); onRefreshDeepSeek(); onRefreshZai(); onRefreshGo(); }}
          disabled={!pollEnabled && !settings.deepseekEnabled && !settings.zaiEnabled && !settings.goEnabled}
        >
          <IconRefreshOutlineRegular size={12} />
        </button>
      </div>

      {/* 内置六家：三家独立额度监控 + 三家余额厂商，一家一卡 */}
      <div className={css.groupLabel}>{t('providers.groupBuiltin')}</div>
      <div className={css.list}>
        {/* DeepSeek 余额 */}
        <div className={css.card}>
          {renderCardHead(
            t('deepseek.title'),
            null,
            <ProviderKeyRow refs={['DEEPSEEK_API_KEY']} t={t} onSaved={onRefreshDeepSeek} />,
          )}
          {deepseekBody}
          <ProviderSwitchRows
            t={t}
            name="DeepSeek"
            keys={DEEPSEEK_SWITCH_KEYS}
            enabled={settings.deepseekEnabled}
            showInSidebar={settings.showDeepSeekInSidebar}
            fetchMinutes={settings.deepseekFetchMinutes}
            onPatch={(patch) => onUpdateSettings({
              deepseekEnabled: patch.enabled ?? settings.deepseekEnabled,
              showDeepSeekInSidebar: patch.showInSidebar ?? settings.showDeepSeekInSidebar,
              deepseekFetchMinutes: patch.fetchMinutes ?? settings.deepseekFetchMinutes,
            })}
          />
        </div>

        {/* Z.ai 额度 */}
        <div className={css.card}>
          {renderCardHead(
            t('zai.title'),
            (zai?.status === 'ok' ? zai.plan : null) ?? null,
            <ProviderKeyRow refs={['ZAI_API_KEY', 'ZAI_CODING_CN_API_KEY']} t={t} onSaved={onRefreshZai} />,
          )}
          <span className={shared.goHint}>{t('providers.zai.credHint')}</span>
          {zaiBody}
          <ProviderSwitchRows
            t={t}
            name="Z.ai"
            keys={ZAI_SWITCH_KEYS}
            enabled={settings.zaiEnabled}
            showInSidebar={settings.showZaiInSidebar}
            fetchMinutes={settings.zaiFetchMinutes}
            onPatch={(patch) => onUpdateSettings({
              zaiEnabled: patch.enabled ?? settings.zaiEnabled,
              showZaiInSidebar: patch.showInSidebar ?? settings.showZaiInSidebar,
              zaiFetchMinutes: patch.fetchMinutes ?? settings.zaiFetchMinutes,
            })}
          />
        </div>

        {/* OpenCode Go 额度 */}
        <div className={css.card}>
          {renderCardHead(
            t('go.title'),
            null,
            <ProviderKeyRow refs={['OPENCODE_GO_API_KEY']} t={t} onSaved={onRefreshGo} />,
          )}
          {goBody}
          <ProviderSwitchRows
            t={t}
            name="OpenCode Go"
            keys={GO_SWITCH_KEYS}
            enabled={settings.goEnabled}
            showInSidebar={settings.showGoInSidebar}
            fetchMinutes={settings.goFetchMinutes}
            onPatch={(patch) => onUpdateSettings({
              goEnabled: patch.enabled ?? settings.goEnabled,
              showGoInSidebar: patch.showInSidebar ?? settings.showGoInSidebar,
              goFetchMinutes: patch.fetchMinutes ?? settings.goFetchMinutes,
            })}
          />
        </div>

        {/* SiliconFlow / 小米 MiMo / 火山引擎：名称固定、不可删，按家开关与间隔 */}
        {BUILTIN_PROVIDER_IDS.map((id) => {
          const entry = entryById.get(id);
          const prefs = builtinSettingsOf(id);
          const keyRefs = PROVIDER_KEY_REFS[id] ?? [];
          const credHintKey = PROVIDER_CRED_HINT_KEY[id];
          const name = t(PROVIDER_NAME_KEY[id]);
          return (
            <div className={css.card} key={id}>
              {renderCardHead(
                name,
                (prefs.enabled ? entry?.plan : null) ?? null,
                <ProviderKeyRow refs={keyRefs} t={t} onSaved={refresh} />,
              )}
              {credHintKey !== undefined && <span className={shared.goHint}>{t(credHintKey)}</span>}
              {renderEntryBody(prefs.enabled ? entry : undefined, keyRefs, !prefs.enabled)}
              <ProviderSwitchRows
                t={t}
                name={name}
                keys={BUILTIN_SWITCH_KEYS}
                enabled={prefs.enabled}
                showInSidebar={prefs.showInSidebar}
                fetchMinutes={prefs.fetchMinutes}
                onPatch={(patch) => patchBuiltin(id, patch)}
              />
            </div>
          );
        })}
      </div>

      {/* 用户自助添加的 Bearer 厂商 */}
      <div className={css.groupLabel}>{t('providers.groupCustom')}</div>
      {custom.length === 0 && !adding && (
        <span className={shared.goHint}>{t('providers.customEmpty')}</span>
      )}
      <div className={css.list}>
        {custom.map((p) => {
          if (editingId === p.id) return null; // 编辑时该卡位置由表单替换到下方
          const entry = entryById.get(p.id);
          return (
            <div className={css.card} key={p.id}>
              {renderCardHead(p.label, null, null)}
              {renderEntryBody(p.enabled ? entry : undefined, [p.credentialRef], !p.enabled)}
              <ProviderSwitchRows
                t={t}
                name={p.label}
                keys={CUSTOM_SWITCH_KEYS}
                enabled={p.enabled}
                showInSidebar={p.showInSidebar}
                fetchMinutes={p.fetchMinutes}
                onPatch={(patch) => {
                  const next = settings.customProviders.map((q) => (q.id === p.id ? { ...q, ...patch } : q));
                  onUpdateSettings({ customProviders: next });
                }}
              />
              <div className={css.cardActions}>
                <span className={css.keyRef}>{p.credentialRef}</span>
                <span className={css.cardBtns}>
                  {confirmDeleteId === p.id ? (
                    <>
                      <button type="button" className={css.linkBtnDanger}
                        onClick={() => removeProvider(p.id)}>
                        {t('providers.confirmDelete')}
                      </button>
                      <button type="button" className={css.linkBtn}
                        onClick={() => setConfirmDeleteId(null)}>
                        {t('providers.cancelDelete')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className={css.linkBtn}
                        onClick={() => { setEditingId(p.id); setAdding(false); }}>
                        {t('providers.edit')}
                      </button>
                      <button type="button" className={css.linkBtnDanger}
                        onClick={() => setConfirmDeleteId(p.id)}>
                        {t('providers.delete')}
                      </button>
                    </>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 添加 / 编辑表单 */}
      {(adding || editing !== null) && (
        <ProviderForm
          t={t}
          initial={editing}
          onCancel={() => { setAdding(false); setEditingId(null); }}
          onSaved={(config) => { upsertProvider(config); refresh(); }}
        />
      )}

      {!adding && editing === null && (
        <button type="button" className={css.addBtn}
          disabled={custom.length >= 30}
          title={custom.length >= 30 ? (t('providers.maxReached', { max: 30 }) as string) : ''}
          onClick={() => setAdding(true)}>
          + {t('providers.add')}
        </button>
      )}
    </div>
  );
}