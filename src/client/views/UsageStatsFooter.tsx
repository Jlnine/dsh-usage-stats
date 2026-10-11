/**
 * 用量统计的侧边栏底部动作：渲染在 `sidebar.footer.action` 列表插槽设置按钮上方的今日统计触发器。
 *
 * 合一按钮，宽列与折叠 rail 共用，侧边栏排序自上而下为 Z.ai 额度、Go 额度、DeepSeek 余额、
 * 勾选侧边栏的各服务商额度、今日用量，全部在同一按钮内，任意位置点击均打开模态窗详情
 * {@link UsageStatsPanel}。
 *
 * 宽列：按钮内纵向多行——
 *   1) 带"Z.ai 额度"标签的 Z.ai 额度芯片，含滚动 5 小时、本周百分比与 Web 搜索次数，悬浮显示卡片化额度明细，
 *   2) 带"Go 额度"标签的 OpenCode Go 订阅额度芯片，含滚动 5 小时、本周与本月用量百分比，≥80% 预警、≥100% 超支，悬浮显示三档窗口卡片明细，
 *   3) 带"DeepSeek余额"标签的 DeepSeek 余额芯片，含多币种 totalBalance，悬浮显示余额卡片明细，
 *   4) 勾选「在侧边栏展示」的服务商（内置三家与自助添加厂商）：名称 + 金额或额度百分比芯片，悬浮看摘要，
 *   5) 图标 + "今日" + 今日 tokens / 调用次数 + 三色比例条，含缓存、输入与输出，悬浮显示各类别具体数值。
 * 56px rail 即折叠列：按钮内纵向堆叠，与宽列同序——各额度迷你芯片（Z.ai、Go、DeepSeek 与各服务商），
 *   再今日用量迷你芯片，两行含今日与 tokens 缩写数值，tooltip 给出今日完整明细。整块按钮任意位置可点。
 *
 * Z.ai 与 Go 的额度行与各服务商额度行走同一份数据驱动的软写入清单（出现与否只由偏好决定，
 * 内容各自渲染）；DeepSeek 余额保留专属硬编码行。各行抓取开关、侧边栏展示开关与抓取间隔
 * 在「服务商」页卡片里改（useUsageSettings 读服务端设置文档，见 client/settings.ts）：
 * 关闭抓取则不轮询，对应数据恒为 null，芯片显示占位横杠；侧边栏开关只影响底部芯片展示，
 * 不影响模态窗内详情。
 */

import { IconDataOutlineRegular, Tooltip as BaseTooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useRef, useState } from 'react';


import { cacheTotal, goLevelOf, goPercent, goResetsAt } from '../../utils.ts';
import { HintCard } from '../components/HintCard.tsx';
import { Tooltip } from '../components/Tooltip.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { avgPerCall, dayTotal, fmt, fmtFull, pctOf, todayOf } from '../stats.ts';
import { useDeepSeekBalance, useGoQuota, useSidebarProviderQuotas, useZaiQuota, type GoWindow, type ZaiWindow } from '../useQuota.ts';
import { useSnapshot } from '../useSnapshot.ts';
import { useUsageSettings } from '../useUsageSettings.ts';

import css from './UsageStatsFooter.module.css';
import { UsageStatsPanel } from './UsageStatsPanel.tsx';

import type { ProviderQuotaEntry, ProviderQuotaWindow } from '../../types.ts';
import type { LocaleFn, UsageStatsKey } from '../locales.ts';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';

export type UsageStatsFooterProps =
  PropsRuntime<'sidebar.footer.action'> & PropsLocale<'dsh-usage-stats'>;

/** 侧边栏软写入条目：wide 为宽列行内容，rail 为折叠列迷你芯片，key 为渲染键。 */
interface SoftQuotaItem {
  key: string
  wide: React.ReactNode
  rail: React.ReactNode
}

/** 单个额度窗口的展示条目，含短名、全名与窗口数据。 */
interface GoWindowEntry {
  key: string
  short: string
  full: string
  win: GoWindow
}

/** Z.ai 窗口展示条目：win 为 ZaiWindow，比 GoWindow 多点数明细 used/limit。 */
interface ZaiWindowEntry {
  key: string
  short: string
  full: string
  win: ZaiWindow
}

// ---- 额度 tooltip 卡片共用样式与渲染助手，Go、Z.ai 与 DeepSeek 三处共用同一设计语言 ----
/** 额度档位 → 进度条 / 百分比颜色，与概览磁贴 goFill* 同 token，fallback 与芯片预警色一致。 */
const TIP_LEVEL_COLOR: Record<'ok' | 'warn' | 'over', string> = {
  ok: 'var(--dsw-alias-state-success-primary, #34c759)',
  warn: 'var(--dsw-alias-state-warn-primary, #f5a623)',
  over: 'var(--dsw-alias-state-error-primary, #e5484d)',
};

/** 软写入的内置余额厂商 id → 显示名文案键（与「服务商」页同一套名称）。 */
const PROVIDER_NAME_KEY: Record<string, UsageStatsKey> = {
  siliconflow: 'provider.siliconflow',
  'xiaomi-mimo': 'provider.xiaomiMimo',
  volcengine: 'provider.volcengine',
};

/** 软写入的内置余额厂商 id → 凭据变量名清单（未配置提示用）。 */
const PROVIDER_KEY_REFS: Record<string, string[]> = {
  siliconflow: ['SILICONFLOW_API_KEY'],
  'xiaomi-mimo': ['XIAOMI_MIMO_API_KEY', 'XIAOMI_TOKEN_PLAN_CN'],
  volcengine: ['VOLCENGINE_ACCESS_KEY_ID', 'VOLCENGINE_SECRET_ACCESS_KEY'],
};

/** 服务商额度窗口 kind → 文案键。 */
const WINDOW_LABEL_KEY: Record<ProviderQuotaWindow['kind'], UsageStatsKey> = {
  plan: 'providers.window.plan',
  month: 'providers.window.month',
};

