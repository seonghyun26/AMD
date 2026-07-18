import { UI_COLORS } from "@/lib/colors";

export const PLOT_COLORS = UI_COLORS.plot.series;

export const PLOT_CONFIG: Partial<Plotly.Config> = {
  responsive: true,
  displayModeBar: false,
  displaylogo: false,
};

export function plotAxis(
  isDark: boolean,
  options: { compact?: boolean; accent?: string } = {},
) {
  const { compact = false, accent } = options;
  return {
    zeroline: false,
    gridcolor: isDark ? UI_COLORS.neutral[800] : UI_COLORS.neutral[200],
    zerolinecolor: isDark ? UI_COLORS.neutral[700] : UI_COLORS.neutral[300],
    color: isDark ? UI_COLORS.neutral[500] : UI_COLORS.neutral[400],
    tickfont: {
      size: compact ? 9 : 11,
      color: isDark ? UI_COLORS.neutral[400] : UI_COLORS.neutral[500],
    },
    titlefont: {
      size: compact ? 10 : 12,
      color: accent ?? (isDark ? UI_COLORS.neutral[400] : UI_COLORS.neutral[600]),
    },
    gridwidth: 1,
    showgrid: true,
  };
}

export function plotLayout(
  isDark: boolean,
  overrides: Partial<Plotly.Layout> = {},
): Partial<Plotly.Layout> {
  const axis = plotAxis(isDark);
  const base: Partial<Plotly.Layout> = {
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    font: {
      color: isDark ? UI_COLORS.neutral[400] : UI_COLORS.neutral[700],
      size: 10,
    },
    hovermode: "x unified",
    hoverlabel: {
      bgcolor: isDark ? UI_COLORS.neutral[900] : "#ffffff",
      bordercolor: isDark ? UI_COLORS.neutral[700] : UI_COLORS.neutral[200],
      font: {
        size: 11,
        color: isDark ? UI_COLORS.neutral[200] : UI_COLORS.neutral[700],
      },
    },
    margin: { t: 8, l: 52, r: 12, b: 40 },
    xaxis: axis,
    yaxis: axis,
  };

  return {
    ...base,
    ...overrides,
    xaxis: { ...axis, ...(overrides.xaxis ?? {}) },
    yaxis: { ...axis, ...(overrides.yaxis ?? {}) },
  };
}
