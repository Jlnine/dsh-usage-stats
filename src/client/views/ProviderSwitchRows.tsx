/**
 * 服务商卡片内的三项偏好行：启用监控 / 在侧边栏展示 / 抓取间隔（下限 3 分钟）。
 * 内置三家、DeepSeek 余额、Z.ai 额度、OpenCode Go 额度与自助添加的厂商
 * 共用同一布局与交互，只是文案键由调用方给出（各自既有文案，插值参数为 {name}）。
 *
 * 独立成文件是因为抓取间隔要用 useIntervalText 持有本地输入态，
 * 不能在父组件循环里调 hook。样式用本组件自己的 CSS Module，颜色走设计 token。
 */
import { clampProvidersFetchMinutes, PROVIDERS_FETCH_MIN_MINUTES } from '../../utils.ts';
import { SettingsSwitch } from '../components/SettingsSwitch.tsx';
import { useIntervalText } from '../useIntervalText.ts';

import css from './ProviderSwitchRows.module.css';

import type { UsageStatsKey } from '../locales.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 三项偏好的文案键集合；插值参数为 {name}，不用的文案键可留空串。 */
export interface ProviderSwitchKeys {
  enabled: UsageStatsKey
  enabledHint: UsageStatsKey
  sidebar: UsageStatsKey
  sidebarHint: UsageStatsKey
  interval: UsageStatsKey
  intervalHint: UsageStatsKey
}

export function ProviderSwitchRows({ t, name, keys, enabled, showInSidebar, fetchMinutes, onPatch }: {
  t: PropsLocale<'dsh-usage-stats'>['t']
  /** 卡片标题名，用于通用文案里的 {name} 插值。 */
  name: string
  /** 三项文案键（各自既有文案或通用文案）。 */
  keys: ProviderSwitchKeys
  enabled: boolean
  showInSidebar: boolean
  fetchMinutes: number
  /** 只落显式给出的字段：开关按字段写，间隔已先夹取。 */
  onPatch: (patch: { enabled?: boolean; showInSidebar?: boolean; fetchMinutes?: number }) => void
}) {
  const interval = useIntervalText(
    fetchMinutes,
    clampProvidersFetchMinutes,
    (m) => onPatch({ fetchMinutes: m }),
  );

  return (
    <>
      {/* 1. 启用监控 */}
      <label className={css.row}>
        <span className={css.text}>
          <span className={css.title}>{t(keys.enabled, { name })}</span>
          <span className={css.desc}>{t(keys.enabledHint, { name })}</span>
        </span>
        <SettingsSwitch checked={enabled} onToggle={() => onPatch({ enabled: !enabled })} />
      </label>

      {/* 2. 侧边栏展示，关闭监控时置灰 */}
      <label className={`${css.row} ${enabled ? '' : css.rowDisabled}`}>
        <span className={css.text}>
          <span className={css.title}>{t(keys.sidebar, { name })}</span>
          <span className={css.desc}>{t(keys.sidebarHint, { name })}</span>
        </span>
        <SettingsSwitch
          checked={showInSidebar}
          disabled={!enabled}
          onToggle={() => onPatch({ showInSidebar: !showInSidebar })}
        />
      </label>

      {/* 3. 抓取间隔，关闭监控时置灰 */}
      <label className={`${css.row} ${enabled ? '' : css.rowDisabled}`}>
        <span className={css.text}>
          <span className={css.title}>{t(keys.interval, { name })}</span>
          <span className={css.desc}>{t(keys.intervalHint, { min: PROVIDERS_FETCH_MIN_MINUTES })}</span>
        </span>
        <span className={css.intervalInput}>
          <input
            type="number"
            min={PROVIDERS_FETCH_MIN_MINUTES}
            step={1}
            disabled={!enabled}
            {...interval.field}
          />
          <span className={css.intervalUnit}>{t('settings.unitMinutes')}</span>
        </span>
      </label>
    </>
  );
}