/** tooltip 标题行，13px 字号、700 字重，底部留白与卡片群分隔。 */
function TipTitle({ children }: { children: React.ReactNode }) {
  return <div className={shared.tipTitle}>{children}</div>;
}

/** 小徽标 pill，展示货币代码或订阅计划名；超长计划名由调用方给 maxWidth 收窄。 */
function TipPill({ children, maxWidth }: { children: React.ReactNode; maxWidth?: number }) {
  return (
    <span className={shared.tipPill} style={maxWidth === undefined ? undefined : { maxWidth }}>
      {children}
    </span>
  );
}

/** 状态提示卡，用于 no-key、no-plan、error 与空数据等非正常态。 */
function TipHint({ children }: { children: React.ReactNode }) {
  return <div className={shared.tipHint}>{children}</div>;
}

/** tooltip 底部更新时间，右对齐、顶部带分割线，弱化但仍可读。 */
function TipFooter({ children }: { children: React.ReactNode }) {
  return <div className={shared.tipFooter}>{children}</div>;
}

/**
 * 单个额度窗口卡片：窗口名 + 按档位着色的大字号数值 + 进度条 + 重置时间。
 * `value` 缺省渲染 `{pct}%`；次数型额度如 Z.ai Web 搜索传 `used/limit` 文本，
 * 进度条仍按 pct 填充。`points` 为可选的点数明细，如 Z.ai 的 currentValue/usage
 * 缩写值，渲染在百分比左侧。
 */
function QuotaTipRow({ label, pct, level, reset, value, points }: {
  label: string
  pct: number
  level: 'ok' | 'warn' | 'over'
  reset: string
  value?: string
  points?: string
}) {
  const color = TIP_LEVEL_COLOR[level];
  const width = `${Math.max(0, Math.min(100, pct))}%`;
  return (
    <div className={shared.tipCard}>
      <div className={shared.tipCardHead}>
        <span className={shared.tipRowLabel}>{label}</span>
        <span className={shared.tipRowValues}>
          {points !== undefined && (
            <span className={shared.tipPoints}>{points}</span>
          )}
          <span className={shared.tipValue} style={{ color }}>
            {value ?? `${pct}%`}
          </span>
        </span>
      </div>
      <div className={shared.tipBarTrack}>
        <div className={shared.tipBarFill} style={{ width, background: color }} />
      </div>
      {reset !== '' && (
        <div className={shared.tipReset}>{reset}</div>
      )}
    </div>
  );
}

/** 余额明细行，圆点 + 标签居左、数值居右，DeepSeek 赠送与充值两行共用。 */
function BalanceTipRow({ dot, label, amount }: { dot: string; label: string; amount: string }) {
  return (
    <div className={shared.balanceRow}>
      <span className={shared.balanceLabel}>
        <span className={shared.balanceDot} style={{ background: dot }} />
        {label}
      </span>
      <span className={shared.balanceAmount}>{amount}</span>
    </div>
  );
}

