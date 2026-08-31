"use client";

import { useEffect, useRef } from "react";
import type { EChartsCoreOption } from "echarts/core";

export function EChart({ option, label, height = 280 }: { option: EChartsCoreOption; label: string; height?: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    let disposed = false; let observer: ResizeObserver | undefined; let chart: { setOption: (value: EChartsCoreOption, options: { notMerge: boolean }) => void; resize: () => void; dispose: () => void } | undefined; const element = host.current;
    void (async () => {
      const [core, charts, components, renderers] = await Promise.all([import("echarts/core"), import("echarts/charts"), import("echarts/components"), import("echarts/renderers")]);
      core.use([charts.BarChart, charts.LineChart, charts.PieChart, charts.ScatterChart, components.GridComponent, components.LegendComponent, components.TooltipComponent, components.MarkLineComponent, renderers.CanvasRenderer]);
      if (disposed || !element) return; chart = core.init(element, undefined, { renderer: "canvas" }); chart.setOption(option, { notMerge: true }); observer = new ResizeObserver(() => chart?.resize()); observer.observe(element);
    })();
    return () => { disposed = true; observer?.disconnect(); chart?.dispose(); };
  }, [option]);
  return <div ref={host} role="img" aria-label={label} style={{ width: "100%", height }} />;
}
