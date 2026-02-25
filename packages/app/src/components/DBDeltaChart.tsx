import { createPortal } from 'react-dom';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { withErrorBoundary } from 'react-error-boundary';
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ClickHouseQueryError } from '@hyperdx/common-utils/dist/clickhouse';
import {
  ChartConfigWithDateRange,
  ChartConfigWithOptDateRange,
  Filter,
} from '@hyperdx/common-utils/dist/types';
import {
  ActionIcon,
  Box,
  Code,
  Container,
  Divider,
  Flex,
  Pagination,
  Text,
  Tooltip as MantineTooltip,
} from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import {
  IconCheck,
  IconCopy,
  IconFilter,
  IconFilterX,
} from '@tabler/icons-react';

import { isAggregateFunction } from '@/ChartUtils';
import { useQueriedChartConfig } from '@/hooks/useChartConfig';
import { getFirstTimestampValueExpression } from '@/source';
import {
  getChartColorError,
  getChartColorSuccess,
  truncateMiddle,
} from '@/utils';

import { SQLPreview } from './ChartSQLPreview';

import styles from '../../styles/HDXLineChart.module.scss';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTypeWrappers(type: string): string {
  let t = type.trim();
  let changed = true;
  while (changed) {
    changed = false;
    if (t.startsWith('LowCardinality(') && t.endsWith(')')) {
      t = t.slice('LowCardinality('.length, -1).trim();
      changed = true;
    } else if (t.startsWith('Nullable(') && t.endsWith(')')) {
      t = t.slice('Nullable('.length, -1).trim();
      changed = true;
    }
  }
  return t;
}

/**
 * Converts a flattened dot-notation property key (produced by flattenData())
 * into a valid ClickHouse SQL expression for use in filter conditions.
 *
 * flattenData() uses JavaScript's object/array iteration, producing keys like:
 *   "ResourceAttributes.service.name"     for Map(String, String) columns
 *   "Events.Attributes[0].message.type"   for Array(Map(String, String)) columns
 *
 * These must be converted to bracket notation for ClickHouse Map access:
 *   "ResourceAttributes['service.name']"
 *   "Events.Attributes[1]['message.type']"  (note: 0-based JS → 1-based CH index)
 */
export function flattenedKeyToSqlExpression(
  key: string,
  columnMeta: { name: string; type: string }[],
): string {
  for (const col of columnMeta) {
    const baseType = stripTypeWrappers(col.type);

    if (baseType.startsWith('Map(')) {
      // Simple Map column: "MapCol.some.key" → "MapCol['some.key']"
      if (key.startsWith(col.name + '.')) {
        const mapKey = key.slice(col.name.length + 1);
        return `${col.name}['${mapKey}']`;
      }
    } else if (baseType.startsWith('Array(')) {
      const innerType = stripTypeWrappers(baseType.slice('Array('.length, -1));
      if (innerType.startsWith('Map(')) {
        // Array(Map) column: "ColName[N].key" → "ColName[N+1]['key']"
        // flattenData() uses 0-based JS indexing; ClickHouse SQL uses 1-based.
        const pattern = new RegExp(
          `^${escapeRegExp(col.name)}\\[(\\d+)\\]\\.(.+)$`,
        );
        const match = key.match(pattern);
        if (match) {
          const chIndex = parseInt(match[1]) + 1;
          const mapKey = match[2];
          return `${col.name}[${chIndex}]['${mapKey}']`;
        }
      }
    }
  }
  return key;
}

/**
 * Returns true if the field is a structural ID field that should always be hidden.
 *
 * Matches:
 *   - Top-level String columns whose name ends in "Id" or "ID" (e.g., TraceId, SpanId)
 *   - Array(String) column elements or plain column references whose name ends in
 *     "Id" or "ID" (e.g., Links.TraceId[0] from a Links.TraceId Array(String) column)
 */
