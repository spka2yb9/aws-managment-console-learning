import Box from '@cloudscape-design/components/box';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatValue, type Datapoint, type MetricUnit } from '../sim/cloudwatch';

export interface GraphSeries {
  label: string;
  data: Datapoint[];
}

// Cloudscape's categorical chart palette
const COLORS = ['#688ae8', '#c33d69', '#2ea597', '#8456ce', '#e07941', '#3759ce'];

const time = (t: number, withDate: boolean) =>
  new Date(t).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', ...(withDate ? { month: '2-digit', day: '2-digit' } : {}) });

/** A CloudWatch line graph (recharts inside the caller's Cloudscape container). */
export default function MetricGraph({ series, start, end, unit, threshold, height = 180 }: { series: GraphSeries[]; start: number; end: number; unit?: MetricUnit; threshold?: number; height?: number }) {
  const points = series.reduce((n, s) => n + s.data.length, 0);
  if (!points)
    return (
      <Box textAlign="center" color="text-body-secondary" padding={{ vertical: 'xxl' }} data-testid="metric-graph-empty">
        利用可能なデータがありません。
      </Box>
    );
  // one row per timestamp, one column per series
  const rows = new Map<number, Record<string, number>>();
  series.forEach((s, n) => s.data.forEach((d) => rows.set(d.t, { ...rows.get(d.t), t: d.t, [`s${n}`]: d.v })));
  const data = [...rows.values()].sort((a, b) => a.t - b.t);
  const withDate = end - start > 86_400_000;
  return (
    <div data-testid="metric-graph" data-points={points} aria-label={series.map((s) => s.label).join(', ')} role="img">
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#e9ebed" vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={[start, end]} tickFormatter={(t: number) => time(t, withDate)} tick={{ fontSize: 11 }} minTickGap={24} />
          <YAxis tickFormatter={(v: number) => formatValue(v, unit)} tick={{ fontSize: 11 }} width={52} domain={unit === 'Percent' ? [0, (max: number) => Math.max(10, Math.ceil(max / 10) * 10)] : [0, 'auto']} />
          <Tooltip labelFormatter={(t) => time(Number(t), true)} formatter={(v, name) => [formatValue(Number(v), unit), series[Number(String(name).slice(1))]?.label ?? name]} />
          {series.length > 1 && <Legend formatter={(name: string) => series[Number(name.slice(1))]?.label ?? name} wrapperStyle={{ fontSize: 12 }} />}
          {threshold !== undefined && <ReferenceLine y={threshold} stroke="#d91515" strokeDasharray="4 4" ifOverflow="extendDomain" />}
          {series.map((_, n) => (
            <Line key={n} dataKey={`s${n}`} stroke={COLORS[n % COLORS.length]} dot={false} strokeWidth={2} isAnimationActive={false} connectNulls />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
