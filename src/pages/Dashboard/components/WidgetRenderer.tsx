import StatWidget from './widgets/StatWidget';
import BarChartWidget from './widgets/BarChartWidget';
import PieChartWidget from './widgets/PieChartWidget';
import LineChartWidget from './widgets/LineChartWidget';
import TableWidget from './widgets/TableWidget';
import type { DashboardWidget } from '@/types';

interface WidgetRendererProps {
  widget: DashboardWidget;
  isPublic?: boolean;
}

export default function WidgetRenderer({ widget, isPublic }: WidgetRendererProps) {
  switch (widget.type) {
    case 'stat':
      return <StatWidget widget={widget} />;
    case 'bar_chart':
      return <BarChartWidget widget={widget} />;
    case 'pie_chart':
      return <PieChartWidget widget={widget} />;
    case 'line_chart':
      return <LineChartWidget widget={widget} />;
    case 'table':
      return <TableWidget widget={widget} isPublic={isPublic} />;
    default:
      return <div>Unknown widget type</div>;
  }
}