export function UsageStatsFooter({ wide, t }: UsageStatsFooterProps) {
  // 本地化函数单点转换，组件内统一用 tFn。
  const tFn = t as unknown as LocaleFn;
  const [open, setOpen] = useState(false);
  const [data, err, refreshSnapshot, errDetail] = useSnapshot();
  // Go 额度、DeepSeek 余额与 Z.ai 额度抓取开关与间隔来自偏好设置，默认开启、间隔 5 分钟
  const [settings, updateSettings] = useUsageSettings();
  const [go, refreshQuota] = useGoQuota(settings.goEnabled, settings.goFetchMinutes);
  const [deepseek, refreshDeepSeek] = useDeepSeekBalance(settings.deepseekEnabled, settings.deepseekFetchMinutes);
  const [zai, refreshZai] = useZaiQuota(settings.zaiEnabled, settings.zaiFetchMinutes);
  // 侧边栏底部的服务商额度：只轮询「启用监控且勾选侧边栏」的子集（内置与自定义各自的子集）。
  const [providerQuotas] = useSidebarProviderQuotas(settings);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    const footerActionsDiv = root?.parentElement?.parentElement as HTMLElement | null;
    if (!footerActionsDiv) {
      console.warn('[usage-stats] 未找到 footerActions 容器，flex 布局调整跳过（harness DOM 可能已变更）');
      return;
    }
    const prev = footerActionsDiv.style.flexDirection;
    footerActionsDiv.style.flexDirection = 'column';
    return () => {
      footerActionsDiv.style.flexDirection = prev;
    };
  }, []);

  const today = todayOf(data?.series.all ?? []);
  const todayTokens = today ? dayTotal(today) : 0;
  const todayCalls = today?.calls ?? 0;
  const missing = (data?.failed ?? 0) > 0;

  // 今日各分类 token 数，缓存为 cacheRead + cacheWrite，共用 utils.cacheTotal
  const cacheTokens = cacheTotal(today ?? {});
  const inputTokens = today?.input ?? 0;
  const outputTokens = today?.output ?? 0;
  // 缓存命中率，cacheRead 除以 cacheRead 与 input 之和
  const cacheRead = today?.cacheRead ?? 0;
  const cacheHitRate = (cacheRead + inputTokens) > 0
    ? Math.round((cacheRead / (cacheRead + inputTokens)) * 1000) / 10
    : null;

  // ---- OpenCode Go 额度，三档窗口为滚动 5 小时、本周与本月 ----
  const goWindows: GoWindowEntry[] =
    go?.status === 'ok'
      ? [
        { key: 'rolling', short: t('go.short.rolling'), full: t('go.rolling'), win: go.rolling },
        { key: 'weekly', short: t('go.short.weekly'), full: t('go.weekly'), win: go.weekly },
        { key: 'monthly', short: t('go.short.monthly'), full: t('go.monthly'), win: go.monthly },
      ].filter((w): w is GoWindowEntry => w.win !== null)
      : [];
  const resetsOf = (win: GoWindow): string => goResetsAt(t, win);

  // 额度芯片档位样式，避免嵌套三元
  const getChipClass = (level: 'over' | 'warn' | 'ok'): string => {
    if (level === 'over') return css.goChipOver;
    if (level === 'warn') return css.goChipWarn;
    return '';
  };

  // 单个额度芯片，宽列 chips，短标签 + 百分比，按档位着色；
  // 悬浮显示完整三档窗口卡片明细，与 rail 共用同一份 goTipContent。
  const goChip = ({ key, short, win }: GoWindowEntry) => {
    const pct = goPercent(win);
    const level = goLevelOf(pct);
    const cls = getChipClass(level);
    return (
      <Tooltip key={key} content={goTipContent} side="top" delayMs={400}>
        <span className={`${css.goChip} ${cls}`}>{short} {pct}%</span>
      </Tooltip>
    );
  };

  // ---- DeepSeek 余额，多币种余额明细，仅含余额、无今日用量 ----
  // 卡片式布局，标题 + 货币卡片含徽标与大字号总额 + 赠送与充值两行细分含圆点标识与分割线 + 底部更新时间。
  const deepseekWideTooltip = (() => {
    if (deepseek?.status !== 'ok') return null;
    const balances = deepseek.balances;
    if (!deepseek.isAvailable) {
      return (
        <div className={shared.tipPanel}>
          <TipTitle>{t('deepseek.title')}</TipTitle>
          <TipHint>{t('deepseek.notAvailable')}</TipHint>
        </div>
      );
    }
    if (balances.length === 0) {
      return (
        <div className={shared.tipPanel}>
          <TipTitle>{t('deepseek.title')}</TipTitle>
          <TipHint>{t('deepseek.balancesEmpty')}</TipHint>
        </div>
      );
    }
    return (
      <div className={shared.tipPanelWide}>
        <TipTitle>{t('deepseek.title')}</TipTitle>
        <div className={shared.tipStack}>
          {balances.map((b) => (
            <div key={b.currency} className={shared.tipCard}>
              <div className={`${shared.tipCardHead} ${shared.tipCardHeadTight}`}>
                <TipPill>{b.currency}</TipPill>
                <span className={`${shared.tipAmount} ${shared.tipAmountLg}`}>
                  {b.totalBalance}
                </span>
              </div>
              <div className={shared.tipDivider} />
              <div className={shared.tipRows}>
                <BalanceTipRow dot="rgba(255,255,255,0.45)" label={t('deepseek.grantedBalance')} amount={b.grantedBalance} />
                <BalanceTipRow dot="#3fb57a" label={t('deepseek.toppedUpBalance')} amount={b.toppedUpBalance} />
              </div>
            </div>
          ))}
        </div>
        <TipFooter>
          {t('updatedAt')} {new Date(deepseek.fetchedAt).toLocaleTimeString()}
        </TipFooter>
      </div>
    );
  })();

  // 今日明细行清单：折叠 rail 与宽列比例条两个 tooltip 共用同一份，
  // 平均每次调用走 stats 的 avgPerCall，与日期/会话/模型三表同一口径。
  const todayDetailRows: [string, string][] = [
    [t('table.cacheRead'), fmtFull(cacheTokens)],
    [t('table.input'), fmtFull(inputTokens)],
    [t('table.output'), fmtFull(outputTokens)],
    [t('table.total'), fmtFull(todayTokens)],
    [t('footer.cacheHitRate'), pctOf(cacheHitRate)],
    [t('table.calls'), fmtFull(todayCalls)],
    [t('table.avgPerCall'), fmtFull(avgPerCall(todayTokens, todayCalls) ?? 0)],
  ];

  // 折叠态今日用量芯片的 tooltip：明细行与宽列比例条 tooltip 完全共用，
  // 不含额度明细，三额度的明细由各自芯片的 tooltip 承载。
  const railContent = (() => {
    if (!today || todayTokens === 0) return t('footer.railEmpty');
    return (
      <div className={shared.tipPanel}>
        <div className={shared.tipHeader}>{t('footer.railHeader')}</div>
        <div className={shared.tipList}>
          {todayDetailRows.map(([k, v]) => (
            <div key={k} className={shared.tipListRow}>
              <span className={shared.tipListKey}>{k}</span>
              <span className={shared.tipListVal}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    );
  })();

  // 折叠态 Go 芯片取滚动 5 小时窗口。
  const railRolling = goWindows.find((w) => w.key === 'rolling');

  // Go 额度 tooltip，宽列芯片与折叠 rail 共用，卡片化三档窗口明细，
  // 每档一张窗口卡含窗口名、档位着色百分比、进度条与重置时间，异常态为提示卡。
  const goTipContent = (() => {
    if (go === null) return '';
    const wrap = (hint: string) => (
      <div className={shared.tipPanelGo}>
        <TipTitle>{t('go.title')}</TipTitle>
        <TipHint>{hint}</TipHint>
      </div>
    );
    if (go.status === 'ok') {
      if (goWindows.length === 0) return '';
      return (
        <div className={shared.tipPanelGo}>
          <TipTitle>{t('go.title')}</TipTitle>
          <div className={shared.tipStack}>
            {goWindows.map((w) => {
              const pct = goPercent(w.win);
              return (
                <QuotaTipRow
                  key={w.key}
                  label={w.full}
                  pct={pct}
                  level={goLevelOf(pct)}
                  reset={resetsOf(w.win)}
                />
              );
            })}
          </div>
          <TipFooter>
            {t('updatedAt')} {new Date(go.fetchedAt).toLocaleTimeString()}
          </TipFooter>
        </div>
      );
    }
    if (go.status === 'no-key') return wrap(t('go.notConfigured'));
    if (go.status === 'no-plan') {
      return (
        <div className={shared.tipPanelGo}>
          <TipTitle>{t('go.title')}</TipTitle>
          <HintCard text={t('go.noPlan')} tone="tip" />
        </div>
      );
    }
    return wrap(t('go.unavailable'));
  })();

  // 折叠态 DeepSeek 芯片 tooltip，与宽列同款卡片设计，共用助手，rail 下宽度略收。
  const railDeepSeekContent = (() => {
    if (deepseek?.status !== 'ok') return '';
    const balances = deepseek.balances;
    if (!deepseek.isAvailable) {
      return (
        <div className={shared.tipPanel}>
          <TipTitle>{t('deepseek.title')}</TipTitle>
          <TipHint>{t('deepseek.notAvailable')}</TipHint>
        </div>
      );
    }
    if (balances.length === 0) {
      return (
        <div className={shared.tipPanel}>
          <TipTitle>{t('deepseek.title')}</TipTitle>
          <TipHint>{t('deepseek.balancesEmpty')}</TipHint>
        </div>
      );
    }
    return (
      <div className={shared.tipPanelRail}>
        <TipTitle>{t('deepseek.title')}</TipTitle>
        <div className={shared.tipStack}>
          {balances.map((b) => (
            <div key={b.currency} className={shared.tipCard}>
              <div className={shared.tipCardHead}>
                <TipPill>{b.currency}</TipPill>
                <span className={shared.tipAmount}>{b.totalBalance}</span>
              </div>
              <div className={shared.tipDivider} />
              <div className={shared.tipRows}>
                <BalanceTipRow dot="rgba(255,255,255,0.45)" label={t('deepseek.grantedBalance')} amount={b.grantedBalance} />
                <BalanceTipRow dot="#3fb57a" label={t('deepseek.toppedUpBalance')} amount={b.toppedUpBalance} />
              </div>
            </div>
          ))}
        </div>
        <TipFooter>
          {t('updatedAt')} {new Date(deepseek.fetchedAt).toLocaleTimeString()}
        </TipFooter>
      </div>
    );
  })();

  // 折叠态芯片档位：正常态用底色，预警 / 超支沿用芯片警示色。
  const railLevel = railRolling === undefined ? undefined : goLevelOf(goPercent(railRolling.win));
  const railCls = railLevel ? getChipClass(railLevel) : '';

  // 展开态比例条 tooltip 即宽列比例条，行清单与折叠 rail 共用
  const barContent = (() => {
    if (!today || todayTokens === 0) return null;
    return (
      <div className={`${shared.tipPanelRows} ${shared.tipList}`}>
        {todayDetailRows.map(([k, v]) => (
          <div key={k} className={shared.tipListRow}>
            <span className={shared.tipListKey}>{k}</span>
            <span className={shared.tipListVal}>{v}</span>
          </div>
        ))}
      </div>
    );
  })();

  const toggle = () => setOpen((v) => !v);
  const ariaLabel = t('footer.railAria', { tokens: fmtFull(todayTokens), calls: fmtFull(todayCalls) });

  // 三额度行显隐同一写法：启用监控且侧边栏展示开关开即渲染（数据未加载时给占位横杠），
  // 宽列与 rail 共用；DeepSeek 保留下方专属硬编码行，Z.ai、Go 与服务商额度条目一样走软写入清单。
  const showZai = settings.zaiEnabled && settings.showZaiInSidebar;
  const showGo = settings.goEnabled && settings.showGoInSidebar;
  const showDeepSeek = settings.deepseekEnabled && settings.showDeepSeekInSidebar;

  // 软写入的服务商额度条目：由偏好配置驱动的统一清单，顺序为「勾选侧边栏的内置三家」再
  // 自定义厂商，最多 8 家防侧边栏溢出；额度条目按 id 匹配，尚未加载时芯片显示占位。
  const sidebarProviders: { id: string; label: string; credentialRef: string }[] = [
    ...settings.builtinProviders
      .filter((p) => p.enabled && p.showInSidebar)
      .map((p) => ({
        id: p.id,
        label: t(PROVIDER_NAME_KEY[p.id]),
        credentialRef: (PROVIDER_KEY_REFS[p.id] ?? []).join(' / '),
      })),
    ...settings.customProviders
      .filter((p) => p.enabled && p.showInSidebar)
      .map((p) => ({ id: p.id, label: p.label, credentialRef: p.credentialRef })),
  ].slice(0, 8);

  /** 按 id 取该服务商的额度条目；尚未加载时 undefined。 */
  const providerEntryOf = (id: string): ProviderQuotaEntry | undefined =>
    providerQuotas?.providers.find((e) => e.id === id);

  /** 单个服务商额度条目的 tooltip 摘要（金额与窗口拼一行；异常态给原因）。 */
  const providerTip = (provider: { label: string; credentialRef: string }, entry: ProviderQuotaEntry | undefined): string => {
    if (entry === undefined) return `${provider.label}：${t('state.loading')}`;
    if (entry.status === 'no-key') return t('providers.notConfigured', { keys: provider.credentialRef });
    if (entry.status === 'error') return entry.error ?? t('providers.unavailable');
    const parts = [
      ...entry.amounts.map((a) => `${a.currency} ${a.total === null ? '--' : Number(a.total).toFixed(2)}`),
      ...entry.windows.map((w) => `${t(WINDOW_LABEL_KEY[w.kind])} ${Math.round(Math.max(0, Math.min(100, w.percent)))}%`),
    ];
    return parts.length > 0 ? `${provider.label}：${parts.join(' · ')}` : t('providers.noData');
  };

  // 宽列：服务商额度芯片组，金额与窗口各一枚芯片（窗口按档位着色），
  // 未配置 / 失败 / 加载中分别给提示芯片与横杠。
  const providerWideRow = (provider: { id: string; label: string; credentialRef: string }, entry: ProviderQuotaEntry | undefined): React.ReactNode => {
    const tip = providerTip(provider, entry);
    const chips: React.ReactNode[] = [];
    if (entry?.status === 'ok') {
      for (const amount of entry.amounts) {
        chips.push(
          <BaseTooltip key={`a-${amount.currency}`} label={tip} side="top" delayMs={400}>
            <span className={css.goChip}>
              {amount.currency} {amount.total === null ? '--' : Number(amount.total).toFixed(2)}
            </span>
          </BaseTooltip>,
        );
      }
      for (const win of entry.windows) {
        const pct = Math.round(Math.max(0, Math.min(100, win.percent)));
        chips.push(
          <BaseTooltip key={`w-${win.kind}`} label={tip} side="top" delayMs={400}>
            <span className={`${css.goChip} ${getChipClass(goLevelOf(pct))}`}>
              {t(WINDOW_LABEL_KEY[win.kind])} {pct}%
            </span>
          </BaseTooltip>,
        );
      }
    }
    if (chips.length === 0) {
      if (entry?.status === 'no-key') {
        chips.push(
          <BaseTooltip key="no-key" label={tip} side="top" delayMs={400}>
            <span className={`${css.goChip} ${css.goChipHint}`}>{t('state.noKey')}</span>
          </BaseTooltip>,
        );
      } else if (entry?.status === 'error') {
        chips.push(
          <BaseTooltip key="error" label={tip} side="top" delayMs={400}>
            <span className={`${css.goChip} ${css.goChipOver}`}>!</span>
          </BaseTooltip>,
        );
      } else {
        chips.push(<span className={css.goChip} key="empty">—</span>);
      }
    }
    return (
      <span className={css.unifiedGoRow} key={provider.id}>
        <span className={`${css.goLabel} ${css.customGoLabel}`} title={provider.label}>{provider.label}</span>
        {chips}
      </span>
    );
  };

  // 折叠列：服务商迷你芯片，名 + 首个金额（没有金额时用首个窗口百分比），异常态给 — / ! 并在 tooltip 说明。
  const providerRailChip = (provider: { id: string; label: string; credentialRef: string }, entry: ProviderQuotaEntry | undefined): React.ReactNode => {
    const tip = providerTip(provider, entry);
    let value: string | null = null;
    if (entry?.status === 'ok') {
      const amount = entry.amounts[0];
      if (amount !== undefined && amount.total !== null) value = Number(amount.total).toFixed(2);
      else if (entry.windows.length > 0) value = `${Math.round(Math.max(0, Math.min(100, entry.windows[0].percent)))}%`;
    }
    if (value !== null) {
      return (
        <BaseTooltip label={tip} side="top" delayMs={400}>
          <span className={css.goRailChipBox}>
            <span className={`${css.goRailChipLabel} ${css.customRailLabel}`}>{provider.label}</span>
            <span className={css.goRailChipPct}>{value.slice(0, 6)}</span>
          </span>
        </BaseTooltip>
      );
    }
    let stateCls = '';
    let stateText = '—';
    if (entry?.status === 'error') {
      stateCls = css.goChipOver;
      stateText = '!';
    } else if (entry?.status === 'no-key') {
      stateCls = css.goChipHint;
      stateText = t('state.noKey');
    }
    return (
      <BaseTooltip label={tip} side="top" delayMs={400}>
        <span className={`${css.goRailChipBox} ${stateCls}`}>
          <span className={`${css.goRailChipLabel} ${css.customRailLabel}`}>{provider.label}</span>
          <span className={css.goRailChipPct}>{stateText}</span>
        </span>
      </BaseTooltip>
    );
  };

  // ---- Z.ai 额度，含会话与本周百分比及 Web 搜索次数 ----
  const zaiWindows: ZaiWindowEntry[] =
    zai?.status === 'ok'
      ? [
        { key: 'session', short: t('zai.short.session'), full: t('zai.session'), win: zai.session },
        { key: 'weekly', short: t('zai.short.weekly'), full: t('zai.weekly'), win: zai.weekly },
      ].filter((w): w is ZaiWindowEntry => w.win !== null)
      : [];
  const zaiWeb = zai?.status === 'ok' ? zai.webSearches : null;
  const zaiChip = ({ key, short, win }: ZaiWindowEntry) => {
    const pct = goPercent(win);
    const level = goLevelOf(pct);
    const cls = getChipClass(level);
    return (
      <Tooltip key={key} content={zaiTipContent} side="top" delayMs={400}>
        <span className={`${css.goChip} ${cls}`}>{short} {pct}%</span>
      </Tooltip>
    );
  };

  // 折叠态 Z.ai：取会话窗口优先，否则取本周
  const railZai = zaiWindows.find((w) => w.key === 'session') ?? zaiWindows[0];
  const railZaiLevel = railZai ? goLevelOf(goPercent(railZai.win)) : undefined;
  const railZaiCls = railZaiLevel ? getChipClass(railZaiLevel) : '';

  // Z.ai 额度 tooltip，宽列芯片与折叠 rail 共用，卡片化明细 —
  // 标题行带订阅计划徽标，会话与本周窗口卡及 Web 搜索次数卡含进度条与重置时间，底部带更新时间，异常态为提示卡。
  const zaiTipContent = (() => {
    if (zai === null) return '';
    const wrap = (hint: string) => (
      <div className={shared.tipPanelGo}>
        <TipTitle>{t('zai.title')}</TipTitle>
        <TipHint>{hint}</TipHint>
      </div>
    );
    if (zai.status !== 'ok') {
      if (zai.status === 'no-key') return wrap(t('zai.notConfigured'));
      if (zai.status === 'no-plan') {
        return (
          <div className={shared.tipPanelGo}>
            <TipTitle>{t('zai.title')}</TipTitle>
            <HintCard text={t('zai.noPlan')} tone="tip" />
          </div>
        );
      }
      return wrap(t('zai.unavailable'));
    }
    const webReset = zai.webSearches?.resetsAt
      ? t('zai.resetsAt', { time: new Date(zai.webSearches.resetsAt).toLocaleString() })
      : '';
    const hasRows = zaiWindows.length > 0 || zai.webSearches !== null;
    if (!hasRows) return wrap(t('zai.noData'));
    return (
      <div className={shared.tipPanelGo}>
        <div className={shared.tipHeaderRow}>
          <span className={shared.tipTitle}>{t('zai.title')}</span>
          {zai.plan && <TipPill maxWidth={120}>{zai.plan}</TipPill>}
        </div>
        <div className={shared.tipStack}>
          {zaiWindows.map((w) => {
            const pct = goPercent(w.win);
            const pointsText = w.win.used !== null && w.win.limit !== null
              ? `${fmt(w.win.used, tFn)} / ${fmt(w.win.limit, tFn)}`
              : undefined;
            return (
              <QuotaTipRow
                key={w.key}
                label={w.full}
                pct={pct}
                level={goLevelOf(pct)}
                reset={resetsOf(w.win)}
                points={pointsText}
              />
            );
          })}
          {zai.webSearches && (
            <QuotaTipRow
              label={t('zai.webSearches')}
              pct={Math.max(0, Math.min(100, zai.webSearches.percent))}
              level={goLevelOf(Math.max(0, Math.min(100, zai.webSearches.percent)))}
              reset={webReset}
              value={t('zai.webSearchesCount', { used: zai.webSearches.used, limit: zai.webSearches.limit })}
            />
          )}
        </div>
        <TipFooter>
          {t('updatedAt')} {new Date(zai.fetchedAt).toLocaleTimeString()}
        </TipFooter>
      </div>
    );
  })();

  // 折叠态 Go 芯片内容，ok 时展示滚动 5 小时窗口，no-key、no-plan、error 与加载中均共用 goTipContent，
  // 内容为卡片化明细或提示卡，go 为 null 时内容为空串、气泡自然隐藏。
  const renderGoRail = (): React.ReactNode => {
    if (go?.status === 'ok' && railRolling !== undefined) {
      return (
        <Tooltip content={goTipContent} side="top" delayMs={400}>
          <span className={`${css.goRailChipBox} ${railCls}`}>
            <span className={css.goRailChipLabel}>{railRolling.short}</span>
            <span className={css.goRailChipPct}>{goPercent(railRolling.win)}%</span>
          </span>
        </Tooltip>
      );
    }
    if (go?.status === 'no-key' || go?.status === 'no-plan') {
      return (
        <Tooltip content={goTipContent} side="top" delayMs={400}>
          <span className={`${css.goRailChipBox}`}>
            <span className={css.goRailChipLabel}>{t('go.label')}</span>
            <span className={css.goRailChipPct}>—</span>
          </span>
        </Tooltip>
      );
    }
    if (go?.status === 'error') {
      return (
        <Tooltip content={goTipContent} side="top" delayMs={400}>
          <span className={`${css.goRailChipBox} ${css.goChipOver}`}>
            <span className={css.goRailChipLabel}>{t('go.label')}</span>
            <span className={css.goRailChipPct}>!</span>
          </span>
        </Tooltip>
      );
    }
    return (
      <Tooltip content={goTipContent} side="top" delayMs={400}>
        <span className={`${css.goRailChipBox}`}>
          <span className={css.goRailChipLabel}>{t('go.label')}</span>
          <span className={css.goRailChipPct}>—</span>
        </span>
      </Tooltip>
    );
  };

  // 折叠态 DeepSeek 芯片内容
  const renderDeepSeekRail = (): React.ReactNode => {
    if (deepseek?.status === 'ok' && deepseek.isAvailable && deepseek.balances.length > 0) {
      return (
        <Tooltip content={railDeepSeekContent} side="top" delayMs={400}>
          <span className={css.goRailChipBox}>
            <span className={css.goRailChipLabel}>{deepseek.balances[0].currency}</span>
            <span className={css.goRailChipPct}>{deepseek.balances[0].totalBalance.slice(0, 6)}</span>
          </span>
        </Tooltip>
      );
    }
    if (deepseek?.status === 'ok' && !deepseek.isAvailable) {
      return (
        <BaseTooltip label={t('deepseek.notAvailable')} side="top" delayMs={400}>
          <span className={css.goRailChipBox}>
            <span className={css.goRailChipLabel}>{t('deepseek.label')}</span>
            <span className={css.goRailChipPct}>—</span>
          </span>
        </BaseTooltip>
      );
    }
    if (deepseek?.status === 'no-key') {
      return (
        <BaseTooltip label={t('deepseek.notConfigured')} side="top" delayMs={400}>
          <span className={css.goRailChipBox}>
            <span className={css.goRailChipLabel}>{t('deepseek.label')}</span>
            <span className={css.goRailChipPct}>—</span>
          </span>
        </BaseTooltip>
      );
    }
    if (deepseek?.status === 'error') {
      return (
        <BaseTooltip label={t('deepseek.unavailable')} side="top" delayMs={400}>
          <span className={`${css.goRailChipBox} ${css.goChipOver}`}>
            <span className={css.goRailChipLabel}>{t('deepseek.label')}</span>
            <span className={css.goRailChipPct}>!</span>
          </span>
        </BaseTooltip>
      );
    }
    return (
      <Tooltip content={railDeepSeekContent} side="top" delayMs={400}>
        <span className={css.goRailChipBox}>
          <span className={css.goRailChipLabel}>{t('deepseek.label')}</span>
          <span className={css.goRailChipPct}>—</span>
        </span>
      </Tooltip>
    );
  };

  // 折叠态 Z.ai 芯片内容，全部状态共用 zaiTipContent，内容为卡片化明细或提示卡。
  const renderZaiRail = (): React.ReactNode => {
    if (zai?.status === 'ok' && railZai) {
      return (
        <Tooltip content={zaiTipContent} side="top" delayMs={400}>
          <span className={`${css.goRailChipBox} ${railZaiCls}`}>
            <span className={css.goRailChipLabel}>{railZai.short}</span>
            <span className={css.goRailChipPct}>{goPercent(railZai.win)}%</span>
          </span>
        </Tooltip>
      );
    }
    if (zai?.status === 'ok' && zai.webSearches) {
      return (
        <Tooltip content={zaiTipContent} side="top" delayMs={400}>
          <span className={css.goRailChipBox}>
            <span className={css.goRailChipLabel}>{t('zai.short.webSearches')}</span>
            <span className={css.goRailChipPct}>{zai.webSearches.used}/{zai.webSearches.limit}</span>
          </span>
        </Tooltip>
      );
    }
    if (zai?.status === 'no-key' || zai?.status === 'no-plan') {
      return (
        <Tooltip content={zaiTipContent} side="top" delayMs={400}>
          <span className={css.goRailChipBox}>
            <span className={css.goRailChipLabel}>{t('zai.short.label')}</span>
            <span className={css.goRailChipPct}>—</span>
          </span>
        </Tooltip>
      );
    }
    if (zai?.status === 'error') {
      return (
        <Tooltip content={zaiTipContent} side="top" delayMs={400}>
          <span className={`${css.goRailChipBox} ${css.goChipOver}`}>
            <span className={css.goRailChipLabel}>{t('zai.short.label')}</span>
            <span className={css.goRailChipPct}>!</span>
          </span>
        </Tooltip>
      );
    }
    return (
      <Tooltip content={zaiTipContent} side="top" delayMs={400}>
        <span className={css.goRailChipBox}>
          <span className={css.goRailChipLabel}>{t('zai.short.label')}</span>
          <span className={css.goRailChipPct}>—</span>
        </span>
      </Tooltip>
    );
  };

  // ---- 侧边栏软写入条目清单 ----
  // Z.ai 与 OpenCode Go 与「服务商」页勾选侧边栏的服务商走同一份数据驱动的清单：
  // 是否出现只由偏好配置决定，内容各自渲染；DeepSeek 保留下方专属硬编码行。
  const monitorItems: SoftQuotaItem[] = [];
  if (showZai) {
    monitorItems.push({
      key: 'zai',
      wide: (
        <span className={css.unifiedGoRow} key="zai">
          <span className={css.goLabel}>{t('zai.label')}</span>
          {zai !== null && zai.status === 'ok' && zaiWindows.length > 0 && zaiWindows.map(zaiChip)}
          {zai !== null && zai.status === 'ok' && zaiWindows.length === 0 && zaiWeb && (
            <Tooltip content={zaiTipContent} side="top" delayMs={400}>
              <span className={css.goChip}>{t('zai.short.webSearches')} {zaiWeb.used}/{zaiWeb.limit}</span>
            </Tooltip>
          )}
          {zai !== null && zai.status === 'ok' && zaiWindows.length === 0 && !zaiWeb && <span className={css.goChip}>—</span>}
          {zai !== null && zai.status === 'ok' && zaiWeb && zaiWindows.length > 0 && (
            <Tooltip content={zaiTipContent} side="top" delayMs={400}>
              <span className={css.goChip}>{t('zai.short.webSearches')} {zaiWeb.used}/{zaiWeb.limit}</span>
            </Tooltip>
          )}
          {zai !== null && (zai.status === 'no-key' || zai.status === 'no-plan') && (
            <Tooltip content={zaiTipContent} side="top" delayMs={400}>
              <span className={`${css.goChip} ${css.goChipHint}`}>
                {zai.status === 'no-plan' ? t('state.noPlan') : t('state.noKey')}
              </span>
            </Tooltip>
          )}
          {zai !== null && zai.status === 'error' && (
            <Tooltip content={zaiTipContent} side="top" delayMs={400}>
              <span className={`${css.goChip} ${css.goChipOver}`}>!</span>
            </Tooltip>
          )}
          {zai === null && <span className={css.goChip}>—</span>}
        </span>
      ),
      rail: (
        <span className={css.goRailChip} key="zai">
          {renderZaiRail()}
        </span>
      ),
    });
  }
  if (showGo) {
    monitorItems.push({
      key: 'go',
      wide: (
        <span className={css.unifiedGoRow} key="go">
          <span className={css.goLabel}>{t('go.label')}</span>
          {go !== null && go.status === 'ok' && goWindows.length > 0 && goWindows.map(goChip)}
          {go !== null && go.status === 'ok' && goWindows.length === 0 && <span className={css.goChip}>—</span>}
          {go !== null && (go.status === 'no-key' || go.status === 'no-plan') && (
            <Tooltip content={goTipContent} side="top" delayMs={400}>
              <span className={`${css.goChip} ${css.goChipHint}`}>
                {go.status === 'no-plan' ? t('state.noPlan') : t('state.noKey')}
              </span>
            </Tooltip>
          )}
          {go !== null && go.status === 'error' && (
            <Tooltip content={goTipContent} side="top" delayMs={400}>
              <span className={`${css.goChip} ${css.goChipOver}`}>!</span>
            </Tooltip>
          )}
          {go === null && <span className={css.goChip}>—</span>}
        </span>
      ),
      rail: (
        <span className={css.goRailChip} key="go">
          {renderGoRail()}
        </span>
      ),
    });
  }

  // 服务商额度条目：内置三家勾选侧边栏的在前、自定义厂商在后；条目未加载时给占位芯片。
  const providerItems: SoftQuotaItem[] = sidebarProviders.map((provider) => {
    const entry = providerEntryOf(provider.id);
    return {
      key: provider.id,
      wide: providerWideRow(provider, entry),
      rail: <span className={css.goRailChip} key={provider.id}>{providerRailChip(provider, entry)}</span>,
    };
  });

  return (
    <div ref={rootRef} className={wide ? css.root : `${css.root} ${css.rail}`} data-usage-stats-footer>
      <UsageStatsPanel
        open={open}
        data={data}
        err={err}
        errDetail={errDetail}
        go={go}
        deepseek={deepseek}
        zai={zai}
        settings={settings}
        onUpdateSettings={updateSettings}
        onClose={() => setOpen(false)}
        onRefresh={() => { refreshSnapshot(); refreshQuota(); refreshDeepSeek(); refreshZai(); }}
        onRefreshGo={refreshQuota}
        onRefreshDeepSeek={refreshDeepSeek}
        onRefreshZai={refreshZai}
        t={t}
      />
      {wide ? (
        // 宽列合一按钮：整块可点，行序自上而下为 Z.ai 额度 + Go 额度 + DeepSeek 余额 + 今日用量 + 比例条
        <button
          type="button"
          className={css.unified}
          data-active={open || undefined}
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={toggle}
        >
          {/* 软写入条目：Z.ai 与 Go 由偏好配置驱动，与服务商条目同一清单机制 */}
          {monitorItems.map((item) => item.wide)}
          {showDeepSeek && (
            <span className={css.unifiedGoRow}>
              <span className={css.goLabel}>{t('deepseek.label')}</span>
              {deepseek !== null && deepseek.status === 'ok' && deepseek.isAvailable && deepseek.balances.length > 0 && deepseek.balances.map((b) => (
                <Tooltip key={b.currency} content={deepseekWideTooltip} side="top" delayMs={400}>
                  <span className={css.goChip}>{b.currency} {b.totalBalance}</span>
                </Tooltip>
              ))}
              {deepseek !== null && deepseek.status === 'ok' && deepseek.isAvailable && deepseek.balances.length === 0 && (
                <Tooltip content={deepseekWideTooltip} side="top" delayMs={400}>
                  <span className={css.goChip}>—</span>
                </Tooltip>
              )}
              {deepseek !== null && deepseek.status === 'ok' && !deepseek.isAvailable && (
                <BaseTooltip label={t('deepseek.notAvailable')} side="top" delayMs={400}>
                  <span className={css.goChip}>—</span>
                </BaseTooltip>
              )}
              {deepseek !== null && deepseek.status === 'no-key' && (
                <BaseTooltip label={t('deepseek.notConfigured')} side="top" delayMs={400}>
                  <span className={`${css.goChip} ${css.goChipHint}`}>{t('state.noKey')}</span>
                </BaseTooltip>
              )}
              {deepseek !== null && deepseek.status === 'error' && (
                <BaseTooltip label={t('deepseek.unavailable')} side="top" delayMs={400}>
                  <span className={`${css.goChip} ${css.goChipOver}`}>!</span>
                </BaseTooltip>
              )}
              {deepseek === null && <span className={css.goChip}>—</span>}
            </span>
          )}
          {/* 服务商额度条目：勾选侧边栏的内置三家在前、自定义厂商在后 */}
          {providerItems.map((item) => item.wide)}
          <span className={css.unifiedMain}>
            <span className={css.badgeIcon}><IconDataOutlineRegular size={14} /></span>
            <span className={css.badgeLabel}>{t('footer.todayLabel')}</span>
            <span className={css.badgeMeta}>
              {err
                ? <span className={css.badgeErr}>--</span>
                : (
                  <>
                    <span className={css.badgeCalls}>{fmtFull(todayCalls)}{t('panel.summary.callsSuffix')}</span>
                    <span className={css.badgeTokens}>· {fmt(todayTokens, tFn)}</span>
                    {missing && <span className={css.badgeErr}>{fmtFull(data?.failed ?? 0)}</span>}
                  </>
                )}
            </span>
            {!err && todayTokens > 0 && (
              <Tooltip follow content={barContent} side="top" delayMs={300}>
                <span className={css.barRow}>
                  {cacheTokens > 0 && (
                    <span
                      className={`${css.barSeg} ${css.barCache}`}
                      style={{ flex: cacheTokens }}
                    />
                  )}
                  {inputTokens > 0 && (
                    <span
                      className={`${css.barSeg} ${css.barInput}`}
                      style={{ flex: inputTokens }}
                    />
                  )}
                  {outputTokens > 0 && (
                    <span
                      className={`${css.barSeg} ${css.barOutput}`}
                      style={{ flex: outputTokens }}
                    />
                  )}
                </span>
              </Tooltip>
            )}
          </span>
        </button>
      ) : (
        // 折叠 rail 合一按钮，Z.ai、Go 与 DeepSeek 迷你芯片在上、今日用量芯片在下含今日与 tokens 缩写值，整块可点
        <button
          type="button"
          className={css.railUnified}
          data-active={open || undefined}
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={toggle}
        >
          {/* 软写入条目：Z.ai 与 Go 由偏好配置驱动，与服务商条目同一清单机制 */}
          {monitorItems.map((item) => item.rail)}
          {showDeepSeek && (
            <span className={css.goRailChip}>
              {renderDeepSeekRail()}
            </span>
          )}
          {/* 服务商额度条目：勾选侧边栏的内置三家在前、自定义厂商在后 */}
          {providerItems.map((item) => item.rail)}
          {/* 今日用量迷你芯片，折叠态也展示今日 tokens 总量为缩写值，tooltip 为完整明细，按需求使用今日文字 */}
          <Tooltip content={railContent} side="right" delayMs={500}>
            <span className={css.goRailChipBox}>
              <span className={css.goRailChipLabel}>{t('footer.todayLabel')}</span>
              <span className={`${css.goRailChipPct} ${css.goRailChipPctCompact}`}>
                {err ? '--' : fmt(todayTokens, tFn)}
              </span>
            </span>
          </Tooltip>
        </button>
      )}
    </div>
  );
}