export function isIdField(
  key: string,
  columnMeta: { name: string; type: string }[],
): boolean {
  // Extract base column name:
  //   "ColName[N]" → colName is "ColName"
  //   "ColName" (no brackets) → colName is the key itself
  //   "ColName[N].subkey" → has brackets but doesn't end with ], skip
  const arrMatch = key.match(/^([^\[]+)\[(\d+)\]$/);
  const colName = arrMatch ? arrMatch[1] : key.includes('[') ? null : key;
  if (!colName) return false;
  if (!/(Id|ID)$/.test(colName)) return false;

  const col = columnMeta.find(c => c.name === colName);
  if (!col) return false;
  const baseType = stripTypeWrappers(col.type);
  if (baseType === 'String') return true;
  if (baseType.startsWith('Array(')) {
    const innerType = stripTypeWrappers(baseType.slice('Array('.length, -1));
    return innerType === 'String';
  }
  return false;
}

/**
 * Returns true if the field is a per-index timestamp array element (e.g.,
 * Events.Timestamp[0]) from a column of type Array(DateTime64(...)), or the
 * plain column reference itself (e.g., Events.Timestamp).
 */
export function isTimestampArrayField(
  key: string,
  columnMeta: { name: string; type: string }[],
): boolean {
  const arrMatch = key.match(/^([^\[]+)\[(\d+)\]$/);
  const colName = arrMatch ? arrMatch[1] : key.includes('[') ? null : key;
  if (!colName) return false;

  const col = columnMeta.find(c => c.name === colName);
  if (!col) return false;
  const baseType = stripTypeWrappers(col.type);
  if (!baseType.startsWith('Array(')) return false;
  const innerType = stripTypeWrappers(baseType.slice('Array('.length, -1));
  return innerType.startsWith('DateTime64(');
}

/**
 * Returns true if the field should always be hidden per the structural denylist:
 *   - ID fields (TraceId, SpanId, ParentSpanId, Links.TraceId[N], Links.SpanId[N], etc.)
 *   - Per-index timestamp array elements (Events.Timestamp[N], Links.Timestamp[N], etc.)
 */
export function isDenylisted(
  key: string,
  columnMeta: { name: string; type: string }[],
): boolean {
  return isIdField(key, columnMeta) || isTimestampArrayField(key, columnMeta);
}

/**
 * Returns true if the field should be hidden due to high cardinality (most values are
 * unique, meaning it provides little analytical value in the comparison view).
 *
 * Takes the percentage occurrence maps (value → percentage 0–100) produced by
 * getPropertyStatistics, and the raw property occurrence counts. Unique value count is
 * derived from the map's size.
 *
 * A field is considered high cardinality when:
 *   min(outlierUniqueness, inlierUniqueness) > 0.9 AND combined sample size > 20
 *
 * "min" ensures that if either group clusters (low cardinality), the field is kept visible.
 * If only one group has data, that group's uniqueness alone is used.
 */
export function isHighCardinality(
  key: string,
  outlierValueOccurences: Map<string, Map<string, number>>,
  inlierValueOccurences: Map<string, Map<string, number>>,
  outlierPropertyOccurences: Map<string, number>,
  inlierPropertyOccurences: Map<string, number>,
): boolean {
  const outlierTotal = outlierPropertyOccurences.get(key) ?? 0;
  const inlierTotal = inlierPropertyOccurences.get(key) ?? 0;
  const combinedSampleSize = outlierTotal + inlierTotal;
  if (combinedSampleSize <= 20) return false;

  const outlierUniqueValues = outlierValueOccurences.get(key)?.size ?? 0;
  const inlierUniqueValues = inlierValueOccurences.get(key)?.size ?? 0;

  const outlierUniqueness =
    outlierTotal > 0 ? outlierUniqueValues / outlierTotal : null;
  const inlierUniqueness =
    inlierTotal > 0 ? inlierUniqueValues / inlierTotal : null;

  let effectiveUniqueness: number;
  if (outlierUniqueness !== null && inlierUniqueness !== null) {
    effectiveUniqueness = Math.min(outlierUniqueness, inlierUniqueness);
  } else if (outlierUniqueness !== null) {
    effectiveUniqueness = outlierUniqueness;
  } else if (inlierUniqueness !== null) {
    effectiveUniqueness = inlierUniqueness;
  } else {
    return false;
  }

  return effectiveUniqueness > 0.9;
}

/*
 * Response Data is like...
{
  Timestamp: "",
  Map: {
    "property": value,
  }
}

- Flatten
- Count Property Occurences
- Pick most common properties
- Count values for most common properties

- Merge both sets of properties? one property?
 */

// TODO: doesn't work for empty objects?
// https://stackoverflow.com/a/19101235
function flattenData(data: Record<string, any>) {
  const result: Record<string, any> = {};
  function recurse(cur: Record<string, any>, prop: string) {
    if (Object(cur) !== cur) {
      result[prop] = cur;
    } else if (Array.isArray(cur)) {
      let l;
      for (let i = 0, l = cur.length; i < l; i++)
        recurse(cur[i], prop + '[' + i + ']');
      if (l == 0) result[prop] = [];
    } else {
      let isEmpty = true;
      for (const p in cur) {
        isEmpty = false;
        recurse(cur[p], prop ? prop + '.' + p : p);
      }
      if (isEmpty && prop) result[prop] = {};
    }
  }
  recurse(data, '');
  return result;
}

function getPropertyStatistics(data: Record<string, any>[]) {
  const flattened = data.map(flattenData);
  const propertyOccurences = new Map<string, number>();

  const MIN_PROPERTY_OCCURENCES = 5;
  const commonProperties = new Set<string>();

  flattened.forEach(item => {
    Object.entries(item).forEach(([key, value]) => {
      const count = propertyOccurences.get(key) || 0;
      propertyOccurences.set(key, count + 1);

      if (count + 1 >= MIN_PROPERTY_OCCURENCES) {
        commonProperties.add(key);
      }
    });
  });

  // property -> (value -> count)
  const valueOccurences = new Map<string, Map<string, number>>();
  flattened.forEach(item => {
    Object.entries(item).forEach(([key, value]) => {
      if (commonProperties.has(key)) {
        let valuesMap = valueOccurences.get(key);
        if (!valuesMap) {
          valuesMap = new Map<string, number>();
          valueOccurences.set(key, valuesMap);
        }

        const valueCount = valuesMap.get(value) || 0;
        valuesMap.set(value, valueCount + 1);
      }
    });
  });

  const percentageOccurences = new Map<string, Map<string, number>>();
  valueOccurences.forEach((valuesMap, property) => {
    const percentageMap = new Map<string, number>();
    valuesMap.forEach((valueCount, value) => {
      percentageMap.set(
        value,
        (valueCount / (propertyOccurences.get(property) ?? 0)) * 100,
      );
    });
    percentageOccurences.set(property, percentageMap);
  });

  return {
    percentageOccurences,
    propertyOccurences,
  };
}

function mergeValueStatisticsMaps(
  outlierValues: Map<string, number>, // value -> count
  inlierValues: Map<string, number>,
) {
  const mergedArray: {
    name: string;
    outlierCount: number;
    inlierCount: number;
  }[] = [];
  // Collect all value names for this property
  // we sort them so timestamps are ordered
  const allValues = Array.from(
    new Set([...outlierValues.keys(), ...inlierValues.keys()]),
  ).sort();

  allValues.forEach(value => {
    const count1 = outlierValues.get(value) || 0;
    const count2 = inlierValues.get(value) || 0;
    mergedArray.push({
      name: value,
      outlierCount: count1,
      inlierCount: count2,
    });
  });

  return mergedArray;
}

export type AddFilterFn = (
  property: string,
  value: string,
  action?: 'only' | 'exclude' | 'include',
) => void;

// Hover-only tooltip: shows value name and percentages, no action buttons.
// Actions are handled by the click popover in PropertyComparisonChart.
const HDXBarChartTooltip = withErrorBoundary(
  memo((props: any) => {
    const { active, payload, label, title } = props;

    if (active && payload && payload.length) {
      return (
        <div className={styles.chartTooltip}>
          <div className={styles.chartTooltipContent}>
            {title && (
              <Text size="xs" mb="xs">
                {title}
              </Text>
            )}
            <Text size="xs" mb="xs">
              {String(label).length === 0 ? <i>Empty String</i> : String(label)}
            </Text>
            {payload
              .sort((a: any, b: any) => b.value - a.value)
              .map((p: any) => (
                <div key={p.dataKey}>
                  {p.name}: {p.value.toFixed(2)}%
                </div>
              ))}
          </div>
        </div>
      );
    }
    return null;
  }),
  {
    onError: console.error,
    fallback: (
      <div className="text-danger px-2 py-1 m-2 fs-8 font-monospace bg-danger-transparent">
        An error occurred while rendering the tooltip.
      </div>
    ),
  },
);

// Custom XAxis tick that truncates long labels and adds a native SVG tooltip.
function TruncatedTick({ x, y, payload }: any) {
  const value = String(payload?.value ?? '');
  const MAX_CHARS = 12;
  const displayValue =
    value.length > MAX_CHARS ? value.slice(0, MAX_CHARS) + '…' : value;
  return (
    <g transform={`translate(${x},${y})`}>
      <title>{value}</title>
      <text
        x={0}
        y={0}
        dy={12}
        textAnchor="middle"
        fontSize={10}
        fontFamily="IBM Plex Mono, monospace"
      >
        {displayValue}
      </text>
    </g>
  );
}

// When a field has more than this many distinct values, the remaining values
// are collapsed into a single "Other (N)" bucket shown in neutral gray.
export const MAX_CHART_VALUES = 6;

// Aggregates chart data beyond MAX_CHART_VALUES into a single "Other (N)" entry.
// Sorts by combined count (outlier + inlier) descending so the most frequent
// values are kept. Returns data unchanged if already within the limit.
export function applyTopNAggregation(
  data: { name: string; outlierCount: number; inlierCount: number }[],
): {
  name: string;
  outlierCount: number;
  inlierCount: number;
  isOther?: boolean;
}[] {
  if (data.length <= MAX_CHART_VALUES) return data;

  const sorted = [...data].sort(
    (a, b) =>
      b.outlierCount + b.inlierCount - (a.outlierCount + a.inlierCount),
  );
  const top = sorted.slice(0, MAX_CHART_VALUES);
  const rest = sorted.slice(MAX_CHART_VALUES);

  const otherOutlierCount = rest.reduce((sum, item) => sum + item.outlierCount, 0);
  const otherInlierCount = rest.reduce((sum, item) => sum + item.inlierCount, 0);

  return [
    ...top,
    {
      name: `Other (${rest.length})`,
      outlierCount: otherOutlierCount,
      inlierCount: otherInlierCount,
      isOther: true,
    },
  ];
}

function PropertyComparisonChart({
  name,
  outlierValueOccurences,
  inlierValueOccurences,
  onAddFilter,
}: {
  name: string;
  outlierValueOccurences: Map<string, number>;
  inlierValueOccurences: Map<string, number>;
  onAddFilter?: AddFilterFn;
}) {
  const mergedValueStatistics = mergeValueStatisticsMaps(
    outlierValueOccurences,
    inlierValueOccurences,
  );
  const chartData = applyTopNAggregation(mergedValueStatistics);

  const totalOutliers = useMemo(
    () =>
      Array.from(outlierValueOccurences.values()).reduce((a, b) => a + b, 0),
    [outlierValueOccurences],
  );
  const totalInliers = useMemo(
    () =>
      Array.from(inlierValueOccurences.values()).reduce((a, b) => a + b, 0),
    [inlierValueOccurences],
  );

  const [clickedBar, setClickedBar] = useState<{
    value: string;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [copiedValue, setCopiedValue] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const chartWrapperRef = useRef<HTMLDivElement>(null);

  // Dismiss popover when clicking outside both the popover and the chart wrapper
  useEffect(() => {
    if (!clickedBar) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        chartWrapperRef.current &&
        !chartWrapperRef.current.contains(e.target as Node)
      ) {
        setClickedBar(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [clickedBar]);

  // Dismiss popover on scroll (prevents stale popover when chart scrolls offscreen)
  useEffect(() => {
    if (!clickedBar) return;
    const handleScroll = () => setClickedBar(null);
    window.addEventListener('scroll', handleScroll, true);
    return () => window.removeEventListener('scroll', handleScroll, true);
  }, [clickedBar]);

  const handleChartClick = useCallback((data: any, event: any) => {
    if (!data?.activePayload?.length) {
      setClickedBar(null);
      return;
    }
    if (data.activePayload[0]?.payload?.isOther) {
      setClickedBar(null);
      return;
    }
    setClickedBar({
      value: String(data.activeLabel ?? ''),
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }, []);

  return (
    <div ref={chartWrapperRef} style={{ width: '100%', height: 120 }}>
      <Text size="xs" ta="center" title={name}>
        {truncateMiddle(name, 32)}
      </Text>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          barGap={2}
          width={500}
          height={300}
          data={chartData}
          margin={{
            top: 0,
            right: 0,
            left: 0,
            bottom: 0,
          }}
          onClick={handleChartClick}
          style={{ cursor: 'pointer' }}
        >
          <XAxis dataKey="name" tick={<TruncatedTick />} />
          <YAxis
            tick={{ fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }}
          />
          <Tooltip
            content={<HDXBarChartTooltip title={name} />}
            allowEscapeViewBox={{ y: true }}
          />
          <Bar
            dataKey="outlierCount"
            name="Outliers"
            fill={getChartColorError()}
            isAnimationActive={false}
          >
            {chartData.map((entry, index) => (
              <Cell
                key={`out-${index}`}
                fill={entry.isOther ? '#868e96' : getChartColorError()}
              />
            ))}
          </Bar>
          <Bar
            dataKey="inlierCount"
            name="Inliers"
            fill={getChartColorSuccess()}
            isAnimationActive={false}
          >
            {chartData.map((entry, index) => (
              <Cell
                key={`in-${index}`}
                fill={entry.isOther ? '#868e96' : getChartColorSuccess()}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {clickedBar &&
        createPortal(
          <div
            ref={popoverRef}
            className={styles.chartTooltip}
            style={{
              position: 'fixed',
              left: clickedBar.clientX,
              top: clickedBar.clientY - 8,
              transform: 'translate(-50%, -100%)',
              zIndex: 9999,
              borderRadius: 4,
              padding: '8px 12px',
              minWidth: 200,
              maxWidth: 320,
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            }}
          >
            <Text
              size="xs"
              c="dimmed"
              fw={600}
              mb={4}
              style={{ wordBreak: 'break-all' }}
              title={name}
            >
              {truncateMiddle(name, 40)}
            </Text>
            <Text size="xs" mb={6} style={{ wordBreak: 'break-all' }}>
              {clickedBar.value.length === 0 ? (
                <i>Empty String</i>
              ) : (
                clickedBar.value
              )}
            </Text>
            {(() => {
              const outlierCount =
                outlierValueOccurences.get(clickedBar.value) ?? 0;
              const inlierCount =
                inlierValueOccurences.get(clickedBar.value) ?? 0;
              const outlierPct =
                totalOutliers > 0
                  ? ((outlierCount / totalOutliers) * 100).toFixed(1)
                  : null;
              const inlierPct =
                totalInliers > 0
                  ? ((inlierCount / totalInliers) * 100).toFixed(1)
                  : null;
              return (
                <Flex gap={12} mb={8}>
                  <Text size="xs" c={getChartColorError()}>
                    Outliers: {outlierCount}
                    {outlierPct != null ? ` (${outlierPct}%)` : ''}
                  </Text>
                  <Text size="xs" c={getChartColorSuccess()}>
                    Inliers: {inlierCount}
                    {inlierPct != null ? ` (${inlierPct}%)` : ''}
                  </Text>
                </Flex>
              );
            })()}
            <Flex gap={4} align="center">
              {onAddFilter && (
                <>
                  <MantineTooltip
                    label="Filter for this value"
                    position="top"
                    withArrow
                    fz="xs"
                  >
                    <ActionIcon
                      variant="primary"
                      size="xs"
                      onClick={() => {
                        onAddFilter(name, clickedBar.value, 'include');
                        setClickedBar(null);
                      }}
                    >
                      <IconFilter size={12} />
                    </ActionIcon>
                  </MantineTooltip>
                  <MantineTooltip
                    label="Exclude this value"
                    position="top"
                    withArrow
                    fz="xs"
                  >
                    <ActionIcon
                      variant="secondary"
                      size="xs"
                      onClick={() => {
                        onAddFilter(name, clickedBar.value, 'exclude');
                        setClickedBar(null);
                      }}
                    >
                      <IconFilterX size={12} />
                    </ActionIcon>
                  </MantineTooltip>
                </>
              )}
              <MantineTooltip
                label={copiedValue ? 'Copied!' : 'Copy value'}
                position="top"
                withArrow
                fz="xs"
              >
                <ActionIcon
                  variant="secondary"
                  size="xs"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(clickedBar.value);
                      setCopiedValue(true);
                      setTimeout(() => setCopiedValue(false), 2000);
                    } catch (e) {
                      console.error('Failed to copy:', e);
                    }
                  }}
                  color={copiedValue ? 'green' : undefined}
                >
                  {copiedValue ? (
                    <IconCheck size={12} />
                  ) : (
                    <IconCopy size={12} />
                  )}
                </ActionIcon>
              </MantineTooltip>
            </Flex>
          </div>,
          document.body,
        )}
    </div>
  );
}

// Layout constants for dynamic grid calculation.
// CHART_WIDTH is the minimum chart width used to determine how many columns fit; actual rendered
// width expands to fill the container (charts use width: '100%' inside a CSS grid).
// CHART_HEIGHT must match PropertyComparisonChart's outer div height.
// CHART_GAP is used both in the column/row formula and as the CSS grid gap.
const CHART_WIDTH = 340; // minimum column width threshold (px)
const CHART_HEIGHT = 120; // must match PropertyComparisonChart outer div height (px)
const CHART_GAP = 16; // px; used in grid gap and layout math
// Space reserved for the pagination row: Pagination control (~32px) + top padding (16px).
// Always reserved (even when pagination is hidden via visibility:hidden) so rows count is stable.
const PAGINATION_HEIGHT = 48;

export default function DBDeltaChart({
  config,
  valueExpr,
  xMin,
  xMax,
  yMin,
  yMax,
  onAddFilter,
}: {
  config: ChartConfigWithDateRange;
  valueExpr: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  onAddFilter?: AddFilterFn;
}) {
  // Determine if the value expression uses aggregate functions
  const isAggregate = isAggregateFunction(valueExpr);

  // Get the timestamp expression from config
  const timestampExpr = getFirstTimestampValueExpression(
    config.timestampValueExpression,
  );

  // Helper to build the shared AggregatedTimestamps CTE (used by both outlier and inlier queries)
  const buildAggregatedTimestampsCTE = () =>
    isAggregate
      ? {
          name: 'AggregatedTimestamps',
          chartConfig: {
            ...config,
            from: config.from,
            select: timestampExpr,
            filters: [
              ...(config.filters ?? []),
              {
                type: 'sql',
                condition: `${timestampExpr} >= ${xMin}`,
              } satisfies Filter,
              {
                type: 'sql',
                condition: `${timestampExpr} <= ${xMax}`,
              } satisfies Filter,
              ...(config.where
                ? [
                    {
                      type: config.whereLanguage,
                      condition: config.where,
                    } as Filter,
                  ]
                : []),
            ],
            groupBy: timestampExpr,
            having: `(${valueExpr}) >= ${yMin} AND (${valueExpr}) <= ${yMax}`,
          },
        }
      : null;

  // Helper to build WITH clauses for a query (outlier or inlier)
  const buildWithClauses = (
    isOutlier: boolean,
  ): NonNullable<ChartConfigWithOptDateRange['with']> => {
    const aggregatedTimestampsCTE = buildAggregatedTimestampsCTE();

    // Build the SQL condition for filtering
    const buildSqlCondition = () => {
      const timestampExpression = `${timestampExpr} >= ${xMin} AND ${timestampExpr} <= ${xMax}`;
      let query = timestampExpression;
      if (!isAggregate) {
        // For non-aggregates, we filter directly on both timestamp and value
        query += ` AND (${valueExpr}) >= ${yMin} AND (${valueExpr}) <= ${yMax}`;
      }
      return isOutlier ? query : `NOT (${query})`;
    };

    const sqlCondition = buildSqlCondition();
    const aggregateTimestampCondition = isOutlier
      ? `${timestampExpr} IN (SELECT ${timestampExpr} FROM AggregatedTimestamps)`
      : `${timestampExpr} NOT IN (SELECT ${timestampExpr} FROM AggregatedTimestamps)`;

    return [
      ...(aggregatedTimestampsCTE ? [aggregatedTimestampsCTE] : []),
      {
        name: 'PartIds',
        chartConfig: {
          ...config,
          select: 'tuple(_part, _part_offset)',
          filters: [
            ...(config.filters ?? []),
            {
              type: 'sql',
              condition: sqlCondition,
            } satisfies Filter,
            ...(isAggregate
              ? [
                  {
                    type: 'sql',
                    condition: aggregateTimestampCondition,
                  } satisfies Filter,
                ]
              : []),
          ],
          orderBy: [{ ordering: 'DESC', valueExpression: 'rand()' }],
          limit: { limit: 1000 },
        },
      },
    ];
  };

  // Helper to build filters for the main query
  const buildFilters = (isOutlier: boolean) => {
    // Build the SQL condition for filtering
    const buildSqlCondition = () => {
      if (isAggregate) {
        // For aggregates, we filter by timestamp range
        return isOutlier
          ? `${timestampExpr} >= ${xMin} AND ${timestampExpr} <= ${xMax}`
          : `NOT (${timestampExpr} >= ${xMin} AND ${timestampExpr} <= ${xMax})`;
      } else {
        // For non-aggregates, we filter directly on both timestamp and value
        return isOutlier
          ? `(${valueExpr}) >= ${yMin} AND (${valueExpr}) <= ${yMax} AND ${timestampExpr} >= ${xMin} AND ${timestampExpr} <= ${xMax}`
          : `NOT ((${valueExpr}) >= ${yMin} AND (${valueExpr}) <= ${yMax} AND ${timestampExpr} >= ${xMin} AND ${timestampExpr} <= ${xMax})`;
      }
    };

    const sqlCondition = buildSqlCondition();
    const aggregateTimestampCondition = isOutlier
      ? `${timestampExpr} IN (SELECT ${timestampExpr} FROM AggregatedTimestamps)`
      : `${timestampExpr} NOT IN (SELECT ${timestampExpr} FROM AggregatedTimestamps)`;

    return [
      ...(config.filters ?? []),
      {
        type: 'sql',
        condition: sqlCondition,
      } as { type: 'sql'; condition: string },
      ...(isAggregate
        ? [
            {
              type: 'sql',
              condition: aggregateTimestampCondition,
            } as { type: 'sql'; condition: string },
          ]
        : []),
      {
        type: 'sql',
        condition: `indexHint((_part, _part_offset) IN PartIds)`,
      } as { type: 'sql'; condition: string },
    ];
  };

  const { data: outlierData, error } = useQueriedChartConfig({
    ...config,
    with: buildWithClauses(true),
    select: '*',
    filters: buildFilters(true),
    orderBy: [{ ordering: 'DESC', valueExpression: 'rand()' }],
    limit: { limit: 1000 },
  });

  const { data: inlierData } = useQueriedChartConfig({
    ...config,
    with: buildWithClauses(false),
    select: '*',
    filters: buildFilters(false),
    orderBy: [{ ordering: 'DESC', valueExpression: 'rand()' }],
    limit: { limit: 1000 },
  });

  // Compute column metadata, property statistics, sorted/visible/hidden property lists.
  // columnMeta is merged here (instead of a separate useMemo) so the denylist and
  // cardinality checks can reference it during the same memoization pass.
  const {
    outlierValueOccurences,
    inlierValueOccurences,
    columnMeta,
    visibleProperties,
    hiddenProperties,
  } = useMemo(() => {
    const columnMeta = (outlierData?.meta ?? inlierData?.meta ?? []) as {
      name: string;
      type: string;
    }[];

    const {
      percentageOccurences: outlierValueOccurences,
      propertyOccurences: outlierPropertyOccurences,
    } = getPropertyStatistics(outlierData?.data ?? []);

    const {
      percentageOccurences: inlierValueOccurences,
      propertyOccurences: inlierPropertyOccurences,
    } = getPropertyStatistics(inlierData?.data ?? []);

    // Get all the unique keys from the outliers
    let uniqueKeys = new Set([...outlierValueOccurences.keys()]);
    // If there's no outliers, use inliers as the unique keys
    if (uniqueKeys.size === 0) {
      uniqueKeys = new Set([...inlierValueOccurences.keys()]);
    }
    // Now process the keys to find the ones with the highest delta between outlier and inlier percentages
    const sortedProperties = Array.from(uniqueKeys)
      .map(key => {
        const inlierCount =
          inlierValueOccurences.get(key) ?? new Map<string, number>();
        const outlierCount =
          outlierValueOccurences.get(key) ?? new Map<string, number>();

        const mergedArray = mergeValueStatisticsMaps(
          outlierCount,
          inlierCount,
        );
        let maxValueDelta = 0;
        mergedArray.forEach(item => {
          const delta = Math.abs(item.outlierCount - item.inlierCount);
          if (delta > maxValueDelta) {
            maxValueDelta = delta;
          }
        });

        return [key, maxValueDelta] as const;
      })
      .sort((a, b) => b[1] - a[1])
      .map(a => a[0]);

    // Split properties into visible (shown in charts) and hidden (denylist or high cardinality)
    const visibleProperties: string[] = [];
    const hiddenProperties: string[] = [];

    sortedProperties.forEach(key => {
      if (isDenylisted(key, columnMeta)) {
        hiddenProperties.push(key);
      } else if (
        isHighCardinality(
          key,
          outlierValueOccurences,
          inlierValueOccurences,
          outlierPropertyOccurences,
          inlierPropertyOccurences,
        )
      ) {
        hiddenProperties.push(key);
      } else {
        visibleProperties.push(key);
      }
    });

    return {
      outlierValueOccurences,
      inlierValueOccurences,
      columnMeta,
      visibleProperties,
      hiddenProperties,
    };
  }, [outlierData, inlierData]);

  // Wrap onAddFilter to convert flattened dot-notation keys (from flattenData)
  // into valid ClickHouse SQL expressions before passing to the filter handler.
  const handleAddFilter = useCallback<NonNullable<AddFilterFn>>(
    (property, value, action) => {
      if (!onAddFilter) return;
      onAddFilter(
        flattenedKeyToSqlExpression(property, columnMeta),
        value,
        action,
      );
    },
    [onAddFilter, columnMeta],
  );

  const [activePage, setPage] = useState(1);

  const {
    ref: containerRef,
    width: containerWidth,
    height: containerHeight,
  } = useElementSize();

  const columns = Math.max(
    1,
    Math.floor((containerWidth + CHART_GAP) / (CHART_WIDTH + CHART_GAP)),
  );
  const rows = Math.max(
    1,
    Math.floor(
      (containerHeight - PAGINATION_HEIGHT + CHART_GAP) /
        (CHART_HEIGHT + CHART_GAP),
    ),
  );
  const PAGE_SIZE = columns * rows;

  useEffect(() => {
    setPage(1);
  }, [PAGE_SIZE, xMin, xMax, yMin, yMax]);

  if (error) {
    return (
      <Container style={{ overflow: 'auto' }}>
        <Box mt="lg">
          <Text my="sm" size="sm">
            Error Message:
          </Text>
          <Code
            block
            style={{
              whiteSpace: 'pre-wrap',
            }}
          >
            {error.message}
          </Code>
        </Box>
        {error instanceof ClickHouseQueryError && (
          <Box mt="lg">
            <Text my="sm" size="sm">
              Original Query:
            </Text>
            <Code
              block
              style={{
                whiteSpace: 'pre-wrap',
              }}
            >
              <SQLPreview data={error.query} formatData />
            </Code>
          </Box>
        )}
      </Container>
    );
  }

  const totalPages = Math.ceil(visibleProperties.length / PAGE_SIZE);

  // Show lower-priority fields on the last page (or when there are no visible fields)
  const showLowerPriorityFields =
    hiddenProperties.length > 0 &&
    (totalPages === 0 || activePage === totalPages);

  return (
    <Box
      ref={containerRef}
      p="md"
      style={{
        overflowX: 'hidden',
        overflowY: 'auto',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: CHART_GAP,
        }}
      >
        {visibleProperties
          .slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE)
          .map(property => (
            <PropertyComparisonChart
              name={property}
              outlierValueOccurences={
                outlierValueOccurences.get(property) ?? new Map()
              }
              inlierValueOccurences={
                inlierValueOccurences.get(property) ?? new Map()
              }
              onAddFilter={onAddFilter ? handleAddFilter : undefined}
              key={property}
            />
          ))}
      </div>
      {showLowerPriorityFields && (
        <>
          <Divider
            mt="lg"
            mb="xs"
            label={
              <Text size="xs" c="dimmed">
                Lower-priority fields ({hiddenProperties.length})
              </Text>
            }
            labelPosition="left"
          />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${columns}, 1fr)`,
              gap: CHART_GAP,
            }}
          >
            {hiddenProperties.map(key => (
              <PropertyComparisonChart
                name={key}
                outlierValueOccurences={
                  outlierValueOccurences.get(key) ?? new Map()
                }
                inlierValueOccurences={
                  inlierValueOccurences.get(key) ?? new Map()
                }
                onAddFilter={onAddFilter ? handleAddFilter : undefined}
                key={key}
              />
            ))}
          </div>
        </>
      )}
      <Flex
        justify="flex-end"
        align="center"
        style={{
          marginTop: 'auto',
          paddingTop: CHART_GAP,
          visibility: totalPages > 1 ? 'visible' : 'hidden',
        }}
      >
        <Pagination
          size="xs"
          value={activePage}
          onChange={setPage}
          total={totalPages}
        />
      </Flex>
    </Box>
  );
}
