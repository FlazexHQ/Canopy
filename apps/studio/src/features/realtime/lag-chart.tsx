import { useEffect, useRef, useState } from "react"
import type UPlotType from "uplot"
import type { RealtimeStats } from "../../api/contract.ts"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { formatDateTime, formatNumber, t } from "../../i18n/index.ts"

export type LagPoint = NonNullable<RealtimeStats["history"]>[number]

/** A one sentence description of the samples, read by screen readers instead of the chart. */
export function chartSummary(points: readonly LagPoint[]): string {
  if (points.length === 0) return t("realtime.chart.empty")
  const lags = points.map((point) => point.lagMs)
  const last = points.at(-1) as LagPoint
  return t("realtime.chart.summary", {
    points: points.length,
    min: Math.min(...lags),
    max: Math.max(...lags),
    last: last.lagMs,
    rate: last.eventsPerSecond,
  })
}

function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === "" ? fallback : value
}

/**
 * Change stream lag and throughput drawn with uPlot, which is loaded only when the chart is shown. The
 * canvas is hidden from assistive technology; the summary and the sample table carry the same data.
 */
export function LagChart({ points }: { readonly points: readonly LagPoint[] }) {
  const host = useRef<HTMLDivElement>(null)
  const plot = useRef<UPlotType | null>(null)
  const [failed, setFailed] = useState(false)
  const data: UPlotType.AlignedData = [
    points.map((point) => point.t / 1000),
    points.map((point) => point.lagMs),
    points.map((point) => point.eventsPerSecond),
  ]

  useEffect(() => {
    let cancelled = false
    const element = host.current
    if (element === null) return
    const canvas = document.createElement("canvas")
    if (typeof canvas.getContext !== "function" || canvas.getContext("2d") === null) {
      setFailed(true)
      return
    }
    void (async () => {
      try {
        const [{ default: UPlot }] = await Promise.all([
          import("uplot"),
          import("uplot/dist/uPlot.min.css"),
        ])
        if (cancelled) return
        const foreground = cssColor("--muted-foreground", "#666")
        const grid = cssColor("--border", "#ddd")
        const axis = { stroke: foreground, grid: { stroke: grid }, ticks: { stroke: grid } }
        plot.current = new UPlot(
          {
            width: Math.max(element.clientWidth, 320),
            height: 220,
            series: [
              {},
              {
                label: t("realtime.chart.lagMs"),
                stroke: cssColor("--primary", "#16a34a"),
                width: 2,
              },
              {
                label: t("realtime.chart.eventsPerSecond"),
                stroke: cssColor("--warning", "#b45309"),
                width: 1.5,
                scale: "rate",
              },
            ],
            axes: [axis, axis, { ...axis, scale: "rate", side: 1 }],
          },
          [[], [], []],
          element,
        )
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      plot.current?.destroy()
      plot.current = null
    }
  }, [])

  useEffect(() => {
    plot.current?.setData(data)
  })

  return (
    <figure className="grid gap-3">
      <figcaption className="text-sm text-muted-foreground">{chartSummary(points)}</figcaption>
      {failed ? null : <div ref={host} aria-hidden="true" className="min-h-[220px] w-full" />}
      <details>
        <summary className="cursor-pointer text-sm">{t("realtime.chart.showTable")}</summary>
        <Table>
          <TableCaption>{t("realtime.chart.tableCaption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("realtime.chart.time")}</TableHead>
              <TableHead>{t("realtime.chart.lagMs")}</TableHead>
              <TableHead>{t("realtime.chart.eventsPerSecond")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {points.map((point) => (
              <TableRow key={point.t} data-testid="lag-sample">
                <TableCell>{formatDateTime(point.t)}</TableCell>
                <TableCell>{formatNumber(point.lagMs)}</TableCell>
                <TableCell>{formatNumber(point.eventsPerSecond)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </details>
    </figure>
  )
}
