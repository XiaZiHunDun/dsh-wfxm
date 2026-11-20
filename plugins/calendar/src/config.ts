/**
 * 飞书应用日历配置（J4）。
 *
 * 采用应用身份（tenant_access_token），读写一本应用自有日历；**不读** owner 的
 * 个人主日历。日历 id 优先取 `DSH_WFXM_CALENDAR_ID`，否则按 summary 查找
 * （默认「dsh 日程」），写操作找不到时新建。
 */

/** 应用自有日历的默认名称；owner 在飞书里按这个名字订阅。 */
export const DEFAULT_CALENDAR_SUMMARY = 'dsh 日程'

/** 日程时间统一按上海墙钟渲染；写操作仍要求显式偏移。 */
export const CALENDAR_TIME_ZONE = 'Asia/Shanghai'

/** 单次读取的天数上限（与前台 `calendar_view.days` 一致）。 */
export const MAX_VIEW_DAYS = 31

export function readCalendarIdOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.DSH_WFXM_CALENDAR_ID?.trim()
  return raw === undefined || raw === '' ? undefined : raw
}

export function readCalendarSummary(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_WFXM_CALENDAR_SUMMARY?.trim()
  return raw === undefined || raw === '' ? DEFAULT_CALENDAR_SUMMARY : raw
}
