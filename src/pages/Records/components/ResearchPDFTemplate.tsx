import { forwardRef } from 'react';

/**
 * A cell value is either a plain formatted string or a link descriptor.
 * Link cells render as an <a data-pdf-link="..."> so the pdf generator can
 * attach clickable link annotations on top of the rasterized image after the
 * html2canvas pass. Plain strings render as-is.
 */
export type CellValue = string | { text: string; url: string };

export interface ProjectRow {
  label: string;
  values: CellValue[];
}

export interface ResearchComparisonData {
  /** Horizontal header labels — one per field column. */
  fieldLabels: string[];
  /** One row per linked project (already filtered by any active view). */
  projectRows: ProjectRow[];
  generatedAt: string;
}

interface ResearchPDFTemplateProps {
  data: ResearchComparisonData;
  landscape: boolean;
}

const ResearchPDFTemplate = forwardRef<HTMLDivElement, ResearchPDFTemplateProps>(
  ({ data, landscape }, ref) => {
    // A4 at 96 DPI: portrait 794×1123, landscape 1123×794. html2canvas rasterizes
    // whatever size we render — setting the exact target prevents aspect-ratio drift.
    const width = landscape ? 1123 : 794;
    const minHeight = landscape ? 794 : 1123;

    const title = data.projectRows.length === 0
      ? 'بحث المشاريع'
      : data.projectRows.length === 1
        ? data.projectRows[0]!.label
        : `دراسة مقارنة — ${data.projectRows.length} مشاريع`;

    return (
      <div
        ref={ref}
        dir="rtl"
        style={{
          width: `${width}px`,
          minHeight: `${minHeight}px`,
          fontFamily: 'Amiri, serif',
          backgroundColor: '#fff',
          color: '#4A4E54',
        }}
      >
        {/* Header */}
        <div style={{ backgroundColor: '#4A2C2A', padding: '28px 36px', color: '#fff' }}>
          <div style={{ fontSize: '13px', color: '#C09B5F', fontWeight: 'bold', marginBottom: '6px' }}>
            وصل العقارية — Wassel Real Estate
          </div>
          <div style={{ fontSize: '26px', fontWeight: 'bold' }}>{title}</div>
          {data.projectRows.length >= 2 && (
            <div style={{ fontSize: '13px', opacity: 0.85, marginTop: '6px' }}>
              {data.projectRows.map((p) => p.label).join('  •  ')}
            </div>
          )}
        </div>

        {/* Comparison table — projects as rows, fields as columns */}
        <div style={{ padding: '24px 36px' }}>
          {data.projectRows.length === 0 ? (
            <div style={{ fontSize: '14px', color: '#8E4E3A', textAlign: 'center', padding: '48px 0' }}>
              لم يتم اختيار أي مشروع بعد
            </div>
          ) : data.fieldLabels.length === 0 ? (
            <div style={{ fontSize: '14px', color: '#8E4E3A', textAlign: 'center', padding: '48px 0' }}>
              لم يتم اختيار أي حقل لهذا العرض
            </div>
          ) : (
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '12px',
                tableLayout: 'fixed',
              }}
            >
              <colgroup>
                <col style={{ width: '180px' }} />
                {data.fieldLabels.map((_, i) => (
                  <col key={i} />
                ))}
              </colgroup>
              <thead>
                <tr style={{ backgroundColor: '#F5EDE0' }}>
                  <th
                    style={{
                      padding: '10px 12px',
                      textAlign: 'start',
                      fontWeight: 'bold',
                      color: '#4A2C2A',
                      borderBottom: '2px solid #D4B896',
                      fontSize: '13px',
                    }}
                  >
                    المشروع
                  </th>
                  {data.fieldLabels.map((label, i) => (
                    <th
                      key={i}
                      style={{
                        padding: '10px 12px',
                        textAlign: 'start',
                        fontWeight: 'bold',
                        color: '#4A2C2A',
                        borderBottom: '2px solid #D4B896',
                        borderInlineStart: '1px solid #E7D8BE',
                        fontSize: '11px',
                      }}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.projectRows.map((row, idx) => (
                  <tr
                    key={idx}
                    style={{
                      backgroundColor: idx % 2 === 0 ? '#fff' : '#FAF5EB',
                    }}
                  >
                    <th
                      style={{
                        padding: '10px 12px',
                        textAlign: 'start',
                        fontWeight: 'bold',
                        color: '#4A2C2A',
                        borderBottom: '1px solid #EBD9B8',
                        verticalAlign: 'top',
                        fontSize: '12px',
                      }}
                    >
                      {row.label}
                    </th>
                    {row.values.map((v, i) => (
                      <td
                        key={i}
                        style={{
                          padding: '10px 12px',
                          color: '#4A2C2A',
                          borderBottom: '1px solid #EBD9B8',
                          borderInlineStart: '1px solid #F1E5CD',
                          verticalAlign: 'top',
                          wordBreak: 'break-word',
                        }}
                      >
                        {typeof v === 'string' ? (
                          v
                        ) : (
                          <a
                            href={v.url}
                            data-pdf-link={v.url}
                            style={{
                              display: 'inline-block',
                              padding: '3px 10px',
                              borderRadius: '8px',
                              backgroundColor: '#B8734F',
                              color: '#fff',
                              fontWeight: 'bold',
                              fontSize: '11px',
                              textDecoration: 'none',
                              direction: 'ltr',
                            }}
                          >
                            {v.text}
                          </a>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            borderTop: '2px solid #D4B896',
            padding: '14px 36px',
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '11px',
            color: '#4A4E54',
            opacity: 0.6,
          }}
        >
          <span>تم إعداد هذه الدراسة بواسطة وصل العقارية</span>
          <span>{data.generatedAt}</span>
        </div>
      </div>
    );
  },
);

ResearchPDFTemplate.displayName = 'ResearchPDFTemplate';
export default ResearchPDFTemplate;
